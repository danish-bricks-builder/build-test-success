/**
 * The appendix grid for the paper: every cell of the table as a picture — one row per task, one
 * column per condition, the latest run per cell, rendered by the agents' own renderer with one
 * camera and one scale. A green frame: every check passes. A red frame: the file is not a valid
 * build (parts collide or float). An amber frame: valid, but a requirement is missed (it falls
 * over, is too big for the footprint, …). A dash: the run produced no model.
 *
 *   npx tsx figures.ts [--records] [--out paper-out/fig-grid.png]
 *
 * Renders are cached under paper-out/renders/<runId>.png. Needs Chrome and the eyes data
 * (sh fetch-data.sh --eyes), like thumb.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromePath } from "./lib/render/chromium";
import { closeRenderer, renderAvailable, renderModel } from "./lib/render";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const FROM = process.argv.includes("--records") ? "records" : "runs";
const OUT = arg("out", "paper-out/fig-grid.png");
const RENDERS = "paper-out/renders";
mkdirSync(RENDERS, { recursive: true });

interface Task { id: string; band: string; type: string }
interface Cond { key: string; name: string }
const tasks: Task[] = JSON.parse(readFileSync("tasks.json", "utf8")).tasks;
const conds: Cond[] = JSON.parse(readFileSync("conditions.json", "utf8")).conditions;
const nameToKey = new Map(conds.map((c) => [c.name, c.key]));

type Mark = "✓" | "×v" | "×s" | "×f" | "×r" | "∅";
interface Cell { id: string; mark: Mark; parts: number | null; ldr: string | null }

function mark(g: Record<string, unknown>): Mark {
  if (g.parseError || g.partCount == null) return "∅";
  if (g.PASS) return "✓";
  if (!g.valid) return "×v";
  if (!g.stable) return "×s";
  if ((g.post as Record<string, boolean> | undefined)?.footprint === false) return "×f";
  return "×r";
}

// latest record per (task, condition key)
const cells = new Map<string, Cell & { stamp: string }>();
for (const f of readdirSync(FROM)) {
  if (!f.endsWith(".json")) continue;
  const r = JSON.parse(readFileSync(join(FROM, f), "utf8"));
  const task = String(r.task ?? "");
  if (task.startsWith("prompt") || !r.condition) continue;
  const key = nameToKey.get(r.condition) ?? r.condition;
  if (!conds.some((c) => c.key === key)) continue;
  const g = r.final ?? r;
  const id: string = r.runId ?? f.replace(/\.json$/, "");
  const stamp = id.split("_").pop() ?? "";
  const k = `${task}|${key}`;
  const prev = cells.get(k);
  if (prev && prev.stamp >= stamp) continue;
  const ldrPath = join(FROM, `${id}.ldr`);
  cells.set(k, { id, mark: mark(g), parts: g.partCount ?? null, ldr: existsSync(ldrPath) ? ldrPath : null, stamp });
}

const FRAME: Record<Mark, string> = { "✓": "#2e9e4f", "×v": "#e0545b", "×s": "#e3a21a", "×f": "#e3a21a", "×r": "#e3a21a", "∅": "#d6d9de" };
const expressible = (_t: Task, _key: string) => true; // every task runs in every condition

async function main() {
  if (!renderAvailable()) { console.error("cannot render here: needs Chrome and public/ldraw (sh fetch-data.sh --eyes)"); process.exit(2); }
  const W = 600, H = 450; // render size per cell (shown at half)
  const pics = new Map<string, string>(); // run id → data url
  for (const c of cells.values()) {
    if (!c.ldr) continue;
    const cached = join(RENDERS, `${c.id}.png`);
    if (!existsSync(cached)) {
      const img = await renderModel(readFileSync(c.ldr, "utf8"), { lat: 25, lon: 45, width: W, height: H, style: "pretty" });
      writeFileSync(cached, Buffer.from(img.dataBase64, "base64"));
      process.stdout.write(".");
    }
    pics.set(c.id, `data:image/png;base64,${readFileSync(cached).toString("base64")}`);
  }
  await closeRenderer();
  console.log(`\n${pics.size} renders`);

  const cellW = 168, cellH = 126, labelW = 34, gap = 8;
  const pageW = labelW + conds.length * (cellW + gap) + gap;
  const rows = tasks.map((t) => {
    const tds = conds.map((c) => {
      if (!expressible(t, c.key)) return `<div class="cell none"><span>—</span></div>`;
      const cell = cells.get(`${t.id}|${c.key}`);
      if (!cell) return `<div class="cell none"><span>?</span></div>`;
      const pic = pics.get(cell.id);
      const frame = FRAME[cell.mark];
      return pic
        ? `<div class="cell" style="border-color:${frame}" title="${cell.id} ${cell.mark}"><img src="${pic}"></div>`
        : `<div class="cell none" style="border-color:${frame}"><span>∅</span></div>`;
    });
    return `<div class="row"><div class="label"><span>${t.id}</span></div>${tds.join("")}</div>`;
  });
  let band = "";
  const body: string[] = [];
  tasks.forEach((t, i) => {
    if (t.band !== band) { band = t.band; body.push(`<div class="band">${band}</div>`); }
    body.push(rows[i]);
  });
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; font-family: "Times New Roman", Times, serif; color: #111; }
    #page { width: ${pageW}px; padding: 0 0 6px; border-top: 2px solid #111; border-bottom: 2px solid #111; }
    .head { display: flex; align-items: flex-end; margin-left: ${labelW}px; padding: 8px 0 6px; border-bottom: 1px solid #111; }
    .head div { width: ${cellW}px; margin-left: ${gap}px; text-align: center; font-size: 15px; }
    .head div b { display: block; font-size: 15px; }
    .band { font: 12px ui-monospace, Menlo, monospace; color: #666; letter-spacing: .06em; text-transform: uppercase; margin: 10px 0 0 ${labelW + gap}px; }
    .row { display: flex; align-items: center; margin-top: ${gap}px; }
    .label { width: ${labelW}px; height: ${cellH}px; position: relative; }
    .label span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-90deg); white-space: nowrap; font: 11px ui-monospace, Menlo, monospace; color: #333; }
    .cell { width: ${cellW}px; height: ${cellH}px; margin-left: ${gap}px; box-sizing: border-box; border: 2.5px solid #d6d9de; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .cell img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .cell.none span { font-size: 16px; color: #777; }
  </style><div id="page"><div class="head">${conds.map((c) => `<div><b>${c.name}</b></div>`).join("")}</div>${body.join("")}</div>`;

  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: chromePath()!, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: pageW, height: 800, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  const el = await page.$("#page");
  mkdirSync(join(OUT, ".."), { recursive: true });
  await el!.screenshot({ path: OUT as `${string}.png` });
  await browser.close();
  const summary = [...cells.values()].reduce((m, c) => ((m[c.mark] = (m[c.mark] ?? 0) + 1), m), {} as Record<string, number>);
  writeFileSync(OUT.replace(/\.png$/, ".json"), JSON.stringify({ from: FROM, cells: [...cells.values()].map(({ stamp: _s, ...c }) => c), summary }, null, 1));
  console.log(`${OUT} · ${JSON.stringify(summary)}`);
}
main();
