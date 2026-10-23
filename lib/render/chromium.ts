/**
 * Headless snapshots through our own three.js pipeline, in one persistent
 * Chrome. Replaces the LeoCAD binary as the renderer behind agents' "eyes",
 * thumbnails and the visual judge.
 *
 * The worker serves public/ from a tiny localhost server (part meshes,
 * colours, the snapshot page) so it needs neither the Next dev server nor
 * the network, and works the same on a laptop or a Linux box. One browser,
 * one page, renders serialised — a queue, not a swarm of app launches.
 *
 * Chrome: CHROME_PATH, else the usual macOS / Linux install locations.
 */
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "puppeteer-core";
import { buildSnapBundle } from "./bundle";

export interface RenderOptions {
  lat?: number;
  lon?: number;
  width?: number;
  height?: number;
  /** "pretty": figure renders (soft light, shadow, transparent background, 2× pixels) */
  style?: "plain" | "pretty";
  /** connector glyphs drawn over the model (see SnapMarker) */
  markers?: import("./snapScene").SnapMarker[];
  /** draw the LDraw origin and axes on the model */
  axes?: boolean;
}
export interface RenderedImage {
  dataBase64: string;
  mediaType: "image/png";
}

const PUBLIC = join(process.cwd(), "public");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((x): x is string => !!x);

/**
 * Longitude offset so the presets the agents use ("front" = lon 0,
 * "side" = lon 90) look at the model from the same sides LeoCAD did.
 */
export const LON_OFFSET = Number(process.env.DBB_RENDER_LON_OFFSET ?? 0);

export function chromePath(): string | null {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** True when this machine can render (a Chrome binary and the local part library exist). */
export function renderAvailable(): boolean {
  return !!chromePath() && existsSync(join(PUBLIC, "ldraw", "LDConfig.ldr"));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".dat": "text/plain; charset=utf-8",
  ".ldr": "text/plain; charset=utf-8",
  ".mpd": "text/plain; charset=utf-8",
};

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = normalize(join(PUBLIC, url.endsWith("/") ? `${url}index.html` : url));
    if (req.method !== "GET" || !file.startsWith(PUBLIC + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Worker = { browser: Browser; page: Page; server: Server };
const G = globalThis as unknown as { __dbbSnapWorker?: Promise<Worker> | null; __dbbSnapQueue?: Promise<unknown> };

async function start(): Promise<Worker> {
  const exe = chromePath();
  if (!exe) throw new Error("no Chrome/Chromium found — set CHROME_PATH");
  await buildSnapBundle();
  const server = await serve();
  const { port } = server.address() as AddressInfo;
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--ignore-gpu-blocklist", "--enable-webgl", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(`[render] page error: ${e instanceof Error ? e.message : e}`));
  await page.goto(`http://127.0.0.1:${port}/render-snap/`, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __dbbSnapReady?: boolean }).__dbbSnapReady === true, { timeout: 30_000 });
  const stop = () => {
    browser.close().catch(() => {});
    server.close();
  };
  process.once("exit", stop);
  browser.once("disconnected", () => {
    G.__dbbSnapWorker = null;
    server.close();
  });
  return { browser, page, server };
}

function worker(): Promise<Worker> {
  if (!G.__dbbSnapWorker) {
    G.__dbbSnapWorker = start();
    G.__dbbSnapWorker.catch(() => (G.__dbbSnapWorker = null));
  }
  return G.__dbbSnapWorker;
}

/** Render LDraw text to a PNG from a camera angle (lat above the horizon, lon around the model). */
export async function renderModel(ldraw: string, opts: RenderOptions = {}): Promise<RenderedImage> {
  const job = async (): Promise<RenderedImage> => {
    const { page } = await worker();
    const out = await page.evaluate(
      (text: string, o: RenderOptions & { lonOffset: number }) =>
        (window as unknown as { __dbbSnap: (t: string, o: unknown) => Promise<{ dataUrl: string; failed: string[] }> }).__dbbSnap(text, o),
      ldraw,
      { lat: opts.lat ?? 25, lon: opts.lon ?? 45, width: opts.width ?? 720, height: opts.height ?? 540, lonOffset: LON_OFFSET, style: opts.style ?? "plain", markers: opts.markers, axes: opts.axes },
    );
    if (out.failed.length) console.error(`[render] ${out.failed.length} part(s) could not be drawn: ${out.failed.slice(0, 6).join(", ")}`);
    return { dataBase64: out.dataUrl.replace(/^data:image\/png;base64,/, ""), mediaType: "image/png" };
  };
  // one render at a time on the shared page
  const run = (G.__dbbSnapQueue ?? Promise.resolve()).then(job, job);
  G.__dbbSnapQueue = run.catch(() => {});
  return run;
}

/** Close the browser (scripts call this before exiting so the process can end). */
export async function closeRenderer(): Promise<void> {
  const w = await G.__dbbSnapWorker?.catch(() => null);
  G.__dbbSnapWorker = null;
  if (w) {
    await w.browser.close().catch(() => {});
    w.server.close();
  }
}
