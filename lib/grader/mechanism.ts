/**
 * Mechanism analysis for the referee — rigid bodies, bearings, gears,
 * meshes, gear trains, and the ACTUATION SWEEP.
 *
 * Nothing here trusts the file's intent. Bodies come from contact
 * geometry (keyed axle / stud / friction pin = rigid; colinear round
 * bore = bearing). Gear meshes come from measured centre distance and
 * axis geometry against the LEGO module (pitch radius = 1.25·teeth LDU).
 * Ratios come from velocity matching at the pitch point. And a train only
 * passes when it is DRIVEN through a full turn with every body posed and
 * voxel-collision-checked against everything else — a wrong ratio, a
 * mis-spaced gear or a part in the way shows up as growing
 * interpenetration at some driver angle, which is reported.
 *
 * Not modelled (stated in the verdict): forces, friction, motor stall,
 * backlash, worm/rack/differential kinematics.
 */
import { ldrawFrameOf } from "@/lib/engine/snapAlign";
import type { ConnectionMap } from "@/lib/engine/snapAlign";
import { detectMates, inferJoints, type InferOpts } from "@/lib/editor2/mates";
import { computeJointLimits, rotAboutLine, subtreeOf } from "@/lib/editor2/limits";
import {
  compose,
  connFrame,
  expandedConnectors,
  mulMV,
  orthonormalize,
  type E2Doc,
  type E2Part,
  type Frame,
  type LocalConnector,
  type V3,
} from "@/lib/editor2/kinematics";
import { worldCells, type VoxelData } from "@/lib/engine/voxelCollision";
import { secSegments } from "@/lib/engine/connectionGraph";
import type { PartMetaMap, PlacedPartJson } from "@/lib/data/schemas";
import { motorOutput } from "./motors";
import type { GearInfo, JointInfo, MechanismInfo, MeshInfo, TrainInfo } from "./types";

export interface MechanismOpts {
  /** measure collision-swept arcs for up to this many movable joints (largest moving subtree first) */
  maxJointSweeps?: number;
  /** driver step for gear-train sweeps (deg) */
  stepDeg?: number;
  /** extra interpenetration (LDU³) tolerated beyond the rest pose */
  jamTolLdu3?: number;
  /** skip the sweeps entirely (analysis only) */
  noSweep?: boolean;
  /** sweep only these bearings (by joint id) / these gear trains (by train id): an interactive tool measures one thing at a time */
  onlyJoints?: number[];
  onlyTrains?: number[];
  /**
   * Treat a friction pin as a joint that turns, not as a fastener. The referee's default (off) is the benchmark's:
   * a friction pin holds its pose, so what it joins is one rigid body. A viewer that lets a person pose a model
   * wants the other reading: a leg on friction pins is a (stiff) hip.
   */
  frictionIsJoint?: boolean;
  /**
   * A motor's output turns in its housing (see ./motors): a gear on a motor's shaft is then a driven gear, not a
   * gear "keyed into the chassis". Off by default: the benchmark as calibrated reads a motor as a solid block.
   */
  motors?: boolean;
  log?: (s: string) => void;
}

export interface MechanismContext {
  parts: PlacedPartJson[];
  eparts: E2Part[];
  frames: Map<number, Frame>;
  bodyOf: number[];
  bodies: number[][];
  doc: E2Doc;
  /** the joint inference as it came back: condensed rigid clusters, the kinematic tree, the edges locked by loops */
  inf: ReturnType<typeof inferJoints>;
  info: MechanismInfo;
  /** the part-level union of "physics can't be checked" parts (no connector data) */
  unknownConns: number[];
  cOf: (part: string) => LocalConnector[];
  meta: PartMetaMap;
  vox: VoxelData;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Part-pair mates from the editor's detector (for connectivity's second opinion). */
export function detectMatesFor(parts: PlacedPartJson[], meta: PartMetaMap, conns: ConnectionMap): [number, number][] {
  const hOf = (p: string) => meta[p]?.h ?? 24;
  const eparts: E2Part[] = parts.map((p, i) => {
    const f = ldrawFrameOf(p, hOf);
    return { id: i, part: p.part, color: p.color, root: { o: f.o as V3, r: orthonormalize(f.r) } };
  });
  const frames = new Map(eparts.map((p) => [p.id, p.root!]));
  const memo = new Map<string, LocalConnector[]>();
  const cOf = (part: string) => {
    let h = memo.get(part);
    if (!h) memo.set(part, (h = expandedConnectors(part, conns)));
    return h;
  };
  return detectMates(eparts, frames, cOf).filter((m) => m.a.partId !== m.b.partId).map((m) => [m.a.partId, m.b.partId]);
}

/**
 * Physical contact test: do the voxel skins of part `i` and any part in
 * `others` touch (share a cell or sit in adjacent cells)? Used to tell
 * "attached by a connector we cannot read" from "floating in the air".
 */
export function touchesAny(
  parts: PlacedPartJson[],
  i: number,
  others: number[],
  meta: PartMetaMap,
  vox: VoxelData,
  cache: Map<number, Set<number> | null> = new Map(),
): number | null {
  const hOf = (p: string) => meta[p]?.h ?? 24;
  const cellsOf = (k: number) => {
    if (!cache.has(k)) cache.set(k, worldCells(parts[k], vox, hOf));
    return cache.get(k)!;
  };
  const ci = cellsOf(i);
  if (!ci) return null;
  // dilate i's cells by one in each axis (cell keys are packed ints — see voxelCollision.worldCells)
  const pi = parts[i];
  const ri = radiusOf(pi.part, vox);
  for (const j of others) {
    const pj = parts[j];
    const dd = Math.hypot(pi.x - pj.x, pi.y - pj.y, pi.z - pj.z);
    if (dd > ri + radiusOf(pj.part, vox) + 4) continue;
    const cj = cellsOf(j);
    if (!cj) continue;
    for (const k of ci) if (cj.has(k)) return j;
    // adjacency: probe the 6 neighbours of each of the smaller set
    const [small, big] = ci.size <= cj.size ? [ci, cj] : [cj, ci];
    for (const k of small) {
      for (const n of neighbours(k)) if (big.has(n)) return j;
    }
  }
  return null;
}
function radiusOf(part: string, vox: VoxelData): number {
  const v = vox.parts[part];
  return v ? (Math.hypot(v.dims[0], v.dims[1], v.dims[2]) * vox.res) / 2 : 40;
}
/**
 * DEEP overlap: shared cells that are INTERIOR to both parts (all six
 * neighbours occupied). The voxel skin — the one-cell boundary layer that
 * two touching parts share by quantisation — drops out, so what remains
 * is material that is genuinely inside both bodies: an axle through a
 * gear's disc, a plate sunk into a brick. Cells (LDU³ at res 1).
 */
