/**
 * The observed-pose → enumerated-placement matcher.
 *
 * A catalog stores ONE representative per physical placement, so an
 * observed pose must be matched up to physical equivalence:
 *
 *   symmetry   R_obs·S_B ≈ R_pl for S_B mapping B's solid onto itself,
 *              and the whole relation conjugated by A's group likewise
 *   revolute   any rotation about the mate axis, any depth along it —
 *              spin and depth are the JOINT's coordinates
 *   cyl slide  rigid axles/pins seat at any depth along the axis, and
 *              spin freely when the FEMALE bore is round
 *
 * One instance of this lived inline in corpus-report.ts, and every
 * debug script re-implemented an approximation of it — which is how
 * "the matcher" and "what we think the matcher does" drifted apart.
 * This module is the single implementation; the report, the audit and
 * any diagnosis import it.
 */
import { expandedConnectors, secSegments, type LocalConnector } from "@/lib/engine/connectionGraph";
import { mulMM, mulMV, transpose } from "@/lib/editor2/kinematics";
import type { ConnectionMap } from "@/lib/engine/snapAlign";
import type { VoxelData } from "@/lib/engine/voxelCollision";
import type { MatePlacement } from "@/lib/rules/enumerate";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const matNear = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The 24 proper axis-aligned rotations — candidate self-symmetries. */
const ROT24: number[][] = (() => {
  const out: number[][] = [];
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const pm of perms)
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      const m = Array(9).fill(0);
      m[pm[0]] = sx;
      m[3 + pm[1]] = sy;
      m[6 + pm[2]] = sz;
      const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det > 0) out.push(m);
    }
  return out;
})();

export interface MatchExplain {
  /** Which rule accepted the match, or every reason each rule refused. */
  rule?: "exact" | "rigid" | "cyl-slide" | "revolute";
  viaSymB?: number[];
  viaSymA?: number[];
  slide?: number;
}

