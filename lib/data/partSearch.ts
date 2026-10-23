/**
 * Part search that understands how people actually ask for bricks:
 *  - "2x8", "2 x 8", "2by8" all mean the same footprint
 *  - dims match MEASURED geometry (meta.json), not just the name — a
 *    "plate 2x8" query finds every part whose real footprint is 2×8 studs
 *  - common AFOL nicknames (jumper, cheese slope, headlight…) resolve
 *  - results rank by match quality then real-world popularity (usage.json)
 */
import type { PartIndexRow, PartMetaMap, PartUsage } from "./schemas";

/** Nickname → canonical search tokens. Small on purpose; grows over time. */
const ALIASES: Record<string, string> = {
  jumper: "plate 1x2 with 1 stud",
  cheese: "slope 30 1x1",
  headlight: "brick 1x1 with headlight",
  erling: "brick 1x1 with headlight",
  snot: "bracket",
  studless: "tile",
  frame: "technic brick",
  swivel: "turntable",
  tire: "tyre", // LDraw parts are named "Tyre" (UK); map the US spelling to it
  wheel: "wheel",
  mudguard: "vehicle mudguard",
  windscreen: "windscreen",
  trans: "trans",
};

/** Type word → substring the category name must contain. */
const TYPE_TO_CATEGORY: Record<string, string> = {
  plate: "plate",
  plates: "plate",
  tile: "tile",
  tiles: "tile",
  brick: "brick",
  bricks: "brick",
  slope: "slope",
  slopes: "slope",
  wedge: "wedge",
  technic: "technic",
  baseplate: "baseplate",
  panel: "panel",
  hinge: "hinge",
  minifig: "minifig",
};

export interface ParsedQuery {
  /** Footprint from the query, sorted (min,max); null if none given. */
  dims: [number, number] | null;
  /** Category constraint from a type word, if any. */
  categoryLike: string | null;
  /** Remaining free-text tokens (lowercase). */
  tokens: string[];
}

export function parseQuery(raw: string): ParsedQuery {
  let q = raw.trim().toLowerCase();
  // Aliases apply on whole words.
  q = q
    .split(/\s+/)
    .map((w) => ALIASES[w] ?? w)
    .join(" ");
  // Normalize dimension spellings: "2 x 8", "2by8", "2×8" → "2x8".
  q = q.replace(/(\d+)\s*(?:x|×|by)\s*(\d+)/g, "$1x$2");

  let dims: [number, number] | null = null;
  let categoryLike: string | null = null;
  const tokens: string[] = [];
  for (const t of q.split(/\s+/)) {
    if (!t) continue;
    const dm = t.match(/^(\d+)x(\d+)$/);
    if (dm && !dims) {
      const a = Number(dm[1]);
      const b = Number(dm[2]);
      dims = [Math.min(a, b), Math.max(a, b)];
      continue;
    }
    if (TYPE_TO_CATEGORY[t] && !categoryLike) {
      categoryLike = TYPE_TO_CATEGORY[t];
      // Type words also help name matching ("plate" in the name).
      tokens.push(t.replace(/s$/, ""));
      continue;
    }
    tokens.push(t);
  }
  return { dims, categoryLike, tokens };
}

export interface SearchDeps {
  meta?: PartMetaMap;
  usage?: PartUsage;
  categories?: Map<number, string>;
}

/** Score a part for a parsed query; ≤0 = no match. */
export function scorePart(row: PartIndexRow, pq: ParsedQuery, deps: SearchDeps): number {
  // Normalize the NAME's dims too so "Plate 2 x 8" tokenizes as "plate 2x8".
  const name = row.n.toLowerCase().replace(/(\d+)\s*x\s*(\d+)/g, "$1x$2");
  const hay = `${row.p.toLowerCase()} ${name}`;

  let score = 0;

  if (pq.dims) {
    const m = deps.meta?.[row.p];
    const measured: [number, number] | null = m ? [Math.min(m.w, m.l), Math.max(m.w, m.l)] : null;
    const nameDims = name.includes(`${pq.dims[0]}x${pq.dims[1]}`) || name.includes(`${pq.dims[1]}x${pq.dims[0]}`);
    const measuredDims = measured !== null && measured[0] === pq.dims[0] && measured[1] === pq.dims[1];
    if (!nameDims && !measuredDims) return 0;
    score += nameDims && measuredDims ? 40 : nameDims ? 30 : 20;
  }

  if (pq.categoryLike) {
    const catName = (deps.categories?.get(row.c) ?? "").toLowerCase();
    const inCat = catName.includes(pq.categoryLike);
    const inName = hay.includes(pq.categoryLike);
    if (!inCat && !inName) return 0;
    score += inCat ? 20 : 8;
    // Prefer the PLAIN category over "special"/"round"/… variants.
    if (inCat && !catName.includes("special")) score += 6;
  }

  for (const t of pq.tokens) {
    if (!hay.includes(t)) return 0;
    score += 4;
  }
  if (pq.tokens.length === 0 && !pq.dims && !pq.categoryLike) return 0;

  // Shorter names are usually the canonical part, not an assembly of it.
  score += Math.max(0, 12 - Math.floor(row.n.length / 12));
  // Real-world popularity.
  score += Math.min(14, Math.log2(1 + (deps.usage?.[row.p] ?? 0)) * 2);
  return score;
}

/** Full search: returns matching rows, best first. */
export function searchParts(
  rows: PartIndexRow[],
  query: string,
  deps: SearchDeps,
  limit = 400,
): PartIndexRow[] {
  const pq = parseQuery(query);
  if (!pq.dims && !pq.categoryLike && pq.tokens.length === 0) return rows.slice(0, limit);
  const scored: { row: PartIndexRow; s: number }[] = [];
  for (const row of rows) {
    const s = scorePart(row, pq, deps);
    if (s > 0) scored.push({ row, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.row);
}
