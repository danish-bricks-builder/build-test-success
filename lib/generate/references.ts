/**
 * Reference-design retrieval (server-side) — find structures in the
 * StableText2Brick dataset whose captions match a query, and return them
 * as brick-text the model can study. Used by the copilot's get_reference
 * tool and as few-shot examples in /api/generate.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { s2bShardOf } from "../data/s2b";
import { partsToBrickText } from "./bricktext";
import type { PlacedPartJson, S2bCatalogRow, S2bStructure } from "../data/schemas";

let catalogCache: S2bCatalogRow[] | null = null;

async function loadCatalog(): Promise<S2bCatalogRow[]> {
  if (catalogCache) return catalogCache;
  const dir = join(process.cwd(), "public", "data", "s2b");
  const chunks = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      fs
        .readFile(join(dir, `catalog-${String(i).padStart(3, "0")}.json`), "utf8")
        .then((t) => JSON.parse(t) as S2bCatalogRow[])
        .catch(() => [] as S2bCatalogRow[]),
    ),
  );
  catalogCache = chunks.flat();
  return catalogCache;
}

export interface ReferenceDesign {
  id: string;
  caption: string;
  category: string;
  bricks: number;
  brickText: string;
}

/** Top-k caption matches with their full structures as brick-text. */
/** Query words → dataset category vocabulary (the dataset has no 'truck'). */
const QUERY_SYNONYMS: Record<string, string> = {
  truck: "car",
  pickup: "car",
  van: "bus",
  jeep: "car",
  suv: "car",
  ship: "watercraft",
  boat: "watercraft",
  sailboat: "watercraft",
  plane: "airplane",
  jet: "airplane",
  couch: "sofa",
  seat: "chair",
  home: "house",
};

export async function findReferences(query: string, k = 3): Promise<ReferenceDesign[]> {
  const catalog = await loadCatalog();
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
    .map((w) => QUERY_SYNONYMS[w] ?? w);
  if (words.length === 0) return [];

  const scored = catalog
    .map((row) => {
      const cap = row.caption.toLowerCase();
      const catName = row.cat.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (catName.includes(w)) score += 2; // category match is strong signal
        if (cap.includes(w)) score += 1;
      }
      return { row, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Math.abs(a.row.nb - 50) - Math.abs(b.row.nb - 50));

  // Dedupe near-identical captions so k results are actually diverse.
  const seen = new Set<string>();
  const picked: typeof scored = [];
  for (const item of scored) {
    const key = item.row.caption.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
    if (picked.length === k) break;
  }

  const out: ReferenceDesign[] = [];
  for (const { row } of picked) {
    try {
      const shard = JSON.parse(
        await fs.readFile(
          join(
            process.cwd(),
            "public",
            "models",
            "s2b",
            `shard-${String(s2bShardOf(row.id)).padStart(3, "0")}.json`,
          ),
          "utf8",
        ),
      ) as Record<string, S2bStructure>;
      const structure = shard[row.id];
      if (!structure) continue;
      out.push({
        id: row.id,
        caption: row.caption,
        category: row.cat,
        bricks: structure.parts.length,
        brickText: partsToBrickText(structure.parts as PlacedPartJson[]),
      });
    } catch {
      /* shard missing — skip */
    }
  }
  return out;
}

/** Render references as a compact prompt block. */
export function referencesBlock(refs: ReferenceDesign[]): string {
  if (refs.length === 0) return "No matching reference designs found.";
  return refs
    .map(
      (r) =>
        `### Reference: "${r.caption}" (${r.category}, ${r.bricks} bricks)\n${r.brickText}`,
    )
    .join("\n\n");
}
