/**
 * REAL connection validation (BrickLink-Studio-grade): for every placed
 * part, enumerate its individual connectors (grid specs expanded), find
 * counterpart connectors on other parts that geometrically MATE —
 * opposite gender, compatible family/radius, coincident position,
 * parallel axes. A build is valid when every part is connected through
 * real joints (or rests on the ground) and nothing interpenetrates.
 */
import { partBBox } from "./geometry";
import { ldrawFrameOf, type ConnectionMap, type Snap } from "./snapAlign";
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";

export interface WorldConnector {
  part: number; // index into parts
  snap: Snap;
  kind: string; // cyl | gen | clp | fgr | sph
  gender?: string;
  radius: number | null;
  pos: [number, number, number]; // engine frame
  axis: [number, number, number];
}

export interface Joint {
  a: number;
  b: number;
  type: string; // e.g. "stud", "pin/bar r4", "axle", "gen", "finger"
  count: number; // matched connector pairs between the two parts
}

export interface Validation {
  joints: Joint[];
  /** Parts with no real joint and not resting on the ground. */
  unconnected: number[];
  /** Parts resting on ground (bottom ≈ 0). */
  grounded: number[];
  /** Mated pairs whose section profiles DON'T fit at this pose (an
   * over-inserted pin's collar inside the bore) — pose-invalid joints. */
  profileViolations: { a: number; b: number; reason: string }[];
  /** Bore interiors of every mated female — where engagement overlap
   * (snap-fit interference) is legitimate. */
  engagementZones: EngagementZone[];
}

/** Parsed section spec: all REAL section radii (lead-in chamfers L_/_L
 * excluded — they describe insertion, not the fit) + total length. A
 * pin reads "L_ 6.25 2  R 6 16 …": its fit radii are 6 and 8, not the
 * 6.25 flare — first-radius matching rejected every pin↔pinhole pair. */
interface SecsInfo {
  rads: number[];
  total: number;
}
const SECS_CACHE = new Map<string, SecsInfo>();
function secsInfo(secs?: string): SecsInfo {
  const key = secs ?? "";
  let si = SECS_CACHE.get(key);
  if (si) return si;
  si = { rads: [], total: 0 };
  for (const m of key.matchAll(/(L_|_L|[RSA])\s+([\d.]+)\s+([\d.]+)/g)) {
    if (m[1] === "L_" || m[1] === "_L") continue;
    si.rads.push(Number(m[2]));
    si.total += Number(m[3]);
  }
  SECS_CACHE.set(key, si);
  return si;
}

/** Full section profile INCLUDING lead-ins, in listed order. Segments
 * are laid out CENTERED on the connector origin along its axis (the
 * shadow convention: a 3700 bore "R8 2 · R6 16 · R8 2" spans the
 * brick's 20-LDU width centered on the hole position). */
export interface SecSeg {
  kind: string; // R | S | A | L_ | _L
  rad: number;
  len: number;
}
const SEG_CACHE = new Map<string, SecSeg[]>();
export function secSegments(secs?: string): SecSeg[] {
  const key = secs ?? "";
  let segs = SEG_CACHE.get(key);
  if (segs) return segs;
  segs = [];
  for (const m of key.matchAll(/(L_|_L|[RSA])\s+([\d.]+)\s+([\d.]+)/g)) {
    segs.push({ kind: m[1], rad: Number(m[2]), len: Number(m[3]) });
  }
  SEG_CACHE.set(key, segs);
  return segs;
}

/** Segment band of a connector along its OWN axis, in coordinates
 * relative to its pos (positive = along +axis). LDCad convention: the
 * listed sections run from the start along the −AXIS (a stud's "R 6 4"
 * extends from its base INTO the receiving part; a pocket's "R 6 20"
 * from the mouth up into the brick). center=true shifts the band to be
 * centered on pos (pins, axles, through-bores). Returns segments as
 * [hi→lo] intervals: seg i spans [at − len, at]. */
