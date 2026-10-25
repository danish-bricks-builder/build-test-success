/**
 * Thumbnails for the results viewer: one PNG per final build, rendered by the same headless
 * three.js pipeline the agents' eyes use (lib/render; needs Chrome and sh scripts/fetch-data.sh --eyes).
 *
 *   npx tsx viewer/thumb.ts --all            every results/runs/*.ldr and runs/*.ldr without a thumbnail yet
 *   npx tsx viewer/thumb.ts runs/x.ldr …     these files
 *
 * The PNG lands in results/thumbs/ or runs/thumbs/. viewer/serve.py runs --all after every
 * job; the viewer shows the picture in the table cell when it exists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { closeRenderer, renderAvailable, renderModel } from "../lib/render";

const args = process.argv.slice(2);
let files: string[] = args.filter((a) => a !== "--all");
if (args.includes("--all")) {
  for (const [dir, thumbs] of [["results/runs", "results/thumbs"], ["runs", "runs/thumbs"]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ldr") || /\.round\d+\.ldr$/.test(f)) continue; // attempts are not final builds
      if (!existsSync(join(thumbs, f.replace(/\.ldr$/, ".png")))) files.push(join(dir, f));
    }
  }
}
if (!files.length) { console.log("nothing to render"); process.exit(0); }
if (!renderAvailable()) { console.error("cannot render here: needs Chrome and public/ldraw (sh scripts/fetch-data.sh --eyes)"); process.exit(2); }

async function main() {
let n = 0;
for (const f of files) {
  const out = join(dirname(f).startsWith("results") ? "results/thumbs" : "runs/thumbs", basename(f).replace(/\.ldr$/, ".png"));
  try {
    const img = await renderModel(readFileSync(f, "utf8"), { lat: 25, lon: 45, width: 288, height: 216, style: "plain" });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(img.dataBase64, "base64"));
    n++;
    console.log(`${out}`);
  } catch (e) {
    console.error(`${f}: ${e instanceof Error ? e.message : e}`);
  }
}
await closeRenderer();
console.log(`${n}/${files.length} rendered`);
}
main();
