/**
 * PART DOCUMENTATION — what `./dbb connectors` and `./dbb part` print.
 *
 * The raw connector table (kind = the LDCad shape code, position, axis as a
 * vector) is unreadable: a 2x4 brick is nineteen lines of "cyl F", a 2x10
 * plate forty-nine, and nothing says which end is up. This module turns the
 * same data into what a builder actually needs:
 *
 *   - the part's NAME and SIZE (studs + LDU) and the origin convention,
 *   - connectors NAMED in plain words (stud, stud socket, tube, hollow stud,
 *     pin hole, axle hole, axle, pin, bar, clip, hinge, ball) — derived from
 *     gender + section profile + caps exactly the way lib/editor2/mates.ts
 *     classifies them, and "unknown (…)" when the profile says nothing,
 *   - connectors GROUPED by face and by regular grid (a 2x4 stud field is one
 *     line with a C-index range, not eight lines),
 *   - an ASCII MAP per face, so "where on the part" is a look, not arithmetic.
 *
 * Nothing here decides anything: it reads the same tables the compiler and
 * the grader read (public/data/parts/connections.json + meta.json).
 */
import { expandedConnectors, secSegments, type LocalConnector } from "../engine/connectionGraph";
import { getConnections, getPartIndex } from "./connect";
import type { PartMetaMap } from "../data/schemas";

type V3 = [number, number, number];

