/**
 * Structural soundness — the pure-geometry subset of the lego-engineering
 * verification stack (no physics engine): a stud-connectivity graph over
 * grid parts, connected components, grounding, and per-part support.
 *
 * Two grid parts CONNECT when their footprints overlap in XZ and one's top
 * face meets the other's bottom face. A part is GROUNDED at y≈0. A build
 * is SOUND when every part belongs to a grounded component.
 *
 * Oriented parts (imported SNOT/angled) are excluded — their connections
 * aren't face-to-face stacks.
 */
import { partBBox } from "./geometry";
import type { PartMetaMap, PlacedPart } from "./types";

export interface Soundness {
  sound: boolean;
  parts: number;
  gridParts: number;
  connections: number;
  components: number;
  /** Indices of parts in components that never touch the ground. */
  floating: number[];
  /** Human/model-readable verdict lines. */
  report: string;
}

export function checkSoundness(
  parts: PlacedPart[],
  meta: PartMetaMap,
  /** Extra connectivity edges — REAL joints from the connection graph
   * (pins, clips…). Physical contact alone misses engaged joints whose
   * bodies no longer overlap (a properly seated wheel on a pin). */
  extraEdges?: [number, number][],
): Soundness {
  // ALL parts with known geometry join the SUPPORT graph — a car resting
  // on its tires is grounded through physical contact, no studs required.
  const idx: number[] = [];
  const gridIdx: number[] = [];
  parts.forEach((p, i) => {
    if (!meta[p.part]) return;
    idx.push(i);
    if (!p.m) gridIdx.push(i);
  });
  const boxes = new Map(idx.map((i) => [i, partBBox(parts[i], meta)]));

  const parent = new Map<number, number>(idx.map((i) => [i, i]));
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const EPS = 0.6;
  let connections = 0;
  if (extraEdges) {
    for (const [a, b] of extraEdges) {
      if (parent.has(a) && parent.has(b)) union(a, b);
    }
  }
  const grounded = new Set<number>();
  const gridSet = new Set(gridIdx);
  for (let ai = 0; ai < idx.length; ai++) {
    const i = idx[ai];
    const A = boxes.get(i)!;
    if (A[2] < EPS) grounded.add(i); // bottom at y≈0
    for (let bi = ai + 1; bi < idx.length; bi++) {
      const j = idx[bi];
      const B = boxes.get(j)!;
      const touch =
        A[0] < B[1] + EPS && A[1] > B[0] - EPS &&
        A[2] < B[3] + EPS && A[3] > B[2] - EPS &&
        A[4] < B[5] + EPS && A[5] > B[4] - EPS;
      if (!touch) continue;
      if (gridSet.has(i) && gridSet.has(j)) {
        // Grid↔grid: only a real face-to-face STACK bonds — top meets
        // bottom with meaningful footprint overlap (≥ half a stud cell).
        // Side kisses, corner grazes, and resting on a slope's ridge are
        // contact, not structure; counting them as bonds is how broken
        // houses used to pass as "sound".
        const ovX = Math.min(A[1], B[1]) - Math.max(A[0], B[0]);
        const ovZ = Math.min(A[5], B[5]) - Math.max(A[4], B[4]);
        const stacked = Math.abs(A[3] - B[2]) < EPS || Math.abs(B[3] - A[2]) < EPS;
        if (stacked && ovX >= 8 && ovZ >= 8) {
          union(i, j);
          connections++;
        }
      } else {
        // Oriented parts (SNOT/angled imports): bboxes can't judge
        // engagement — keep loose contact so imported models aren't
        // spuriously flagged. Real joints arrive via extraEdges anyway.
        union(i, j);
      }
    }
  }

  // Components + grounding.
  const compRoots = new Map<number, number[]>();
  for (const i of idx) {
    const r = find(i);
    let arr = compRoots.get(r);
    if (!arr) compRoots.set(r, (arr = []));
    arr.push(i);
  }
  const groundedRoots = new Set([...grounded].map((i) => find(i)));
  const floating: number[] = [];
  for (const [root, members] of compRoots) {
    if (!groundedRoots.has(root)) floating.push(...members);
  }

  // Multiple structures are fine as long as each is grounded; floating
  // parts are the only hard failure.
  const sound = floating.length === 0;
  const lines = [
    sound ? "VERDICT: SOUND" : "VERDICT: UNSOUND",
    `${parts.length} parts (${gridIdx.length} checked) · ${connections} connections · ${compRoots.size} component${compRoots.size === 1 ? "" : "s"}`,
  ];
  if (floating.length > 0) {
    lines.push(
      `⚠ ${floating.length} FLOATING parts (no path to ground): indices ${floating.slice(0, 15).join(", ")}${floating.length > 15 ? "…" : ""} — they would fall. Support them from below or connect them to a grounded structure.`,
    );
  }
  if (compRoots.size > 1 && floating.length === 0) {
    // NOT a problem: mid-build this is the normal state (a row of columns
    // before the beam ties them together). Flagging it with ⚠ made the
    // copilot tear down and rebuild sound work.
    lines.push(
      `note: ${compRoots.size} separate grounded structures so far — normal while building; they unify when you bridge them.`,
    );
  }
  return {
    sound,
    parts: parts.length,
    gridParts: gridIdx.length,
    connections,
    components: compRoots.size,
    floating,
    report: lines.join("\n"),
  };
}

/**
 * Quick per-placement support check: does this part rest on the ground or
 * on top of another part? (Cheaper than a full soundness pass; used for
 * instant feedback on each placement.)
 */
export function isSupported(candidate: PlacedPart, parts: PlacedPart[], meta: PartMetaMap): boolean {
  if (candidate.m || !meta[candidate.part]) return true; // not judged
  const c = partBBox(candidate, meta);
  if (c[2] < 0.6) return true; // on the baseplate
  return parts.some((p) => {
    if (p.m || !meta[p.part]) return false;
    const b = partBBox(p, meta);
    const xz = c[0] < b[1] - 0.6 && c[1] > b[0] + 0.6 && c[4] < b[5] - 0.6 && c[5] > b[4] + 0.6;
    return xz && Math.abs(b[3] - c[2]) < 0.6;
  });
}
