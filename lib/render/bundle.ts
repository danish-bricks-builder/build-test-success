/** Build (or reuse) the esbuild bundle for the headless snapshot page. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
export const SNAP_BUNDLE = join(ROOT, "public", "render-snap", "snap.js");
const SOURCES = ["lib/render/snap-page.ts", "lib/render/snapScene.ts", "lib/ldraw/PartMeshCache.ts", "lib/engine/scene/compose.ts", "lib/ldraw/serialize.ts"];

function newestSource(): number {
  let t = 0;
  for (const f of SOURCES) if (existsSync(join(ROOT, f))) t = Math.max(t, statSync(join(ROOT, f)).mtimeMs);
  // every directory the bundle pulls from — snapScene.ts lives in lib/render
  // and was missing here, so edits to the renderer itself did not rebuild it
  for (const d of ["lib/engine", "lib/ldraw", "lib/render"]) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (f.endsWith(".ts")) t = Math.max(t, statSync(join(ROOT, d, f)).mtimeMs);
    }
  }
  return t;
}

export async function buildSnapBundle(opts: { force?: boolean } = {}): Promise<string> {
  if (!opts.force && existsSync(SNAP_BUNDLE) && statSync(SNAP_BUNDLE).mtimeMs >= newestSource()) return SNAP_BUNDLE;
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [join(ROOT, "lib/render/snap-page.ts")],
    outfile: SNAP_BUNDLE,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    tsconfig: join(ROOT, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  return SNAP_BUNDLE;
}