const IDENT9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul9 = (m: number[], v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/* ── section profiles ─────────────────────────────────────────────── */

interface SecInfo {
  rads: number[];
  first: { rad: number; len: number } | null;
  total: number;
  hasAxle: boolean;
  hasSquare: boolean;
  roundOnly: boolean;
}

const SEC_CACHE = new Map<string, SecInfo>();
/** Same parse as lib/editor2/mates.ts: lead-in chamfers describe insertion,
 * not the fit, so they are excluded from the radii and the length. */
function secInfo(secs?: string): SecInfo {
  const key = secs ?? "";
  let si = SEC_CACHE.get(key);
  if (si) return si;
  si = { rads: [], first: null, total: 0, hasAxle: false, hasSquare: false, roundOnly: true };
  for (const seg of secSegments(secs)) {
    if (seg.kind === "L_" || seg.kind === "_L") continue;
    si.rads.push(seg.rad);
    si.total += seg.len;
    if (!si.first) si.first = { rad: seg.rad, len: seg.len };
    if (seg.kind === "A") si.hasAxle = true;
    if (seg.kind === "S") si.hasSquare = true;
    if (seg.kind !== "R") si.roundOnly = false;
  }
  SEC_CACHE.set(key, si);
  return si;
}

const isR6 = (r: number) => r >= 5.5 && r <= 6.5;

/* ── faces & axes ─────────────────────────────────────────────────── */

/** Which drawing surface a connector belongs to. Through features (an axle
 * hole bored right across a beam) belong to the side PAIR, not to one face. */
export type Face = "top" | "bottom" | "sideX" | "sideZ" | "angled";

export interface ConnDoc {
  /** 1-based C number, as every other tool prints it. */
  i: number;
  c: LocalConnector;
  /** Plain-words type, e.g. "stud", "pin hole (round, through)". */
  label: string;
  /** Map glyph, or null when the connector is not drawn (bars, clips, …). */
  symbol: string | null;
  face: Face;
  /** Authored axis (ori · [0,1,0]) in part-local LDraw coordinates. */
  axis: V3;
  /** Where the feature opens/protrudes: males protrude opposite their axis. */
  outward: V3;
  /** Open at both ends (a bore right through the part). */
  through: boolean;
  /** Axis in words, e.g. "points up (−y)" / "through, along z". */
  axisWords: string;
  /** Set on the r4 bore of a hollow stud — drawn as part of the stud. */
  partOf?: number;
}

const DIRS: { v: V3; word: string }[] = [
  { v: [0, -1, 0], word: "up (−y)" },
  { v: [0, 1, 0], word: "down (+y)" },
  { v: [1, 0, 0], word: "+x" },
  { v: [-1, 0, 0], word: "−x" },
  { v: [0, 0, 1], word: "+z" },
  { v: [0, 0, -1], word: "−z" },
];

function dirWord(v: V3): string | null {
  for (const d of DIRS) {
    if (d.v[0] * v[0] + d.v[1] * v[1] + d.v[2] * v[2] > 0.95) return d.word;
  }
  return null;
}

function axisLetter(v: V3): "x" | "y" | "z" | null {
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const m = Math.max(...a);
  if (m < 0.95) return null;
  return a[0] === m ? "x" : a[1] === m ? "y" : "z";
}

/* ── classification ───────────────────────────────────────────────── */

/**
 * Name one connector in plain words.
 *
 * The rules are the ones lib/editor2/mates.ts already uses to decide what a
 * contact IS (fastenerContact / contactClassLabel): cross sections ("A") are
 * axles and axle holes; a short all-round r6 male is a stud and a long one a
 * pin; a square ("S") or shallow round r6 female is a stud socket; an
 * r8/r6/r8 bore is a pin hole. Anything the profile does not decide is
 * reported as unknown rather than guessed at.
 *
 * `studXZ` is the part's own stud lattice: a brick's underside carries BOTH
 * full wells under each stud and the smaller tube bores between four studs,
 * and only the position tells them apart.
 */
function classify(
  c: LocalConnector,
  ctx: { studXZ: Set<string>; hasStuds: boolean },
): { label: string; symbol: string | null } {
  const si = secInfo(c.secs);
  // The shadow library states openness explicitly: "one" = one mouth only,
  // "none" = open at both ends. Anything else is simply not stated.
  const ends = c.caps === "one" ? "blind" : c.caps === "none" ? "through" : "";
  const endTxt = ends ? `, ${ends}` : "";
  if (c.kind === "fgr") return { label: "hinge finger", symbol: null };
  if (c.kind === "clp") return { label: "clip", symbol: null };
  // LDCad's "gen" is the catch-all mount: wheel↔tyre, ball joints, minifig
  // parts. It only ever mates with a gen of the other gender.
  if (c.kind === "gen" || c.kind === "sph")
    return { label: `generic mount (wheel/tyre or ball joint), ${c.gender === "M" ? "male" : "female"}`, symbol: null };
  if (c.kind !== "cyl") return { label: `unknown (kind "${c.kind}")`, symbol: null };

  if (si.hasAxle) {
    if (c.gender === "M") return { label: `axle (cross shaft, ${si.total} LDU)`, symbol: "═" };
    return { label: `axle hole (cross${endTxt})`, symbol: "+" };
  }

  if (c.gender === "M") {
    const r = si.first?.rad ?? c.radius ?? 0;
    if (si.roundOnly && si.rads.some(isR6) && si.total <= 10) return { label: "stud", symbol: "O" };
    if (si.rads.some(isR6) && si.total > 10) return { label: `pin (${si.total} LDU)`, symbol: "•" };
    if (r <= 4.5) {
      // A plate's underside cylinder is authored as a short r4 male; a bar,
      // and the r4 pins of a wheel holder, are longer.
      if (si.total <= 6) return { label: "tube (underside cylinder)", symbol: "⊙" };
      return { label: `bar/pin shaft (r${r}, ${si.total} LDU)`, symbol: null };
    }
    return { label: `unknown (male cyl, profile "${c.secs ?? "none"}")`, symbol: null };
  }

  if (c.gender === "F") {
    const first = si.first;
    // r8 collar seat + r6 bore = the Technic pin hole.
    if (first && first.rad >= 7.5 && si.rads.some(isR6))
      return { label: `pin hole (round${endTxt})`, symbol: "@" };
    if (si.hasSquare && si.rads.some(isR6)) return { label: "stud socket", symbol: "o" };
    if (first && isR6(first.rad)) {
      // A bore open at BOTH ends is a hole, not a pocket: it takes a stud or
      // a pin from either side (the round holes in an old 24t gear).
      if (ends === "through") return { label: "round hole (r6, through — takes a stud or a pin)", symbol: "@" };
      const key = `${Math.round(c.local[0])},${Math.round(c.local[2])}`;
      if (ctx.hasStuds && !ctx.studXZ.has(key)) return { label: "tube (bore)", symbol: "⊙" };
      return { label: si.total > 8 ? "stud socket (deep well)" : "stud socket", symbol: "o" };
    }
    if (first && first.rad <= 4.5)
      return { label: `bar/pin socket (r${first.rad}${endTxt})`, symbol: null };
    return { label: `unknown (female cyl, profile "${c.secs ?? "none"}")`, symbol: null };
  }
  return { label: `unknown (no gender, profile "${c.secs ?? "none"}")`, symbol: null };
}

/** Every connector of a part, named, faced and axis-worded. */
export function describeConnectors(part: string): ConnDoc[] {
  const cs = expandedConnectors(part, getConnections());
  const studXZ = new Set<string>();
  for (const c of cs) {
    if (c.kind !== "cyl" || c.gender !== "M") continue;
    const si = secInfo(c.secs);
    if (si.roundOnly && si.rads.some(isR6) && si.total <= 10)
      studXZ.add(`${Math.round(c.local[0])},${Math.round(c.local[2])}`);
  }
  const ctx = { studXZ, hasStuds: studXZ.size > 0 };

  const docs: ConnDoc[] = cs.map((c, idx) => {
    const axis = mul9(c.ori ?? IDENT9, [0, 1, 0]);
    const n = Math.hypot(...axis) || 1;
    const a: V3 = [axis[0] / n, axis[1] / n, axis[2] / n];
    // Males protrude AGAINST their authored axis (a stud's axis points into
    // the brick); females open along it.
    const outward: V3 = c.gender === "M" ? [-a[0], -a[1], -a[2]] : a;
    const through = c.caps === "none";
    const { label, symbol } = classify(c, ctx);
    const letter = axisLetter(a);
    let face: Face;
    // A bore along y is drawn on the face it opens onto; a bore along x or z
    // belongs to the side PAIR it runs between, not to one of them.
    if (through && (letter === "x" || letter === "z")) face = letter === "x" ? "sideX" : "sideZ";
    else {
      const w = dirWord(outward);
      face = w === "up (−y)" ? "top" : w === "down (+y)" ? "bottom"
        : w === "+x" || w === "−x" ? "sideX"
        : w === "+z" || w === "−z" ? "sideZ" : "angled";
    }
    const dw = dirWord(outward);
    // Hinges, clips and balls have no mouth: their axis is the axis they turn
    // about, so saying "opens −x" would be a lie.
    const pivot = c.kind === "fgr" || c.kind === "clp" || c.kind === "gen" || c.kind === "sph";
    const axisWords = pivot
      ? `axis along ${letter ?? a.map((v) => Math.round(v * 100) / 100).join(", ")}`
      : through
        ? `through, along ${letter ?? "an off-axis direction"}`
        : dw
          ? `${c.gender === "M" ? "points" : "opens"} ${dw}`
          : `off-axis (${a.map((v) => Math.round(v * 100) / 100).join(", ")})`;
    return { i: idx + 1, c, label, symbol, face, axis: a, outward, through, axisWords };
  });

  // A hollow stud is a stud with an r4 bore down its middle: the male stud
  // and the female bore are two connectors at the same x/z on the same face.
  for (const d of docs) {
    if (d.label !== "stud") continue;
    const bore = docs.find(
      (o) =>
        o !== d &&
        o.c.gender === "F" &&
        (secInfo(o.c.secs).first?.rad ?? 9) <= 4.5 &&
        Math.abs(o.c.local[0] - d.c.local[0]) < 0.6 &&
        Math.abs(o.c.local[2] - d.c.local[2]) < 0.6 &&
        Math.abs(o.c.local[1] - d.c.local[1]) <= 6,
    );
    if (bore) {
      d.label = "hollow stud";
      d.symbol = "Ø";
      bore.partOf = d.i;
      bore.symbol = null;
      bore.label = `bore of hollow stud C${d.i} (takes a bar)`;
    }
  }
  return docs;
}

/* ── grouping ─────────────────────────────────────────────────────── */

const num = (v: number) => (Math.round(v * 10) / 10).toString();

/** "C1–C8" / "C1, C4, C9" — index sets, compactly. */
function rangeText(idx: number[]): string {
  const s = [...idx].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j - i >= 1 ? `C${s[i]}–C${s[j]}` : `C${s[i]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** Is a set of (u,v) points a full n×m lattice? Returns "4x2 @ 20 LDU". */
function latticeText(pts: [number, number][]): string | null {
  if (pts.length < 2) return null;
  const us = [...new Set(pts.map((p) => Math.round(p[0] * 10) / 10))].sort((a, b) => a - b);
  const vs = [...new Set(pts.map((p) => Math.round(p[1] * 10) / 10))].sort((a, b) => a - b);
  if (us.length * vs.length !== pts.length) return null;
  const pitch = (arr: number[]): number | null => {
    if (arr.length < 2) return null;
    const p = arr[1] - arr[0];
    for (let i = 2; i < arr.length; i++) if (Math.abs(arr[i] - arr[i - 1] - p) > 0.05) return null;
    return p;
  };
  const pu = pitch(us);
  const pv = pitch(vs);
  if (us.length > 1 && pu === null) return null;
  if (vs.length > 1 && pv === null) return null;
  const pitchTxt = [pu, pv].filter((p): p is number => p !== null).map(num);
  return `${us.length}x${vs.length} grid${pitchTxt.length ? ` @ ${[...new Set(pitchTxt)].join("/")} LDU` : ""}`;
}

/** "at y=24" — the constant coordinate a whole face group shares, if any. */
function planeText(face: Face, docs: ConnDoc[]): string | null {
  const axis: 0 | 1 | 2 = face === "top" || face === "bottom" ? 1 : face === "sideX" ? 0 : 2;
  const vals = [...new Set(docs.map((d) => Math.round(d.c.local[axis] * 10) / 10))];
  if (vals.length !== 1) return null;
  return `at ${"xyz"[axis]}=${num(vals[0])}`;
}

interface Group {
  face: Face;
  label: string;
  docs: ConnDoc[];
}

function groupOf(docs: ConnDoc[]): Group[] {
  const map = new Map<string, Group>();
  for (const d of docs) {
    const key = `${d.face}|${d.label}|${d.c.secs ?? ""}|${d.axisWords}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { face: d.face, label: d.label, docs: [] }));
    g.docs.push(d);
  }
  return [...map.values()];
}

