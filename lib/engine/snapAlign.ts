/**
 * Snap alignment — place a part so one of its connectors coincides with a
 * connector on an already-placed part, using LDCad shadow connection data.
 * This is the seed of connection-aware snapping; today it powers the
 * connection fixtures (correct by construction) and their tests.
 *
 * All solving happens in the LDraw frame, then converts to engine placement
 * via the X = RotX(π) world map (pos: y,z negate; matrix stored as-is).
 */
import { engineRotFromLdraw } from "./orientation";
import type { PlacedPartJson } from "../data/schemas";

export interface Snap {
  t: string;
  g?: string;
  pos: [number, number, number];
  ori?: number[];
  secs?: string;
  grid?: string;
  /** Caps spec — "one" marks a BLIND hole (open at one end only). */
  c?: string;
  /** center=true: section profile centered on pos (else it runs from
   * pos along the −axis in listed order). */
  ctr?: 1;
}
export type ConnectionMap = Record<string, Snap[]>;

type V3 = [number, number, number];

const mulMV = (m: number[], v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rodrigues rotation taking vector a onto vector b (row-major). */
function rotationFromTo(aRaw: V3, bRaw: V3): number[] {
  const unit = (v: V3): V3 => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const a = unit(aRaw);
  const b = unit(bRaw);
  const cross: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot > 0.99999) return IDENT.slice();
  if (dot < -0.99999) {
    // 180°: rotate about any axis perpendicular to a.
    const perp: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis: V3 = [
      a[1] * perp[2] - a[2] * perp[1],
      a[2] * perp[0] - a[0] * perp[2],
      a[0] * perp[1] - a[1] * perp[0],
    ];
    const n = Math.hypot(...axis) || 1;
    const [x, y, z] = axis.map((v) => v / n) as V3;
    return [
      2 * x * x - 1, 2 * x * y, 2 * x * z,
      2 * x * y, 2 * y * y - 1, 2 * y * z,
      2 * x * z, 2 * y * z, 2 * z * z - 1,
    ];
  }
  const k = 1 / (1 + dot);
  const [cx, cy, cz] = cross;
  return [
    cx * cx * k + dot, cx * cy * k - cz, cx * cz * k + cy,
    cy * cx * k + cz, cy * cy * k + dot, cy * cz * k - cx,
    cz * cx * k - cy, cz * cy * k + cx, cz * cz * k + dot,
  ];
}

/** A placement's LDraw-frame origin + rotation. */
export function ldrawFrameOf(p: PlacedPartJson, hOf: (part: string) => number): { o: V3; r: number[] } {
  if (p.m && p.m.length === 9) {
    return { o: [p.x, -p.y, -p.z], r: p.m.slice() };
  }
  const theta = ((360 - p.rot) % 360) * (Math.PI / 180); // engine→LDraw angle
  const c = Math.round(Math.cos(theta) * 1e9) / 1e9;
  const s = Math.round(Math.sin(theta) * 1e9) / 1e9;
  return { o: [p.x, -(p.y + hOf(p.part)), -p.z], r: [c, 0, s, 0, 1, 0, -s, 0, c] };
}

/** World (LDraw) position + axis of a snap on a placed part. */
export function snapWorld(
  p: PlacedPartJson,
  snap: Snap,
  hOf: (part: string) => number,
): { pos: V3; axis: V3 } {
  const f = ldrawFrameOf(p, hOf);
  const local = snap.ori ?? IDENT;
  const pos = f.o.map((v, i) => v + mulMV(f.r, snap.pos)[i]) as V3;
  const axis = mulMV(f.r, mulMV(local, [0, 1, 0]));
  const n = Math.hypot(...axis) || 1;
  return { pos, axis: [axis[0] / n, axis[1] / n, axis[2] / n] };
}

/**
 * Solve the placement of `movingPart` so its snap #movingSnapIdx coincides
 * (position + axis) with snap #fixedSnapIdx on the placed `fixed` part.
 * `slide` shifts the moving part along the shared axis (LDU).
 */
