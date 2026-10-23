/**
 * join_structures — tie separate structures together, automatically.
 *
 * The engine bonds two grid parts only when one STACKS on the other: face
 * to face, at least half a stud of overlap. Side-by-side courses do not
 * bond. So a build drifts into "N separate grounded structures" the moment
 * a wall, a colonnade or a wing is raised beside its neighbour instead of
 * over it — the single most common defect in agent builds, and the one
 * models try to fix by DELETING the strays.
 *
 * The fix is mechanical, so it should not cost a model a single token of
 * reasoning: find the two structures, find a level where both present a
 * top face within reach of each other, and lay a plate across the gap so
 * it bonds to both. That is what this does — repeatedly, smallest
 * structure first, until everything is one piece or nothing more can
 * reach.
 */
import { partBBox } from "../engine/geometry";
import type { PlacedPartJson } from "../data/schemas";
import { collides, type BuildSession } from "./state";
import { jointEdges } from "./connect";
import { placeOnStuds } from "./connect2";

/** The plates it reaches for, longest first: a longer tie bridges a wider gap. */
const TIES: { part: string; w: number }[] = [
  { part: "3832", w: 10 }, // Plate 2 x 10
  { part: "3795", w: 6 }, // Plate 2 x 6
  { part: "3020", w: 4 }, // Plate 2 x 4
  { part: "3460", w: 8 }, // Plate 1 x 8
  { part: "3666", w: 6 }, // Plate 1 x 6
  { part: "3710", w: 4 }, // Plate 1 x 4
  { part: "3023", w: 2 }, // Plate 1 x 2
];

const EPS = 0.6;

/** What partBBox returns — a readonly tuple, so it must not be widened to
 * number[] anywhere it is carried around (a stricter TypeScript than the one
 * in this lockfile rejects that, which is how this reached a deploy). */
type Box = ReturnType<typeof partBBox>;
/** A part's free top face: the part, the height of that face, and its box. */
interface Face {
  i: number;
  top: number;
  box: Box;
}

/** Union-find over the same rule the soundness check uses. */
function components(session: BuildSession): Map<number, number[]> {
  const { parts, meta } = session;
  const idx = parts.map((_, i) => i).filter((i) => meta[parts[i].part]);
  const box = new Map(idx.map((i) => [i, partBBox(parts[i], meta)]));
  const parent = new Map(idx.map((i) => [i, i]));
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [a, b] of jointEdges(session)) if (parent.has(a) && parent.has(b)) union(a, b);
  for (let ai = 0; ai < idx.length; ai++)
    for (let bi = ai + 1; bi < idx.length; bi++) {
      const A = box.get(idx[ai])!, B = box.get(idx[bi])!;
      if (!(A[0] < B[1] + EPS && A[1] > B[0] - EPS && A[2] < B[3] + EPS && A[3] > B[2] - EPS && A[4] < B[5] + EPS && A[5] > B[4] - EPS)) continue;
      const ovX = Math.min(A[1], B[1]) - Math.max(A[0], B[0]);
      const ovZ = Math.min(A[5], B[5]) - Math.max(A[4], B[4]);
      const stacked = Math.abs(A[3] - B[2]) < EPS || Math.abs(B[3] - A[2]) < EPS;
      if (stacked && ovX >= 8 && ovZ >= 8) union(idx[ai], idx[bi]);
    }
  const out = new Map<number, number[]>();
  for (const i of idx) {
    const r = find(i);
    (out.get(r) ?? out.set(r, []).get(r)!).push(i);
  }
  return out;
}

/**
 * Every part whose top face is FREE — nothing of any structure stacked on
 * it. These are the faces a tie can land on. (Restricting this to the
 * topmost part of each structure was too strict: two walls of different
 * heights then share no level, and the common ground they do share — a
 * course lower down — never gets considered.)
 */
