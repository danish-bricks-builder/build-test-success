/**
 * Two-part mate enumerator — every way part B can mate onto part A.
 *
 * Proposal: for each compatible connector pair (a on A, b on B), place B so
 * the two connector frames coincide, trying both axis polarities and four
 * rotations about the mate axis. Validation: the PRODUCTION contact
 * detector (detectMates) must find an engaged contact in the proposed
 * placement, and the production classifier (inferJoints) labels it
 * rigid/revolute with its rule. So the gallery shows exactly what the
 * editor's own inference would accept — no separate mate model.
 *
 * v1 limits: rotations sampled at 90° (dedup collapses symmetric ones);
 * no part-vs-part collision check yet — a placement can be geometrically
 * engaged but physically overlapping.
 */
import {
  FLIP_X,
  compose,
  connFrame,
  expandedConnectors,
  mulMM,
  mulMV,
  rotY,
  transpose,
  type ConnectionMap,
  type E2Part,
  type Frame,
  type LocalConnector,
  type V3,
} from "@/lib/editor2/kinematics";
import { detectMates, inferJoints, type InferOpts, type PairRule } from "@/lib/editor2/mates";
import { secSegments, type SecSeg } from "@/lib/engine/connectionGraph";
import { contactLabel } from "@/lib/instructions/emit";
import { checkCollisionsValidated, worldCells, type VoxelData } from "@/lib/engine/voxelCollision";
import type { PartMetaMap, PlacedPartJson } from "@/lib/data/schemas";

export interface MatePlacement {
  /** World frame for part B; part A sits at identity. */
  frame: Frame;
  aConn: number;
  bConn: number;
  /** Contact class of the intended connector pair ("stud", "pin", …). */
  label: string;
  kind: "rigid" | "revolute";
  rule: PairRule;
  /** Total engaged contacts in this placement (a 2×4 on a 2×4 shares 8). */
  contacts: number;
  /** Rotation about the mate axis (deg) and axis polarity flip applied. */
  rot: number;
  flip: boolean;
  /** Human description: B's offset from A in studs/LDU + orientation. */
  desc: string;
  /** The engaged connector pair, named: "stud(10,0) → tube(-20,0)". */
  via: string;
}

/** Human name for a connector: stud/bar/pin/axle/pocket/tube/bore/… */
export function connName(c: LocalConnector): string {
  if (c.kind !== "cyl") return c.kind;
  const segs = secSegments(c.secs);
  const total = segs.reduce((s, x) => s + x.len, 0);
  const hasA = segs.some((x) => x.kind === "A");
  if (c.gender === "M") {
    if (hasA) return segs.some((x) => x.kind === "R" && x.len >= 8) ? "axle-pin" : "axle";
    if (total >= 12) return "pin";
    return (c.radius ?? 6) <= 4.5 ? "bar" : "stud";
  }
  const len = Number(c.secs?.match(/[RS]\s+[\d.]+\s+([\d.]+)/)?.[1] ?? 0);
  if (c.caps === "one" && total <= 8) {
    if (c.secs?.trimStart().startsWith("S") || len >= 16) return "pocket";
    return "tube";
  }
  if (c.caps === "one" && (c.secs?.trimStart().startsWith("S") || len >= 16)) return "pocket";
  if (hasA) return "axle hole";
  return "bore";
}

/** Compact orientation description for a rotation matrix. y is the
 * vertical (LDraw): "about y" = spun flat; "about x/z" = tipped over. */
