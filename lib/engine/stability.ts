/**
 * Stability-lite — simplified statics over a placed build (the grader
 * ladder's rung between soundness and task postconditions). No physics
 * engine: rigid-body statics with two checks, both against gravity only:
 *
 *   1. GLOBAL TOPPLE — the whole build's center of mass must sit inside
 *      the convex hull of its ground-contact footprint (margin in LDU).
 *   2. CANTILEVER — any sub-assembly whose ONLY connection to the
 *      grounded structure is a single stud interface must either keep its
 *      CoM over that interface's footprint, or the overturning moment
 *      must be carried by stud clutch tension (count × clutch force ×
 *      lever), with a safety factor.
 *
 * Mass comes from the part voxel grids (solid cells × ABS density);
 * parts without voxel coverage fall back to bbox volume × fill factor —
 * coverage is reported, not hidden. Method credit: BrickGPT / StableLego
 * force-based stability, radically simplified for grading.
 *
 * Known v1 limits (state in the paper, don't paper over): axis-aligned
 * footprint rectangles (rotated parts get their AABB); a component held
 * by SEVERAL interfaces is only checked one cut at a time; non-stud
 * joints (pins, axles, clips) are treated as rigid braces and never
 * checked — Technic frames pass on connectivity alone.
 */
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";
import type { Validation } from "./connectionGraph";
import { ldrawFrameOf } from "./snapAlign";
import type { VoxelData } from "./voxelCollision";

const LDU_MM = 0.4;
const G = 9.81;
/** ABS ≈ 1.05 g/cm³ = 1.05e-3 g/mm³ → grams per LDU³ (1 LDU³ = 0.064 mm³) */
const G_PER_LDU3 = 1.05e-3 * LDU_MM ** 3;
/** bbox-fallback fill factor (bricks are hollow) */
const BBOX_FILL = 0.45;
/** conservative clutch (pull-off) force per engaged stud, newtons */
const CLUTCH_N = 6;
/** restoring moment must exceed overturning by this factor */
const SAFETY = 2;
/** overhang below this is quantization noise, not a failure (LDU) */
const OVERHANG_NOISE = 4;
/** a structure lighter than this (and than 5% of the scene) only warns */
const MINOR_MASS_G = 15;

/** resting-on-ground tolerance, LDU. One plate height: OMR authors eyeball
 * the ground plane (a tractor's four tires bottom out 0–12 LDU apart in
 * posed scenes); anything within 1.5 plates of the floor reads as resting.
 * Known limit: unsettled display poses can still false-fail topple. */
const GROUND_TOL = 12.0;

export interface StabilityIssue {
  kind: "topple" | "cantilever";
  /** severe issues fail the build; the rest are warnings (scene clutter,
   * quantization-scale margins) */
  severe: boolean;
  /** hanging component (part indices), or [] for global topple */
  parts: number[];
  /** the interface (lower, upper) for cantilever issues */
  cut?: [number, number];
  overhangLdu: number;
  detail: string;
}

export interface StabilityReport {
  ok: boolean;
  totalMassG: number;
  /** distance (LDU) of the global CoM inside the ground hull; negative = outside */
  globalMarginLdu: number;
  issues: StabilityIssue[];
  coverage: { voxel: number; bbox: number };
  report: string;
}

interface Body {
  massG: number;
  com: [number, number, number]; // engine frame, y up, LDU
  rect: { x0: number; x1: number; z0: number; z1: number };
  minY: number;
}

// base64 -> bytes, per-part cache (mirrors voxelCollision's decoder - that
// module's packed 1024-cell keys OVERFLOW for parts >512 LDU from the
// origin, which is any tall building; here we accumulate directly instead)
const bitsCache = new Map<string, Uint8Array>();
function bitsOf(vox: VoxelData, part: string): Uint8Array | null {
  let hit = bitsCache.get(part);
  if (hit) return hit;
  const def = vox.parts[part];
  if (!def) return null;
  const bin = typeof atob === "function" ? atob(def.bits) : Buffer.from(def.bits, "base64").toString("binary");
  hit = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) hit[i] = bin.charCodeAt(i);
  bitsCache.set(part, hit);
  return hit;
}

