/**
 * TRUE collision detection — placed parts' solid voxel grids (real
 * geometry: studs, tubes, cavities) intersected in world space.
 *
 * A stud inside an anti-stud tube or a pin inside its hole occupies a
 * CAVITY — empty voxels — so legitimate connections don't collide, while
 * genuinely interpenetrating bodies do.
 */
import { ldrawFrameOf, type ConnectionMap } from "./snapAlign";
import { validateConnections } from "./connectionGraph";
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";

export interface VoxelData {
  res: number;
  parts: Record<string, { min: [number, number, number]; dims: [number, number, number]; bits: string }>;
}

export interface Collision {
  a: number;
  b: number;
  /** Shared voxel count (× res³ = LDU³ volume). */
  voxels: number;
  /** Section-profile violation (over-inserted pin etc.), when the pose
   * is invalid even though voxel overlap is within the joint allowance. */
  profile?: string;
}

const decoded = new WeakMap<VoxelData, Map<string, Uint8Array>>();

function bitsOf(vox: VoxelData, part: string): Uint8Array | null {
  let cache = decoded.get(vox);
  if (!cache) decoded.set(vox, (cache = new Map()));
  let hit = cache.get(part);
  if (hit) return hit;
  const def = vox.parts[part];
  if (!def) return null;
  const bin = typeof atob === "function" ? atob(def.bits) : Buffer.from(def.bits, "base64").toString("binary");
  hit = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) hit[i] = bin.charCodeAt(i);
  cache.set(part, hit);
  return hit;
}

/** World-space occupied cell keys for a placement (quantized to res). */
export function worldCells(
  p: PlacedPartJson,
  vox: VoxelData,
  hOf: (part: string) => number,
): Set<number> | null {
  const def = vox.parts[p.part];
  const bits = bitsOf(vox, p.part);
  if (!def || !bits) return null;
  const [nx, ny, nz] = def.dims;
  const res = vox.res;
  const f = ldrawFrameOf(p, hOf);
  const cells = new Set<number>();
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = ix + nx * (iy + ny * iz);
        if (!(bits[idx >> 3] & (1 << (idx & 7)))) continue;
        // LDraw-local voxel center → world LDraw → engine world.
        const lx = def.min[0] + (ix + 0.5) * res;
        const ly = def.min[1] + (iy + 0.5) * res;
        const lz = def.min[2] + (iz + 0.5) * res;
        const wx = f.o[0] + f.r[0] * lx + f.r[1] * ly + f.r[2] * lz;
        const wy = f.o[1] + f.r[3] * lx + f.r[4] * ly + f.r[5] * lz;
        const wz = f.o[2] + f.r[6] * lx + f.r[7] * ly + f.r[8] * lz;
        // Engine frame (y,z flip) then quantize. Offset grid to cell keys.
        const cx = Math.floor(wx / res) + 512;
        const cy = Math.floor(-wy / res) + 512;
        const cz = Math.floor(-wz / res) + 512;
        cells.add(cx + 1024 * (cy + 1024 * cz));
      }
    }
  }
  return cells;
}

/** World cells of a placement's ENVELOPE — its full voxel bounding box,
 * ignoring the occupancy bits. The geometric-interlock experiment:
 * envelopes overlapping while solids stay clear = the shapes enclose
 * one another (form closure). */
export function envelopeCells(
  p: PlacedPartJson,
  vox: VoxelData,
  hOf: (part: string) => number,
): Set<number> | null {
  const def = vox.parts[p.part];
  if (!def) return null;
  const [nx, ny, nz] = def.dims;
  const res = vox.res;
  const f = ldrawFrameOf(p, hOf);
  const cells = new Set<number>();
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const lx = def.min[0] + (ix + 0.5) * res;
        const ly = def.min[1] + (iy + 0.5) * res;
        const lz = def.min[2] + (iz + 0.5) * res;
        const wx = f.o[0] + f.r[0] * lx + f.r[1] * ly + f.r[2] * lz;
        const wy = f.o[1] + f.r[3] * lx + f.r[4] * ly + f.r[5] * lz;
        const wz = f.o[2] + f.r[6] * lx + f.r[7] * ly + f.r[8] * lz;
        const cx = Math.floor(wx / res) + 512;
        const cy = Math.floor(-wy / res) + 512;
        const cz = Math.floor(-wz / res) + 512;
        cells.add(cx + 1024 * (cy + 1024 * cz));
      }
    }
  }
  return cells;
}