const FACE_TITLE: Record<Face, string> = {
  top: "TOP",
  bottom: "BOTTOM",
  sideX: "SIDES ±x",
  sideZ: "SIDES ±z",
  angled: "ANGLED / not on a flat face",
};

/* ── ASCII maps ───────────────────────────────────────────────────── */

const COL_LDU = 10; // ½ stud per column
const ROW_LDU_Y = 4; // ½ plate per row on side views
const MAX_COLS = 32; // 16 studs

/** Map axes for a face: which local coordinate runs right, which runs down. */
function mapAxes(face: Face): { u: 0 | 1 | 2; v: 0 | 1 | 2; uName: string; vName: string; vLdu: number } | null {
  if (face === "top" || face === "bottom") return { u: 0, v: 2, uName: "x", vName: "z", vLdu: COL_LDU };
  if (face === "sideX") return { u: 2, v: 1, uName: "z", vName: "y", vLdu: ROW_LDU_Y };
  if (face === "sideZ") return { u: 0, v: 1, uName: "x", vName: "y", vLdu: ROW_LDU_Y };
  return null;
}

function faceMap(face: Face, docs: ConnDoc[]): string[] {
  const ax = mapAxes(face);
  const drawn = docs.filter((d) => d.symbol);
  if (!ax || !drawn.length) return [];
  const uOf = (d: ConnDoc) => d.c.local[ax.u];
  const vOf = (d: ConnDoc) => d.c.local[ax.v];
  const uMin = Math.min(...drawn.map(uOf));
  const uMax = Math.max(...drawn.map(uOf));
  const vMin = Math.min(...drawn.map(vOf));
  const vMax = Math.max(...drawn.map(vOf));
  const nCols = Math.round((uMax - uMin) / COL_LDU) + 1;
  const nRows = Math.round((vMax - vMin) / ax.vLdu) + 1;
  const note =
    face === "top" || face === "bottom"
      ? `${ax.uName} → right, ${ax.vName} ↓ · 1 col = ${COL_LDU} LDU (½ stud)`
      : `${ax.uName} → right, ${ax.vName} ↓ (y is DOWN) · 1 col = ${COL_LDU} LDU, 1 row = ${ax.vLdu} LDU`;
  if (nCols > MAX_COLS || nRows > MAX_COLS) {
    const summary = groupOf(drawn)
      .map((g) => `${g.docs.length}× ${g.label}${latticeText(g.docs.map((d) => [uOf(d), vOf(d)])) ? ` (${latticeText(g.docs.map((d) => [uOf(d), vOf(d)]))})` : ""}`)
      .join(", ");
    return [
      `${FACE_TITLE[face]}  (${note})`,
      `  map suppressed: ${nCols}x${nRows} cells (> ${MAX_COLS}). ${summary}.`,
    ];
  }
  const cells: (string | null)[][] = Array.from({ length: nRows }, () => Array(nCols).fill(null));
  for (const d of drawn) {
    const ci = Math.round((uOf(d) - uMin) / COL_LDU);
    const ri = Math.round((vOf(d) - vMin) / ax.vLdu);
    const txt = `${d.symbol}${d.i}`;
    cells[ri][ci] = cells[ri][ci] ? `${cells[ri][ci]}/${txt}` : txt;
  }
  const w = Math.max(4, ...cells.flat().map((c) => (c ? [...c].length + 1 : 0)));
  const pad = (s: string) => " ".repeat(Math.max(0, w - [...s].length)) + s;
  const gut = Math.max(...Array.from({ length: nRows }, (_, r) => `${ax.vName}${num(vMin + r * ax.vLdu)}`.length)) + 1;
  const out = [`${FACE_TITLE[face]}  (${note})`];
  out.push(
    " ".repeat(gut) + Array.from({ length: nCols }, (_, c) => pad(num(uMin + c * COL_LDU))).join(""),
  );
  for (let r = 0; r < nRows; r++) {
    const lbl = `${ax.vName}${num(vMin + r * ax.vLdu)}`;
    out.push(
      lbl + " ".repeat(gut - lbl.length) + cells[r].map((c) => pad(c ?? "·")).join(""),
    );
  }
  return out;
}

