/**
 * The size of a build for the task checks: height above the ground plane and the footprint in
 * studs, from each part's nominal w × l box turned the way the part is placed. A 1×4 brick set
 * across the grid is one stud wide and four long; the earlier measure ignored rotation and
 * counted it four wide, which reported towers and houses wider than they were.
 */
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";

export interface Extent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  /** studs, x by z */
  footprint: [number, number];
}

export function extentOfParts(parts: PlacedPartJson[], meta: PartMetaMap | Record<string, { w: number; l: number; h: number }>): Extent {
  let maxY = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const m = (meta as Record<string, { w: number; l: number; h: number }>)[p.part] ?? { w: 2, l: 2, h: 24 };
    const hw = (m.w * 20) / 2, hl = (m.l * 20) / 2;
    let ex = hw, ez = hl;
    const R = (p as { m?: number[] }).m;
    if (R && R.length === 9) {
      // an arbitrary orientation: the box's half extents through |R|
      ex = Math.abs(R[0]) * hw + Math.abs(R[2]) * hl;
      ez = Math.abs(R[6]) * hw + Math.abs(R[8]) * hl;
    } else if (p.rot === 90 || p.rot === 270) {
      ex = hl;
      ez = hw;
    }
    maxY = Math.max(maxY, p.y + m.h);
    minX = Math.min(minX, p.x - ex);
    maxX = Math.max(maxX, p.x + ex);
    minZ = Math.min(minZ, p.z - ez);
    maxZ = Math.max(maxZ, p.z + ez);
  }
  if (!parts.length) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, height: 0, footprint: [0, 0] };
  return { minX, maxX, minZ, maxZ, height: maxY, footprint: [(maxX - minX) / 20, (maxZ - minZ) / 20] };
}