/** Surface-contact count: solid cells of one part with a solid cell of
 * the other in their 6-neighborhood (touching, not interpenetrating). */
export function contactCells(a: Set<number>, b: Set<number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const NEIGH = [1, -1, 1024, -1024, 1024 * 1024, -1024 * 1024];
  let n = 0;
  for (const c of small) {
    if (big.has(c)) continue; // interpenetration counted elsewhere
    for (const d of NEIGH) {
      if (big.has(c + d)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * All colliding pairs. Pairs sharing fewer than `tolerance` voxels are
 * ignored (surface kisses / quantization noise at part boundaries).
 */
/**
 * Joint-aware collision check. The allowance for engagement overlap is
 * SPATIAL, not volumetric: shared cells are excused only when they lie
 * inside a mated female's bore interior (her engagement zone) — that is
 * where snap-fit interference (friction ridges, flare lips) lives by
 * design. Shared cells OUTSIDE every mated zone are genuine collision
 * for jointed and stranger pairs alike: a pin slid too deep overlaps
 * the deck BEHIND the hole — modest volume, but none of it excusable.
 * Non-cyl joints (hinge fingers, balls) get a small volume allowance
 * instead. `strangerToleranceLdu3` (LDU³) absorbs quantization noise.
 */
export function checkCollisionsValidated(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  vox: VoxelData,
  conns: ConnectionMap,
  strangerToleranceLdu3 = 24,
  nonCylJointToleranceLdu3 = 240,
): Collision[] {
  const cellVol = vox.res ** 3;
  const cellsTol = Math.max(1, Math.round(strangerToleranceLdu3 / cellVol));
  const val = validateConnections(parts, meta, conns);
  const jointed = new Set(val.joints.map((j) => `${j.a}/${j.b}`));
  const zonesByPair = new Map<string, typeof val.engagementZones>();
  for (const z of val.engagementZones) {
    const k = `${z.a}/${z.b}`;
    if (!zonesByPair.has(k)) zonesByPair.set(k, []);
    zonesByPair.get(k)!.push(z);
  }
  const hOf = (part: string) => meta[part]?.h ?? 24;
  const res = vox.res;

  const out = checkCollisions(parts, meta, vox, cellsTol).filter((c) => {
    const key = `${c.a}/${c.b}`;
    if (!jointed.has(key)) return true; // strangers: any real overlap is a collision
    const zones = zonesByPair.get(key);
    if (!zones || zones.length === 0) return c.voxels * cellVol >= nonCylJointToleranceLdu3;
    // Count shared cells OUTSIDE every mated bore.
    const ca = worldCells(parts[c.a], vox, hOf);
    const cb = worldCells(parts[c.b], vox, hOf);
    if (!ca || !cb) return true;
    const [small, big] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
    let unexcused = 0;
    for (const cell of small) {
      if (!big.has(cell)) continue;
      // Unpack the cell key to engine-frame coords (same frame as the
      // zones' WorldConnector pos/axis).
      const cx = ((cell % 1024) - 512 + 0.5) * res;
      const cy = ((((cell / 1024) | 0) % 1024) - 512 + 0.5) * res;
      const cz = (((cell / (1024 * 1024)) | 0) - 512 + 0.5) * res;
      let inZone = false;
      for (const z of zones) {
        const dx = cx - z.pos[0];
        const dy = cy - z.pos[1];
        const dz = cz - z.pos[2];
        const along = dx * z.axis[0] + dy * z.axis[1] + dz * z.axis[2];
        if (along < z.lo || along > z.hi) continue;
        const lat2 = dx * dx + dy * dy + dz * dz - along * along;
        if (lat2 <= z.radial * z.radial) {
          inZone = true;
          break;
        }
      }
      if (!inZone) unexcused++;
    }
    return unexcused >= cellsTol;
  });

  // Profile-invalid joints are collisions regardless of voxel volume —
  // a collar jammed mid-bore reads as modest skin overlap but the pose
  // is physically impossible.
  for (const v of val.profileViolations) {
    const hit = out.find((c) => c.a === v.a && c.b === v.b);
    if (hit) hit.profile = v.reason;
    else out.push({ a: v.a, b: v.b, voxels: 0, profile: v.reason });
  }
  return out;
}

/** Shared voxel count between exactly two placements (0 = no contact). */
export function pairOverlap(
  a: PlacedPartJson,
  b: PlacedPartJson,
  meta: PartMetaMap,
  vox: VoxelData,
): number {
  const hOf = (part: string) => meta[part]?.h ?? 24;
  const ca = worldCells(a, vox, hOf);
  const cb = worldCells(b, vox, hOf);
  if (!ca || !cb) return 0;
  const [small, big] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
  let shared = 0;
  for (const key of small) if (big.has(key)) shared++;
  return shared;
}

/** Engine-frame AABB of a placement's VOXEL box (true geometry bounds —
 * studs and protrusions included, unlike the meta slab box). */
function voxAABB(
  p: PlacedPartJson,
  vox: VoxelData,
  hOf: (part: string) => number,
): [number, number, number, number, number, number] | null {
  const def = vox.parts[p.part];
  if (!def) return null;
  const f = ldrawFrameOf(p, hOf);
  const lo = def.min;
  const hi = [lo[0] + def.dims[0] * vox.res, lo[1] + def.dims[1] * vox.res, lo[2] + def.dims[2] * vox.res];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const x of [lo[0], hi[0]])
    for (const y of [lo[1], hi[1]])
      for (const z of [lo[2], hi[2]]) {
        const wx = f.o[0] + f.r[0] * x + f.r[1] * y + f.r[2] * z;
        const wy = -(f.o[1] + f.r[3] * x + f.r[4] * y + f.r[5] * z);
        const wz = -(f.o[2] + f.r[6] * x + f.r[7] * y + f.r[8] * z);
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
        minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
      }
  return [minX, maxX, minY, maxY, minZ, maxZ];
}

export function checkCollisions(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  vox: VoxelData,
  tolerance = 4,
): Collision[] {
  const hOf = (part: string) => meta[part]?.h ?? 24;
  // Broad-phase on the voxel AABB, not the meta slab box: meta boxes
  // exclude studs, so stud-band interpenetration (a stud stabbing into a
  // kissing slab) used to slip past the touch gate entirely.
  const boxes = parts.map((p) => voxAABB(p, vox, hOf));
  const cellCache = new Map<number, Set<number> | null>();
  const cellsOf = (i: number) => {
    let c = cellCache.get(i);
    if (c === undefined) {
      c = worldCells(parts[i], vox, hOf);
      cellCache.set(i, c);
    }
    return c;
  };

  const out: Collision[] = [];
  for (let i = 0; i < parts.length; i++) {
    const A = boxes[i];
    if (!A) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const B = boxes[j];
      if (!B) continue;
      const touch =
        A[0] < B[1] && A[1] > B[0] && A[2] < B[3] && A[3] > B[2] && A[4] < B[5] && A[5] > B[4];
      if (!touch) continue;
      const ca = cellsOf(i);
      const cb = cellsOf(j);
      if (!ca || !cb) continue;
      const [small, big] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
      let shared = 0;
      for (const key of small) if (big.has(key)) shared++;
      if (shared >= tolerance) out.push({ a: i, b: j, voxels: shared });
    }
  }
  return out.sort((x, y) => y.voxels - x.voxels);
}