export function deepOverlap(a: Set<number> | null, b: Set<number> | null): number {
  if (!a || !b) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const k of small) {
    if (!big.has(k)) continue;
    if (interior(k, small) && interior(k, big)) n++;
  }
  return n;
}
function interior(k: number, s: Set<number>): boolean {
  return s.has(k + 1) && s.has(k - 1) && s.has(k + CELL_STRIDE_Y) && s.has(k - CELL_STRIDE_Y) && s.has(k + CELL_STRIDE_Z) && s.has(k - CELL_STRIDE_Z);
}

/** worldCells packs cell coords as cx + 1024·(cy + 1024·cz). */
const CELL_STRIDE_Y = 1024;
const CELL_STRIDE_Z = 1024 * 1024;
/** neighbours in that packing. */
function neighbours(k: number): number[] {
  return [k + 1, k - 1, k + CELL_STRIDE_Y, k - CELL_STRIDE_Y, k + CELL_STRIDE_Z, k - CELL_STRIDE_Z];
}

/**
 * Near-miss connectors between a loose piece and the main assembly: a
 * male/female pair of the same kind, axes parallel, centres within
 * `tolLdu` but NOT mated — the signature of a misaligned part (a plate
 * 8 LDU off its studs). Returns the closest such pair, if any.
 */
export function nearMissConnectors(
  parts: PlacedPartJson[],
  piece: number[],
  main: number[],
  meta: PartMetaMap,
  conns: ConnectionMap,
  tolLdu = 12,
): NearMiss | null {
  const all = nearMissConnectorsAll(parts, piece, main, meta, conns, tolLdu);
  return all[0] ?? null;
}
export interface NearMiss {
  a: number;
  b: number;
  dist: number;
  kind: string;
  tiltDeg: number;
  /** offset along the partner's axis vs across it (distance from the axis line) */
  axialLdu: number;
  lateralLdu: number;
  /** length of the male section (short = pin, long = axle) */
  maleLenLdu: number;
}
/** All near-miss pairs, best (smallest positional+angular miss) first, one per piece connector. */
export function nearMissConnectorsAll(
  parts: PlacedPartJson[],
  piece: number[],
  main: number[],
  meta: PartMetaMap,
  conns: ConnectionMap,
  tolLdu = 12,
): NearMiss[] {
  const hOf = (p: string) => meta[p]?.h ?? 24;
  const memo = new Map<string, LocalConnector[]>();
  const cOf = (part: string) => {
    let h = memo.get(part);
    if (!h) memo.set(part, (h = expandedConnectors(part, conns)));
    return h;
  };
  const frameOf = (i: number): Frame => {
    const f = ldrawFrameOf(parts[i], hOf);
    return { o: f.o as V3, r: orthonormalize(f.r) };
  };
  type WC = { part: number; pos: V3; ax: V3; kind: string; gender?: string; len: number };
  const world = (i: number): WC[] => {
    const f = frameOf(i);
    return cOf(parts[i].part).map((c) => {
      const w = compose(f, connFrame(c));
      const len = secSegments(c.secs).reduce((s, x) => s + x.len, 0);
      return { part: i, pos: w.o, ax: unit(mulMV(w.r, [0, 1, 0])), kind: c.kind, gender: c.gender, len };
    });
  };
  // bucket main connectors on a 40-LDU grid
  const CELL = 40;
  const key = (p: V3) => `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)},${Math.floor(p[2] / CELL)}`;
  const buckets = new Map<string, WC[]>();
  const put = (w: WC, p: V3) => {
    const k = key(p);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(w);
  };
  for (const i of main) {
    if (!conns[parts[i].part]) continue;
    for (const w of world(i)) {
      put(w, w.pos);
      // a long male (an axle) is reachable anywhere along its length:
      // index sample points along its axis too
      if (w.gender === "M" && w.len > CELL) {
        for (let s = CELL; s <= w.len / 2; s += CELL) {
          put(w, add(w.pos, scale(w.ax, s)));
          put(w, add(w.pos, scale(w.ax, -s)));
        }
      }
    }
  }
  const out: NearMiss[] = [];
  for (const i of piece) {
    if (!conns[parts[i].part]) continue;
    for (const w of world(i)) {
      let best: NearMiss | null = null;
      const c = [Math.floor(w.pos[0] / CELL), Math.floor(w.pos[1] / CELL), Math.floor(w.pos[2] / CELL)];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            for (const m of buckets.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
              if (m.kind !== w.kind || !m.gender || !w.gender || m.gender === w.gender) continue;
              const cosv = Math.min(1, Math.abs(dot(m.ax, w.ax)));
              if (cosv < 0.85) continue; // > ~32° apart: not the same joint at all
              const tiltDeg = (Math.acos(cosv) * 180) / Math.PI;
              // measure against the MALE's axis line: a gear anywhere along
              // a long axle is 0 LDU off laterally, however far along it sits
              const male = m.gender === "M" ? m : w;
              const female = male === m ? w : m;
              const dv = sub(female.pos, male.pos);
              const axialOff = dot(dv, male.ax);
              const lateral = norm(sub(dv, scale(male.ax, axialOff)));
              const axial = Math.abs(axialOff);
              if (lateral > tolLdu || axial > Math.max(60, male.len / 2 + tolLdu)) continue;
              const d = norm(dv);
              const score = lateral + tiltDeg; // 1° ≈ 1 LDU
              if (!best || score < best.lateralLdu + best.tiltDeg) best = { a: i, b: m.part, dist: d, kind: w.kind, tiltDeg, axialLdu: axial, lateralLdu: lateral, maleLenLdu: male.len };
            }
          }
      if (best) out.push(best);
    }
  }
  out.sort((x, y) => x.lateralLdu + x.tiltDeg - (y.lateralLdu + y.tiltDeg));
  return out;
}

/** LEGO gear module: 8 teeth ↔ 1 stud pitch diameter → r = 1.25·teeth LDU. */
export const PITCH_LDU_PER_TOOTH = 1.25;