const LEGEND: [string, string][] = [
  ["O", "stud"],
  ["o", "stud socket"],
  ["⊙", "tube"],
  ["Ø", "hollow stud"],
  ["@", "pin hole"],
  ["+", "axle hole"],
  ["═", "axle"],
  ["•", "pin"],
];

/* ── the reports ──────────────────────────────────────────────────── */

/** Catalogue name. LDraw numbers a few parts without a variant letter
 * (3648) where the catalogue only has 3648a/3648b — say which row was used. */
export function partName(part: string): string {
  const idx = getPartIndex();
  const exact = idx.find((r) => r.p === part);
  if (exact) return exact.n;
  const variant = idx.find((r) => r.p.length === part.length + 1 && r.p.startsWith(part) && /[a-z]$/.test(r.p));
  if (variant) return `${variant.n}  (catalogue entry ${variant.p})`;
  return "(not in the part index)";
}

function header(part: string, meta: PartMetaMap, nConn: number, hasStuds: boolean): string[] {
  const m = meta[part];
  const lines = [`${part}  ${partName(part)}`];
  if (m) {
    lines.push(
      `size ${m.w} x ${m.l} studs · ${m.w * 20} x ${m.l * 20} x ${m.h} LDU (x by z by height)` +
        (m.grid ? "" : " · off the stud grid"),
    );
    if (m.ox || m.oz) lines.push(`footprint centre sits ${num(m.ox)},${num(m.oz)} LDU from the origin (x,z)`);
  } else lines.push("size unknown — no measured metadata for this part");
  lines.push(
    `origin: centre of the TOP face. +y is DOWN, so the body runs y 0 → +${m?.h ?? 24}` +
      `${hasStuds ? " and studs rise to y −4" : ""}. Positions below are part-local LDU.`,
  );
  lines.push(`${nConn} connector${nConn === 1 ? "" : "s"}`);
  return lines;
}

