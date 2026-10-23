/**
 * Static data the copilot needs on the server: measured part metadata
 * (footprints/heights) and the buildable palette. Cached per process.
 * Shared by the browser copilot route and the LeoCAD bridge route.
 */
import { readDataJson } from "@/lib/data/serverData";
import type { PartMetaMap } from "@/lib/data/schemas";
import { warmServerData } from "./connect";

// on globalThis so `next dev` hot reloads share one copy (see connect.ts)
const G = globalThis as unknown as { __dbbMeta?: PartMetaMap | null; __dbbPalette?: { p: string; n: string }[] | null };

export async function loadStatic() {
  if (!G.__dbbMeta) {
    G.__dbbMeta = (await readDataJson("data/parts/meta.json")) as PartMetaMap;
    G.__dbbPalette = (await readDataJson("data/parts/palette.json")) as { p: string; n: string }[];
  }
  // connections / part index (/ voxels when present) — the sync tool
  // getters depend on these being cached before the agent runs.
  await warmServerData();
  return { meta: G.__dbbMeta!, palette: G.__dbbPalette! };
}