export function rotDesc(r: number[]): string {
  const det =
    r[0] * (r[4] * r[8] - r[5] * r[7]) -
    r[1] * (r[3] * r[8] - r[5] * r[6]) +
    r[2] * (r[3] * r[7] - r[4] * r[6]);
  if (det < 0) return "MIRRORED (bad frame)"; // improper — should never survive
  const trace = r[0] + r[4] + r[8];
  const deg = (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
  if (deg < 0.5) return "upright";
  if (deg > 179.5) {
    // 180°: the sin-based axis formula degenerates — read the axis off
    // the diagonal instead (uᵢ² = (rᵢᵢ+1)/2).
    const u = [r[0], r[4], r[8]].map((v) => Math.sqrt(Math.max(0, (v + 1) / 2)));
    const named = (["x", "y", "z"] as const).map((name, i) => ({ name, v: u[i] })).find((c) => c.v > 0.99);
    return named ? `180° about ${named.name}${named.name === "y" ? "" : " (upside down)"}` : "180° about diag";
  }
  const ax: V3 = [r[7] - r[5], r[2] - r[6], r[3] - r[1]];
  const n = Math.hypot(...ax);
  if (n < 1e-4) return `${Math.round(deg)}°`;
  const u = ax.map((v) => v / n);
  const named = (["x", "y", "z"] as const)
    .map((name, i) => ({ name, v: u[i] }))
    .find((c) => Math.abs(Math.abs(c.v) - 1) < 0.02);
  return `${Math.round(deg)}° about ${named ? `${named.v < 0 ? "−" : ""}${named.name}` : "diag"}`;
}

/** LDraw frame → placed-part record. Convention (see ldraw/serialize,
 * engine/snapAlign.ldrawFrameOf): position is engine-frame (y/z are
 * LDraw's negated) but `m` is the RAW LDraw rotation — serialize writes
 * it into type-1 lines untouched. Do NOT conjugate: F·R·F equals R for
 * y-rotations (so the bug hides in axis-aligned tests) but displaces
 * every x/z-tilted placement's voxel cloud. */
export function toPlaced(part: string, f: Frame, color: number): PlacedPartJson {
  return {
    part,
    color,
    x: f.o[0],
    y: -f.o[1],
    z: -f.o[2],
    rot: 0,
    m: f.r.slice(),
  } as PlacedPartJson;
}

/** Cheap compatibility pre-filter — the validator has the final say. */
function quickCompatible(a: LocalConnector, b: LocalConnector): boolean {
  const pair = [a.kind, b.kind].sort().join("+");
  if (pair === "cyl+cyl") return a.gender !== b.gender;
  if (pair === "fgr+fgr") return true;
  if (pair === "clp+cyl") return true;
  if (pair === "gen+gen") return a.gender !== b.gender;
  return false;
}

const quant = (f: Frame) =>
  `${f.o.map((v) => Math.round(v * 2) / 2).join(",")}|${f.r.map((v) => Math.round(v * 50) / 50).join(",")}`;

export interface EnumerateOpts {
  /** Output cap (default 2048) — safety valve against a runaway loop,
   *  NOT a real limit: a 16x16 baseplate legitimately seats a plate at
   *  220+ positions, and a cap of 240 truncated those catalogs so most
   *  observed placements had nothing to match. */
  max?: number;
  /**
   * Work budget: connector PAIRS examined before the search gives up
   * (default: no limit). The output cap above bounds what is kept, not what
   * is looked at, and the two are far apart on a big part — seating a 16x8
   * panel (361 connectors) onto a 16x2 beam (79) is 28,519 pairs of voxel
   * work, which measured at six minutes inside one copilot tool call. An
   * interactive caller should pass a budget and say so when it bites; the
   * catalog builders must not, or they would silently ship a short catalog.
   */
  maxPairs?: number;
  /** Wall-clock budget in ms (default: none). Checked every 8 pairs — the
   * cost of a pair varies by two orders of magnitude with the voxel work, so
   * time is the bound an interactive caller actually cares about. */
  maxMs?: number;
  /** Name-based classification predicates (friction pins, round-1×1 and
   * tyre-wheel vetoes) — pass the same ones the editor runs with, or the
   * gallery misclassifies friction pins as movable. */
  infer?: InferOpts;
  /** When provided, placements whose bodies COLLIDE (cavity-aware voxel
   * check, joint engagement allowed) are pruned, and geometric dedup
   * uses B's actual voxel occupancy (collapses symmetric-part twins). */
  meta?: PartMetaMap;
  vox?: VoxelData;
  /**
   * Restrict the outer loop to these connector indices of A. B still
   * sees A's FULL connector set, so contact counts, engagement and
   * collision are unchanged — only which seats we start from is
   * reduced. Used by the lattice pass, which enumerates one
   * representative per repeated seat and translates the results.
   */
  aIndices?: number[];
}

export interface EnumerateResult {
  placements: MatePlacement[];
  /** Proposals rejected because the two bodies interpenetrate. */
  prunedColliding: number;
  /** Proposals rejected as geometric duplicates (part symmetry). */
  prunedDuplicate: number;
  /** The pair budget ran out: this catalog is partial. */
  truncated: boolean;
  /** Connector pairs actually examined. */
  pairs: number;
}

/**
 * Enumerate validated placements of B onto A. Deterministic order:
 * (aConn, bConn, flip, rot).
 */
export function enumerateMates(
  partA: string,
  partB: string,
  conns: ConnectionMap,
  opts: EnumerateOpts = {},
): EnumerateResult {
  const { max = 2048, maxPairs = Infinity, maxMs, infer, meta, vox, aIndices } = opts;
  const deadline = maxMs ? Date.now() + maxMs : Infinity;
  const ca = expandedConnectors(partA, conns);
  const cb = expandedConnectors(partB, conns);
  const connectorsOf = (part: string) => expandedConnectors(part, conns);
  const out: MatePlacement[] = [];
  const seen = new Set<string>();
  const seenGeo = new Set<string>();
  /** Spin-symmetric placements kept so far — near-match dedup (same
   * contacts, origin within 4.5 LDU) collapses depth-sampling jitter. */
  const rndKept: { ck: string; o: V3 }[] = [];
  /** Movable placements kept so far — same joint, near-equal depth. */
  const revKept: { ck: string; slide: number }[] = [];

  /**
   * Is B end-for-end symmetric about connector `bi`? If so, inserting
   * it "the other way round" is the SAME placement (a plain axle), and
   * if not it is a real choice (a bar with a ball on one end, an
   * axle-pin). Measured on the voxel model: slice the occupancy along
   * the connector axis and compare the profile with its mirror about
   * the connector origin. The section profile alone can't answer this —
   * it describes the connector, not the part hanging off it.
   */
  const flipSymCache = new Map<number, boolean>();
  const flipSymmetric = (bi: number): boolean => {
    const hit = flipSymCache.get(bi);
    if (hit !== undefined) return hit;
    let sym = false;
    const c = cb[bi];
    if (vox?.parts[partB] && c) {
      const cells = worldCells(toPlaced(partB, { o: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, 14), vox, hOf);
      if (cells) {
        // Connector pos/axis in ENGINE coords (y/z negated), matching
        // the cell keys.
        const p: V3 = [c.local[0], -c.local[1], -c.local[2]];
        const axL = mulMV(c.ori ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0]);
        const n = Math.hypot(...axL) || 1;
        const ax: V3 = [axL[0] / n, -axL[1] / n, -axL[2] / n];
        const res = vox.res;
        const hist = new Map<number, number>();
        for (const cell of cells) {
          const cx = ((cell % 1024) - 512 + 0.5) * res;
          const cy = ((((cell / 1024) | 0) % 1024) - 512 + 0.5) * res;
          const cz = (((cell / (1024 * 1024)) | 0) - 512 + 0.5) * res;
          const t = Math.round((cx - p[0]) * ax[0] + (cy - p[1]) * ax[1] + (cz - p[2]) * ax[2]);
          hist.set(t, (hist.get(t) ?? 0) + 1);
        }
        let diff = 0;
        let total = 0;
        for (const [t, n2] of hist) {
          diff += Math.abs(n2 - (hist.get(-t) ?? 0));
          total += n2;
        }
        sym = total > 0 && diff / total < 0.06; // 6% slack for voxel jitter
      }
    }
    flipSymCache.set(bi, sym);
    return sym;
  };
  /**
   * Is B's SOLID a body of revolution about connector `bi`'s axis? Only
   * then do the four spin samples describe one placement.
   *
   * Connector layout alone cannot answer this. `bAxisSym` asks whether
   * B's connectors lie on a single axis line, which is trivially true of
   * ANY single-connector part — a cheese slope, a headlight brick, a
   * wedge. Treating those as spin-symmetric collapsed their four
   * distinct orientations into one, so the catalog offered a 1x1 slope
   * in exactly one direction and every other way builders actually use
   * it read as unbuildable (3021 x 54200 alone: 424 mates).
   *
   * Measured on the voxel model: rotate the occupancy 90° about the
   * connector axis and require near-total overlap, with a one-cell
   * dilation to absorb the parity-fill bias.
   */
  const spinSolidCache = new Map<number, boolean>();
  const spinSymmetricSolid = (bi: number): boolean => {
    const hit = spinSolidCache.get(bi);
    if (hit !== undefined) return hit;
    let sym = false;
    const c = cb[bi];
    const def = vox?.parts[partB];
    if (def && c) {
      const axL = mulMV(c.ori ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0]);
      const n = Math.hypot(...axL) || 1;
      const ax: V3 = [axL[0] / n, axL[1] / n, axL[2] / n];
      // Only axis-aligned connectors can be tested on the voxel lattice;
      // anything else stays "not symmetric", which keeps all four spins.
      const major = [Math.abs(ax[0]), Math.abs(ax[1]), Math.abs(ax[2])];
      const k = major.indexOf(Math.max(...major));
      if (major[k] > 0.99) {
        const bits = typeof atob === "function" ? atob(def.bits) : Buffer.from(def.bits, "base64").toString("binary");
        const [dx, dy, dz] = def.dims;
        const pts: [number, number, number][] = [];
        const set = new Set<number>();
        let i = 0;
        for (let z = 0; z < dz; z++)
          for (let y = 0; y < dy; y++)
            for (let x = 0; x < dx; x++, i++)
              if (bits.charCodeAt(i >> 3) & (1 << (i & 7))) {
                pts.push([x, y, z]);
                set.add(x + 1024 * (y + 1024 * z));
              }
        if (pts.length) {
          // Rotate about the CENTROID of the occupancy, and share one
          // centre between the two cross-axis coordinates. The bounding
          // box is not square in cross-section (a round pin voxelises to
          // 16x17), so spinning about the box centre throws a genuinely
          // round part off its own grid and reports it as asymmetric.
          const cen = [0, 0, 0];
          for (const q of pts) {
            cen[0] += q[0];
            cen[1] += q[1];
            cen[2] += q[2];
          }
          cen[0] /= pts.length;
          cen[1] /= pts.length;
          cen[2] /= pts.length;
          const u = (k + 1) % 3;
          const w = (k + 2) % 3;
          const shared = (cen[u] + cen[w]) / 2;
          const ctr = [0, 0, 0];
          ctr[k] = cen[k];
          ctr[u] = shared;
          ctr[w] = shared;
          // 90° about axis k, in grid coords
          const rot = (q: number[]): number[] => {
            const d = [q[0] - ctr[0], q[1] - ctr[1], q[2] - ctr[2]];
            const o = k === 0 ? [d[0], -d[2], d[1]] : k === 1 ? [d[2], d[1], -d[0]] : [-d[1], d[0], d[2]];
            return [Math.round(o[0] + ctr[0]), Math.round(o[1] + ctr[1]), Math.round(o[2] + ctr[2])];
          };
          const NB = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
          let ok = 0;
          for (const q of pts) {
            const t = rot(q);
            for (const nb of NB)
              if (set.has(t[0] + nb[0] + 1024 * (t[1] + nb[1] + 1024 * (t[2] + nb[2])))) {
                ok++;
                break;
              }
          }
          sym = ok / pts.length >= 0.9;
        }
      }
    }
    spinSolidCache.set(bi, sym);
    return sym;
  };

  let prunedColliding = 0;
  let prunedDuplicate = 0;
  const hOf = (part: string) => meta?.[part]?.h ?? 24;
  const placedA = toPlaced(partA, { o: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, 7);
  // Is B a single-axis part (pin, axle, bush)? All its connectors on
  // one axis line → spinning B about a cyl mate axis changes nothing.
  const bAxisSym =
    cb.length > 0 &&
    cb.every((c) => {
      const ax0 = mulMV(cb[0].ori ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0]);
      const ax = mulMV(c.ori ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0]);
      const dot = ax0[0] * ax[0] + ax0[1] * ax[1] + ax0[2] * ax[2];
      if (Math.abs(dot) < 0.99) return false;
      const d = [c.local[0] - cb[0].local[0], c.local[1] - cb[0].local[1], c.local[2] - cb[0].local[2]];
      const along = d[0] * ax0[0] + d[1] * ax0[1] + d[2] * ax0[2];
      const lat2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along * along;
      return lat2 <= 0.75 * 0.75;
    });
  const aLoop = aIndices ?? ca.map((_, i) => i);
  let pairs = 0;
  let truncated = false;
  for (const ai of aLoop) {
    if (out.length >= max || truncated) break;
    for (let bi = 0; bi < cb.length && out.length < max; bi++) {
      const a = ca[ai];
      const b = cb[bi];
      if (!quickCompatible(a, b)) continue;
      // budget counts the pairs that cost something, not the ones the
      // compatibility test throws out in a nanosecond
      if (++pairs > maxPairs) { truncated = true; break; }
      if ((pairs & 7) === 0 && Date.now() > deadline) { truncated = true; break; }
      // SLIDE sampling: a long male in a long female (pin/axle in a
      // bore) has a translational DOF along the shared axis, and exact
      // frame-coincidence is often the ILLEGAL pose (a friction pin
      // centered in a single brick = collar jam) — the legal seats are
      // slid. Sample the half-stud lattice across the engagement range;
      // profile/collision pruning keeps only the physical stops. Short
      // males (studs) keep the single coincident seat.
      const aSegs = secSegments(a.secs);
      const bSegs = secSegments(b.secs);
      const aLen = aSegs.reduce((s, x) => s + x.len, 0);
      const bLen = bSegs.reduce((s, x) => s + x.len, 0);
      // Which side is the male decides whether depth is even a choice:
      // a SHORT male (stud, tip) has exactly ONE seat — frame
      // coincidence, where it bottoms out. Only a LONG male (pin,
      // axle, bar) can rest at several depths, so only then do we
      // sample slides. (Sampling on a short male produced "stud 1 LDU
      // out of its pocket" phantoms.)
      const aIsMale = a.gender === "M";
      const maleSegs = aIsMale ? aSegs : bSegs;
      const maleLen = aIsMale ? aLen : bLen;
      const femLen = aIsMale ? bLen : aLen;
      const maleMulti = new Set(maleSegs.filter((x) => x.kind === "R" || x.kind === "A").map((x) => x.rad)).size > 1;
      const slides: number[] = [0];
      // A leading male section WIDER than the female's bore cannot
      // enter it — it is a shoulder the female seats against, so the
      // seat sits that far from frame coincidence rather than at it.
      // 6141's stud is "R 10 3  R 6 4": only the r6 part goes into a
      // r6 tube, and the r10 shoulder holds the mating part 3 LDU
      // clear. Snapping origin-to-origin instead drove it 3 LDU into
      // the shoulder, where the collision check correctly killed it —
      // so a round plate with a stud came out with ONE placement
      // against everything (6,689 corpus mates unreachable).
      if (a.kind === "cyl" && b.kind === "cyl" && maleLen < 12) {
        const femSegs = aIsMale ? bSegs : aSegs;
        // The MOUTH radius decides what can enter, not the narrowest
        // section deeper in. 3062b's female is "R 6 20  R 4 8": a stud
        // enters the r6 mouth, and using the r4 waist instead counted
        // the male's own r6 shaft as too wide, putting the seat 7 LDU
        // out instead of 3. Sections are listed from the mouth inward.
        const bores = femSegs.filter((x) => x.kind === "R" || x.kind === "S" || x.kind === "A").map((x) => x.rad);
        if (bores.length) {
          const bore = bores[0];
          let lead = 0;
          for (const seg of maleSegs) {
            if (seg.rad > bore + 0.6) lead += seg.len;
            else break;
          }
          // both signs: the profile runs along −axis, and which way the
          // shoulder faces depends on the flip. Collision prunes the
          // wrong one.
          if (lead > 0) slides.push(lead, -lead);
        }
      }
      if (a.kind === "cyl" && b.kind === "cyl" && maleLen >= 12) {
        if (femLen >= 12 && !maleMulti) {
          // Smooth long-in-long (continuous slide DOF): half-stud
          // lattice; the detent rule keeps one representative.
          for (let s = 10; aLen / 2 + bLen / 2 - s >= 4; s += 10) slides.push(s, -s);
        } else {
          // Fine sampling at 1 LDU: seats are set by FEATURE geometry
          // (a pocket's depth, a flange meeting the bore face) — off
          // the stud lattice, and a 2-LDU step leaves stops visibly
          // sunk. The stop tests below keep only resting positions.
          for (let s = 1; aLen / 2 + bLen / 2 - s >= 2; s += 1) slides.push(s, -s);
        }
      }
      // Spin symmetry: when EVERY connector of B lies on one axis line
      // (pins, axles, bushes — not bricks), rotating B about the mate
      // axis is not a distinct placement: cross/ridge sections are
      // 4-fold or continuously symmetric at our 90° sampling. Flip
      // (end-for-end) stays distinct unless B's profile is palindromic.
      const norm = (x: SecSeg) => `${x.kind.replace(/^_L$|^L_$/, "L")}:${x.rad}:${x.len}`;
      // Geometric when voxels exist (sees the ball on a bar's end);
      // section-profile palindrome as the fallback.
      const palindromic = vox?.parts[partB]
        ? flipSymmetric(bi)
        : bSegs.map(norm).join("|") === [...bSegs].reverse().map(norm).join("|");
      const spinSym = a.kind === "cyl" && b.kind === "cyl" && bAxisSym && spinSymmetricSolid(bi);
      for (const flip of [false, true]) {
        for (const rot of [0, 90, 180, 270]) {
        const dirDone = { plus: false, minus: false };
        // One representative of the FREE-SLIDE continuum (an axle
        // mid-bore) — but ONLY when this family has no real stop. A
        // half-inserted pose next to the flange seats reads as a
        // failure, and the slide-travel readout already describes the
        // continuum. `freeIdx` remembers where the rep landed so the
        // first stop can retract it.
        let freeEmitted = false;
        let freeIdx = -1;
        // Frame for a given slide within this (flip, rot) — used for
        // the candidate itself and for the blocked-deeper stop test.
        const frameFor = (s: number): Frame => {
          let world = compose(connFrame(a), { o: [0, s, 0], r: rotY(rot) });
          if (flip) world = compose(world, { o: [0, 0, 0], r: FLIP_X });
          const cf = connFrame(b);
          const r = mulMM(world.r, transpose(cf.r));
          const o = world.o.map((v, i) => v - mulMV(r, cf.o)[i]) as V3;
          return { o, r };
        };
        // ENUM_TRACE="partA/partB" prints why each candidate lives or
        // dies — the loop has six exits, and knowing which one fired is
        // the whole diagnosis when a corpus pose fails to appear.
        const trace = process.env.ENUM_TRACE === `${partA}/${partB}`
          ? (slide: number, why: string) =>
              console.error(`  [trace ai=${ai} bi=${bi} f=${flip ? 1 : 0} r=${rot} s=${slide}] ${why}`)
          : null;
        for (const slide of slides) {
          if (out.length >= max) break;
          if (slide > 0 && dirDone.plus) { trace?.(slide, "dirDone+"); continue; }
          if (slide < 0 && dirDone.minus) { trace?.(slide, "dirDone-"); continue; }
          const frame = frameFor(slide);
          const key = quant(frame);
          if (seen.has(key)) { trace?.(slide, `dup-frame o=${frame.o.map(Math.round)}`); continue; }

          const parts: E2Part[] = [
            { id: 1, part: partA, color: 7, root: { o: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] } },
            { id: 2, part: partB, color: 14, root: frame },
          ];
          const frames = new Map<number, Frame>([
            [1, parts[0].root!],
            [2, frame],
          ]);
          const mates = detectMates(parts, frames, connectorsOf);
          if (mates.length === 0) { trace?.(slide, `no-mates o=${frame.o.map(Math.round)}`); continue; }
          // The intended pair must itself be engaged — placements where only
          // OTHER connectors happened to touch are duplicates of other seeds.
          const intended = mates.find(
            (m) =>
              (m.a.partId === 1 && m.a.conn === ai && m.b.conn === bi) ||
              (m.b.partId === 1 && m.b.conn === ai && m.a.conn === bi),
          );
          if (!intended) { trace?.(slide, `not-intended o=${frame.o.map(Math.round)}`); continue; }
          // Record the frame ONLY once a seed proves the intended mate.
          // Recording on rejection poisoned the frame for every LATER
          // connector pair: 3022's big S-pocket seeds the jumper-centering
          // frame first, gets refused not-intended (the mate belongs to
          // the center tube), and the tube's own legitimate seed then read
          // as dup-frame — the placement vanished from the catalog.
          seen.add(key);

          const placedB = meta && vox ? toPlaced(partB, frame, 14) : null;
          let seatNote = "";
          let isFree = false;

          // Collision pruning: cavity-aware voxel check; legitimate joint
          // engagement (studs in tubes, pins in holes) is allowed.
          if (placedB && meta && vox) {
            const colls = checkCollisionsValidated([placedA, placedB], meta, vox, conns);
            if (colls.length > 0) {
              prunedColliding++;
              continue;
            }
            // STOP test for collared/flanged males (any bore length): a
            // resting pose is one where pushing a step DEEPER is
            // blocked (flange against the face, collar clicked in a
            // recess, tip-lip click). Free-sliding poses — including
            // the frame-coincident center of a thin bore on a long pin
            // — are the continuous DOF; ONE representative is kept.
            if (maleMulti && slides.length > 1) {
              const blocked = (s2: number) =>
                checkCollisionsValidated([placedA, toPlaced(partB, frameFor(s2), 14)], meta, vox, conns)
                  .length > 0;
              const isStop =
                slide === 0 ? blocked(1) || blocked(-1) : blocked(slide - Math.sign(slide));
              if (!isStop) {
                if (freeEmitted) continue;
                freeEmitted = true; // provisional: retracted if a stop follows
                isFree = true;
                seatNote = " · slides freely (rep)";
              } else if (slide !== 0) {
                // A resting position away from frame-coincidence — the
                // flange seat, a tip-lip click… stated factually by its
                // offset along the axis so shallow seats are visible.
                seatNote = ` · stop @${slide > 0 ? "+" : ""}${slide}`;
              }
            }
          }

          // GEOMETRIC dedup: same engaged contact points + same occupied
          // space = the same physical placement, even when a symmetric
          // part arrived there via a different rotation.
          const contactsKey = mates
            .map(
              (m) =>
                `${contactLabel(m.a, m.b)}@${(m.a.partId === 1 ? m.a : m.b).pos
                  .map((v) => Math.round(v * 2) / 2)
                  .join(",")}`,
            )
            .sort()
            .join("|");
          const cells = placedB && vox ? worldCells(placedB, vox, hOf) : null;
          // Dedup key at 2-LDU cell granularity: the parity fill is
          // asymmetric by one cell under 180° rotation, so symmetric
          // twins differ by a hairline at res 1 — coarsening absorbs
          // that (distinct placements differ by ≥10 LDU). Cell keys are
          // worldCells' packing: c = cx + 1024·(cy + 1024·cz).
          // A placement that survives (or duplicates a survivor) is a
          // real stop — no deeper slide in this direction (detent
          // rule). Collared males in long bores skip the suppression:
          // they have MULTIPLE discrete stops, and the blocked-deeper
          // test above already prunes the in-between positions.
          const markDir = () => {
            if (maleMulti && slides.length > 1) return;
            if (slide === 0) dirDone.plus = dirDone.minus = true;
            else if (slide > 0) dirDone.plus = true;
            else dirDone.minus = true;
          };

          const inferred = inferJoints(parts, frames, connectorsOf, { current: 3 }, infer);
          const pair = inferred.pairs[0];

          let geoKey: string;
          if (pair?.kind === "revolute") {
            // A MOVABLE pair's spin about the mate axis is the joint's
            // ANGLE, not a different placement — a bar in a clip is one
            // connection you can then rotate (the viewer drives it with
            // the angle slider). So the rot samples collapse to one
            // representative; flip stays distinct unless the part is
            // end-for-end symmetric, and near-equal depths (voxel
            // jitter picking stops a LDU apart) merge. Exact voxel-set
            // dedup can't do this: the voxelizer's jitter breaks
            // perfect rotational symmetry.
            const ck = `REV#${contactsKey}#${ai}/${bi}${palindromic ? "" : `#f${flip}`}`;
            if (revKept.some((e) => e.ck === ck && Math.abs(e.slide - slide) <= 4.5)) {
              prunedDuplicate++;
              markDir();
              continue;
            }
            revKept.push({ ck, slide });
            geoKey = `${ck}#s${slide}`;
          } else if (spinSym) {
            // Near-match: spin variants of the same seat land at depths
            // a couple LDU apart (the split-pin slots shift the
            // collision envelope per spin) — same contacts + origin
            // within 4.5 LDU = the same physical placement.
            const ck = `${contactsKey}${palindromic ? "" : `#f${flip}`}`;
            const near = rndKept.some(
              (e) =>
                e.ck === ck &&
                Math.hypot(e.o[0] - frame.o[0], e.o[1] - frame.o[1], e.o[2] - frame.o[2]) <= 4.5,
            );
            if (near) {
              prunedDuplicate++;
              markDir();
              continue;
            }
            rndKept.push({ ck, o: frame.o });
            geoKey = `RND#${ck}#${frame.o.map((v) => Math.round(v)).join(",")}`;
          } else if (cells) {
            const coarse = new Set<number>();
            for (const c of cells) {
              const cx = c % 1024;
              const cy = ((c / 1024) | 0) % 1024;
              const cz = (c / (1024 * 1024)) | 0;
              coarse.add((cx >> 1) + 512 * ((cy >> 1) + 512 * (cz >> 1)));
            }
            geoKey = `${contactsKey}#${[...coarse].sort((x, y) => x - y).join(";")}`;
          } else {
            geoKey = `${contactsKey}#${quant(frame)}`;
          }
          if (seenGeo.has(geoKey)) {
            prunedDuplicate++;
            markDir(); // duplicates an existing survivor — still a stop
            continue;
          }
          seenGeo.add(geoKey);
          markDir();

          // A real stop retracts this family's free-slide representative:
          // with flange seats listed, a mid-bore pose is redundant (and
          // looks like a half-inserted mistake).
          if (isFree) freeIdx = out.length;
          else if (freeIdx >= 0) {
            out.splice(freeIdx, 1);
            prunedDuplicate++;
            freeIdx = -1;
          }

          const bo = frame.o;
          const aSide = intended.a.partId === 1 ? intended.a : intended.b;
          const bSide = intended.a.partId === 1 ? intended.b : intended.a;
          const aC = ca[aSide.conn];
          const bC = cb[bSide.conn];
          const at = (c: LocalConnector) => `(${c.local[0]},${c.local[2]})`;
          out.push({
            frame,
            aConn: ai,
            bConn: bi,
            label: contactLabel(intended.a, intended.b),
            kind: pair?.kind ?? "rigid",
            rule: pair?.rule ?? "stud",
            contacts: mates.length,
            rot,
            flip,
            desc: `B at (${Math.round((bo[0] / 20) * 2) / 2}, ${Math.round((-bo[2] / 20) * 2) / 2}) studs, ${Math.round(-bo[1] * 2) / 2} LDU up · ${rotDesc(frame.r)}${seatNote}`,
            via: `B C${bSide.conn + 1} ${connName(bC)}${at(bC)} → A C${aSide.conn + 1} ${connName(aC)}${at(aC)}`,
          });
        }
        }
      }
    }
  }
  return { placements: out, prunedColliding, prunedDuplicate, truncated, pairs };
}