export function gearKindOf(name: string): GearInfo["kind"] | null {
  if (/knob wheel/i.test(name)) return "knob";
  if (!/gear|turntable/i.test(name)) return null;
  if (/differential/i.test(name)) return "differential";
  if (/worm/i.test(name)) return "worm";
  if (/rack/i.test(name)) return "rack";
  if (/turntable/i.test(name)) return /\d+ tooth/i.test(name) ? "turntable" : null;
  if (/crown/i.test(name)) return "crown";
  if (/bevel/i.test(name)) return "bevel";
  if (/\d+ tooth/i.test(name)) return "spur";
  return "other";
}
export function teethOf(name: string): number | null {
  if (/knob wheel/i.test(name)) return 4; // knob wheels mesh at 1 stud like 8T gears would
  const m = name.match(/(\d+)\s*tooth/i);
  return m ? Number(m[1]) : null;
}

const toPlacement = (part: string, f: Frame): PlacedPartJson => ({ part, color: 0, x: f.o[0], y: -f.o[1], z: -f.o[2], rot: 0, m: f.r.slice() });

/** Build the mechanism context: bodies, joints, gears, meshes, trains. */
export function analyzeMechanism(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  conns: ConnectionMap,
  vox: VoxelData,
  nameOf: (part: string) => string,
  opts: MechanismOpts = {},
): MechanismContext {
  const log = opts.log ?? (() => {});
  const hOf = (p: string) => meta[p]?.h ?? 24;
  const eparts: E2Part[] = parts.map((p, i) => {
    const f = ldrawFrameOf(p, hOf);
    return { id: i, part: p.part, color: p.color, root: { o: f.o as V3, r: orthonormalize(f.r) } };
  });
  const frames = new Map(eparts.map((p) => [p.id, p.root!]));
  const cMemo = new Map<string, LocalConnector[]>();
  const cOf = (part: string) => {
    let h = cMemo.get(part);
    if (!h) cMemo.set(part, (h = expandedConnectors(part, conns)));
    return h;
  };
  const unknownConns = parts.map((p, i) => (conns[p.part] ? -1 : i)).filter((i) => i >= 0);

  // Same name-based intent the editor uses: friction pins fasten, round
  // 1×1s have unobservable spin, tyre-on-wheel is one solid.
  const inferOpts: InferOpts = {
    frictionPart: (p) => !opts.frictionIsJoint && /with friction/i.test(nameOf(p)),
    rigidPart: (p) => /round 1 x 1|cone 1 x 1/i.test(nameOf(p)),
    rigidPair: (a, b) => {
      const na = nameOf(a), nb = nameOf(b);
      const tyre = /^tyre|tire/i, wheel = /^wheel/i;
      return (tyre.test(na) && wheel.test(nb)) || (tyre.test(nb) && wheel.test(na));
    },
  };
  const t0 = Date.now();
  const inf = inferJoints(eparts, frames, cOf, { current: eparts.length + 1 }, inferOpts);
  log(`inferJoints: ${inf.pairs.length} pairs, ${inf.revolute} revolute, ${inf.lockedJoints} locked, ${inf.clusters} clusters in ${Date.now() - t0}ms`);

  // Bodies = union-find over RIGID pairs (pure contact geometry).
  const uf = parts.map((_, i) => i);
  const find = (x: number): number => {
    while (uf[x] !== x) x = uf[x] = uf[uf[x]];
    return x;
  };
  // (with `motors`) a contact on a motor's turning output is a bearing, whatever the fastener test says
  const rotorOf = new Map<string, Set<number> | null>();
  const onOutput = (part: number, conn: number) => {
    if (!opts.motors) return false;
    const id = parts[part].part;
    if (!rotorOf.has(id)) rotorOf.set(id, motorOutput(id, nameOf(id), cOf(id))?.rotor ?? null);
    return !!rotorOf.get(id)?.has(conn);
  };
  const motorPair = (pr: (typeof inf.pairs)[number]) => onOutput(pr.a, pr.aConn) || onOutput(pr.b, pr.bConn);
  for (const pr of inf.pairs) if (pr.kind === "rigid" && !motorPair(pr)) uf[find(pr.a)] = find(pr.b);
  const bodyIndex = new Map<number, number>();
  const bodyOf = parts.map((_, i) => {
    const r = find(i);
    if (!bodyIndex.has(r)) bodyIndex.set(r, bodyIndex.size);
    return bodyIndex.get(r)!;
  });
  const bodies: number[][] = Array.from({ length: bodyIndex.size }, () => []);
  bodyOf.forEach((b, i) => bodies[b].push(i));
  const largestBody = bodies.reduce((best, b, i) => (b.length > bodies[best].length ? i : best), 0);

  // Joints (bearings): inferred revolute joints; pinned when the loop
  // analysis froze them or both ends fell into one rigid body.
  const doc: E2Doc = { parts: eparts, joints: inf.joints };
  // World axis + pivot of a bearing: the parent connector's frame (same
  // construction as computeJointLimits) — lets a task ask for a VERTICAL
  // door hinge or a HORIZONTAL hood hinge.
  const axisOf = (j: (typeof inf.joints)[number]): { axis?: V3; pivot?: V3 } => {
    const pf = frames.get(j.parent.partId);
    const pp = eparts.find((p) => p.id === j.parent.partId);
    const pc = pp ? cOf(pp.part)[j.parent.conn] : undefined;
    if (!pf || !pc) return {};
    const W = compose(pf, connFrame(pc));
    const a = mulMV(W.r, [0, 1, 0]);
    const n = Math.hypot(a[0], a[1], a[2]) || 1;
    return { axis: [a[0] / n, a[1] / n, a[2] / n], pivot: W.o };
  };
  const joints: JointInfo[] = inf.joints
    .filter((j) => j.kind === "revolute")
    .map((j) => ({
      id: j.id,
      parent: j.parent.partId,
      child: j.child.partId,
      kind: "revolute" as const,
      pinned: !!j.locked || bodyOf[j.parent.partId] === bodyOf[j.child.partId],
      moving: subtreeOf(doc, j).size,
      parts: [...subtreeOf(doc, j)],
      ...axisOf(j),
    }));
  // Which bodies touch which through a bearing (for "floating gear").
  const bearingBodies = new Set<number>();
  for (const pr of inf.pairs) if (pr.kind === "revolute" || motorPair(pr)) { bearingBodies.add(bodyOf[pr.a]); bearingBodies.add(bodyOf[pr.b]); }

  const cellCache = new Map<number, Set<number> | null>();
  const gapIdx = new Set(unknownConns);
  const nearGapPart = (pi: number): boolean => {
    const f = frames.get(pi)!;
    for (const g of gapIdx) {
      const o = frames.get(g)!.o;
      if (Math.hypot(o[0] - f.o[0], o[1] - f.o[1], o[2] - f.o[2]) < 40) return true;
    }
    return false;
  };

  // Gears.
  const gears: GearInfo[] = [];
  parts.forEach((p, i) => {
    const name = nameOf(p.part);
    const kind = gearKindOf(name);
    if (!kind) return;
    const teeth = teethOf(name) ?? 0;
    const f = frames.get(i)!;
    const cs = cOf(p.part);
    // the bore: female round/axle section nearest the part origin
    const bores = cs.filter((c) => c.kind === "cyl" && c.gender === "F");
    const pick = (bores.length ? bores : cs).slice().sort((a, b) => norm(a.local) - norm(b.local))[0];
    let axis: V3 = unit(mulMV(f.r, [0, 1, 0]));
    let axisPt: V3 = f.o;
    if (pick) {
      const w = compose(f, connFrame(pick));
      axis = unit(mulMV(w.r, [0, 1, 0]));
      axisPt = w.o;
    }
    // centre = voxel bbox centre projected onto the axis line
    let center = axisPt;
    const vd = vox.parts[p.part];
    if (vd) {
      const lc: V3 = [vd.min[0] + (vd.dims[0] * vox.res) / 2, vd.min[1] + (vd.dims[1] * vox.res) / 2, vd.min[2] + (vd.dims[2] * vox.res) / 2];
      const wc = add(f.o, mulMV(f.r, lc));
      const t = dot(sub(wc, axisPt), axis);
      center = add(axisPt, scale(axis, t));
    }
    gears.push({ part: i, partId: p.part, teeth, kind, body: bodyOf[i], center, axis, pitchRadius: kind === "knob" ? 10 : PITCH_LDU_PER_TOOTH * teeth });
  });

  // Meshes — measured against the module.
  const meshes: MeshInfo[] = [];
  const meshable = (g: GearInfo) => g.teeth > 0 && (g.kind === "spur" || g.kind === "bevel" || g.kind === "crown" || g.kind === "turntable" || g.kind === "knob");
  const lineDist = (p: V3, q: V3, a: V3) => {
    // distance from point p to the line through q with direction a
    const d = sub(p, q);
    return norm(sub(d, scale(a, dot(d, a))));
  };
  for (let i = 0; i < gears.length; i++) {
    for (let j = i + 1; j < gears.length; j++) {
      const A = gears[i], B = gears[j];
      if (!meshable(A) || !meshable(B)) continue;
      if (A.body === B.body) continue; // same rigid body: compound gear, not a mesh
      const c = Math.abs(dot(A.axis, B.axis));
      const expected = A.pitchRadius + B.pitchRadius;
      const cd = norm(sub(A.center, B.center));
      if (c > 0.97) {
        // parallel: centre distance off-axis ≈ rA + rB, and axially overlapping
        const off = lineDist(B.center, A.center, A.axis);
        const axial = Math.abs(dot(sub(B.center, A.center), A.axis));
        if (Math.abs(off - expected) <= 3 && axial <= 14) {
          meshes.push({ a: i, b: j, ratio: meshRatio(A, B), geometry: "parallel", centerDistance: off, expected });
        }
      } else if (c < 0.12 && (A.kind !== "spur" || B.kind !== "spur") && (A.kind !== "knob") === (B.kind !== "knob")) {
        // perpendicular (bevel/crown): axes cross, and each centre sits
        // about the partner's pitch radius from the partner's axis
        const dA = lineDist(A.center, B.center, B.axis); // A centre → B axis ≈ rA… within LEGO's bevel offsets
        const dB = lineDist(B.center, A.center, A.axis);
        const w = cross(A.axis, B.axis);
        const axesGap = Math.abs(dot(sub(B.center, A.center), unit(w)));
        if (axesGap <= 5 && Math.abs(dA - A.pitchRadius) <= 10 && Math.abs(dB - B.pitchRadius) <= 10) {
          meshes.push({ a: i, b: j, ratio: meshRatio(A, B), geometry: "perpendicular", centerDistance: cd, expected });
        }
      }
    }
  }
  // Rack and pinion: a gear whose pitch circle touches the rack's pitch line, turning in the plane the rack
  // lies in. The rack's shape is read from its voxel box: it runs along its longest side, and its pitch line
  // sits a few LDU inside the toothed face (measured on 87761: pitch line 5 LDU inside a 20 LDU tall rack).
  for (let ri = 0; ri < gears.length; ri++) {
    const R = gears[ri];
    if (R.kind !== "rack") continue;
    const vd = vox.parts[R.partId];
    const f = frames.get(R.part)!;
    if (!vd) continue;
    const half = [0, 1, 2].map((k) => (vd.dims[k] * vox.res) / 2);
    const long = half.indexOf(Math.max(...half));
    const col = (k: number): V3 => [f.r[k], f.r[k + 3], f.r[k + 6]];
    const dir = unit(col(long));
    const mid = add(f.o, mulMV(f.r, [vd.min[0] + half[0], vd.min[1] + half[1], vd.min[2] + half[2]]));
    for (let gi = 0; gi < gears.length; gi++) {
      const G = gears[gi];
      if (!meshable(G) || G.kind === "knob" || G.body === R.body) continue;
      if (Math.abs(dot(G.axis, dir)) > 0.12) continue; // the gear must turn in a plane the rack runs through
      const d = sub(G.center, mid);
      const along = dot(d, dir), axial = dot(d, G.axis);
      if (Math.abs(along) > half[long] + 4 || Math.abs(axial) > 14) continue;
      const perp = sub(sub(d, scale(dir, along)), scale(G.axis, axial));
      const dist = norm(perp);
      if (dist < 1) continue;
      const n = unit(perp); // from the rack's centre line towards the gear
      const thick = [0, 1, 2].reduce((t, k) => t + half[k] * Math.abs(dot(col(k), n)), 0); // the rack's half-height on the gear's side
      const gap = dist - G.pitchRadius; // where the pitch line would be, measured from the centre line
      if (gap < thick - 9 || gap > thick + 2) continue;
      // the rack moves with the gear's rim at the point of contact
      const lduPerRad = dot(cross(G.axis, scale(n, -G.pitchRadius)), dir);
      meshes.push({ a: gi, b: ri, ratio: 0, geometry: "rack", centerDistance: dist, expected: G.pitchRadius + thick - 5, slide: { dir, lduPerRad } });
    }
  }

  // Chain drive: a loop of chain links wrapped round sprockets. A sprocket is engaged when several links lie
  // on its pitch circle (measured on 42035: 16T sprockets, links 20–22 LDU from the axis, pitch radius 20).
  // Two sprockets inside the loop turn the same way; one pressing on the chain from outside turns against it.
  const isLink = (i: number) => /^3711[ab]?$|^3873$/i.test(parts[i].part) || /chain (link|tread)|^technic link\b/i.test(nameOf(parts[i].part));
  const linkIdx = parts.map((_, i) => i).filter(isLink);
  const chainOf = new Map<number, number[]>(); // gear index → the links of the chain it is on
  const chains: { links: number[]; on: { g: number; inside: boolean }[] }[] = [];
  {
    const left = new Set(linkIdx);
    while (left.size) {
      const loop: number[] = [];
      const queue = [left.values().next().value as number];
      left.delete(queue[0]);
      while (queue.length) {
        const i = queue.shift()!;
        loop.push(i);
        for (const j of [...left]) if (norm(sub(frames.get(i)!.o, frames.get(j)!.o)) < 24) { left.delete(j); queue.push(j); }
      }
      if (loop.length < 6) continue;
      const on: { g: number; inside: boolean }[] = [];
      gears.forEach((G, gi) => {
        if (G.kind !== "spur" || G.teeth <= 0) return;
        let onCircle = 0;
        for (const i of loop) {
          const d = sub(frames.get(i)!.o, G.center);
          const ax = dot(d, G.axis);
          const rad = norm(sub(d, scale(G.axis, ax)));
          if (Math.abs(ax) <= 12 && rad >= G.pitchRadius - 3 && rad <= G.pitchRadius + 4) onCircle++;
        }
        if (onCircle < 3) return;
        // inside the loop? project onto the sprocket's plane and count crossings of a ray with the loop, taken in order of angle
        const u = unit(Math.abs(G.axis[0]) < 0.9 ? cross(G.axis, [1, 0, 0]) : cross(G.axis, [0, 1, 0])), v = cross(G.axis, u);
        const pts = loop.map((i) => { const d = sub(frames.get(i)!.o, G.center); return [dot(d, u), dot(d, v)] as [number, number]; });
        const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
        pts.sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
        let inside = false;
        for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
          const [x1, y1] = pts[k], [x2, y2] = pts[j];
          if (y1 > 0 !== y2 > 0 && 0 < ((x2 - x1) * (0 - y1)) / (y2 - y1) + x1) inside = !inside;
        }
        on.push({ g: gi, inside });
      });
      if (on.length < 2) continue;
      chains.push({ links: loop, on });
      for (let k = 1; k < on.length; k++) {
        const A = gears[on[0].g], B = gears[on[k].g];
        if (A.body === B.body) continue;
        meshes.push({ a: on[0].g, b: on[k].g, ratio: (on[0].inside === on[k].inside ? 1 : -1) * (A.teeth / B.teeth), geometry: "chain", centerDistance: norm(sub(A.center, B.center)), expected: 0 });
      }
      for (const o of on) chainOf.set(o.g, loop);
    }
  }

  // Tooth phase: two gears at the right centre distance can still sit
  // tooth-on-tooth. Roll gear A about its own axis through one tooth pitch
  // and find the pose with the least shared voxels; if the as-built pose
  // shares clearly more than that minimum, the teeth clash. Reported with
  // the roll that fixes it.
  for (const m of meshes) {
    // parallel (spur) meshes only: a correct spur mesh shares ~0 voxels and a
    // tooth-on-tooth one ~80; bevel/crown pairs share voxels legitimately
    // (thick teeth engage across the axis), so they are not judged here yet
    if (m.geometry !== "parallel") continue;
    const A = gears[m.a], B = gears[m.b];
    const pa = parts[A.part], pb = parts[B.part];
    const fa = ldrawFrameOf(pa, hOf) as Frame;
    const cellsB = worldCells(pb, vox, hOf);
    if (!cellsB) continue;
    const pitch = 360 / Math.max(1, A.teeth);
    const shared = (deg: number) => {
      const f = deg === 0 ? fa : rotAboutLine(A.axis, A.center, deg)(fa);
      const ca = worldCells({ ...pa, x: f.o[0], y: -f.o[1], z: -f.o[2], m: f.r.slice() }, vox, hOf);
      if (!ca) return 0;
      let n = 0;
      for (const k of ca) if (cellsB.has(k)) n++;
      return n;
    };
    const now = shared(0);
    let best = now, bestDeg = 0;
    for (let deg = pitch / 8; deg < pitch; deg += pitch / 8) {
      const s = shared(deg);
      if (s < best) { best = s; bestDeg = deg; }
    }
    m.phase = { sharedNow: now, sharedBest: best, rollDeg: Math.round(bestDeg * 100) / 100, clash: now > best + 12 };
  }
  log(`gears ${gears.length}, meshes ${meshes.length}`);

  // Trains: connected components over meshes + shared bodies.
  const gAdj = new Map<number, { g: number; ratio: number }[]>();
  const link = (a: number, b: number, r: number) => {
    if (!gAdj.has(a)) gAdj.set(a, []);
    if (!gAdj.has(b)) gAdj.set(b, []);
    gAdj.get(a)!.push({ g: b, ratio: r });
    gAdj.get(b)!.push({ g: a, ratio: 1 / r });
  };
  for (const m of meshes) if (m.geometry !== "rack") link(m.a, m.b, m.ratio);
  // a rack hangs off its pinion: it is not a gear with a speed, it is a body the pinion slides
  const rackMeshes = meshes.filter((m) => m.geometry === "rack");
  const drivenRacks = new Set(rackMeshes.map((m) => m.b));
  for (const m of rackMeshes) if (!gAdj.has(m.a)) gAdj.set(m.a, []); // a lone pinion on a rack is a train too
  const byBody = new Map<number, number[]>();
  gears.forEach((g, gi) => {
    if (!byBody.has(g.body)) byBody.set(g.body, []);
    byBody.get(g.body)!.push(gi);
  });
  for (const gs of byBody.values()) for (let k = 1; k < gs.length; k++) link(gs[0], gs[k], 1);

  const seen = new Set<number>();
  const trains: TrainInfo[] = [];
  gears.forEach((_, gi) => {
    if (seen.has(gi) || !gAdj.has(gi)) return;
    // BFS from the lowest-index gear; ω per gear relative to the driver
    const omega = new Map<number, number>([[gi, 1]]);
    const queue = [gi];
    seen.add(gi);
    let conflict: string | undefined;
    while (queue.length) {
      const g = queue.shift()!;
      for (const e of gAdj.get(g) ?? []) {
        const w = omega.get(g)! * e.ratio;
        if (omega.has(e.g)) {
          if (Math.abs(omega.get(e.g)! - w) > 1e-3 * Math.max(1, Math.abs(w)))
            conflict ??= `gear loop is inconsistent: ${gears[e.g].partId}#${gears[e.g].part} would have to turn at both ${omega.get(e.g)!.toFixed(3)}× and ${w.toFixed(3)}× the driver`;
          continue;
        }
        omega.set(e.g, w);
        seen.add(e.g);
        queue.push(e.g);
      }
    }
    const gs = [...omega.keys()];
    const racks = rackMeshes.filter((m) => omega.has(m.a));
    const bodySet = [...new Set([...gs.map((g) => gears[g].body), ...racks.map((m) => gears[m.b].body)])];
    const ratios: Record<number, number> = {};
    for (const m of racks) ratios[gears[m.b].body] = 0;
    for (const g of gs) ratios[gears[g].body] = omega.get(g)!;
    const chainLinks = [...new Set(gs.flatMap((g) => chainOf.get(g) ?? []))];
    let blocked = conflict;
    let unverifiable: string | undefined;
    // a differential / worm / rack in the train: its kinematics are not
    // modelled, so any loop through it is meaningless — report, don't judge
    // (a rack driven by a pinion IS modelled: it slides)
    const exotic = gs.filter((g) => gears[g].kind === "differential" || gears[g].kind === "worm" || gears[g].kind === "rack");
    const touchesExotic = exotic.length > 0 || gs.some((g) => gears.some((h, hi) => (h.kind === "differential" || h.kind === "worm" || (h.kind === "rack" && !drivenRacks.has(hi))) && h.body === gears[g].body));
    if (touchesExotic) {
      unverifiable = `train contains ${[...new Set(exotic.map((g) => gears[g].kind))].join("/") || "an unmodelled gear kind"} — differential/worm/rack kinematics are not modelled`;
      blocked = undefined;
    }
    if (!blocked && !unverifiable && bodySet.includes(largestBody))
      blocked = `gear ${gs.filter((g) => gears[g].body === largestBody).map((g) => `${gears[g].partId}#${gears[g].part}`).join(", ")} is rigidly part of the chassis (keyed into a fixed axle hole) — the train cannot turn`;
    if (!blocked && !unverifiable) {
      const floating = gs.filter((g) => !bearingBodies.has(gears[g].body));
      if (floating.length) {
        // no bearing detected: either the gear really floats, or its axle
        // passes through a part the mate engine cannot read
        const msg = `gear ${floating.map((g) => `${gears[g].partId}#${gears[g].part}`).join(", ")} has no readable bearing (its body touches nothing through a round bore in the connector library)`;
        const touchesOther = floating.some((g) => {
          const body = gears[g].body;
          const others = parts.map((_, i) => i).filter((i) => bodyOf[i] !== body);
          return bodies[body].some((pi) => touchesAny(parts, pi, others, meta, vox, cellCache) != null);
        });
        if (touchesOther || floating.some((g) => bodies[gears[g].body].some((pi) => nearGapPart(pi)))) unverifiable = `${msg} — but it is in physical contact with other parts, so the bearing may be a library gap`;
        else blocked = `${msg} — it touches nothing: it is floating`;
      }
    }
    const outputs = bodySet.filter((b) => b !== gears[gi].body).map((b) => ({ body: b, ratio: ratios[b] }));
    const drive: NonNullable<TrainInfo["drive"]> = bodySet.map((b) => {
      const gx = gs.find((x) => gears[x].body === b);
      if (gx != null) return { body: b, parts: bodies[b].slice(), axis: gears[gx].axis, center: gears[gx].center, ratio: ratios[b] };
      const m = racks.find((x) => gears[x.b].body === b)!;
      return { body: b, parts: bodies[b].slice(), axis: m.slide!.dir, center: gears[m.b].center, ratio: 0, slide: { dir: m.slide!.dir, lduPerDeg: (omega.get(m.a)! * m.slide!.lduPerRad * Math.PI) / 180 } };
    });
    trains.push({ id: trains.length, driver: gi, gears: [...gs, ...racks.map((m) => m.b)], bodies: bodySet, ratios, outputs, sweep: null, blocked, unverifiable, drive, chain: chainLinks.length ? chainLinks : undefined });
  });
  // gears with no partner at all → single-gear "trains" so the report lists them
  const info: MechanismInfo = {
    bodies: bodies.length,
    bodySizes: bodies.map((b) => b.length),
    bodyOf: bodyOf.slice(),
    joints,
    movable: joints.filter((j) => !j.pinned).length,
    pinned: joints.filter((j) => j.pinned).length,
    gears,
    meshes,
    trains,
  };
  const ctx: MechanismContext = { parts, eparts, frames, bodyOf, bodies, doc, inf, info, unknownConns, cOf, meta, vox };
  if (!opts.noSweep) runSweeps(ctx, opts);
  return ctx;
}

