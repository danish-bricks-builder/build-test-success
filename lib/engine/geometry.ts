/**
 * Engine — Layer 1 (Core). Pure geometry math over PlacedPart.
 *
 * Ported from ai-for-cad's engine/geometry.ts, generalized from "WxL"
 * string types to real LDraw parts with measured metadata (mixed heights,
 * asymmetric origins).
 */
import {
  FALLBACK_META,
  STUD_PITCH,
  type PartMeta,
  type PartMetaMap,
  type PlacedPart,
  type Rotation,
} from "./types";

export const metaOf = (part: string, meta: PartMetaMap): PartMeta =>
  meta[part] ?? FALLBACK_META;

/** Rotate a part-local (x, z) offset by a Y rotation (90° steps). */
export function rotateOffset(ox: number, oz: number, rot: Rotation): [number, number] {
  switch (rot) {
    case 0:
      return [ox, oz];
    case 90:
      return [oz, -ox];
    case 180:
      return [-ox, -oz];
    case 270:
      return [-oz, ox];
  }
}

/** Footprint stud dims at a rotation: [alongX, alongZ]. */
export function footprint(m: PartMeta, rot: Rotation): [number, number] {
  return rot === 90 || rot === 270 ? [m.l, m.w] : [m.w, m.l];
}

/**
 * AABB of a placed part in engine space:
 * [x0, x1, y0, y1, z0, z1].
 *
 * Grid parts (no `m`): footprint centers on the origin plus the rotated
 * origin offset; y spans [y, y + h].
 *
 * Oriented parts (`m` = LDraw row-major rotation): the part's local box
 * (LDraw coords, y ∈ [0, h] downward) is transformed through m, then
 * mapped to engine space (engineY = −ldrawY) and axis-aligned.
 */
export function partBBox(
  p: PlacedPart,
  meta: PartMetaMap,
): readonly [number, number, number, number, number, number] {
  const m = metaOf(p.part, meta);

  if (p.m && p.m.length === 9) {
    const R = p.m;
    const hx = (m.w * STUD_PITCH) / 2;
    const hz = (m.l * STUD_PITCH) / 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const lx of [m.ox - hx, m.ox + hx]) {
      for (const ly of [0, m.h]) {
        for (const lz of [m.oz - hz, m.oz + hz]) {
          // LDraw-local corner through R (row-major), then to engine space
          // via X = RotX(π): engine = (wx, −wy, −wz).
          const wx = R[0] * lx + R[1] * ly + R[2] * lz;
          const wy = R[3] * lx + R[4] * ly + R[5] * lz;
          const wz = R[6] * lx + R[7] * ly + R[8] * lz;
          const ex = p.x + wx;
          const ey = p.y - wy;
          const ez = p.z - wz;
          if (ex < minX) minX = ex;
          if (ex > maxX) maxX = ex;
          if (ey < minY) minY = ey;
          if (ey > maxY) maxY = ey;
          if (ez < minZ) minZ = ez;
          if (ez > maxZ) maxZ = ez;
        }
      }
    }
    return [minX, maxX, minY, maxY, minZ, maxZ];
  }

  const [w, l] = footprint(m, p.rot);
  // Origin offsets are measured in LDraw space; the X = RotX(π) world map
  // negates the Z component before the engine-space rotation.
  const [ox, oz] = rotateOffset(m.ox, -m.oz, p.rot);
  const cx = p.x + ox;
  const cz = p.z + oz;
  const hx = (w * STUD_PITCH) / 2;
  const hz = (l * STUD_PITCH) / 2;
  return [cx - hx, cx + hx, p.y, p.y + m.h, cz - hz, cz + hz];
}

/**
 * Indices of parts whose AABB strictly overlaps another part's.
 * Face-sharing (stacking) is legal and NOT flagged. Spatial-hashed on the
 * XZ plane so 10k-part scenes stay interactive.
 */
export function findOverlapping(parts: PlacedPart[], meta: PartMetaMap): Set<number> {
  const bounds = parts.map((p) => partBBox(p, meta));
  const offenders = new Set<number>();
  // Advisory collision judges SOLID grid parts only:
  //  - oriented parts (axles in holes, hinges) legitimately interpenetrate
  //  - container parts (frames, doors, wheels) legally enclose others
  //  - unknown parts have garbage boxes
  const skip = new Set<number>();
  parts.forEach((p, i) => {
    if (p.m || !meta[p.part]?.solid) skip.add(i);
  });

  // Bucket by 4-stud cells; compare only within/adjacent buckets.
  const CELL = STUD_PITCH * 4;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    const cx0 = Math.floor(b[0] / CELL);
    const cx1 = Math.floor(b[1] / CELL);
    const cz0 = Math.floor(b[4] / CELL);
    const cz1 = Math.floor(b[5] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${cx},${cz}`;
        let arr = buckets.get(key);
        if (!arr) buckets.set(key, (arr = []));
        arr.push(i);
      }
    }
  }

  const EPS = 0.5; // tolerate float fuzz on shared faces
  for (const arr of buckets.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = arr[a];
        const j = arr[b];
        if (skip.has(i) || skip.has(j)) continue;
        if (offenders.has(i) && offenders.has(j)) continue;
        const A = bounds[i];
        const B = bounds[j];
        if (
          A[0] < B[1] - EPS &&
          A[1] > B[0] + EPS &&
          A[2] < B[3] - EPS &&
          A[3] > B[2] + EPS &&
          A[4] < B[5] - EPS &&
          A[5] > B[4] + EPS
        ) {
          offenders.add(i);
          offenders.add(j);
        }
      }
    }
  }
  return offenders;
}

/**
 * The Y the draft should sit at: the top of the highest placed part whose
 * footprint overlaps the draft's, or the baseplate (0). Auto-step-up.
 */
export function terrainY(draft: PlacedPart, placed: PlacedPart[], meta: PartMetaMap): number {
  const [ax0, ax1, , , az0, az1] = partBBox(draft, meta);
  let y = 0;
  for (const p of placed) {
    const [bx0, bx1, , by1, bz0, bz1] = partBBox(p, meta);
    if (ax0 < bx1 - 0.5 && ax1 > bx0 + 0.5 && az0 < bz1 - 0.5 && az1 > bz0 + 0.5) {
      if (by1 > y) y = by1;
    }
  }
  return y;
}

/**
 * Grid parity for a part at a rotation: odd stud counts put the origin at a
 * stud center (offset 10 LDU); even counts sit between studs (multiple of 20).
 */
export function gridParity(m: PartMeta, rot: Rotation): [number, number] {
  const [w, l] = footprint(m, rot);
  return [w % 2 === 1 ? STUD_PITCH / 2 : 0, l % 2 === 1 ? STUD_PITCH / 2 : 0];
}

/** Snap an origin coordinate to the legal grid for the given parity offset. */
export function snapToGrid(v: number, parity: number): number {
  return Math.round((v - parity) / STUD_PITCH) * STUD_PITCH + parity;
}

/** Next rotation step (counter)clockwise. */
export function nextRotation(rot: Rotation, dir: 1 | -1 = 1): Rotation {
  return (((rot + dir * 90) % 360) + 360) % 360 as Rotation;
}
