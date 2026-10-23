/**
 * Thumbnails for the results viewer: one PNG per final build, rendered by the same headless
 * three.js pipeline the agents' eyes use (lib/render; needs Chrome and sh fetch-data.sh --eyes).
 *
 *   npx tsx thumb.ts --all            every records/*.ldr and runs/*.ldr without a thumbnail yet
 *   npx tsx thumb.ts runs/x.ldr …     these files
 *
 * The PNG lands next to its source, in <dir>/thumbs/<stem>.png. serve.py runs --all after every
 * job; the viewer shows the picture in the table cell when it exists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { closeRenderer, renderAvailable, renderModel } from "./lib/render";

const args = process.argv.slice(2);
let files: string[] = args.filter((a) => a !== "--all");
if (args.includes("--all")) {
  for (const dir of ["records", "runs"]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ldr") || /\.round\d+\.ldr$/.test(f)) continue; // attempts are not final builds
      if (!existsSync(join(dir, "thumbs", f.replace(/\.ldr$/, ".png")))) files.push(join(dir, f));
    }
  }
}
if (!files.length) { console.log("nothing to render"); process.exit(0); }
if (!renderAvailable()) { console.error("cannot render here: needs Chrome and public/ldraw (sh fetch-data.sh --eyes)"); process.exit(2); }

async function main() {
let n = 0;
for (const f of files) {
  const out = join(dirname(f), "thumbs", basename(f).replace(/\.ldr$/, ".png"));
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