function freeTops(session: BuildSession): Face[] {
  const { parts, meta } = session;
  const idx = parts.map((_, i) => i).filter((i) => meta[parts[i].part] && !parts[i].m);
  const boxes = new Map(idx.map((i) => [i, partBBox(parts[i], meta)]));
  const out: Face[] = [];
  for (const i of idx) {
    const A = boxes.get(i)!;
    // How much of A's top face is built on. A part counts as a landing while
    // MOST of its top is still open: a 6x8 floor plate with one wall brick on
    // its edge used to count as fully covered, which left the bridger nothing
    // to land on at floor level and no way to tie a loose floor piece in.
    const area = Math.max(1, (A[1] - A[0]) * (A[5] - A[4]));
    let taken = 0;
    for (const j of idx) {
      if (j === i) continue;
      const B = boxes.get(j)!;
      // partBBox is [minX,maxX,minY,maxY,minZ,maxZ] with ground at minY=0:
      // B sits ON A when B's underside meets A's top face.
      if (Math.abs(B[2] - A[3]) >= EPS) continue;
      const ox = Math.min(A[1], B[1]) - Math.max(A[0], B[0]);
      const oz = Math.min(A[5], B[5]) - Math.max(A[4], B[4]);
      if (ox >= 8 && oz >= 8) taken += ox * oz;
    }
    if (taken / area < 0.9) out.push({ i, top: A[3], box: A });
  }
  return out;
}

export interface BridgeResult {
  report: string;
  placed: number;
  before: number;
  after: number;
}

/**
 * Lay ties until the build is one structure. `maxSpan` is how far apart
 * two structures may be (in studs) and still be bridged.
 */