/** `./dbb connectors <part>` — grouped list + face maps. */
export function connectorsReport(part: string, meta: PartMetaMap): string {
  const docs = describeConnectors(part);
  if (!docs.length) return `no connector data for ${part} — ${partName(part)}`;
  const out = header(part, meta, docs.length, docs.some((d) => d.face === "top" && /stud/.test(d.label)));

  out.push("", "CONNECTORS");
  const faces: Face[] = ["top", "bottom", "sideX", "sideZ", "angled"];
  for (const f of faces) {
    const gs = groupOf(docs.filter((d) => d.face === f));
    if (!gs.length) continue;
    out.push(`  ${FACE_TITLE[f]}`);
    for (const g of gs.sort((a, b) => b.docs.length - a.docs.length)) {
      const ax = mapAxes(f);
      const lat = ax ? latticeText(g.docs.map((d) => [d.c.local[ax.u], d.c.local[ax.v]])) : null;
      const plane = planeText(f, g.docs);
      const where =
        g.docs.length === 1
          ? `at ${g.docs[0].c.local.map(num).join(",")}`
          : `${lat ?? `${g.docs.length} positions`}${plane ? ` ${plane}` : ""}`;
      out.push(
        `    ${rangeText(g.docs.map((d) => d.i)).padEnd(16)} ${g.docs.length}× ${g.label} · ${where} · ${g.docs[0].axisWords}`,
      );
    }
  }

  const maps: string[] = [];
  for (const f of ["top", "bottom", "sideX", "sideZ"] as Face[]) {
    const m = faceMap(f, docs.filter((d) => d.face === f));
    if (m.length) maps.push(...m, "");
  }
  if (maps.length) {
    out.push("", "MAPS  (cell = symbol + C-number; · = nothing)");
    const used = new Set(docs.filter((d) => d.symbol).map((d) => d.symbol));
    out.push("  " + LEGEND.filter(([s]) => used.has(s)).map(([s, n]) => `${s} ${n}`).join("   "));
    out.push("");
    out.push(...maps.map((l) => (l ? `  ${l}` : "")));
  }

  const undrawn = docs.filter((d) => !d.symbol && !d.partOf);
  if (undrawn.length) {
    if (out[out.length - 1] !== "") out.push("");
    out.push("NOT DRAWN ON THE MAPS (no symbol of their own: bars, clips, hinges, balls, angled features):");
    for (const d of undrawn.slice(0, 24))
      out.push(`  C${d.i} ${d.label} at ${d.c.local.map(num).join(",")} · ${d.axisWords}`);
    if (undrawn.length > 24) out.push(`  … ${undrawn.length - 24} more (use --all)`);
  }
  out.push("", "`./dbb connectors <part> --all` prints the flat per-connector table.");
  return out.join("\n");
}

