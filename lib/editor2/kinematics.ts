/**
 * editor2 kinematic core — parts + explicit JOINTS with degrees of freedom
 * (Fusion 360 "mates" applied to LEGO connectors).
 *
 * A document is parts (some with an explicit root frame) and joints. A joint
 * mates one connector on a parent part to one connector on a child part; the
 * child's world frame is COMPUTED from the parent's frame, the two connector
 * frames, and the joint value (angle about the connector axis for revolute
 * joints). Change the angle → the child (and everything jointed onto it)
 * swings. All math in the LDraw frame (row-major 3×3 + origin).
 */
import type { ConnectionMap } from "../engine/snapAlign";
import { expandedConnectors, type LocalConnector } from "../engine/connectionGraph";

export type V3 = [number, number, number];
export interface Frame {
  o: V3;
  r: number[]; // row-major 3×3
}

export interface E2Part {
  id: number;
  part: string;
  color: number;
  /** Explicit world frame; null when a joint drives this part. */
  root: Frame | null;
}

export type JointKind = "rigid" | "revolute";

export interface E2Joint {
  id: number;
  parent: { partId: number; conn: number };
  child: { partId: number; conn: number };
  kind: JointKind;
  /** Revolute angle in degrees, about the parent connector's axis. */
  angle: number;
  /** Anti-align the connector axes (mating direction), e.g. hinge fingers. */
  flip: boolean;
  /**
   * Exact rest transform (parent-connector frame → child-connector frame)
   * captured at import, so angle 0 reproduces the as-built pose. When
   * present it supersedes `flip`.
   */
  rest?: Frame;
  /**
   * Revolute in label but pinned by the assembly (part of a loop in the
   * rigid-body cluster graph). Kept frozen; UI shows it locked.
   */
  locked?: boolean;
}

export interface E2Doc {
  parts: E2Part[];
  joints: E2Joint[];
}

export const IDENT: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const ORIGIN_FRAME = (): Frame => ({ o: [0, 0, 0], r: IDENT.slice() });

export const mulMM = (a: number[], b: number[]): number[] => {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
export const mulMV = (m: number[], v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const transpose = (m: number[]): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * Gram-Schmidt re-orthonormalization (rows). LDraw files store rotations
 * to 3 decimals (0.423² + 0.907² = 1.00158), and the kinematics use
 * transpose-as-inverse, so a non-orthonormal placement leaks ~1.6e-3
 * relative error into every chain hop — the source of LDU-scale
 * round-trip drift. Preserves handedness (no cross products), so
 * mirrored placements stay mirrored.
 */
export function orthonormalize(m: number[]): number[] {
  const row = (i: number): V3 => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
  const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
  const subv = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (a: V3): V3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
  const r0 = unit(row(0));
  let r1 = subv(row(1), scale(r0, dot3(row(1), r0)));
  r1 = unit(r1);
  let r2 = subv(row(2), scale(r0, dot3(row(2), r0)));
  r2 = subv(r2, scale(r1, dot3(r2, r1)));
  r2 = unit(r2);
  return [...r0, ...r1, ...r2];
}

export const rotY = (deg: number): number[] => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
/** 180° about X — anti-aligns the local Y (connector) axis. */
export const FLIP_X: number[] = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export const compose = (a: Frame, b: Frame): Frame => ({
  o: a.o.map((v, i) => v + mulMV(a.r, b.o)[i]) as V3,
  r: mulMM(a.r, b.r),
});

export const connFrame = (c: LocalConnector): Frame => ({ o: c.local, r: (c.ori ?? IDENT).slice() });

/** Solve all part world frames. Joints propagate parent→child; parts with a
 * root frame anchor the graph. Returns frames by part id (unsolvable parts —
 * cycles, orphans — are omitted). */
export function solveDoc(
  doc: E2Doc,
  connectorsOf: (part: string) => LocalConnector[],
): Map<number, Frame> {
  const frames = new Map<number, Frame>();
  const partById = new Map(doc.parts.map((p) => [p.id, p]));
  for (const p of doc.parts) if (p.root) frames.set(p.id, p.root);

  let progress = true;
  while (progress) {
    progress = false;
    for (const j of doc.joints) {
      if (frames.has(j.child.partId) || !frames.has(j.parent.partId)) continue;
      const parent = partById.get(j.parent.partId);
      const child = partById.get(j.child.partId);
      if (!parent || !child) continue;
      const pc = connectorsOf(parent.part)[j.parent.conn];
      const cc = connectorsOf(child.part)[j.child.conn];
      if (!pc || !cc) continue;

      // World frame of the parent connector, spun by the joint value, then
      // taken to the child connector by the rest transform (exact as-built)
      // or the flip convention for hand-made mates.
      let world = compose(frames.get(j.parent.partId)!, connFrame(pc));
      world = compose(world, { o: [0, 0, 0], r: rotY(j.kind === "revolute" ? j.angle : 0) });
      if (j.rest) world = compose(world, j.rest);
      else if (j.flip) world = compose(world, { o: [0, 0, 0], r: FLIP_X });

      // Child frame Fc satisfies Fc ∘ Cc = world.
      const cf = connFrame(cc);
      const r = mulMM(world.r, transpose(cf.r));
      const o = world.o.map((v, i) => v - mulMV(r, cf.o)[i]) as V3;
      frames.set(j.child.partId, { o, r });
      progress = true;
    }
  }
  return frames;
}

/** Default mate semantics from a connector pair. */
export function defaultJointKind(a: LocalConnector, b: LocalConnector): { kind: JointKind; flip: boolean } {
  const kinds = [a.kind, b.kind].sort().join("+");
  if (kinds === "fgr+fgr") return { kind: "revolute", flip: true }; // hinge fingers interleave
  if (kinds === "clp+cyl") return { kind: "revolute", flip: false }; // clip around a bar
  if (kinds === "cyl+cyl" && a.gender !== b.gender) {
    // pin/bar into hole/tube: free to spin about the axis
    return { kind: "revolute", flip: a.gender === b.gender ? true : false };
  }
  return { kind: "rigid", flip: false };
}

/** Bake solved frames to LDraw text. */
export function docToLdr(doc: E2Doc, frames: Map<number, Frame>): string {
  const lines = ["0 editor2 export", "0 Name: editor2.ldr"];
  for (const p of doc.parts) {
    const f = frames.get(p.id);
    if (!f) continue;
    const n = (x: number) => Math.round(x * 1e4) / 1e4;
    lines.push(`1 ${p.color} ${f.o.map(n).join(" ")} ${f.r.map(n).join(" ")} ${p.part}.dat`);
  }
  return lines.join("\n") + "\n";
}

export { expandedConnectors };
export type { LocalConnector, ConnectionMap };