export function bridgeStructures(
  session: BuildSession,
  opts: { maxSpan?: number; color?: number; maxTies?: number; maxRise?: number } = {},
): BridgeResult {
  const maxSpan = opts.maxSpan ?? 8;
  const maxRise = (opts.maxRise ?? 5) * 8;   // how much a lower face may be built up, in plates
  const maxTies = opts.maxTies ?? 40;
  const lines: string[] = [];
  const before = components(session).size;
  let placed = 0;
  /** Did any pair of structures come within reach at all? The two failures —
   * "nothing near enough" and "near enough but no tie would sit" — need
   * different advice, and giving the wrong one invites the same call again. */
  let sawCandidate = false;

  for (let round = 0; round < maxTies; round++) {
    const comps = [...components(session).values()].sort((a, b) => b.length - a.length);
    if (comps.length < 2) break;
    const main = comps[0];
    const tops = freeTops(session);
    const byPart = new Map<number, Face>();
    for (const t of tops) byPart.set(t.i, t);
    const mainSet = new Set(main);
    const mainTops = tops.filter((t) => mainSet.has(t.i));
    let tied = false;

    for (const other of comps.slice(1)) {
      const otherSet = new Set(other);
      const tops2 = tops.filter((t) => otherSet.has(t.i));
      // the closest pair of top faces that share a level
      let best: { a: Face; b: Face; gap: number; drop: number } | null = null;
      for (const a of mainTops)
        for (const b of tops2) {
          // A level difference is fine as long as it is a whole number of
          // plates and small enough to make up: the lower face gets a short
          // riser first, then the tie goes across. (Two structures rarely
          // happen to end at the same height — insisting on that is why an
          // earlier version of this could never join a colonnade to a wall.)
          const drop = Math.abs(a.top - b.top);
          if (drop > maxRise || Math.abs(drop % 8) > EPS) continue;
          const gapX = Math.max(0, Math.max(a.box[0], b.box[0]) - Math.min(a.box[1], b.box[1]));
          const gapZ = Math.max(0, Math.max(a.box[4], b.box[4]) - Math.min(a.box[5], b.box[5]));
          // a tie runs along one axis: the other axis must overlap
          if (gapX > 0 && gapZ > 0) continue;
          const gap = (gapX + gapZ) / 20;
          if (gap > maxSpan) continue;
          const score = gap + drop / 8;
          if (!best || score < best.gap + best.drop / 8) best = { a, b, gap, drop };
        }
      if (best) sawCandidate = true;
      if (process.env.DBB_BRIDGE_DEBUG)
        console.log(`[bridge] other=${other.length} parts · mainTops=${mainTops.length} otherTops=${tops2.length} · best=${best ? `gap ${best.gap.toFixed(1)} drop ${best.drop}` : "none"}`);
      if (!best) continue;

      const { a, b } = best;
      // A tie only needs to OVERLAP each side — the engine bonds on half a
      // stud — so its length is the gap plus a stud of landing at each end,
      // not the whole distance between the two parts' far edges.
      const alongX = Math.max(a.box[0], b.box[0]) - Math.min(a.box[1], b.box[1]) > -EPS;
      void best.drop;
      const lo = alongX ? Math.min(a.box[1], b.box[1]) : Math.min(a.box[5], b.box[5]);
      const hi = alongX ? Math.max(a.box[0], b.box[0]) : Math.max(a.box[4], b.box[4]);
      const gapStuds = Math.max(0, (hi - lo) / 20);
      const need = Math.ceil(gapStuds) + 2;
      const spanCentre = (lo + hi) / 2;
      // centre of the two parts' overlap on the other axis
      const crossLo = alongX ? Math.max(a.box[4], b.box[4]) : Math.max(a.box[2 + 2], b.box[4]);
      const crossHi = alongX ? Math.min(a.box[5], b.box[5]) : Math.min(a.box[1], b.box[1]);
      const crossCentre = alongX ? (crossLo + crossHi) / 2 : (Math.max(a.box[0], b.box[0]) + Math.min(a.box[1], b.box[1])) / 2;
      let low = a.top < b.top ? a : b;
      const high = a.top < b.top ? b : a;
      let risers = 0;
      while (high.top - low.top > EPS) {
        const lowPart = session.parts[low.i];
        const msg = placeOnStuds(session, { part: "3022", color: opts.color ?? lowPart.color ?? 71, onto: low.i, dx_studs: 0, dz_studs: 0 });
        if (/^REJECTED/.test(msg)) break;
        // placeOnStuds tolerates a graze; a tie that pushes into its
        // neighbour is worse than no tie at all
        const riser = session.parts[session.parts.length - 1];
        if (collides(riser, session.parts.slice(0, -1), session.meta)) {
          session.parts.pop();
          break;
        }
        risers++;
        const nb = partBBox(session.parts[session.parts.length - 1], session.meta);
        low = { i: session.parts.length - 1, top: nb[3], box: nb };
      }
      if (high.top - low.top > EPS) {
        while (risers-- > 0) session.parts.pop();
        continue;   // could not make the levels meet — try the next structure
      }
      const tieA = a.top < b.top ? low : a;
      const tieB = a.top < b.top ? b : low;
      const base = session.parts[tieA.i];
      void tieB;

      for (const tie of TIES) {
        if (tie.w < need) continue;                            // must reach both
        const rot = alongX ? 0 : 90;
        const centreX = alongX ? spanCentre : crossCentre;
        const centreZ = alongX ? crossCentre : spanCentre;
        const msg = placeOnStuds(session, {
          part: tie.part,
          color: opts.color ?? base.color ?? 71,
          onto: tieA.i,
          dx_studs: (centreX - base.x) / 20,
          dz_studs: (centreZ - base.z) / 20,
          rot: rot as 0 | 90,
        });
        if (/^REJECTED/.test(msg)) {
          if (process.env.DBB_BRIDGE_DEBUG) console.log(`[bridge] ${tie.part} rejected: ${msg.slice(0, 90)}`);
          continue;
        }
        const laid = session.parts[session.parts.length - 1];
        if (collides(laid, session.parts.slice(0, -1), session.meta)) {
          session.parts.pop();
          continue;
        }
        const nowOne = components(session).size < comps.length;
        if (!nowOne) {
          if (process.env.DBB_BRIDGE_DEBUG) console.log(`[bridge] ${tie.part} landed but joined nothing`);
          session.parts.pop();
          continue;
        }
        placed++;
        tied = true;
        lines.push(
          `  tie ${placed}: ${tie.part} over a ${gapStuds.toFixed(0)}-stud gap at y=${Math.round(high.top)}` +
            (risers > 0 ? ` (after raising the lower side by ${risers} plate${risers === 1 ? "" : "s"})` : "") +
            ` — joined a ${other.length}-part structure to the main one`,
        );
        break;
      }
      if (tied) break;
    }
    if (!tied) break;
  }

  const after = components(session).size;
  const head =
    after === 1
      ? `JOINED: the build is ONE structure (${placed} tie${placed === 1 ? "" : "s"} laid, was ${before}).`
      : placed > 0
        ? `PARTIALLY JOINED: ${before} → ${after} structures with ${placed} tie(s). The rest are out of reach — no free face within ${maxSpan} studs and ${opts.maxRise ?? 5} plates of height of another structure.`
        : sawCandidate
          ? `NOT JOINED: ${before} structures. They are close enough, but no tie would sit there — every spanning plate was refused or hit something. Calling this again will do the same thing: lay a plate across the seam yourself, or leave it. A single loose piece lying on the ground (a floor tile with nothing on it) is harmless and is NOT worth deleting parts over.`
          : `NOT JOINED: ${before} structures, and no two of them have free top faces within ${maxSpan} studs and ${opts.maxRise ?? 5} plates of each other. Move them closer or build one up, then run this again — repeating this call unchanged will not help.`;
  return { report: [head, ...lines].join("\n"), placed, before, after };
}

export type { PlacedPartJson };
