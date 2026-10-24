/**
 * The referee: LDraw text (+ optional task) → Verdict.
 *
 * Ladder (every rung runs when it can; the headline booleans AND them):
 *   parse        the file yields parts; every part is a known library part
 *   geometry     no interpenetration at rest (voxel, joint-aware)
 *   connectivity every part is mated into ONE assembly; something touches the ground
 *   stability    stability-lite: no topple, no unsupported cantilever
 *   mechanism    bodies / bearings / gears / meshes; free arcs measured by sweep
 *   actuation    every gear train drives a full turn without jamming
 *   task         postconditions of the task spec
 */
import { fromLdr } from "@/lib/ldraw/serialize";
import { extentOfParts } from "../engine/footprint";
import { validateConnections } from "@/lib/engine/connectionGraph";
import { checkCollisionsValidated, worldCells } from "@/lib/engine/voxelCollision";
import { checkStability } from "@/lib/engine/stability";
import { analyzeMechanism, applySweeps, deepOverlap, detectMatesFor, nearMissConnectorsAll, runSweeps, touchesAny, type MechanismOpts, type NearMiss } from "./mechanism";
import type { GraderData } from "./data";
import type { Box3, Finding, MechanismInfo, Rung, RungId, TaskSpec, Verdict } from "./types";
import { FALLBACK_META } from "@/lib/engine/types";
import { bomF1, poseMatch } from "./reference";

/**
 * Collision thresholds on DEEP overlap (interior cells shared by both
 * parts, LDU³ at 1 LDU voxels) — the voxel skin drops out of this metric,
 * so it separates "touching" from "inside each other" far better than raw
 * shared volume. Calibrated on physical sets: clean sets (850, 950, 41627,
 * 40199) stay ≤ 26; ground-truth files with known modelling errors reach
 * 60–75 on ridged pins; a plate 8 LDU off its studs gives 190–220, a plate
 * 4 LDU sunk gives 240–320, an axle through a solid brick 375.
 */
export const DEEP_STRANGER_FAIL = 80;
export const DEEP_MATED_FAIL = 120;
export const DEEP_WARN = 27;

export interface GradeOpts extends MechanismOpts {
  source?: string;
  /** edit tasks: the seed model (LDraw text) the build started from */
  seedLdraw?: string;
  /** completion tasks: the gold (full) model (LDraw text) */
  goldLdraw?: string;
  /** cap on parts (huge files) — beyond this the grader refuses rather than lies */
  maxParts?: number;
  /**
   * Sweep results measured earlier on the SAME parts: joint arcs and gear-train
   * sweeps are copied in rather than measured again (they are 99 % of a big set's
   * grading time), so a model can be re-scored against changed postconditions in
   * seconds. Ignored — and the sweeps run normally — unless the cached mechanism
   * matches this one bearing for bearing. Never set by the run/grade pipeline.
   */
  reuseSweeps?: MechanismInfo;
}

type V3 = [number, number, number];
const inBox = (v: V3, b: Box3) =>
  (!b.x || (v[0] >= b.x[0] && v[0] <= b.x[1])) && (!b.y || (v[1] >= b.y[0] && v[1] <= b.y[1])) && (!b.z || (v[2] >= b.z[0] && v[2] <= b.z[1]));
const boxStr = (b: Box3) => `{${(["x", "y", "z"] as const).filter((k) => b[k]).map((k) => `${k} ${b[k]![0]}..${b[k]![1]}`).join(", ") || "anywhere"}}`;

/**
 * The task rung's size measure: height (LDU, from the ground plane) and the
 * footprint (studs, x by z) of the parts' nominal w × l boxes around their
 * origins. Coarse (rotation-blind), but it is the one every size check uses.
 */
export function extentOf(parts: { part: string; x: number; y: number; z: number; rot?: number; m?: number[] }[], meta: GraderData["meta"]): { height: number; footprint: [number, number] } {
  const e = extentOfParts(parts as Parameters<typeof extentOfParts>[0], meta);
  return { height: e.height, footprint: e.footprint };
}