function segmentBand(c: WorldConnector): { segs: SecSeg[]; start: number; total: number } {
  const segs = secSegments(c.snap.secs);
  const total = segs.reduce((s, x) => s + x.len, 0);
  return { segs, start: c.snap.ctr ? total / 2 : 0, total };
}

/**
 * Section-profile fit check for a mated cyl↔cyl pair: walk both radius
 * profiles along the shared axis and report any interval where the
 * MALE's section is wider than the FEMALE's bore (beyond `tol`). This
 * is what catches an IMPOSSIBLE pose — the r8 collar or the axle cross
 * dragged inside the r6 bore — even when the voxel overlap is within
 * the engagement allowance. Lead-in chamfers are treated at their
 * nominal radius (a 6.25 flare in an r6 bore is the designed click,
 * within tol).
 *
 * Returns a human-readable violation, or null when the profiles fit.
 */
export function profileViolation(male: WorldConnector, female: WorldConnector, tol = 0.7): string | null {
  const mb = segmentBand(male);
  const fb = segmentBand(female);
  if (mb.segs.length === 0 || fb.segs.length === 0) return null;
  // Express the male band in the female's axial coordinate (relative to
  // female pos, positive along female axis).
  const d = [male.pos[0] - female.pos[0], male.pos[1] - female.pos[1], male.pos[2] - female.pos[2]];
  const delta = d[0] * female.axis[0] + d[1] * female.axis[1] + d[2] * female.axis[2];
  const sign =
    male.axis[0] * female.axis[0] + male.axis[1] * female.axis[1] + male.axis[2] * female.axis[2] >= 0
      ? 1
      : -1;
  let mAt = delta + sign * mb.start;
  for (const m of mb.segs) {
    const mNext = mAt - sign * m.len;
    const m0 = Math.min(mAt, mNext);
    const m1 = Math.max(mAt, mNext);
    mAt = mNext;
    let fAt = fb.start;
    for (const f of fb.segs) {
      const f0 = fAt - f.len;
      const f1 = fAt;
      fAt = f0;
      const lo = Math.max(m0, f0);
      const hi = Math.min(m1, f1);
      if (hi - lo < 0.5) continue; // no meaningful axial overlap
      if (m.rad > f.rad + tol) {
        return `male ${m.kind === "A" ? "axle " : ""}r${m.rad} section inside female r${f.rad} bore`;
      }
      // Section KIND compatibility: a cross-shaped hole (A) passes only
      // axle cross sections and thin bars — a ROUND r6 shaft cannot
      // enter the + opening even though the nominal radii match.
      if (f.kind === "A" && m.kind !== "A" && m.rad > 4.6) {
        return `male round r${m.rad} section inside female axle (cross) hole`;
      }
    }
  }
  return null;
}

/** Engagement zone of a mated female: a world-space cylinder covering
 * her bore interior (span along her axis + bore radius, small margins).
 * Voxel overlap INSIDE a mated zone is snap-fit engagement (ridges,
 * flares); overlap outside every zone is a genuine collision. */
export interface EngagementZone {
  a: number;
  b: number;
  pos: [number, number, number];
  axis: [number, number, number];
  /** axial span relative to pos (lo ≤ hi, along +axis), margined. */
  lo: number;
  hi: number;
  radial: number;
}

/** First numeric radius in a secs spec ("R 6 4" → 6, "A 6 60" → 6). */
function radiusOf(secs?: string): number | null {
  const m = secs?.match(/[RSA_L]+\s+([\d.]+)/);
  return m ? Number(m[1]) : null;
}