/**
 * Copy sweep results measured EARLIER on the same parts (spec consolidation,
 * calibration re-runs where only the postconditions changed) into `ctx`, instead
 * of measuring them again — the sweeps are 99 % of a big set's grading time.
 * Returns false, and changes nothing, unless the cached mechanism matches this
 * one bearing for bearing and train for train; callers fall back to runSweeps.
 */
export function applySweeps(ctx: MechanismContext, cached: MechanismInfo): boolean {
  const info = ctx.info;
  if (cached.joints.length !== info.joints.length || cached.trains.length !== info.trains.length || cached.gears.length !== info.gears.length) return false;
  // matched by bearing id, not by position: the joint list's order is not part of the contract
  const jBy = new Map(cached.joints.map((j) => [j.id, j]));
  for (const a of info.joints) {
    const b = jBy.get(a.id);
    if (!b || a.parent !== b.parent || a.child !== b.child || a.pinned !== b.pinned) return false;
  }
  const tBy = new Map(cached.trains.map((t) => [t.id, t]));
  for (const a of info.trains) {
    const b = tBy.get(a.id);
    if (!b || a.driver !== b.driver || a.gears.join() !== b.gears.join()) return false;
  }
  for (const j of info.joints) {
    const b = jBy.get(j.id)!;
    if (b.arc) j.arc = b.arc;
  }
  for (const t of info.trains) {
    const b = tBy.get(t.id)!;
    t.sweep = b.sweep ?? null;
    if (b.drive) t.drive = b.drive;
  }
  return true;
}