export function createMatcher(conns: ConnectionMap, vox: VoxelData) {
  /** Decode a part's voxel cells as integer coords (grid space). */
  const cellCache = new Map<string, { pts: V3[]; set: Set<number>; c: V3 } | null>();
  function cellsOf(part: string) {
    let v = cellCache.get(part);
    if (v !== undefined) return v;
    const def = vox.parts[part];
    if (!def) {
      cellCache.set(part, null);
      return null;
    }
    const bin = typeof atob === "function" ? atob(def.bits) : Buffer.from(def.bits, "base64").toString("binary");
    const [dx, dy, dz] = def.dims;
    const pts: V3[] = [];
    const set = new Set<number>();
    let i = 0;
    for (let z = 0; z < dz; z++)
      for (let y = 0; y < dy; y++)
        for (let x = 0; x < dx; x++, i++)
          if (bin.charCodeAt(i >> 3) & (1 << (i & 7))) {
            pts.push([x, y, z]);
            set.add(x + 1024 * (y + 1024 * z));
          }
    v = { pts, set, c: [(dx - 1) / 2, (dy - 1) / 2, (dz - 1) / 2] };
    cellCache.set(part, v);
    return v;
  }

  /**
   * Self-symmetries of a part's voxel solid (about its bbox center),
   * scored with a 1-cell dilation to absorb the parity-fill bias —
   * genuine symmetries land at 0.95+, genuine asymmetries at 0.76 or
   * below, so 0.9 has margin on both sides.
   */
  const SYM_MIN = 0.9;
  const symCache = new Map<string, number[][]>();
  function symsOf(part: string): number[][] {
    let s = symCache.get(part);
    if (s) return s;
    const cells = cellsOf(part);
    s = [IDENT];
    if (cells && cells.pts.length) {
      const NB: V3[] = [
        [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      ];
      for (const R of ROT24) {
        if (matNear(R, IDENT, 0.01)) continue;
        let hit = 0;
        for (const p of cells.pts) {
          const d = sub(p, cells.c);
          const q = add(mulMV(R, d) as V3, cells.c).map(Math.round) as V3;
          for (const n of NB) {
            if (cells.set.has(q[0] + n[0] + 1024 * (q[1] + n[1] + 1024 * (q[2] + n[2])))) {
              hit++;
              break;
            }
          }
        }
        if (hit / cells.pts.length >= SYM_MIN) s.push(R);
      }
    }
    symCache.set(part, s);
    return s;
  }

  /** Axial reach of a connector's section profile (LDU). */
  const connLen = (part: string, idx: number): number => {
    const c = expandedConnectors(part, conns)[idx];
    if (!c) return 0;
    return secSegments(c.secs).reduce((a, x) => a + (x.len ?? 0), 0);
  };

  /**
   * Whether the FEMALE side of a placement's engaged pair is round.
   * Spin freedom belongs to the bore, not the contact label: a cross
   * axle inside a pin's hollow round interior turns freely, while the
   * same axle in a cross hole locks to four positions — both labeled
   * "axle".
   */
  function femaleIsRound(pl: MatePlacement, aConns: LocalConnector[], partB: string): boolean {
    const ac = aConns[pl.aConn];
    const fem = ac?.gender === "F" ? ac : partB ? expandedConnectors(partB, conns)[pl.bConn] : undefined;
    if (!fem || fem.gender !== "F") return /pin|bar|cyl/.test(pl.label);
    // R (round bore) and S (stud tube) are both round profiles — only A
    // (cross axle hole) constrains rotation to four seats.
    const segs = secSegments(fem.secs).filter((x) => x.kind === "R" || x.kind === "A" || x.kind === "S");
    return segs.length > 0 && segs.every((x) => x.kind === "R" || x.kind === "S");
  }

  function inner(
    o: V3,
    r: number[],
    pl: MatePlacement,
    symsB: number[][],
    aConns: LocalConnector[],
    partA: string,
    partB: string,
  ): boolean {
    const plo = pl.frame.o as V3;
    // Slide is bounded by the LONGER of the two engaged bodies, not a
    // constant — a 3L bar sits 80 LDU from the seat, an Axle 12 reaches
    // 120.
    const slideCap = Math.max(60, connLen(partB, pl.bConn) + 8, connLen(partA, pl.aConn) + 8);
    const nearPos = norm(sub(o, plo)) <= 4.5;
    const cylindrical = /axle|pin|bar|cyl/.test(pl.label);
    if (pl.kind === "rigid" && !nearPos && !cylindrical) return false;
    for (const S of symsB) {
      const rc = mulMM(r, S);
      if (pl.kind === "rigid") {
        if (nearPos && matNear(rc, pl.frame.r, 0.12)) return true;
        const singleRoundSeat = (pl.contacts ?? 2) <= 1 && femaleIsRound(pl, aConns, partB);
        if (cylindrical || singleRoundSeat) {
          const ac = aConns[pl.aConn];
          if (ac) {
            const uRaw = mulMV(ac.ori ?? IDENT, [0, 1, 0]) as V3;
            const un = norm(uRaw) || 1;
            const u: V3 = [uRaw[0] / un, uRaw[1] / un, uRaw[2] / un];
            const roundBore = femaleIsRound(pl, aConns, partB);
            const rd = mulMM(rc, transpose(pl.frame.r));
            const spinsAboutAxis = roundBore && norm(sub(mulMV(rd, u) as V3, u)) <= 0.15;
            if (spinsAboutAxis || matNear(rc, pl.frame.r, 0.12)) {
              const d = sub(o, plo);
              const s = dot(d, u);
              const perp = norm(sub(d, [u[0] * s, u[1] * s, u[2] * s]));
              if (perp <= 2.0 && Math.abs(s) <= slideCap) return true;
            }
          }
        }
      } else {
        const ac = aConns[pl.aConn];
        if (!ac) continue;
        const uRaw = mulMV(ac.ori ?? IDENT, [0, 1, 0]) as V3;
        const un = norm(uRaw) || 1;
        const u: V3 = [uRaw[0] / un, uRaw[1] / un, uRaw[2] / un];
        const pt = ac.local as V3;
        const rd = mulMM(rc, transpose(pl.frame.r));
        // A revolute joint's rotation must be ABOUT the mate axis — but a
        // hinge is the same joint whether its leaf folds up or down, and
        // those two configurations differ by an axis REVERSAL (rd·u ≈ −u),
        // not just a spin. The catalog keeps one leaf orientation, the
        // corpus uses whichever it built, so accept both: rd preserving
        // OR reversing the axis. (30364×30365 hinge: catalog at one flip,
        // 12 of 13 observed poses at the other.)
        const mapped = mulMV(rd, u) as V3;
        const aligns = norm(sub(mapped, u)) <= 0.15 || norm(add(mapped, u)) <= 0.15;
        if (!aligns) continue;
        const op = add(pt, mulMV(rd, sub(plo, pt)) as V3);
        const d = sub(o, op);
        const s = dot(d, u);
        const perp = norm(sub(d, [u[0] * s, u[1] * s, u[2] * s]));
        if (perp <= 2.0 && Math.abs(s) <= slideCap) return true;
      }
    }
    return false;
  }

  /** Does the observed pose realize this placement, up to equivalence? */
  function poseMatches(
    o: V3,
    r: number[],
    pl: MatePlacement,
    partA: string,
    partB: string,
    aConns?: LocalConnector[],
  ): boolean {
    const ca = aConns ?? expandedConnectors(partA, conns);
    const symsB = symsOf(partB);
    // A relative pose is defined up to BOTH parts' symmetry groups:
    // re-seating A onto itself by S_A reads the same assembly as
    // rel' = S_Aᵀ·rel·S_B with o' = S_Aᵀ·o.
    for (const SA of symsOf(partA)) {
      if (SA === IDENT) continue;
      const SAt = transpose(SA);
      if (inner(mulMV(SAt, o) as V3, mulMM(SAt, r), pl, symsB, ca, partA, partB)) return true;
    }
    return inner(o, r, pl, symsB, ca, partA, partB);
  }

  /**
   * Match an observed pose against a whole catalog. Exact first (cheap,
   * and keeps stable indices for the common case), then equivalence.
   */
  function matchPose(
    o: V3,
    r: number[],
    placements: MatePlacement[],
    partA: string,
    partB: string,
  ): number {
    let hit = placements.findIndex(
      (pl) =>
        pl.frame.o.every((v, i) => Math.abs(v - o[i]) <= 1.01) &&
        pl.frame.r.every((v, i) => Math.abs(v - r[i]) <= 0.06),
    );
    if (hit >= 0) return hit;
    const ca = expandedConnectors(partA, conns);
    hit = placements.findIndex((pl) => poseMatches(o, r, pl, partA, partB, ca));
    return hit;
  }

  return { symsOf, poseMatches, matchPose, femaleIsRound, cellsOf };
}

export type Matcher = ReturnType<typeof createMatcher>;