/** Expand a snap's grid spec into individual connector offsets (snap-local). */
function gridOffsets(grid?: string): [number, number][] {
  if (!grid) return [[0, 0]];
  const tok = grid.trim().split(/\s+/);
  let i = 0;
  const readDim = (): { n: number; centered: boolean } => {
    let centered = false;
    if (tok[i] === "C") {
      centered = true;
      i++;
    }
    return { n: Number(tok[i++]), centered };
  };
  const dx1 = readDim();
  const dz1 = readDim();
  const sx = Number(tok[i++]);
  const sz = Number(tok[i++]);
  if (!Number.isFinite(dx1.n) || !Number.isFinite(dz1.n)) return [[0, 0]];
  const out: [number, number][] = [];
  for (let ax = 0; ax < dx1.n; ax++) {
    for (let az = 0; az < dz1.n; az++) {
      const ox = dx1.centered ? (ax - (dx1.n - 1) / 2) * sx : ax * sx;
      const oz = dz1.centered ? (az - (dz1.n - 1) / 2) * sz : az * sz;
      out.push([ox, oz]);
    }
  }
  return out;
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mulMV = (m: number[], v: [number, number, number]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export interface LocalConnector {
  kind: string;
  gender?: string;
  radius: number | null;
  secs?: string;
  ori?: number[];
  /** Caps spec — "one" = blind hole (enter through the mouth only). */
  caps?: string;
  /** Section profile centered on pos (else it runs from pos, −axis). */
  ctr?: 1;
  /** Part-local LDraw position (grid offset applied). */
  local: [number, number, number];
}

/** All individual connectors of a PART (grids expanded), part-local. */
export function expandedConnectors(part: string, conns: ConnectionMap): LocalConnector[] {
  const out: LocalConnector[] = [];
  const seen = new Set<string>();
  for (const s of conns[part] ?? []) {
    const ori = s.ori ?? IDENT;
    for (const [ox, oz] of gridOffsets(s.grid)) {
      const off = mulMV(ori, [ox, 0, oz]);
      const local: [number, number, number] = [
        s.pos[0] + off[0],
        s.pos[1] + off[1],
        s.pos[2] + off[2],
      ];
      // Orientation is part of identity: a universal-joint cross has TWO
      // perpendicular bars at the same origin — key on the axis line too
      // (canonical sign so +v/−v, the same line, still dedupe).
      const axis = mulMV(ori, [0, 1, 0]);
      const flip =
        axis[0] < -1e-6 ||
        (Math.abs(axis[0]) <= 1e-6 && (axis[1] < -1e-6 || (Math.abs(axis[1]) <= 1e-6 && axis[2] < 0)));
      const ax = (flip ? axis.map((v) => -v) : axis).map((v) => Math.round(v * 100) / 100).join(",");
      const key = `${s.t}/${s.g ?? ""}/${radiusOf(s.secs) ?? ""}@${local.map((v) => Math.round(v * 2) / 2).join(",")}|${ax}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: s.t,
        gender: s.g,
        radius: radiusOf(s.secs),
        secs: s.secs,
        ori: s.ori,
        caps: s.c,
        ctr: s.ctr,
        local,
      });
      // Guard against a pathological grid, NOT a real part: a 16x16
      // baseplate genuinely carries ~256 connectors and a 2x16 plate 32
      // studs. Truncating at 64 silently deleted the rest, so anything
      // seated beyond the 64th stud could never mate — 8,433 of the
      // World Map's 10,759 parts read as connected to nothing, and every
      // large part (wide plates, long beams, panels) led the gap list.
      if (out.length >= 1024) return out;
    }
  }
  return out;
}

/** A LocalConnector as a solver Snap (individual position, no grid). */
export const connectorAsSnap = (c: LocalConnector): Snap => ({
  t: c.kind,
  g: c.gender,
  pos: c.local,
  ori: c.ori,
  secs: c.secs,
  c: c.caps,
});

/** All individual world-space connectors of a placement (grids expanded). */
export function worldConnectors(
  parts: PlacedPartJson[],
  index: number,
  conns: ConnectionMap,
  hOf: (part: string) => number,
): WorldConnector[] {
  const p = parts[index];
  const snaps = conns[p.part] ?? [];
  const f = ldrawFrameOf(p, hOf);
  const out: WorldConnector[] = [];
  const seen = new Set<string>();
  for (const s of snaps) {
    const ori = s.ori ?? IDENT;
    const axisL = mulMV(ori, [0, 1, 0]);
    for (const [ox, oz] of gridOffsets(s.grid)) {
      // Grid offsets live in the snap's local frame (x/z ⊥ axis).
      const off = mulMV(ori, [ox, 0, oz]);
      const local: [number, number, number] = [s.pos[0] + off[0], s.pos[1] + off[1], s.pos[2] + off[2]];
      const w = mulMV(f.r, local);
      const wa = mulMV(f.r, axisL);
      const n = Math.hypot(wa[0], wa[1], wa[2]) || 1;
      const pos: [number, number, number] = [
        f.o[0] + w[0],
        -(f.o[1] + w[1]),
        -(f.o[2] + w[2]),
      ];
      const axis: [number, number, number] = [wa[0] / n, -wa[1] / n, -wa[2] / n];
      // Duplicate connectors (donor inheritance repeats) collapse here.
      const key = `${s.t}/${s.g ?? ""}/${radiusOf(s.secs) ?? ""}@${pos.map((v) => Math.round(v * 2) / 2).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        part: index,
        snap: s,
        kind: s.t,
        gender: s.g,
        radius: radiusOf(s.secs),
        pos,
        axis,
      });
    }
  }
  return out;
}

/** Do two world connectors form a real joint? Cylindrical joints engage
 * over a RANGE along the axis (a pin slides into a bore) — so the test is
 * tight radially and loose axially; studs seat flush (small axial tol). */
function mates(a: WorldConnector, b: WorldConnector): string | null {
  const sdot = a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2];
  const dot = Math.abs(sdot);
  if (dot < 0.99) return null;
  // A BLIND FEMALE (shadow caps=one: underside pockets, tube mouths)
  // accepts a male only through its open mouth — the axes must agree in
  // SIGN. An upside-down stud whose frame merely coincides is anti-
  // aligned: a sham, not an insertion. Only SHORT females (≤8 LDU) are
  // gated: deep round bores are physically through in LEGO, but the
  // shadow marks some (10247's pin hole) caps=one anyway — trusting
  // that would ban one insertion side of every such pin hole.
  if (a.kind === "cyl" && b.kind === "cyl" && sdot < 0.99) {
    const fem = a.gender === "F" ? a : b.gender === "F" ? b : null;
    const male = fem === a ? b : a;
    if (
      fem?.snap.c === "one" &&
      secsInfo(fem.snap.secs).total <= 8 &&
      secsInfo(male.snap.secs).total <= 10
    )
      return null;
  }
  const dv = [a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]];
  const axial = Math.abs(dv[0] * a.axis[0] + dv[1] * a.axis[1] + dv[2] * a.axis[2]);
  const radial = Math.sqrt(Math.max(0, dv[0] ** 2 + dv[1] ** 2 + dv[2] ** 2 - axial ** 2));
  if (radial > 1.5) return null;
  const sa = secsInfo(a.snap.secs);
  const sb = secsInfo(b.snap.secs);
  const slidingKinds =
    (a.kind === "cyl" || a.kind === "clp") && (b.kind === "cyl" || b.kind === "clp");
  const smallCyl = (a.radius ?? b.radius ?? 6) <= 4.5;
  // LONG round bodies (pins, axles, bars ≥12 LDU of sections) engage any
  // bore whose SPAN overlaps theirs along the shared axis — a pin seated
  // one stud deep has its center 10 LDU from the hole center.
  const longBody = sa.total >= 12 || sb.total >= 12;
  const axialTol =
    a.kind === "gen" || b.kind === "gen"
      ? 3
      : slidingKinds && longBody
        ? Math.max(4, sa.total / 2 + sb.total / 2 - 2)
        : slidingKinds && smallCyl
          ? 20
          : 4;
  if (axial > axialTol) return null;

  // clip ↔ bar (cyl M r4)
  if (
    (a.kind === "clp" && b.kind === "cyl" && b.gender === "M" && (b.radius ?? 0) <= 4.5) ||
    (b.kind === "clp" && a.kind === "cyl" && a.gender === "M" && (a.radius ?? 0) <= 4.5)
  ) {
    return "clip/bar";
  }
  if (a.kind !== b.kind) return null;
  if (a.kind === "fgr") return "finger-hinge";
  if (a.kind === "gen") {
    return a.gender && b.gender && a.gender !== b.gender ? "gen" : null;
  }
  if (a.kind === "cyl" || a.kind === "sph") {
    if (!a.gender || !b.gender || a.gender === b.gender) return null;
    // Radius compatibility: ANY section of one within tolerance of ANY
    // section of the other — a pin's r6 shaft meets a pinhole's r6 bore
    // even though both START with a different profile (6.25 lead-in /
    // r8 collar recess). Fall back to the single radius when secs are
    // absent.
    let r: number | null = a.radius ?? b.radius;
    if (sa.rads.length && sb.rads.length) {
      let best: number | null = null;
      for (const r1 of sa.rads)
        for (const r2 of sb.rads)
          if (Math.abs(r1 - r2) <= 0.75 && (best === null || r1 < best)) best = r1;
      if (best === null) return null;
      r = best;
    } else if (a.radius !== null && b.radius !== null && Math.abs(a.radius - b.radius) > 0.75) {
      return null;
    }
    if (r !== null && r >= 5.5) return "stud";
    const secs = `${a.snap.secs ?? ""} ${b.snap.secs ?? ""}`;
    if (secs.includes("A ")) return "axle";
    return "pin/bar";
  }
  return null;
}