/** Joint arcs (collision-swept) and gear-train actuation sweeps. */
export function runSweeps(ctx: MechanismContext, opts: MechanismOpts = {}): void {
  const log = opts.log ?? (() => {});
  const { doc, frames, info, cOf, meta, vox } = ctx;
  const max = opts.maxJointSweeps ?? 24;
  const order = info.joints
    .filter((j) => !j.pinned && (!opts.onlyJoints || opts.onlyJoints.includes(j.id)))
    .sort((a, b) => (b.moving ?? 0) - (a.moving ?? 0))
    .slice(0, max);
  const t1 = Date.now();
  for (const ji of order) {
    const j = doc.joints.find((x) => x.id === ji.id)!;
    ji.arc = computeJointLimits(doc, frames, j, cOf, vox, meta);
  }
  if (order.length) log(`joint arcs: ${order.length} measured in ${Date.now() - t1}ms`);
  for (const tr of info.trains) if (!tr.blocked && !tr.unverifiable && (!opts.onlyTrains || opts.onlyTrains.includes(tr.id))) tr.sweep = sweepTrain(ctx, tr, vox, meta, opts);
}

/** ω_B/ω_A from pitch-point velocity matching (works for spur and bevel). */
function meshRatio(A: GearInfo, B: GearInfo): number {
  // pitch point: from A's centre toward B's centre, perpendicular to A's axis, at rA
  const d = sub(B.center, A.center);
  const perp = unit(sub(d, scale(A.axis, dot(d, A.axis))));
  const p = add(A.center, scale(perp, A.pitchRadius));
  const vA = cross(A.axis, sub(p, A.center)); // velocity at p for ω_A = 1
  const wB = cross(B.axis, sub(p, B.center)); // velocity at p per unit ω_B
  const den = dot(wB, wB);
  if (den < 1e-6) return -(A.teeth / B.teeth);
  const r = dot(vA, wB) / den;
  // snap magnitude to the tooth ratio (geometry noise), keep the measured sign
  const mag = A.teeth / B.teeth;
  return (r < 0 ? -1 : 1) * mag;
}

