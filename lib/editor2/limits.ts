/**
 * Collision-swept joint limits — the missing physics that made "revolute"
 * single-stud panels tear through the model. A joint may only move through
 * its collision-free arc: we sweep the angle in 5° steps, rigidly rotating
 * the joint's subtree about its world axis (exact for a single-joint
 * change — no re-solve needed), and voxel-test the moving parts against
 * nearby static parts. Overlap beyond the as-built baseline (engaged studs
 * legitimately interpenetrate a little) marks the arc's end.
 *
 * A joint whose free arc is negligible is LOCKED BY CONTACT — that's the
 * honest classification for a fender held by one stud against a body.
 */
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";
import { pairOverlap, type VoxelData } from "../engine/voxelCollision";
import type { LocalConnector } from "../engine/connectionGraph";
import { compose, connFrame, mulMV, mulMM, type E2Doc, type E2Joint, type Frame, type V3 } from "./kinematics";

const STEP_DEG = 5;
const TOL_LDU3 = 60; // extra interpenetration allowed beyond baseline
/**
 * A bearing's own two parts interpenetrate by construction (a hinge pin in its
 * cylinder, an axle in its bore) and their shared cells re-rasterise as the
 * joint turns: on a 1x4 swivel hinge (3830/3831) the pair's raw overlap wanders
 * 34–147 LDU³ around an 18 LDU³ baseline through a full free turn, while a real
 * hit (the hinge arm into the base brick) reads 400+ at 5° and climbs. So a
 * pair joined by a revolute joint gets a wider tolerance than strangers.
 */
const BEARING_TOL_LDU3 = 250;
const NEAR_MARGIN = 8; // LDU added to radius prefilter

/** All parts driven (transitively) through this joint. */
export function subtreeOf(doc: E2Doc, joint: E2Joint): Set<number> {
  const children = new Map<number, number[]>();
  for (const j of doc.joints) {
    if (!children.has(j.parent.partId)) children.set(j.parent.partId, []);
    children.get(j.parent.partId)!.push(j.child.partId);
  }
  const out = new Set<number>();
  const queue = [joint.child.partId];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) queue.push(c);
  }
  return out;
}

/** LDraw frame → engine-space oriented placement (matrix form, no meta). */
const toPlacement = (part: string, f: Frame): PlacedPartJson => ({
  part,
  color: 0,
  x: f.o[0],
  y: -f.o[1],
  z: -f.o[2],
  rot: 0,
  m: f.r.slice(),
});

/** Rotation about a world line (axis through pivot), as a frame transform. */
export function rotAboutLine(axis: V3, pivot: V3, deg: number): (f: Frame) => Frame {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const [x, y, z] = axis;
  const R = [
    c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s,
    y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s,
    z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c),
  ];
  return (f) => ({
    r: mulMM(R, f.r),
    o: mulMV(R, [f.o[0] - pivot[0], f.o[1] - pivot[1], f.o[2] - pivot[2]]).map(
      (v, i) => v + pivot[i],
    ) as V3,
  });
}

export interface JointLimits {
  min: number;
  max: number;
}

/** What stopped the sweep at one end of the arc. */
export interface JointStop {
  /** +1 for the max end, -1 for the min end. */
  dir: 1 | -1;
  /** The last free angle in that direction (the reported limit). */
  limit: number;
  /** The first blocked angle (one step past the limit). */
  deg: number;
  /** Part ids: the swept part that hit, and what it hit. */
  mover: number;
  obstacle: number;
  /** Interpenetration at the blocked step, and the tolerance it exceeded. */
  overlap: number;
  baseline: number;
  tol: number;
}

/** Limits plus the collision that ended each direction (null = ran the full 180°). */
export interface JointSweep extends JointLimits {
  stops: { plus: JointStop | null; minus: JointStop | null };
}

export function computeJointLimits(
  doc: E2Doc,
  frames: Map<number, Frame>,
  joint: E2Joint,
  connectorsOf: (part: string) => LocalConnector[],
  vox: VoxelData,
  meta: PartMetaMap,
): JointLimits {
  const { min, max } = explainJointLimits(doc, frames, joint, connectorsOf, vox, meta);
  return { min, max };
}

/**
 * The same sweep, keeping the evidence: which part ran into which, at what
 * angle and how deep. The limit alone says a door opens 80°; this says the
 * door stopped because its handle reached the wing, which is what a reader
 * (and a figure) needs to believe the number.
 */
