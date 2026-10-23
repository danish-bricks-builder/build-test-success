/**
 * Reference metrics for edit / completion tasks: how much of a seed model
 * survived (translate-invariant), and how close a build is to a gold model
 * (bill-of-materials F1, pose match). Ported from scripts/agent/pdf2set.ts.
 */
import type { PlacedPartJson } from "@/lib/data/schemas";

type P = Pick<PlacedPartJson, "part" | "color" | "x" | "y" | "z">;
const poseKey = (p: P, dx = 0, dy = 0, dz = 0) => `${p.part}/${p.color}/${Math.round(p.x - dx)}/${Math.round(p.y - dy)}/${Math.round(p.z - dz)}`;

/** Fraction of GOLD poses reproduced in BUILT after the dominant translation offset. */
export function poseMatch(gold: P[], built: P[]): { frac: number; kept: number; offset: number[] } {
  const builtByType = new Map<string, P[]>();
  for (const p of built) {
    const k = `${p.part}/${p.color}`;
    if (!builtByType.has(k)) builtByType.set(k, []);
    builtByType.get(k)!.push(p);
  }
  const votes = new Map<string, number>();
  for (const g of gold)
    for (const b of builtByType.get(`${g.part}/${g.color}`) ?? []) {
      const key = `${Math.round(b.x - g.x)}/${Math.round(b.y - g.y)}/${Math.round(b.z - g.z)}`;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const [dx, dy, dz] = best ? best[0].split("/").map(Number) : [0, 0, 0];
  const builtSet = new Set(built.map((p) => poseKey(p)));
  let kept = 0;
  for (const g of gold) if (builtSet.has(poseKey(g, -dx, -dy, -dz))) kept++;
  return { frac: gold.length ? kept / gold.length : 0, kept, offset: [dx, dy, dz] };
}

/** Bill-of-materials precision / recall / F1 over (part, colour) multisets. */
export function bomF1(gold: P[], built: P[]): { precision: number; recall: number; f1: number } {
  const count = (ps: P[]) => {
    const m = new Map<string, number>();
    for (const p of ps) m.set(`${p.part}:${p.color}`, (m.get(`${p.part}:${p.color}`) ?? 0) + 1);
    return m;
  };
  const g = count(gold), b = count(built);
  let overlap = 0;
  for (const [k, n] of g) overlap += Math.min(n, b.get(k) ?? 0);
  const precision = built.length ? overlap / built.length : 0;
  const recall = gold.length ? overlap / gold.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3) };
}