/**
 * Drive a train through a full turn of its driver and look for growing
 * interpenetration. Baseline overlaps at rest are subtracted (voxel
 * models of meshing teeth overlap a little by construction).
 */
export function sweepTrain(ctx: MechanismContext, tr: TrainInfo, vox: VoxelData, meta: PartMetaMap, opts: MechanismOpts): TrainInfo["sweep"] {
  const t0 = Date.now();
  const { parts, frames, bodyOf, info } = ctx;
  const stepDeg = opts.stepDeg ?? 10;
  // Overlap is measured DEEP (interior cells of both parts): the voxel
  // skin that re-rasterises as a part rotates drops out, so the allowance
  // can be small. A real jam is material inside material that grows and
  // STAYS as the driver turns. Bearings (axle cross spinning in a bore)
  // get a wider allowance for the cross section's re-rasterisation.
  const tol = opts.jamTolLdu3 ?? 30;
  const bearingTol = tol * 3;
  const bearingPairs = new Set<string>();
  for (const j of info.joints) bearingPairs.add(`${Math.min(j.parent, j.child)}/${Math.max(j.parent, j.child)}`);
  const hOf = (p: string) => meta[p]?.h ?? 24;
  type Motion = { axis: V3; center: V3; ratio: number; slide?: { dir: V3; lduPerDeg: number } };
  const bodyAxis = new Map<number, Motion>();
  for (const g of tr.gears) {
    const G = info.gears[g];
    const d = tr.drive?.find((x) => x.body === G.body);
    if (!bodyAxis.has(G.body)) bodyAxis.set(G.body, d?.slide ? { axis: d.axis, center: d.center, ratio: 0, slide: d.slide } : { axis: G.axis, center: G.center, ratio: tr.ratios[G.body] });
  }
  const hasRack = [...bodyAxis.values()].some((b) => b.slide);
  // a chain's links ride round with the sprockets; they are not posed, so nothing is tested against them
  const chain = new Set(tr.chain ?? []);
  const moving = parts.map((_, i) => i).filter((i) => bodyAxis.has(bodyOf[i]) && !chain.has(i));
  const movingSet = new Set(moving);
  const radOf = (part: string) => {
    const v = vox.parts[part];
    return v ? (Math.hypot(v.dims[0], v.dims[1], v.dims[2]) * vox.res) / 2 : 20;
  };
  // reach of each mover: how far from its body axis it can swing
  const mover = moving.map((i) => {
    const b = bodyAxis.get(bodyOf[i])!;
    const f = frames.get(i)!;
    const d = sub(f.o, b.center);
    const radial = norm(sub(d, scale(b.axis, dot(d, b.axis))));
    return { i, f0: f, rad: radOf(parts[i].part), reach: radial + radOf(parts[i].part), b };
  });
  // static candidates near any mover's swept annulus
  const statics = parts.map((_, i) => i).filter((i) => !movingSet.has(i) && !chain.has(i));
  const staticCells = new Map<number, Set<number> | null>();
  const cellsOf = (i: number) => {
    if (!staticCells.has(i)) staticCells.set(i, worldCells(parts[i], vox, hOf));
    return staticCells.get(i)!;
  };
  const pairs: { m: (typeof mover)[number]; s: number; baseline: number; kind: "static" | "moving" }[] = [];
  for (const m of mover) {
    for (const s of statics) {
      const fs = frames.get(s)!;
      if (m.b.slide) {
        // a sliding part can reach whatever lies within its travel
        if (norm(sub(fs.o, m.f0.o)) <= m.rad + radOf(parts[s].part) + Math.abs(m.b.slide.lduPerDeg) * 360 + 4) pairs.push({ m, s, baseline: 0, kind: "static" });
        continue;
      }
      const d = sub(fs.o, m.b.center);
      const radial = norm(sub(d, scale(m.b.axis, dot(d, m.b.axis))));
      const axial = Math.abs(dot(d, m.b.axis));
      const axialM = Math.abs(dot(sub(m.f0.o, m.b.center), m.b.axis));
      if (Math.abs(radial - (m.reach - m.rad)) > m.rad + radOf(parts[s].part) + 4) continue;
      if (Math.abs(axial - axialM) > m.rad + radOf(parts[s].part) + 4) continue;
      pairs.push({ m, s, baseline: 0, kind: "static" });
    }
  }
  // movers of DIFFERENT bodies against each other (meshing gears, gear vs neighbour axle)
  for (let a = 0; a < mover.length; a++) {
    for (let b = a + 1; b < mover.length; b++) {
      const A = mover[a], B = mover[b];
      if (bodyOf[A.i] === bodyOf[B.i]) continue;
      if (!A.b.slide && !B.b.slide && norm(sub(A.f0.o, B.f0.o)) > A.reach + B.reach + 4) continue;
      if ((A.b.slide || B.b.slide) && norm(sub(A.f0.o, B.f0.o)) > A.rad + B.rad + 100) continue;
      pairs.push({ m: A, s: B.i, baseline: 0, kind: "moving" });
    }
  }
  const poseOf = (m: (typeof mover)[number], deg: number): Frame =>
    m.b.slide ? { r: m.f0.r, o: add(m.f0.o, scale(m.b.slide.dir, m.b.slide.lduPerDeg * deg)) } : rotAboutLine(m.b.axis, m.b.center, m.b.ratio * deg)(m.f0);
  const overlap = (a: Set<number> | null, b: Set<number> | null) => deepOverlap(a, b);
  const cellVol = vox.res ** 3;
  const largestBody = ctx.bodies.reduce((best, b, i) => (b.length > ctx.bodies[best].length ? i : best), 0);
  const jointedBodies = new Set<number>();
  for (const j of info.joints) { jointedBodies.add(bodyOf[j.parent]); jointedBodies.add(bodyOf[j.child]); }
  const excess = new Map<string, number>(); // consecutive over-tolerance steps per pair
  const evalAt = (deg: number): { jam?: { a: number; b: number; ldu3: number } } => {
    const cache = new Map<number, Set<number> | null>();
    const movCells = (m: (typeof mover)[number]) => {
      if (!cache.has(m.i)) cache.set(m.i, worldCells(toPlacement(parts[m.i].part, poseOf(m, deg)), vox, hOf));
      return cache.get(m.i)!;
    };
    let worst: { a: number; b: number; ldu3: number } | undefined;
    for (const p of pairs) {
      const other = p.kind === "static" ? cellsOf(p.s) : movCells(mover.find((x) => x.i === p.s)!);
      const o = overlap(movCells(p.m), other) * cellVol;
      if (deg === 0) {
        p.baseline = o;
        continue;
      }
      const key = `${Math.min(p.m.i, p.s)}/${Math.max(p.m.i, p.s)}`;
      const lim = bearingPairs.has(key) ? bearingTol : tol;
      const over = o - p.baseline;
      if (over > lim) {
        const n = (excess.get(key) ?? 0) + 1;
        excess.set(key, n);
        // persistent (two consecutive steps) or gross (3× the allowance)
        if ((n >= 2 || over > 3 * lim) && (!worst || over > worst.ldu3)) worst = { a: p.m.i, b: p.s, ldu3: over };
      } else excess.set(key, 0);
    }
    return worst ? { jam: worst } : {};
  };
  evalAt(0);
  const steps = Math.round(360 / stepDeg);
  // the obstacle is itself a jointed, non-chassis part: a linkage (piston, connecting rod, tie rod) that would move too
  // the obstacle is a lone part with no mate the library can read: whether it is fixed or rides along cannot be told
  const unread = (s: number) => bodyOf[s] !== largestBody && ctx.bodies[bodyOf[s]].length === 1 && !jointedBodies.has(bodyOf[s]);
  const isLinkage = (s: number) => bodyOf[s] !== largestBody && jointedBodies.has(bodyOf[s]) && !movingSet.has(s);
  if (hasRack) {
    // A rack has ends: the train is not asked for a full turn. Turn the driver each way until the rack (or
    // anything else) meets something, and report the range. A range of less than two steps is a jam.
    let first: { deg: number; a: number; b: number; ldu3: number } | undefined;
    const reach = (sign: 1 | -1) => {
      excess.clear();
      for (let k = 1; k <= steps; k++) {
        const r = evalAt(sign * k * stepDeg);
        if (r.jam) {
          if (k <= 1 && !first) first = { deg: sign * k * stepDeg, a: r.jam.a, b: r.jam.b, ldu3: r.jam.ldu3 };
          return (k - 1) * stepDeg;
        }
      }
      return 360;
    };
    const freeDeg = { max: reach(1), min: -reach(-1) };
    if (freeDeg.max - freeDeg.min >= 2 * stepDeg || !first) return { ok: true, stepDeg, steps, ms: Date.now() - t0, freeDeg };
    return {
      ok: false, stepDeg, steps, jamAtDeg: first.deg, jamParts: [first.a, first.b], jamOverlapLdu3: Math.round(first.ldu3), ms: Date.now() - t0, freeDeg,
      unverifiable: isLinkage(first.b)
        ? `#${first.a} ${parts[first.a].part} meets #${first.b} ${parts[first.b].part}, which is a jointed part of a linkage (a tie rod on a steering rack) — linkage motion is not simulated`
        : unread(first.b)
          ? `#${first.a} ${parts[first.a].part} meets #${first.b} ${parts[first.b].part}, a part with no readable connection of its own — it may well move with the rack`
          : undefined,
    };
  }
  for (let k = 1; k <= steps; k++) {
    const deg = k * stepDeg;
    const r = evalAt(deg);
    if (r.jam) {
      const s = r.jam.b;
      // the obstacle is itself a jointed, non-chassis part: a linkage
      // (piston, connecting rod, lever) that would move too — not simulated
      const linkage = bodyOf[s] !== largestBody && jointedBodies.has(bodyOf[s]) && !movingSet.has(s);
      return {
        ok: false, stepDeg, steps, jamAtDeg: deg, jamParts: [r.jam.a, s], jamOverlapLdu3: Math.round(r.jam.ldu3), ms: Date.now() - t0,
        unverifiable: linkage
          ? `#${r.jam.a} ${parts[r.jam.a].part} meets #${s} ${parts[s].part}, which is a jointed part of a linkage (piston/rod/lever) — linkage motion is not simulated`
          : unread(s)
            ? `#${r.jam.a} ${parts[r.jam.a].part} meets #${s} ${parts[s].part}, a part with no readable connection of its own (a crankshaft half, a part the connector library does not cover) — it may well turn with the train`
            : undefined,
      };
    }
  }
  return { ok: true, stepDeg, steps, ms: Date.now() - t0 };
}