export function explainJointLimits(
  doc: E2Doc,
  frames: Map<number, Frame>,
  joint: E2Joint,
  connectorsOf: (part: string) => LocalConnector[],
  vox: VoxelData,
  meta: PartMetaMap,
): JointSweep {
  const partById = new Map(doc.parts.map((p) => [p.id, p]));
  const moving = subtreeOf(doc, joint);

  // World joint axis (parent connector frame).
  const pPart = partById.get(joint.parent.partId);
  const pFrame = frames.get(joint.parent.partId);
  if (!pPart || !pFrame) return { min: -180, max: 180, stops: { plus: null, minus: null } };
  const pc = connectorsOf(pPart.part)[joint.parent.conn];
  if (!pc) return { min: -180, max: 180, stops: { plus: null, minus: null } };
  const Wp = compose(pFrame, connFrame(pc));
  const axisRaw = mulMV(Wp.r, [0, 1, 0]);
  const n = Math.hypot(...axisRaw) || 1;
  const axis: V3 = [axisRaw[0] / n, axisRaw[1] / n, axisRaw[2] / n];
  const pivot = Wp.o;

  // Radius per part from voxel dims (for the proximity prefilter).
  const radOf = (part: string): number => {
    const v = vox.parts[part];
    if (!v) return 20;
    return (Math.hypot(v.dims[0], v.dims[1], v.dims[2]) * vox.res) / 2;
  };

  interface Actor {
    id: number;
    part: string;
    f0: Frame;
    rad: number;
    /** Max distance from pivot — bounds how far it can travel while swept. */
    reach: number;
  }
  const movers: Actor[] = [];
  const statics: Actor[] = [];
  for (const p of doc.parts) {
    const f = frames.get(p.id);
    if (!f) continue;
    const rad = radOf(p.part);
    const d = Math.hypot(f.o[0] - pivot[0], f.o[1] - pivot[1], f.o[2] - pivot[2]);
    const actor: Actor = { id: p.id, part: p.part, f0: f, rad, reach: d + rad };
    (moving.has(p.id) ? movers : statics).push(actor);
  }

  // Candidate collision pairs: static parts a swept mover could ever reach.
  const bearingPairs = new Set<string>();
  for (const j of doc.joints) if (j.kind === "revolute") bearingPairs.add(`${j.parent.partId}:${j.child.partId}`);
  const isBearing = (a: number, b: number) => bearingPairs.has(`${a}:${b}`) || bearingPairs.has(`${b}:${a}`);
  const pairs: { m: Actor; s: Actor; baseline: number; tol: number }[] = [];
  for (const m of movers) {
    for (const s of statics) {
      const ds = Math.hypot(s.f0.o[0] - pivot[0], s.f0.o[1] - pivot[1], s.f0.o[2] - pivot[2]);
      if (Math.abs(ds - m.reach) > m.rad + s.rad + NEAR_MARGIN && ds > m.reach + s.rad) continue;
      pairs.push({ m, s, baseline: -1, tol: isBearing(m.id, s.id) ? BEARING_TOL_LDU3 : TOL_LDU3 });
    }
  }

  const overlapAt = (pair: { m: Actor; s: Actor }, deg: number): number => {
    const rot = rotAboutLine(axis, pivot, deg);
    return pairOverlap(toPlacement(pair.m.part, rot(pair.m.f0)), toPlacement(pair.s.part, pair.s.f0), meta, vox);
  };
  for (const pair of pairs) {
    pair.baseline = overlapAt(pair, 0);
    // Any pair that already interpenetrates at rest is a mate (a coaxial second
    // hinge, a pin in a hole the joint inference folded into the body): its
    // re-rasterisation noise is the same as the bearing's own.
    if (pair.baseline > 0) pair.tol = Math.max(pair.tol, BEARING_TOL_LDU3);
  }

  /** null when free; otherwise the pair that blocks, deepest first. */
  const blockAt = (deg: number): { pair: (typeof pairs)[number]; overlap: number } | null => {
    let worst: { pair: (typeof pairs)[number]; overlap: number } | null = null;
    for (const pair of pairs) {
      const near =
        Math.hypot(
          ...(rotAboutLine(axis, pivot, deg)(pair.m.f0).o.map((v, i) => v - pair.s.f0.o[i]) as V3),
        ) <=
        pair.m.rad + pair.s.rad + 2;
      if (!near) continue;
      const ov = overlapAt(pair, deg);
      if (ov > pair.baseline + pair.tol && (!worst || ov > worst.overlap)) worst = { pair, overlap: ov };
    }
    return worst;
  };

  const run = (dir: 1 | -1): { limit: number; stop: JointStop | null } => {
    let limit = 0;
    for (let k = 1; k * STEP_DEG <= 180; k++) {
      const a = dir * k * STEP_DEG;
      const hit = blockAt(a);
      if (hit) {
        return {
          limit,
          stop: {
            dir,
            limit,
            deg: a,
            mover: hit.pair.m.id,
            obstacle: hit.pair.s.id,
            overlap: Math.round(hit.overlap),
            baseline: Math.round(hit.pair.baseline),
            tol: hit.pair.tol,
          },
        };
      }
      limit = a;
    }
    return { limit, stop: null };
  };

  const plus = run(1);
  const minus = run(-1);
  return { min: minus.limit, max: plus.limit, stops: { plus: plus.stop, minus: minus.stop } };
}
