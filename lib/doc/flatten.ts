import { modelIndexByKey } from "./parse";
import type { DocProject, DocTreeNode, FlatInstance, OccNode } from "./types";

/**
 * Expand a DocProject's nested structure into concrete part placements
 * for rendering, plus the submodel tree and a global build sequence for
 * the step scrubber.
 *
 * Step semantics: walking the main model in item order, every `0 STEP`
 * (in the main model or inside an expanded submodel) advances one global
 * sequence slot — i.e. submodels are built inline where referenced, which
 * matches how instruction booklets interleave sub-assembly steps.
 *
 * Part-name quirks are ported from fromLdr (lib/ldraw/serialize.ts):
 * OMR files embed custom .dat sections ("<set> - <part>pNN.dat" patterns,
 * -fN flex sections, cNN combos) that can't be fetched standalone — they
 * map to their base library part, or expand if they're assembled combos.
 */

type LMat = { t: [number, number, number]; r: number[] };
const L_IDENTITY: LMat = { t: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

function lApply(m: LMat, x: number, y: number, z: number): [number, number, number] {
  return [
    m.t[0] + m.r[0] * x + m.r[1] * y + m.r[2] * z,
    m.t[1] + m.r[3] * x + m.r[4] * y + m.r[5] * z,
    m.t[2] + m.r[6] * x + m.r[7] * y + m.r[8] * z,
  ];
}

function lCompose(parent: LMat, child: LMat): LMat {
  const t = lApply(parent, child.t[0], child.t[1], child.t[2]);
  const p = parent.r;
  const c = child.r;
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = p[i * 3] * c[j] + p[i * 3 + 1] * c[3 + j] + p[i * 3 + 2] * c[6 + j];
    }
  }
  return { t, r };
}

export interface FlattenResult {
  instances: FlatInstance[];
  /** Total build-sequence slots (scrubber max). */
  stepCount: number;
  tree: DocTreeNode;
  /** Occurrence tree; occs[0] is the main model's root occurrence. */
  occs: OccNode[];
}