function bodyOf(p: PlacedPartJson, meta: PartMetaMap, vox: VoxelData, hOf: (part: string) => number): { body: Body; viaVoxel: boolean } {
  const def = vox.parts[p.part];
  const bits = def ? bitsOf(vox, p.part) : null;
  if (def && bits) {
    const [nx, ny, nz] = def.dims;
    const res = vox.res;
    const f = ldrawFrameOf(p, hOf);
    let n = 0, sx = 0, sy = 0, sz = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const idx = ix + nx * (iy + ny * iz);
          if (!(bits[idx >> 3] & (1 << (idx & 7)))) continue;
          const lx = def.min[0] + (ix + 0.5) * res;
          const ly = def.min[1] + (iy + 0.5) * res;
          const lz = def.min[2] + (iz + 0.5) * res;
          // LDraw world -> engine frame: y up = -LDraw y, z = -LDraw z
          const wx = f.o[0] + f.r[0] * lx + f.r[1] * ly + f.r[2] * lz;
          const wy = -(f.o[1] + f.r[3] * lx + f.r[4] * ly + f.r[5] * lz);
          const wz = -(f.o[2] + f.r[6] * lx + f.r[7] * ly + f.r[8] * lz);
          n++; sx += wx; sy += wy; sz += wz;
          if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
          if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
          if (wy < y0) y0 = wy;
        }
      }
    }
    if (n > 0) {
      const massG = n * res ** 3 * G_PER_LDU3;
      return { body: { massG, com: [sx / n, sy / n, sz / n], rect: { x0, x1, z0, z1 }, minY: y0 }, viaVoxel: true };
    }
  }
  // bbox fallback from meta footprint (w x l studs, h LDU), engine frame
  const m = meta[p.part] ?? { w: 2, l: 2, h: 24, ox: 0, oz: 0 };
  const hw = (m.w * 20) / 2;
  const hl = (m.l * 20) / 2;
  const he = Math.max(hw, hl);
  const cx = p.x + (m.ox ?? 0) * 10;
  const cz = p.z + (m.oz ?? 0) * 10;
  const massG = m.w * 20 * m.l * 20 * m.h * BBOX_FILL * G_PER_LDU3;
  return {
    body: { massG, com: [cx, p.y + m.h / 2, cz], rect: { x0: cx - he, x1: cx + he, z0: cz - he, z1: cz + he }, minY: p.y },
    viaVoxel: false,
  };
}