export function solveAttachment(
  fixed: PlacedPartJson,
  fixedSnap: Snap,
  movingPart: string,
  movingSnap: Snap,
  color: number,
  hOf: (part: string) => number,
  slide = 0,
  /** Extra roll about the shared axis (degrees) — the free DOF of a mate. */
  roll = 0,
  /** Mate anti-parallel instead of parallel (flip the moving part). */
  flip = false,
): PlacedPartJson {
  const target = snapWorld(fixed, fixedSnap, hOf);
  const axis: V3 = flip
    ? [-target.axis[0], -target.axis[1], -target.axis[2]]
    : target.axis;
  const movLocalOri = movingSnap.ori ?? IDENT;
  const movLocalAxis = mulMV(movLocalOri, [0, 1, 0]);
  let R = rotationFromTo(movLocalAxis as V3, axis);
  if (roll !== 0) R = mulMM(rotationAboutAxis(target.axis, roll), R);
  // Moving part rotation in LDraw frame; then origin so snap pos lands on target.
  const snapWorldOffset = mulMV(R, movingSnap.pos);
  const o: V3 = [
    target.pos[0] - snapWorldOffset[0] + target.axis[0] * slide,
    target.pos[1] - snapWorldOffset[1] + target.axis[1] * slide,
    target.pos[2] - snapWorldOffset[2] + target.axis[2] * slide,
  ];
  return {
    part: movingPart,
    color,
    x: o[0],
    y: -o[1],
    z: -o[2],
    rot: 0,
    m: R,
  };
}

/** Rotation about an arbitrary unit axis (row-major, degrees). */
function rotationAboutAxis(axis: V3, deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const [x, y, z] = axis;
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

const mulMM = (a: number[], b: number[]): number[] => {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};

/**
 * Solve with PHYSICAL seating: "push the part on until it stops."
 * The joint axis is the only free direction; the correct position is the
 * one closest to snap coincidence with ZERO volumetric overlap between
 * the two parts — decided by their real (voxelized) geometry, no
 * engagement constants. Parts that interpenetrate BY DESIGN (tires on
 * rims: gen mates) never reach zero and stay at coincidence.
 */
export function solveAttachmentSeated(
  fixed: PlacedPartJson,
  fixedSnap: Snap,
  movingPart: string,
  movingSnap: Snap,
  color: number,
  hOf: (part: string) => number,
  overlapOf: (candidate: PlacedPartJson) => number,
  roll = 0,
  flip = false,
): PlacedPartJson {
  const at = (slide: number) =>
    solveAttachment(fixed, fixedSnap, movingPart, movingSnap, color, hOf, slide, roll, flip);
  // Only protruding cylinders (pins/studs/bars) have a seat to find; gen
  // mates (tire-on-rim), clips, and hinges live AT coincidence.
  if (fixedSnap.g !== "M" || fixedSnap.t !== "cyl") return at(0);
  const zero = at(0);
  if (overlapOf(zero) === 0) return zero;
  // Walk outward in both directions; the first zero-overlap position
  // closest to coincidence is the physical seat. The walk is BOUNDED by
  // the joint's engagement range — a pose beyond it is not attached at
  // all, so "no fit within range" must surface as a failure, not a
  // detached part that happens to be collision-free.
  for (let mag = 1; mag <= 18; mag++) {
    for (const dir of [1, -1]) {
      const candidate = at(dir * mag);
      if (overlapOf(candidate) === 0) return candidate;
    }
  }
  return zero; // interpenetrates everywhere — surface the truth at coincidence
}

/** Convenience pickers. */
export const firstSnap = (
  conns: ConnectionMap,
  part: string,
  pred: (s: Snap) => boolean,
): Snap | undefined => (conns[part] ?? []).find(pred);

export const engineAxis = (p: PlacedPartJson, snap: Snap, hOf: (part: string) => number): V3 => {
  const w = snapWorld(p, snap, hOf);
  return [w.axis[0], -w.axis[1], -w.axis[2]];
};

export { engineRotFromLdraw };
