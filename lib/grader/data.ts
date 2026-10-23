/** Server-side data for the referee: meta, connections, voxels, names. */
import { loadStatic } from "@/lib/copilot/staticData";
import { getConnections, getVoxels } from "@/lib/copilot/connect";
import { readDataJson } from "@/lib/data/serverData";
import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionMap } from "@/lib/engine/snapAlign";
import type { VoxelData } from "@/lib/engine/voxelCollision";
import type { PartMetaMap, PartIndexRow } from "@/lib/data/schemas";

export interface GraderData {
  meta: PartMetaMap;
  conns: ConnectionMap;
  vox: VoxelData;
  nameOf: (part: string) => string;
  /** LDraw primitives (p/ directory) — legal in files (flex hoses) but not parts */
  prims: Set<string>;
}

// Cached on globalThis: in `next dev`, every hot reload of a server module creates a fresh module
// instance, and a module-level cache would re-parse the 264 MB voxel table each time while the old
// copies stay reachable — the dev server climbed past 10 GB that way.
const g = globalThis as unknown as { __dbbGraderData?: Promise<GraderData> | null };
/** part id → the part it was "~Moved to" (lower-case ids), from the local
 * LDraw library's headers; empty on data-less deploys. Cached on globalThis. */
function loadAliases(): Map<string, string> {
  const g2 = globalThis as unknown as { __dbbLdrawAliases?: Map<string, string> };
  if (g2.__dbbLdrawAliases) return g2.__dbbLdrawAliases;
  const map = new Map<string, string>();
  const dir = join(process.cwd(), "public", "ldraw", "parts");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".dat")) continue;
      const fd = openSync(join(dir, f), "r");
      const buf = Buffer.alloc(96);
      const n = readSync(fd, buf, 0, 96, 0);
      closeSync(fd);
      const head = buf.toString("utf8", 0, n);
      const m = head.match(/^0 ~Moved to (\S+)/);
      if (m) map.set(f.slice(0, -4).toLowerCase(), m[1].replace(/\.dat$/i, ""));
    }
  }
  g2.__dbbLdrawAliases = map;
  return map;
}

export function loadGraderData(): Promise<GraderData> {
  if (!g.__dbbGraderData) {
    g.__dbbGraderData = (async () => {
      const { meta } = await loadStatic();
      const conns = getConnections();
      const vox = getVoxels();
      const index = (await readDataJson("data/parts/index.json")) as PartIndexRow[];
      const names = new Map(index.map((r) => [r.p, r.n]));
      // LDraw aliases: "0 ~Moved to 3648b" in 3648.dat. The index only names
      // canonical parts, so a model that uses the old number (models often do —
      // Fable wrote 3648 for the 24T gear) would otherwise have no name and the
      // gear recogniser would miss it. Scanned once from the local library.
      const aliases = loadAliases();
      const nameOf = (part: string): string => {
        const direct = names.get(part) ?? names.get(part.replace(/[a-z].*$/, ""));
        if (direct) return direct;
        const to = aliases.get(part.toLowerCase());
        return to ? (names.get(to) ?? names.get(to.replace(/[a-z].*$/, "")) ?? "") : "";
      };
      const prims = new Set<string>(((await readDataJson("ldraw/p/manifest.json").catch(() => [])) as string[]).map((s) => s.toLowerCase()));
      return { meta, conns, vox, nameOf, prims };
    })();
    g.__dbbGraderData.catch(() => (g.__dbbGraderData = null));
  }
  return g.__dbbGraderData;
}