export function gradeLdraw(ldraw: string, data: GraderData, task?: TaskSpec, opts: GradeOpts = {}): Verdict {
  const T0 = Date.now();
  const { meta, conns, vox, nameOf, prims } = data;
  const rungs: Rung[] = [];
  const run = (id: RungId, fn: (f: Finding[]) => "pass" | "fail" | "skip") => {
    const t = Date.now();
    const findings: Finding[] = [];
    let status: Rung["status"];
    try {
      status = fn(findings);
    } catch (e) {
      findings.push({ severity: "fail", code: "grader-error", msg: `${id}: ${e instanceof Error ? e.message : e}` });
      status = "fail";
    }
    if (status === "pass" && findings.some((f) => f.severity === "fail")) status = "fail";
    rungs.push({ id, status, ms: Date.now() - t, findings });
    return status;
  };

  // Declared before any early exit: finish() reads it (a parse failure used to
  // hit the temporal dead zone and crash the grader instead of reporting).
  let mech: ReturnType<typeof analyzeMechanism> | null = null;

  // ── parse ──────────────────────────────────────────────────────
  let parts = [] as ReturnType<typeof fromLdr>["parts"];
  run("parse", (f) => {
    const imp = fromLdr(ldraw, meta);
    parts = imp.parts;
    if (!parts.length) {
      f.push({ severity: "fail", code: "empty", msg: "no part lines (type 1) found" });
      return "fail";
    }
    if (opts.maxParts && parts.length > opts.maxParts) {
      f.push({ severity: "fail", code: "too-large", msg: `${parts.length} parts exceeds the grader cap of ${opts.maxParts}` });
      return "fail";
    }
    const primIdx = parts.map((p, i) => (!meta[p.part] && prims.has(p.part.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
    const unknown = parts.map((p, i) => (meta[p.part] || prims.has(p.part.toLowerCase()) ? -1 : i)).filter((i) => i >= 0);
    if (primIdx.length)
      f.push({ severity: "warn", code: "primitive-as-part", msg: `${primIdx.length} line(s) place bare LDraw primitives (${[...new Set(primIdx.map((i) => parts[i].part))].slice(0, 5).join(", ")}) — flex hoses/cables drawn by hand; not gradeable, ignored`, parts: primIdx.slice(0, 50) });
    if (primIdx.length) parts = parts.filter((_, i) => !primIdx.includes(i));
    if (unknown.length)
      f.push({ severity: "fail", code: "unknown-part", msg: `${unknown.length} part(s) are not in the library: ${[...new Set(unknown.map((i) => parts[i].part))].slice(0, 8).join(", ")}`, parts: unknown.slice(0, 50) });
    const noConn = parts.map((p, i) => (conns[p.part] ? -1 : i)).filter((i) => i >= 0);
    if (noConn.length)
      f.push({ severity: "warn", code: "no-connector-data", msg: `${noConn.length} part(s) have no connector data — their mates cannot be checked: ${[...new Set(noConn.map((i) => parts[i].part))].slice(0, 8).join(", ")}`, parts: noConn.slice(0, 50) });
    const noVox = parts.map((p, i) => (vox.parts[p.part] ? -1 : i)).filter((i) => i >= 0);
    if (noVox.length)
      f.push({ severity: "warn", code: "no-voxels", msg: `${noVox.length} part(s) have no voxel model — collisions involving them are unchecked`, parts: noVox.slice(0, 50) });
    f.push({ severity: "info", code: "parts", msg: `${parts.length} parts, ${new Set(parts.map((p) => p.part)).size} distinct` });
    return unknown.length ? "fail" : "pass";
  });
  if (!parts.length) return finish();
  if (rungs[0].status === "fail") return finish();

  // mechanism analysis first (cheap, no sweeps): geometry needs to know
  // which part pairs are meshing gears — interleaved teeth overlap by design
  try {
    mech = analyzeMechanism(parts, meta, conns, vox, nameOf, { ...opts, noSweep: true });
  } catch (e) {
    rungs.push({ id: "mechanism", status: "fail", ms: 0, findings: [{ severity: "fail", code: "grader-error", msg: `mechanism: ${e instanceof Error ? e.message : e}` }] });
    return finish();
  }
  const meshPairs = new Set(mech.info.meshes.map((x) => { const a = mech!.info.gears[x.a].part, b = mech!.info.gears[x.b].part; return `${Math.min(a, b)}/${Math.max(a, b)}`; }));

  // ── geometry ───────────────────────────────────────────────────
  run("geometry", (f) => {
    // Voxel models are 1 LDU; two parts in real contact share a skin of
    // up to a few hundred LDU³ by quantisation. Thresholds below are the
    // noise floor measured on physical sets (8880, 8063, 10271, 42112):
    // genuine interpenetration (a face 2+ LDU deep, an axle through solid
    // plastic) is ≥ ~600 LDU³ between strangers; inside a detected mate
    // (bores, ridges, clutch teeth) the skin is thicker.
    const cols = checkCollisionsValidated(parts, meta, vox, conns);
    const mated = new Set(validateConnections(parts, meta, conns).joints.map((j) => `${j.a}/${j.b}`));
    const hOf = (p: string) => meta[p]?.h ?? 24;
    const cache = new Map<number, Set<number> | null>();
    const cellsOf = (i: number) => {
      if (!cache.has(i)) cache.set(i, worldCells(parts[i], vox, hOf));
      return cache.get(i)!;
    };
    const rows = cols.map((c) => ({ ...c, deep: deepOverlap(cellsOf(c.a), cellsOf(c.b)) * vox.res ** 3 })).sort((x, y) => y.deep - x.deep || y.voxels - x.voxels);
    let fails = 0, warns = 0, noise = 0;
    for (const c of rows) {
      const ldu3 = c.voxels * vox.res ** 3;
      const isMate = mated.has(`${c.a}/${c.b}`) || meshPairs.has(`${Math.min(c.a, c.b)}/${Math.max(c.a, c.b)}`);
      const na = nameOf(parts[c.a].part), nb = nameOf(parts[c.b].part);
      const tyreWheel = (/^tyre|^tire/i.test(na) && /^wheel/i.test(nb)) || (/^tyre|^tire/i.test(nb) && /^wheel/i.test(na));
      const unverifiable = !conns[parts[c.a].part] || !conns[parts[c.b].part] || !na || !nb || tyreWheel;
      const failAt = isMate ? DEEP_MATED_FAIL : DEEP_STRANGER_FAIL;
      if (c.deep < DEEP_WARN) { noise++; continue; }
      const sev: Finding["severity"] = c.deep >= failAt && !unverifiable ? "fail" : "warn";
      if (sev === "fail") fails++; else warns++;
      if (sev === "fail" ? fails <= 200 : warns <= 25)
        f.push({ severity: sev, code: unverifiable ? "collision-unverifiable" : "collision", msg: `#${c.a} ${parts[c.a].part} interpenetrates #${c.b} ${parts[c.b].part} (${c.deep} LDU³ deep, ${ldu3} shared${c.profile ? `, ${c.profile}` : ""}${isMate ? ", mated" : ""}${tyreWheel ? ", tyre on wheel (rubber stretch, by design)" : unverifiable ? ", a part lacks library data" : ""})`, parts: [c.a, c.b], data: { deep: c.deep, ldu3, mated: isMate } });
    }
    if (warns > 25) f.push({ severity: "warn", code: "collision", msg: `… ${warns - 25} more marginal overlaps` });
    f.push({ severity: "info", code: "collision-summary", msg: `${fails} interpenetrations, ${warns} marginal overlaps, ${noise} contact-skin pairs below the noise floor` });
    return fails ? "fail" : "pass";
  });

  // ── connectivity ───────────────────────────────────────────────
  let validation: ReturnType<typeof validateConnections> | null = null;
  let assemblies = 1;
  run("connectivity", (f) => {
    validation = validateConnections(parts, meta, conns);
    const adj: number[][] = parts.map(() => []);
    for (const j of validation.joints) {
      adj[j.a].push(j.b);
      adj[j.b].push(j.a);
    }
    // second opinion: the editor's mate detector (different engagement
    // model) — a mate found by either engine is a physical contact
    for (const m of detectMatesFor(parts, meta, conns)) {
      adj[m[0]].push(m[1]);
      adj[m[1]].push(m[0]);
    }
    const comp = new Array<number>(parts.length).fill(-1);
    const comps: number[][] = [];
    for (let i = 0; i < parts.length; i++) {
      if (comp[i] >= 0) continue;
      const q = [i];
      comp[i] = comps.length;
      const members: number[] = [];
      while (q.length) {
        const x = q.shift()!;
        members.push(x);
        for (const y of adj[x]) if (comp[y] < 0) { comp[y] = comps.length; q.push(y); }
      }
      comps.push(members);
    }
    comps.sort((a, b) => b.length - a.length);
    const loose = comps.slice(1);
    const main = comps[0] ?? [];
    // A loose piece is judged by physics, not by the mate library alone:
    //   floating   — no voxel contact with the main assembly → FAIL
    //   touching   — in contact but no mate the library can read → unverifiable (warn)
    //   no data    — parts without connector/voxel data → unverifiable (warn)
    const noData = loose.filter((c) => c.every((i) => !conns[parts[i].part] || !vox.parts[parts[i].part]));
    const touching: number[][] = [];
    const misaligned: { piece: number[]; nm: NearMiss; n: number }[] = [];
    const separate: number[][] = [];
    const judged: number[][] = [];
    const cellCache = new Map<number, Set<number> | null>();
    const groundedSet = new Set(validation.grounded);
    for (const c of loose) {
      if (noData.includes(c)) continue;
      let touch: number | null = null;
      for (const i of c) {
        touch = touchesAny(parts, i, main, meta, vox, cellCache);
        if (touch != null) break;
      }
      if (touch != null) {
        // in contact: are there connectors that ALMOST mate? then it is
        // misaligned (a real error); otherwise the contact is unreadable
        // < 2.5 LDU is inside OMR/library rounding — a mate the library
        // rejected on a tolerance, not a misplaced part
        // Misaligned = the piece's connectors line up with the main
        // assembly's but do not mate: several near-misses (a plate 8 LDU
        // off all its studs), or one that is colinear but short/long along
        // the axis (a half-inserted pin), or one that is cocked (≥ 4°).
        // A single lateral near-miss is just a hole next to a stud.
        const all = nearMissConnectorsAll(parts, c, main, meta, conns);
        // cocked: axes ≥ 4° apart while sitting on the same axis line
        const cocked = all.find((n) => n.tiltDeg >= 4 && n.lateralLdu <= 6);
        // half-inserted: on-axis, but a SHORT male (pin) sits ≥ 2.5 LDU short of its seat
        const axial = all.find((n) => n.lateralLdu <= 2 && n.axialLdu >= 2.5 && n.maleLenLdu <= 24 && n.tiltDeg < 4);
        // misplaced: several connector pairs 2.5–12 LDU off their partners across the axis
        const lateral = all.filter((n) => n.lateralLdu >= 2.5 && n.lateralLdu <= 12 && n.axialLdu <= 12);
        const nm = cocked ?? axial ?? (lateral.length >= 2 ? lateral[0] : null);
        const nms = nm ? (nm === cocked || nm === axial ? [nm] : lateral) : [];
        if (nm) misaligned.push({ piece: c, nm, n: nms.length });
        else touching.push(c);
      } else if (c.some((i) => groundedSet.has(i))) separate.push(c); // its own object standing on the ground
      else judged.push(c);
    }
    for (const { piece, nm, n } of misaligned)
      f.push({ severity: "fail", code: "misaligned", msg: `${piece.length} part(s) touch the main assembly with ${n} connector pair(s) that almost mate but do not: #${nm.a} ${parts[nm.a].part} ${nm.kind} is ${nm.dist.toFixed(1)} LDU (${nm.axialLdu.toFixed(1)} along the axis, ${nm.lateralLdu.toFixed(1)} across) and ${nm.tiltDeg.toFixed(1)}° off #${nm.b} ${parts[nm.b].part}`, parts: [...piece.slice(0, 20), nm.b], data: { dist: nm.dist, tiltDeg: nm.tiltDeg, axial: nm.axialLdu, lateral: nm.lateralLdu, pairs: n } });
    assemblies = 1 + separate.length;
    if (separate.length)
      f.push({ severity: "warn", code: "separate-assembly", msg: `${separate.length} separate object(s) stand on the ground apart from the main assembly (${separate.map((c) => c.length).join(", ")} parts)`, parts: separate.flat().slice(0, 40), data: { pieces: separate.slice(0, 12).map((c) => c.slice(0, 8)) } });
    const looseParts = judged.flat();
    if (noData.length)
      f.push({ severity: "warn", code: "disconnected-unverifiable", msg: `${noData.flat().length} part(s) in ${noData.length} piece(s) have no connector/voxel data (tyres, chains, stickers…) — attachment unverifiable`, parts: noData.flat().slice(0, 40) });
    if (touching.length)
      f.push({ severity: "warn", code: "attached-unverifiable", msg: `${touching.flat().length} part(s) in ${touching.length} piece(s) touch the main assembly but no mate is readable in the connector library (largest ${Math.max(...touching.map((c) => c.length))} parts) — attachment unverifiable`, parts: touching.flat().slice(0, 40), data: { pieces: touching.slice(0, 12).map((c) => c.slice(0, 8)) } });
    if (looseParts.length) {
      const singles = judged.filter((c) => c.length === 1).length;
      f.push({
        severity: "fail",
        code: "disconnected",
        msg: `${looseParts.length} part(s) in ${judged.length} piece(s) float free of the main assembly — no mate and no contact (${singles} single parts; largest loose piece ${Math.max(...judged.map((c) => c.length))} parts): ${judged.slice(0, 4).map((c) => c.slice(0, 3).map((i) => `#${i} ${parts[i].part}`).join(" ")).join(" | ")}`,
        parts: looseParts.slice(0, 60),
        data: { components: comps.length, pieces: judged.slice(0, 12).map((c) => c.slice(0, 8)) },
      });
    }
    if (!validation.grounded.length) f.push({ severity: "warn", code: "not-grounded", msg: "no part rests on the ground plane (y = 0)" });
    f.push({ severity: "info", code: "mates", msg: `${validation.joints.length} mated pairs, ${comps.length} piece(s), ${validation.grounded.length} grounded part(s)` });
    return looseParts.length || misaligned.length ? "fail" : "pass";
  });

  // ── stability ──────────────────────────────────────────────────
  run("stability", (f) => {
    const rep = checkStability(parts, meta, validation!, vox);
    let fails = 0;
    const cellCache = new Map<number, Set<number> | null>();
    for (const is of rep.issues) {
      // A structure in physical contact with parts OUTSIDE it (wheels on
      // unreadable hubs, tyres, chains) may be supported through a contact
      // the library cannot read — unverifiable, not failed. A structure
      // that touches nothing but the ground and still tips really tips.
      const members = is.parts.length ? is.parts : [];
      const memberSet = new Set(members);
      const outside = parts.map((_, i) => i).filter((i) => !memberSet.has(i));
      const onOther = members.length > 0 && members.some((i) => touchesAny(parts, i, outside, meta, vox, cellCache) != null);
      const sev: Finding["severity"] = is.severe && !onOther ? "fail" : "warn";
      if (sev === "fail") fails++;
      f.push({ severity: sev, code: onOther ? `${is.kind}-unverifiable` : is.kind, msg: `${is.detail}${onOther ? " — but it is in contact with parts outside the structure (unreadable mate); support unverifiable" : ""}`, parts: is.parts.slice(0, 40), data: { overhangLdu: is.overhangLdu, cut: is.cut } });
    }
    f.push({ severity: "info", code: "stability", msg: `mass ${rep.totalMassG.toFixed(0)} g, CoM margin ${rep.globalMarginLdu.toFixed(1)} LDU inside the support hull` });
    return fails ? "fail" : "pass";
  });

  // ── mechanism ──────────────────────────────────────────────────
  run("mechanism", (f) => {
    const reused = opts.reuseSweeps ? applySweeps(mech!, opts.reuseSweeps) : false;
    if (reused) f.push({ severity: "info", code: "sweeps-reused", msg: "joint arcs and gear-train sweeps reused from an earlier measurement of the same parts" });
    else if (!opts.noSweep) runSweeps(mech!, opts);
    const m = mech!.info;
    f.push({ severity: "info", code: "bodies", msg: `${m.bodies} rigid bodies (largest ${Math.max(...m.bodySizes)} parts), ${m.movable} movable bearings, ${m.pinned} pinned` });
    const meshed = new Set(m.meshes.flatMap((x) => [x.a, x.b]));
    for (const [gi, g] of m.gears.entries()) {
      if (g.kind === "rack" && meshed.has(gi)) continue; // a rack on a pinion is modelled: it slides
      if (g.kind === "worm" || g.kind === "rack" || g.kind === "differential")
        f.push({ severity: "warn", code: "gear-unsupported", msg: `#${g.part} ${g.partId} (${g.kind}) — kinematics not modelled by this referee`, parts: [g.part] });
      else if (!meshed.has(gi)) f.push({ severity: "warn", code: "gear-unmeshed", msg: `#${g.part} ${g.partId} (${g.teeth}T) meshes with nothing`, parts: [g.part] });
    }
    let clashes = 0;
    for (const x of m.meshes) {
      if (x.geometry === "rack") {
        f.push({ severity: "info", code: "mesh", msg: `#${m.gears[x.a].part} ${m.gears[x.a].teeth}T drives rack #${m.gears[x.b].part} ${m.gears[x.b].partId}: the rack moves ${Math.abs((x.slide?.lduPerRad ?? 0) * 2 * Math.PI).toFixed(0)} LDU per turn of the gear`, parts: [m.gears[x.a].part, m.gears[x.b].part] });
        continue;
      }
      if (x.geometry === "chain") {
        f.push({ severity: "info", code: "mesh", msg: `#${m.gears[x.a].part} ${m.gears[x.a].teeth}T ↔ #${m.gears[x.b].part} ${m.gears[x.b].teeth}T (joined by a chain, ratio ${x.ratio.toFixed(3)})`, parts: [m.gears[x.a].part, m.gears[x.b].part] });
        continue;
      }
      f.push({ severity: "info", code: "mesh", msg: `#${m.gears[x.a].part} ${m.gears[x.a].teeth}T ↔ #${m.gears[x.b].part} ${m.gears[x.b].teeth}T (${x.geometry}, centre ${x.centerDistance.toFixed(1)} vs ${x.expected.toFixed(1)} LDU, ratio ${x.ratio.toFixed(3)})`, parts: [m.gears[x.a].part, m.gears[x.b].part] });
      if (x.phase?.clash) {
        // as posed, the teeth interpenetrate. On a free bearing the gear
        // self-phases when you assemble it, so that is a located warning
        // with the roll that fixes the file; if the train cannot turn at
        // all (pinned), the clash is a real failure.
        const train = m.trains.find((t) => t.gears.includes(x.a) || t.gears.includes(x.b));
        const pinned = !!train?.blocked;
        if (pinned) clashes++;
        f.push({ severity: pinned ? "fail" : "warn", code: "gear-phase", msg: `teeth clash as posed: #${m.gears[x.a].part} ${m.gears[x.a].teeth}T sits tooth-on-tooth with #${m.gears[x.b].part} ${m.gears[x.b].teeth}T (${x.phase.sharedNow} shared voxels; ${x.phase.sharedBest} at best) — roll #${m.gears[x.a].part} by ${x.phase.rollDeg}° about its axis${pinned ? "; the train is pinned so it cannot self-phase" : ""}`, parts: [m.gears[x.a].part, m.gears[x.b].part], data: { rollDeg: x.phase.rollDeg } });
      }
    }
    for (const j of m.joints) {
      if (!j.pinned && j.arc && j.arc.min === 0 && j.arc.max === 0)
        f.push({ severity: "warn", code: "joint-stuck", msg: `bearing J${j.id} (#${j.parent} ${parts[j.parent].part} ↔ #${j.child} ${parts[j.child].part}) cannot turn at all — blocked by neighbouring parts`, parts: [j.parent, j.child] });
    }
    const arcs = m.joints.filter((j) => j.arc).map((j) => j.arc!.max - j.arc!.min);
    if (arcs.length) f.push({ severity: "info", code: "arcs", msg: `${arcs.length} bearings swept: free arcs ${Math.min(...arcs)}–${Math.max(...arcs)}°` });
    f.push({ severity: "info", code: "gears", msg: `${m.gears.length} gears, ${m.meshes.length} meshes, ${m.trains.length} train(s)` });
    return clashes ? "fail" : "pass";
  });

  // ── actuation ──────────────────────────────────────────────────
  run("actuation", (f) => {
    const m = mech!.info;
    if (!m.trains.length) {
      f.push({ severity: "info", code: "no-trains", msg: "no gear trains to actuate" });
      return "skip";
    }
    let bad = 0;
    for (const tr of m.trains) {
      const d = m.gears[tr.driver];
      const label = `train ${tr.id} (driver #${d.part} ${d.partId} ${d.teeth}T, ${tr.gears.length} gears, ${tr.bodies.length} bodies)`;
      if (tr.unverifiable) {
        f.push({ severity: "warn", code: "train-unverifiable", msg: `${label}: ${tr.unverifiable}`, parts: tr.gears.map((g) => m.gears[g].part) });
        continue;
      }
      if (tr.blocked) {
        bad++;
        f.push({ severity: "fail", code: "train-blocked", msg: `${label}: ${tr.blocked}`, parts: tr.gears.map((g) => m.gears[g].part) });
        continue;
      }
      if (!tr.sweep) {
        f.push({ severity: "warn", code: "train-unswept", msg: `${label}: not swept` });
        continue;
      }
      const outs = tr.outputs.map((o) => `${o.ratio > 0 ? "+" : ""}${o.ratio.toFixed(3)}`).join(", ");
      if (tr.sweep.ok && tr.sweep.freeDeg)
        f.push({ severity: "info", code: "train-ok", msg: `${label}: drives a rack; the driver turns from ${tr.sweep.freeDeg.min}° to ${tr.sweep.freeDeg.max}° before the rack meets something (${tr.sweep.ms} ms)`, parts: tr.gears.map((g) => m.gears[g].part) });
      else if (tr.sweep.ok) f.push({ severity: "info", code: "train-ok", msg: `${label}: full turn clean (${tr.sweep.steps}×${tr.sweep.stepDeg}°, ${tr.sweep.ms} ms); output ratios ${outs}`, parts: tr.gears.map((g) => m.gears[g].part) });
      else if (tr.sweep.unverifiable) {
        f.push({ severity: "warn", code: "train-unverifiable", msg: `${label}: at driver angle ${tr.sweep.jamAtDeg}° ${tr.sweep.unverifiable}`, parts: tr.sweep.jamParts, atDeg: tr.sweep.jamAtDeg });
      } else {
        bad++;
        const [a, b] = tr.sweep.jamParts!;
        f.push({ severity: "fail", code: "train-jams", msg: `${label}: jams at driver angle ${tr.sweep.jamAtDeg}° — #${a} ${parts[a].part} runs into #${b} ${parts[b].part} (+${tr.sweep.jamOverlapLdu3} LDU³)`, parts: [a, b], atDeg: tr.sweep.jamAtDeg });
      }
    }
    return bad ? "fail" : "pass";
  });

  // ── task ───────────────────────────────────────────────────────
  if (task?.post) {
    run("task", (f) => {
      const post = task.post!;
      const m = mech!.info;
      let fails = 0;
      const check = (ok: boolean, code: string, msg: string, extra?: Partial<Finding>) => {
        if (!ok) fails++;
        f.push({ severity: ok ? "info" : "fail", code, msg: `${ok ? "✓" : "✗"} ${msg}`, ...extra });
      };
      // Box checks (joints[].pivotIn, partsIn) are written in the SEED's LDraw
      // frame. A submission moved as a whole is mapped back by the dominant
      // translation from the seed (computed only when a box check exists).
      const needsFrame = !!(post.partsIn?.length || post.joints?.some((j) => j.pivotIn != null));
      let off: [number, number, number] = [0, 0, 0];
      if (needsFrame && opts.seedLdraw) {
        const o = poseMatch(fromLdr(opts.seedLdraw, meta).parts, parts).offset; // engine frame: y, z flipped
        off = [o[0] || 0, -o[1] || 0, -o[2] || 0];
      }
      const toSeed = (v: [number, number, number]): [number, number, number] => [v[0] - off[0], v[1] - off[1], v[2] - off[2]];
      // a part's LDraw origin (fromLdr stores engine y = −y_ldraw − h for grid rotations, −y_ldraw otherwise)
      const ldrawOrigin = (p: (typeof parts)[number]): V3 => [p.x, p.m ? -p.y : -(p.y + (meta[p.part]?.h ?? FALLBACK_META.h)), -p.z || 0];
      if (post.minPreserved != null) {
        if (!opts.seedLdraw) f.push({ severity: "warn", code: "preserved", msg: "preservation not judged — no seed model given" });
        else {
          const seed = fromLdr(opts.seedLdraw, meta).parts;
          const pm = poseMatch(seed, parts);
          check(pm.frac >= post.minPreserved, "preserved", `${(pm.frac * 100).toFixed(1)}% of the seed's ${seed.length} parts kept in place (${pm.kept}) ≥ ${post.minPreserved * 100}%`, { data: { preserved: pm.frac, offset: pm.offset } });
        }
      }
      if (post.reference) {
        if (!opts.goldLdraw) f.push({ severity: "warn", code: "reference", msg: "reference match not judged — no gold model given" });
        else {
          const gold = fromLdr(opts.goldLdraw, meta).parts;
          const bf = bomF1(gold, parts), pm = poseMatch(gold, parts);
          if (post.reference.minBomF1 != null) check(bf.f1 >= post.reference.minBomF1, "bom-f1", `bill-of-materials F1 ${bf.f1} (P ${bf.precision} R ${bf.recall}) ≥ ${post.reference.minBomF1}`, { data: bf });
          if (post.reference.minPoseMatch != null) check(pm.frac >= post.reference.minPoseMatch, "pose-match", `${(pm.frac * 100).toFixed(1)}% of the gold's ${gold.length} poses reproduced ≥ ${post.reference.minPoseMatch * 100}%`, { data: { poseMatch: pm.frac } });
        }
      }
      if (post.minParts != null) check(parts.length >= post.minParts, "min-parts", `parts ${parts.length} ≥ ${post.minParts}`);
      if (post.maxParts != null) check(parts.length <= post.maxParts, "max-parts", `parts ${parts.length} ≤ ${post.maxParts}`);
      const { height: maxY, footprint: fp } = extentOf(parts, meta);
      if (post.minHeightLdu != null) check(maxY >= post.minHeightLdu, "min-height", `height ${maxY.toFixed(0)} ≥ ${post.minHeightLdu} LDU`);
      if (post.maxHeightLdu != null) check(maxY <= post.maxHeightLdu, "max-height", `height ${maxY.toFixed(0)} ≤ ${post.maxHeightLdu} LDU`);
      if (post.maxFootprintStuds) {
        const ok = Math.max(...fp) <= Math.max(...post.maxFootprintStuds) && Math.min(...fp) <= Math.min(...post.maxFootprintStuds) + 1e-3;
        check(ok, "footprint", `footprint ${fp.map((v) => v.toFixed(1)).join("×")} within ${post.maxFootprintStuds.join("×")} studs`);
      }
      if (post.minFootprintStuds) {
        const ok = Math.max(...fp) >= Math.max(...post.minFootprintStuds) - 1e-3 && Math.min(...fp) >= Math.min(...post.minFootprintStuds) - 1e-3;
        check(ok, "min-footprint", `footprint ${fp.map((v) => v.toFixed(1)).join("×")} at least ${post.minFootprintStuds.join("×")} studs`);
      }
      for (const req of post.partNames ?? []) {
        const re = new RegExp(req.match, "i");
        const n = parts.filter((p) => re.test(nameOf(p.part) || p.part)).length;
        check(n >= req.min, "part-names", `${n} part(s) matching /${req.match}/ ≥ ${req.min}`);
      }
      if (post.minMovableJoints != null) check(m.movable >= post.minMovableJoints, "movable-joints", `${m.movable} movable bearings ≥ ${post.minMovableJoints}`);
      if (post.minFreeArcDeg != null) {
        const best = Math.max(0, ...m.joints.filter((j) => j.arc).map((j) => j.arc!.max - j.arc!.min));
        check(best >= post.minFreeArcDeg, "free-arc", `widest swept arc ${best}° ≥ ${post.minFreeArcDeg}°`);
      }
      for (const req of post.joints ?? []) {
        const tol = ((req.axisTolDeg ?? 20) * Math.PI) / 180;
        const axisOk = (a?: [number, number, number]) => {
          const want = req.axis ?? "any";
          if (want === "any") return true;
          if (!a) return false;
          const up = Math.abs(a[1]);
          return want === "vertical" ? up >= Math.cos(tol) : up <= Math.sin(tol);
        };
        const boxes = req.pivotIn == null ? null : Array.isArray(req.pivotIn) ? req.pivotIn : [req.pivotIn];
        const pivotOk = (pv?: [number, number, number]) => !boxes || (!!pv && boxes.some((b) => inBox(toSeed(pv), b)));
        const hits = m.joints.filter(
          (j) =>
            !j.pinned &&
            (j.arc ? j.arc.max - j.arc.min : 0) >= (req.minArcDeg ?? 0) &&
            (req.minMoving == null || (j.moving ?? 0) >= req.minMoving) &&
            axisOk(j.axis) &&
            pivotOk(j.pivot),
        );
        const unmeasured = m.joints.filter((j) => !j.pinned && !j.arc && axisOk(j.axis) && pivotOk(j.pivot)).length;
        // with a pivot box, say where the qualifying swings actually are, so a miss is locatable
        let where = "";
        if (boxes) {
          const swingers = m.joints.filter(
            (j) => !j.pinned && (j.arc ? j.arc.max - j.arc.min : 0) >= (req.minArcDeg ?? 0) && (req.minMoving == null || (j.moving ?? 0) >= req.minMoving) && axisOk(j.axis),
          );
          const fmt = (j: (typeof swingers)[number]) => `J${j.id} at ${j.pivot ? `(${toSeed(j.pivot).map(Math.round).join(", ")})` : "(no pivot)"} ${j.arc ? j.arc.max - j.arc.min : 0}°/${j.moving ?? 0} parts`;
          const outside = swingers.filter((j) => !hits.includes(j));
          const weak = m.joints.filter((j) => !j.pinned && axisOk(j.axis) && pivotOk(j.pivot) && !hits.includes(j));
          const fmtWeak = (j: (typeof weak)[number]) => `J${j.id} at ${j.pivot ? `(${toSeed(j.pivot).map(Math.round).join(", ")})` : "(no pivot)"} ${j.arc ? `${j.arc.max - j.arc.min}°` : "unswept"}/${j.moving ?? 0} parts`;
          where =
            ` — pivot box ${boxes.map(boxStr).join(" or ")}${off.some((v) => v) ? ` (seed frame; submission offset ${off.join(", ")})` : ""}` +
            `; inside: ${hits.length ? hits.slice(0, 6).map(fmt).join(", ") : "none"}` +
            `; qualifying swings outside it: ${outside.length ? outside.slice(0, 6).map(fmt).join(", ") : "none"}` +
            (weak.length ? `; in it but too small a swing or too few parts: ${weak.slice(0, 6).map(fmtWeak).join(", ")}` : "");
        }
        check(
          hits.length >= req.min,
          `joints:${req.id}`,
          `${req.id}: ${hits.length} ${req.axis ?? "any"}-axis bearing(s) swinging ≥ ${req.minArcDeg ?? 0}°${boxes && req.minMoving != null ? ` carrying ≥ ${req.minMoving} parts` : ""} (need ${req.min})${unmeasured ? `; ${unmeasured} candidate(s) not swept` : ""}${where}`,
          { parts: hits.map((j) => j.child), data: { joints: hits.map((j) => j.id), unmeasured, ...(boxes ? { pivots: hits.map((j) => j.pivot && toSeed(j.pivot)), offset: off } : {}) } },
        );
      }
      for (const req of post.partsIn ?? []) {
        const re = new RegExp(req.match, "i");
        const found = parts
          .map((p, i) => ({ i, p, o: toSeed(ldrawOrigin(p)) }))
          .filter(({ p, o }) => re.test(nameOf(p.part) || p.part) && inBox(o, req.box));
        const n = found.length;
        const ok = (req.min == null || n >= req.min) && (req.max == null || n <= req.max);
        const bound = [req.min != null ? `≥ ${req.min}` : "", req.max != null ? `≤ ${req.max}` : ""].filter(Boolean).join(" and ");
        check(
          ok,
          `parts-in:${req.id}`,
          `${req.id}: ${n} part(s) matching /${req.match}/ inside ${boxStr(req.box)} (need ${bound})${off.some((v) => v) ? ` (seed frame; submission offset ${off.join(", ")})` : ""}${n ? ` — e.g. ${found.slice(0, 5).map(({ p, o }) => `${p.part} at (${o.map(Math.round).join(", ")})`).join("; ")}` : ""}`,
          { parts: found.slice(0, 40).map((x) => x.i), data: { count: n, offset: off } },
        );
      }
      if (post.minGearTrains != null) check(m.trains.filter((t) => !t.blocked && !t.unverifiable && t.sweep?.ok).length >= post.minGearTrains, "gear-trains", `${m.trains.filter((t) => !t.blocked && !t.unverifiable && t.sweep?.ok).length} verified train(s) ≥ ${post.minGearTrains}`);
      if (post.gearRatio) {
        const tol = post.gearRatio.tol ?? 0.02;
        const want = post.gearRatio.ratio;
        const hit = m.trains.find((t) => !t.blocked && t.sweep?.ok && t.outputs.some((o) => Math.abs(Math.abs(1 / o.ratio) - want) <= tol * want || Math.abs(Math.abs(o.ratio) - want) <= tol * want));
        check(!!hit, "gear-ratio", `a verified train realises ratio ${want} (±${(tol * 100).toFixed(0)}%)${hit ? ` — train ${hit.id}` : ""}`);
      }
      if (post.actuate !== false && m.trains.length) check(m.trains.every((t) => t.unverifiable || t.sweep?.unverifiable || (!t.blocked && t.sweep?.ok)), "actuate", "every judged gear train drives a full turn");
      if (post.maxAssemblies != null) check(assemblies <= post.maxAssemblies, "assemblies", `${assemblies} assembly/assemblies ≤ ${post.maxAssemblies}`);
      if (post.bag) {
        const used = new Map<string, number[]>();
        parts.forEach((p, i) => {
          const k = `${p.part}/${p.color}`;
          used.set(k, [...(used.get(k) ?? []), i]);
        });
        const over = [...used].filter(([k, ids]) => ids.length > (post.bag!.parts[k] ?? 0));
        const extra = over.reduce((n, [k, ids]) => n + ids.length - (post.bag!.parts[k] ?? 0), 0);
        const list = over.slice(0, 8).map(([k, ids]) => `${k} ×${ids.length} (bag has ${post.bag!.parts[k] ?? 0})`).join(", ");
        check(over.length === 0, "bag", over.length ? `${extra} part(s) not in the ${post.bag.from} bag: ${list}` : `every part comes from the ${post.bag.from} bag`, {
          parts: over.flatMap(([k, ids]) => ids.slice(post.bag!.parts[k] ?? 0)).slice(0, 40),
        });
        if (post.bag.minUsed != null) {
          const total = Object.values(post.bag.parts).reduce((a, b) => a + b, 0);
          const usedN = Object.entries(post.bag.parts).reduce((n, [k, want]) => n + Math.min(want, used.get(k)?.length ?? 0), 0);
          check(usedN >= post.bag.minUsed * total, "bag-used", `${usedN} of ${total} bag parts used (${Math.round((100 * usedN) / total)}%, need ≥ ${Math.round(post.bag.minUsed * 100)}%)`, { data: { used: usedN, total } });
        }
        if (post.bag.useAll) {
          const short = Object.entries(post.bag.parts).filter(([k, n]) => (used.get(k)?.length ?? 0) < n);
          const missing = short.reduce((n, [k, want]) => n + want - (used.get(k)?.length ?? 0), 0);
          const slist = short.slice(0, 8).map(([k, want]) => `${k} ×${want - (used.get(k)?.length ?? 0)}`).join(", ");
          check(short.length === 0, "bag-all", short.length ? `${missing} bag part(s) left unused: ${slist}${short.length > 8 ? ", …" : ""}` : `every part of the ${post.bag.from} bag is used`);
        }
      }
      return fails ? "fail" : "pass";
    });
  }
  return finish();

  function finish(): Verdict {
    const st = (id: RungId) => rungs.find((r) => r.id === id)?.status ?? "skip";
    const pass = (id: RungId) => st(id) === "pass" || st(id) === "skip";
    const valid = st("parse") === "pass" && st("geometry") === "pass" && st("connectivity") === "pass";
    const functional = valid && pass("stability") && pass("mechanism") && pass("actuation");
    const adherent = task?.post ? functional && st("task") === "pass" : null;
    const firstFail = rungs.find((r) => r.status === "fail");
    const mechInfo = mech ? (mech as ReturnType<typeof analyzeMechanism>).info : null;
    const verifiedTrains = mechInfo?.trains.filter((t) => t.sweep?.ok).length ?? 0;
    const unverifiableTrains = mechInfo?.trains.filter((t) => t.unverifiable || t.sweep?.unverifiable).length ?? 0;
    const summary = firstFail
      ? `FAIL at ${firstFail.id}: ${firstFail.findings.find((x) => x.severity === "fail")?.msg ?? "?"}`
      : `PASS — ${parts.length} parts, ${mechInfo?.movable ?? 0} movable bearings, ${verifiedTrains} gear train(s) verified${unverifiableTrains ? `, ${unverifiableTrains} unverifiable` : ""}`;
    return {
      ok: adherent ?? functional,
      valid,
      functional,
      adherent,
      source: opts.source ?? "ldraw",
      parts: parts.length,
      ms: Date.now() - T0,
      rungs,
      mechanism: mechInfo,
      summary,
    };
  }
}