/** Andrew's monotone chain, points as [x,z]. */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...new Map(pts.map((q) => [`${q[0]},${q[1]}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 2) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const hi: [number, number][] = [];
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** Signed distance of point to hull: positive inside (min edge distance). */
function hullMargin(h: [number, number][], x: number, z: number): number {
  if (h.length === 0) return -Infinity;
  if (h.length === 1) return -Math.hypot(x - h[0][0], z - h[0][1]);
  // orientation-agnostic containment: inside iff the point is on the same
  // side of every edge (works for CW or CCW hulls)
  let hasPos = false;
  let hasNeg = false;
  let minD = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const cross = ex * (z - a[1]) - ez * (x - a[0]);
    if (cross > 0) hasPos = true;
    if (cross < 0) hasNeg = true;
    const len = Math.hypot(ex, ez) || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (len * len)));
    minD = Math.min(minD, Math.hypot(x - (a[0] + t * ex), z - (a[1] + t * ez)));
  }
  const inside = !(hasPos && hasNeg);
  return inside ? minD : -minD;
}

const rectMargin = (r: Body["rect"], x: number, z: number): number =>
  Math.min(x - r.x0, r.x1 - x, z - r.z0, r.z1 - z);

export function checkStability(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  validation: Validation,
  vox: VoxelData,
): StabilityReport {
  const hOf = (part: string) => meta[part]?.h ?? 24;
  const bodies: Body[] = [];
  let voxelCount = 0;
  for (const p of parts) {
    const { body, viaVoxel } = bodyOf(p, meta, vox, hOf);
    bodies.push(body);
    if (viaVoxel) voxelCount++;
  }
  const totalMassG = bodies.reduce((a, b) => a + b.massG, 0);

  const issues: StabilityIssue[] = [];

  // ── adjacency first: joints + resting contacts define the STRUCTURES
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const j of validation.joints) link(j.a, j.b);

  // Resting contacts as brace edges: A's top meets B's bottom with real
  // footprint overlap (soundness-style). The joint graph alone is sparser
  // than reality wherever connector data has gaps — without these edges,
  // whole floors "hang" on the one detected stud (Fallingwater's terraces).
  const topY = (b: Body) => b.minY + (b.com[1] - b.minY) * 2; // ≈ max y from symmetric CoM
  for (let a = 0; a < bodies.length; a++) {
    for (let b = a + 1; b < bodies.length; b++) {
      const lo = topY(bodies[a]) <= topY(bodies[b]) ? a : b;
      const hi = lo === a ? b : a;
      if (Math.abs(bodies[hi].minY - topY(bodies[lo])) > 3) continue;
      const ra = bodies[a].rect, rb = bodies[b].rect;
      const ox = Math.min(ra.x1, rb.x1) - Math.max(ra.x0, rb.x0);
      const oz = Math.min(ra.z1, rb.z1) - Math.max(ra.z0, rb.z0);
      if (ox >= 8 && oz >= 8) link(a, b);
    }
  }

  // ── connected components: an OMR scene may hold several free-standing
  // structures (9393 poses the tractor beside its grabber accessory) —
  // every check runs per structure, each on its OWN floor plane.
  const compOf = new Array<number>(bodies.length).fill(-1);
  const comps: number[][] = [];
  for (let i = 0; i < bodies.length; i++) {
    if (compOf[i] >= 0) continue;
    const c: number[] = [];
    const stack = [i];
    compOf[i] = comps.length;
    while (stack.length) {
      const n = stack.pop()!;
      c.push(n);
      for (const nb of adj.get(n) ?? []) if (compOf[nb] < 0) { compOf[nb] = comps.length; stack.push(nb); }
    }
    comps.push(c);
  }

  let globalMarginLdu = Infinity;
  const grounded = new Set<number>();
  for (const comp of comps) {
    const floorY = Math.min(...comp.map((i) => bodies[i].minY));
    for (const i of comp) if (bodies[i].minY <= floorY + GROUND_TOL) grounded.add(i);

    // topple: component CoM vs the hull of ITS grounded footprints
    const pts: [number, number][] = [];
    for (const i of comp) {
      if (!grounded.has(i)) continue;
      const r = bodies[i].rect;
      pts.push([r.x0, r.z0], [r.x0, r.z1], [r.x1, r.z0], [r.x1, r.z1]);
    }
    let m = 0, cx = 0, cz = 0;
    for (const i of comp) { m += bodies[i].massG; cx += bodies[i].com[0] * bodies[i].massG; cz += bodies[i].com[2] * bodies[i].massG; }
    cx /= m || 1; cz /= m || 1;
    const margin = hullMargin(hull(pts), cx, cz);
    globalMarginLdu = Math.min(globalMarginLdu, margin);
    if (margin < 0) {
      const minor = m < MINOR_MASS_G && m < totalMassG * 0.05;
      const severe = -margin > OVERHANG_NOISE && !minor;
      issues.push({
        kind: "topple", severe, parts: comp.length === bodies.length ? [] : comp, overhangLdu: -margin,
        detail: `structure of ${comp.length} part(s), ${m.toFixed(1)} g: CoM is ${(-margin).toFixed(1)} LDU outside its ground footprint — it tips over${severe ? "" : " (minor)"}`,
      });
    }
  }

  // ── cantilever: stud interfaces whose removal leaves the upper side
  // with no path to its structure's grounded parts
  const studJoints = validation.joints.filter((j) => j.type.startsWith("stud"));
  for (const j of studJoints) {
    const lower = bodies[j.a].minY <= bodies[j.b].minY ? j.a : j.b;
    const upper = lower === j.a ? j.b : j.a;
    const seen = new Set<number>([upper]);
    const stack = [upper];
    let touchesGround = grounded.has(upper);
    while (stack.length && !touchesGround) {
      const n = stack.pop()!;
      for (const nb of adj.get(n) ?? []) {
        if ((n === j.a && nb === j.b) || (n === j.b && nb === j.a)) continue;
        if (seen.has(nb)) continue;
        seen.add(nb);
        if (grounded.has(nb)) { touchesGround = true; break; }
        stack.push(nb);
      }
    }
    if (touchesGround || seen.has(lower)) continue;
    const ra = bodies[j.a].rect;
    const rb = bodies[j.b].rect;
    const rect = {
      x0: Math.max(ra.x0, rb.x0), x1: Math.min(ra.x1, rb.x1),
      z0: Math.max(ra.z0, rb.z0), z1: Math.min(ra.z1, rb.z1),
    };
    if (rect.x1 <= rect.x0 || rect.z1 <= rect.z0) continue; // side-stud etc. — out of scope v1
    let m = 0, cx = 0, cz = 0;
    for (const i of seen) { m += bodies[i].massG; cx += bodies[i].com[0] * bodies[i].massG; cz += bodies[i].com[2] * bodies[i].massG; }
    cx /= m || 1; cz /= m || 1;
    const margin = rectMargin(rect, cx, cz);
    if (margin >= 0) continue;
    const overhang = -margin;
    const overturnNmm = (m / 1000) * G * overhang * LDU_MM;
    const leverLdu = Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0) / 2;
    const restoreNmm = CLUTCH_N * j.count * leverLdu * LDU_MM;
    if (restoreNmm >= overturnNmm * SAFETY) continue;
    const minor = m < MINOR_MASS_G && m < totalMassG * 0.05;
    issues.push({
      kind: "cantilever",
      severe: overhang > OVERHANG_NOISE && !minor,
      parts: [...seen],
      cut: [lower, upper],
      overhangLdu: overhang,
      detail:
        `${seen.size} part(s) (${(m).toFixed(1)} g) hang on ${j.count} stud(s) between #${lower} and #${upper}: ` +
        `CoM overhangs the interface by ${overhang.toFixed(1)} LDU — clutch carries ${restoreNmm.toFixed(1)} N·mm of the ${(overturnNmm * SAFETY).toFixed(1)} needed`,
    });
  }

  const severe = issues.filter((i) => i.severe);
  const ok = severe.length === 0;
  const report = ok
    ? `STABLE${issues.length ? ` (${issues.length} minor warning(s))` : ""}: ${parts.length} parts · ${totalMassG.toFixed(0)} g · CoM margin ${globalMarginLdu === Infinity ? "∞" : globalMarginLdu.toFixed(1)} LDU inside ground footprint`
    : `UNSTABLE: ${severe.length} issue(s) — ` + severe.map((i) => i.detail).join(" ; ");
  return {
    ok,
    totalMassG,
    globalMarginLdu: Number.isFinite(globalMarginLdu) ? +globalMarginLdu.toFixed(1) : globalMarginLdu,
    issues,
    coverage: { voxel: voxelCount, bbox: parts.length - voxelCount },
    report,
  };
}
