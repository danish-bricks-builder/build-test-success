"use client";

/**
 * Client-side fetchers for the static catalogs in public/data/.
 * Each catalog is fetched once per session and cached (they're immutable
 * per data release).
 */
import type {
  ColorDef,
  DatasetStats,
  OmrEntry,
  PartCategory,
  PartImgMap,
  PartIndexRow,
  PartMetaMap,
  PartUsage,
  S2bCatalogRow,
  SetIndexRow,
  SetInventory,
  ThemeDef,
} from "./schemas";

const cache = new Map<string, Promise<unknown>>();

function fetchJson<T>(path: string): Promise<T> {
  let hit = cache.get(path) as Promise<T> | undefined;
  if (!hit) {
    hit = fetch(path).then((res) => {
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    });
    cache.set(path, hit);
    hit.catch(() => cache.delete(path));
  }
  return hit;
}

export const getPartsIndex = () => fetchJson<PartIndexRow[]>("/data/parts/index.json");
export const getCategories = () => fetchJson<PartCategory[]>("/data/parts/categories.json");
export const getUsage = () => fetchJson<PartUsage>("/data/parts/usage.json");
export const getImgMap = () => fetchJson<PartImgMap>("/data/parts/img-map.json");
export const getPartMeta = () => fetchJson<PartMetaMap>("/data/parts/meta.json");
export const getPalette = () => fetchJson<{ p: string; n: string; c: number }[]>("/data/parts/palette.json");
export const getColors = () => fetchJson<ColorDef[]>("/data/colors.json");
export const getSetsIndex = () => fetchJson<SetIndexRow[]>("/data/sets/index.json");
export const getThemes = () => fetchJson<ThemeDef[]>("/data/themes.json");
export const getStats = () => fetchJson<DatasetStats>("/data/stats.json");
export const getSetInventory = (setNum: string) =>
  fetchJson<SetInventory>(`/data/inv/${encodeURIComponent(setNum)}.json`);
export const getOmrCatalog = () => fetchJson<OmrEntry[]>("/data/omr/catalog.json");
/** One shard of the S2B structure catalogue (id, category, caption, brick
 * count) — ~4,700 rows each, ten of them. The structures themselves live in
 * the 474 model shards; these are just enough to list and search. */
export const getS2bCatalog = (shard: number) =>
  fetchJson<S2bCatalogRow[]>(`/data/s2b/catalog-${String(shard).padStart(3, "0")}.json`);
/** Shadow-library connector map (~21MB) — fetched once per session; every
 * editor mount used to refetch it raw (twice, under dev StrictMode). */
export const getConnections = () => fetchJson<Record<string, unknown[]>>("/data/parts/connections.json");
export const getOmrIndex = () => fetchJson<Record<string, string>>("/data/omr-index.json");

/** Sets containing a part: [setNum, qty][] sorted by qty desc (top 200). */
export async function getPartSets(part: string): Promise<[string, number][]> {
  let h = 0;
  for (let i = 0; i < part.length; i++) h = (h * 31 + part.charCodeAt(i)) >>> 0;
  const shard = (h % 256).toString(16).padStart(2, "0");
  const data = await fetchJson<Record<string, [string, number][]>>(`/data/parts/in-sets/${shard}.json`);
  return data[part] ?? [];
}

/**
 * Best-guess thumbnail URL for a part (Rebrickable CDN, CC BY):
 * a real per-part image from the inventory data when we have one, else the
 * constructed LDraw-render URL in light bluish gray.
 */
export function partThumbUrl(part: string, imgMap?: PartImgMap): string {
  return imgMap?.[part] ?? `https://cdn.rebrickable.com/media/parts/ldraw/71/${encodeURIComponent(part)}.png`;
}