/** Build the joint graph + connectivity validation. */
export function validateConnections(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  conns: ConnectionMap,
): Validation {
  const hOf = (part: string) => meta[part]?.h ?? 24;
  const connectors = parts.map((_, i) => worldConnectors(parts, i, conns, hOf));
  const boxes = parts.map((p) => (meta[p.part] ? partBBox(p, meta) : null));

  const jointMap = new Map<string, Joint>();
  const violationMap = new Map<string, { a: number; b: number; reason: string }>();
  const zones: EngagementZone[] = [];
  for (let i = 0; i < parts.length; i++) {
    const A = boxes[i];
    if (!A) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const B = boxes[j];
      if (!B) continue;
      const near =
        A[0] < B[1] + 2 && A[1] > B[0] - 2 &&
        A[2] < B[3] + 2 && A[3] > B[2] - 2 &&
        A[4] < B[5] + 2 && A[5] > B[4] - 2;
      if (!near) continue;
      for (const ca of connectors[i]) {
        for (const cb of connectors[j]) {
          const type = mates(ca, cb);
          if (!type) continue;
          const key = `${i}/${j}/${type}`;
          const joint = jointMap.get(key);
          if (joint) joint.count++;
          else jointMap.set(key, { a: i, b: j, type, count: 1 });
          // Pose validity of the mated pair: section profiles must fit.
          if (ca.kind === "cyl" && cb.kind === "cyl" && ca.gender !== cb.gender) {
            const male = ca.gender === "M" ? ca : cb;
            const female = male === ca ? cb : ca;
            const v = profileViolation(male, female);
            if (v && !violationMap.has(`${i}/${j}`)) violationMap.set(`${i}/${j}`, { a: i, b: j, reason: v });
            // Record the female's bore interior as a legit-overlap zone.
            const fb = segmentBand(female);
            const rad = Math.max(...secsInfo(female.snap.secs).rads, female.radius ?? 6);
            // Axial margins tight (0.75): a wider margin excused a
            // flange sinking past the bore mouth as "engagement".
            zones.push({
              a: i,
              b: j,
              pos: female.pos,
              axis: female.axis,
              lo: fb.start - fb.total - 0.75,
              hi: fb.start + 0.75,
              radial: rad + 1.5,
            });
          }
        }
      }
    }
  }

  const joints = [...jointMap.values()];
  const connected = new Set<number>();
  for (const jt of joints) {
    connected.add(jt.a);
    connected.add(jt.b);
  }
  const grounded: number[] = [];
  const unconnected: number[] = [];
  parts.forEach((p, i) => {
    const box = boxes[i];
    const onGround = box !== null && box[2] < 0.6;
    if (onGround) grounded.push(i);
    if (!connected.has(i) && !onGround) unconnected.push(i);
  });

  return {
    joints,
    unconnected,
    grounded,
    profileViolations: [...violationMap.values()],
    engagementZones: zones,
  };
}
