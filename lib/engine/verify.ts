/**
 * verifyBuild — the one answer to "is every placement valid, and what holds
 * what?" Composes the real joint graph (validateConnections), true-geometry
 * collisions (checkCollisionsValidated), and groundedness into a single
 * verdict with named per-part reasons, plus the connection graph as a
 * first-class artifact:
 *
 *   - joints: typed edges (stud / pin / axle / clip / …) between placements
 *   - clusters: connected components through those joints — the physical
 *     subassemblies of the build (assembly proposals for flat files)
 *   - perPart: ok | unconnected | colliding, with human reasons
 *
 * Powers the builder's Validate panel, the copilot's gate, and evals.
 */
import { validateConnections, type Joint } from "./connectionGraph";
import { checkCollisionsValidated, type Collision, type VoxelData } from "./voxelCollision";
import type { ConnectionMap } from "./snapAlign";
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";

export interface PartVerdict {
  idx: number;
  ok: boolean;
  reasons: string[];
}

export interface BuildVerification {
  ok: boolean;
  joints: Joint[];
  /** Adjacency over joints (index → neighbor indices). */
  adjacency: number[][];
  /** Connected components through joints, largest first. Parts with no
   * joints form singleton clusters. */
  clusters: number[][];
  grounded: number[];
  unconnected: number[];
  collisions: Collision[];
  perPart: PartVerdict[];
  report: string;
}

export function verifyBuild(
  parts: PlacedPartJson[],
  meta: PartMetaMap,
  conns: ConnectionMap,
  vox: VoxelData,
): BuildVerification {
  const v = validateConnections(parts, meta, conns);
  const collisions = checkCollisionsValidated(parts, meta, vox, conns);

  const adjacency: number[][] = parts.map(() => []);
  for (const j of v.joints) {
    adjacency[j.a].push(j.b);
    adjacency[j.b].push(j.a);
  }

  // Connected components through real joints.
  const clusterOf = new Array<number>(parts.length).fill(-1);
  const clusters: number[][] = [];
  for (let i = 0; i < parts.length; i++) {
    if (clusterOf[i] !== -1) continue;
    const members: number[] = [];
    const stack = [i];
    clusterOf[i] = clusters.length;
    while (stack.length) {
      const n = stack.pop()!;
      members.push(n);
      for (const nb of adjacency[n]) {
        if (clusterOf[nb] === -1) {
          clusterOf[nb] = clusters.length;
          stack.push(nb);
        }
      }
    }
    clusters.push(members.sort((a, b) => a - b));
  }
  clusters.sort((a, b) => b.length - a.length);

  const collidingWith = new Map<number, number[]>();
  for (const c of collisions) {
    (collidingWith.get(c.a) ?? collidingWith.set(c.a, []).get(c.a)!).push(c.b);
    (collidingWith.get(c.b) ?? collidingWith.set(c.b, []).get(c.b)!).push(c.a);
  }
  const groundedSet = new Set(v.grounded);
  const unconnectedSet = new Set(v.unconnected);

  // A cluster that no part of touches the ground floats, however well its own parts are joined:
  // every part must reach the ground through real joints or rest on it.
  const floating = new Set<number>();
  for (const members of clusters) if (!members.some((i) => groundedSet.has(i))) for (const i of members) floating.add(i);
  const perPart: PartVerdict[] = parts.map((p, idx) => {
    const reasons: string[] = [];
    if (unconnectedSet.has(idx)) {
      reasons.push("no joint to any other part and not resting on the ground");
    } else if (floating.has(idx)) {
      reasons.push("joined only to parts that never reach the ground (the structure floats)");
    }
    const hits = collidingWith.get(idx);
    if (hits?.length) {
      reasons.push(`interpenetrates part${hits.length === 1 ? "" : "s"} ${hits.slice(0, 4).join(", ")}`);
    }
    return { idx, ok: reasons.length === 0, reasons };
  });

  const bad = perPart.filter((p) => !p.ok).length;
  const ok = bad === 0;
  const report = ok
    ? `VALID: ${parts.length} parts · ${v.joints.length} joints · ${clusters.length} cluster${clusters.length === 1 ? "" : "s"} · ${v.grounded.length} grounded · no collisions`
    : `${bad} invalid part${bad === 1 ? "" : "s"}: ${v.unconnected.length + floating.size} unattached, ${collisions.length} collision${collisions.length === 1 ? "" : "s"} · ${clusters.length} clusters`;

  return {
    ok,
    joints: v.joints,
    adjacency,
    clusters,
    grounded: [...groundedSet].sort((a, b) => a - b),
    unconnected: v.unconnected,
    collisions,
    perPart,
    report,
  };
}