export function flattenProject(
  project: DocProject,
  isKnownPart: (id: string) => boolean = () => true,
): FlattenResult {
  const byKey = modelIndexByKey(project);
  const instances: FlatInstance[] = [];
  const occs: OccNode[] = [];
  // seq is shared across the whole walk (module-level mutable counter).
  let seq = 0;

  const newOcc = (modelIndex: number, parent: number | null): number => {
    const id = occs.length;
    occs.push({ id, modelIndex, parent, children: [] });
    if (parent !== null) occs[parent].children.push(id);
    return id;
  };

  const partIdOf = (refKey: string) => refKey.replace(/\.dat$/i, "").replace(/^.*\//, "");

  /** Candidate library ids for an embedded custom part section. */
  const candidatesFor = (refKey: string): string[] => {
    const raw = partIdOf(refKey);
    const base = raw.split(" - ").pop()!.trim();
    const list = [
      raw,
      base,
      base.replace(/p[a-z0-9]+$/i, ""), // pattern: 3816bp8a → 3816b
      base.replace(/-f\d+$/i, ""), // flex section: 37178-f1 → 37178
      base.replace(/c\d+$/i, ""), // combo/shortcut: 568c01 → 568
    ];
    return [...new Set(list.filter(Boolean))];
  };

  // An embedded .dat section is a combo worth expanding only when its
  // type-1 children resolve to real things (sections or known library
  // parts). Sections whose children are bare LDraw primitives (stud.dat,
  // 4-4cyli.dat…) are part GEOMETRY — expanding those would spray meaningless
  // primitive "instances"; they stay as single placements instead.
  const modelHasResolvablePlacements = (index: number) =>
    project.models[index].items.some(
      (it) =>
        it.kind === "piece" &&
        (byKey.has(it.refKey) || isKnownPart(partIdOf(it.refKey))),
    );

  const expand = (
    modelIndex: number,
    world: LMat,
    inheritColor: number,
    path: number[],
    occId: number,
  ) => {
    if (path.length > 24) return; // cycle guard
    const model = project.models[modelIndex];
    for (let itemIndex = 0; itemIndex < model.items.length; itemIndex++) {
      const item = model.items[itemIndex];
      if (item.kind === "step") {
        seq++;
        continue;
      }
      if (item.kind !== "piece") continue;

      const color = item.color === 16 ? inheritColor : item.color;
      const combined = lCompose(world, { t: item.t, r: item.r });
      const subIndex = byKey.get(item.refKey);

      if (subIndex !== undefined && !item.refKey.endsWith(".dat")) {
        // A true submodel reference: expand in place as a new occurrence.
        expand(subIndex, combined, color, [...path, subIndex], newOcc(subIndex, occId));
        continue;
      }

      if (subIndex !== undefined && item.refKey.endsWith(".dat")) {
        // Embedded custom part. Map to a base library part when one exists;
        // expand when it's a combo assembled from other refs (same
        // occurrence — combos are part geometry, not sub-assemblies);
        // otherwise keep as a placement and let the loader's fallbacks try.
        const candidates = candidatesFor(item.refKey);
        const known = candidates.filter(isKnownPart);
        if (known.length === 0 && modelHasResolvablePlacements(subIndex)) {
          expand(subIndex, combined, color, [...path, subIndex], occId);
          continue;
        }
        instances.push({
          partCandidates: known.length ? known : candidates,
          color,
          t: combined.t,
          r: combined.r,
          seq,
          modelIndex,
          itemIndex,
          modelPath: path,
          occId,
          parent: world,
        });
        continue;
      }

      instances.push({
        partCandidates: [partIdOf(item.refKey)],
        color,
        t: combined.t,
        r: combined.r,
        seq,
        modelIndex,
        itemIndex,
        modelPath: path,
        occId,
        parent: world,
      });
    }
  };

  const main = project.mainIndex;
  expand(main, L_IDENTITY, 16, [main], newOcc(main, null));

  // Header-only main quirk (e.g. OMR 6360-1): fall back to unreferenced
  // sections, mirroring fromLdr.
  if (instances.length === 0 && project.models.length > 1) {
    const referenced = new Set<string>();
    for (const model of project.models) {
      for (const item of model.items) {
        if (item.kind === "piece") referenced.add(item.refKey);
      }
    }
    for (let i = 0; i < project.models.length; i++) {
      const m = project.models[i];
      if (i !== main && !m.key.endsWith(".dat") && !referenced.has(m.key)) {
        expand(i, L_IDENTITY, 16, [i], newOcc(i, 0));
      }
    }
  }

  const stepCount = Math.max(1, seq + 1);
  return { instances, stepCount, tree: buildTree(project, main, byKey), occs };
}

function buildTree(
  project: DocProject,
  root: number,
  byKey: Map<string, number>,
): DocTreeNode {
  const totals = new Map<number, number>();

  const totalParts = (index: number, depth: number): number => {
    if (depth > 24) return 0;
    const hit = totals.get(index);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const item of project.models[index].items) {
      if (item.kind !== "piece") continue;
      const sub = byKey.get(item.refKey);
      if (sub !== undefined && !item.refKey.endsWith(".dat")) n += totalParts(sub, depth + 1);
      else n++;
    }
    totals.set(index, n);
    return n;
  };

  const build = (index: number, depth: number): DocTreeNode => {
    const model = project.models[index];
    const childCounts = new Map<number, number>();
    let ownParts = 0;
    for (const item of model.items) {
      if (item.kind !== "piece") continue;
      const sub = byKey.get(item.refKey);
      if (sub !== undefined && !item.refKey.endsWith(".dat")) {
        childCounts.set(sub, (childCounts.get(sub) ?? 0) + 1);
      } else ownParts++;
    }
    return {
      modelIndex: index,
      name: model.name || project.fileName || "main",
      ownParts,
      totalParts: totalParts(index, 0),
      instanceCount: 1,
      children:
        depth > 24
          ? []
          : [...childCounts.entries()].map(([sub, count]) => ({
              ...build(sub, depth + 1),
              instanceCount: count,
            })),
    };
  };

  return build(root, 0);
}