/** The old flat table, with the axis actually computed (it used to print "?"). */
export function connectorsFlat(part: string): string {
  const docs = describeConnectors(part);
  if (!docs.length) return `no connector data for ${part}`;
  return docs
    .map(
      (d) =>
        `C${d.i}\t${d.label}\t${d.c.kind}\t${d.c.gender ?? "-"}\tpos ${d.c.local.map(num).join(",")}` +
        `\taxis ${d.axis.map((v) => Math.round(v * 100) / 100).join(",")}\t${d.axisWords}` +
        `\tsecs "${d.c.secs ?? "-"}"${d.c.caps ? ` caps=${d.c.caps}` : ""}${d.c.ctr ? " centred" : ""}`,
    )
    .join("\n");
}

/* ── shape notes that decide which statement to use ───────────────── */

export interface ShapeNotes {
  /** Distinct heights of downward-opening stud sockets (a stepped underside). */
  socketYs: number[];
  hasTopStuds: boolean;
  hasBottomSockets: boolean;
  notes: string[];
}

export function shapeNotes(part: string, meta: PartMetaMap): ShapeNotes {
  const docs = describeConnectors(part);
  // Only the SOCKETS decide whether the underside is one plane: a tube sits
  // proud of it by design and says nothing about how the part seats.
  const sockets = docs.filter((d) => d.face === "bottom" && d.label.startsWith("stud socket"));
  const underside = docs.filter((d) => d.face === "bottom");
  const socketYs = [...new Set(sockets.map((d) => Math.round(d.c.local[1])))].sort((a, b) => a - b);
  const hasTopStuds = docs.some((d) => d.face === "top" && /^(stud|hollow stud)$/.test(d.label));
  const notes: string[] = [];
  if (socketYs.length > 1)
    notes.push(
      `stepped underside: stud sockets at y=${socketYs.join(" and y=")} — the bottom is not one flat plane, ` +
        `so \`on\` cannot seat it flat. Use \`seat <name> ${part} <colour> onto <base>\` and pick an option.`,
    );
  if (!hasTopStuds)
    notes.push(`no studs on the top face — nothing can be \`on\`-stacked onto ${part}; use \`attach\`/\`seat\`.`);
  if (!underside.length)
    notes.push(`no stud sockets underneath — ${part} cannot be \`on\`-stacked onto a studded part; use \`attach\`/\`seat\`.`);
  if (meta[part] && !meta[part].grid)
    notes.push(`off the stud grid (meta grid=false): \`on\` has no lattice to snap to here; prefer \`seat\`.`);
  const through = docs.filter((d) => d.through);
  if (through.length)
    notes.push(
      `${through.length} through bore${through.length === 1 ? "" : "s"}: ` +
        [...new Set(through.map((d) => `${d.label} ${d.axisWords}`))].join(", ") + ".",
    );
  return { socketYs, hasTopStuds, hasBottomSockets: sockets.length > 0, notes };
}
