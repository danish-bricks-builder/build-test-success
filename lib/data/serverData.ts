/**
 * Server-side dataset reads. Deploys ship no data (the bucket serves
 * /data etc. via next.config.ts rewrites), so server code that needs a
 * catalog file reads the local checkout when present and falls back to
 * fetching the same path from DATA_ORIGIN.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Read a public/-relative text file locally, else from DATA_ORIGIN. */
export async function readDataText(rel: string): Promise<string> {
  try {
    return await fs.readFile(join(process.cwd(), "public", rel), "utf8");
  } catch (err) {
    const origin = process.env.DATA_ORIGIN?.replace(/\/$/, "");
    if (!origin) throw err;
    const res = await fetch(`${origin}/${rel}`);
    if (!res.ok) throw new Error(`fetch ${origin}/${rel}: HTTP ${res.status}`);
    return res.text();
  }
}

/** Read a public/-relative JSON file locally, else from DATA_ORIGIN. */
export async function readDataJson(rel: string): Promise<unknown> {
  return JSON.parse(await readDataText(rel));
}
