/**
 * BrickGPT/LegoGPT brick-text format ↔ builder parts.
 *
 * The format (from "Generating Physically Stable and Buildable LEGO®
 * Designs from Text", Pun et al., CMU 2025): one brick per line,
 * `HxW (x,y,z)` — footprint H studs along grid-x by W studs along grid-y,
 * at integer grid position with z = layer (unit-height bricks), in a
 * 20×20×20 world. Same encoding as the StableText2Brick dataset.
 */
import type { PlacedPartJson } from "../data/schemas";

/** footprint dims (min x max) → LDraw part number (standard bricks). */
export const BRICK_BY_DIMS: Record<string, string> = {
  "1x1": "3005",
  "1x2": "3004",
  "1x3": "3622",
  "1x4": "3010",
  "1x6": "3009",
  "1x8": "3008",
  "2x2": "3003",
  "2x3": "3002",
  "2x4": "3001",
  "2x6": "2456",
  "2x8": "3007",
};

export interface BrickTextResult {
  parts: PlacedPartJson[];
  /** Lines that could not be used (malformed or unavailable dims). */
  rejected: string[];
}

/** Parse brick-text into builder parts. Tolerant: bad lines are collected,
 * not fatal (generators occasionally emit a stray line). */
export function brickTextToParts(bricksText: string, color: number): BrickTextResult {
  const parts: PlacedPartJson[] = [];
  const rejected: string[] = [];
  for (const raw of bricksText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)x(\d+)\s*\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!m) {
      rejected.push(line);
      continue;
    }
    const h = Number(m[1]);
    const w = Number(m[2]);
    const gx = Number(m[3]);
    const gy = Number(m[4]);
    const gz = Number(m[5]);
    const dims = `${Math.min(h, w)}x${Math.max(h, w)}`;
    const part = BRICK_BY_DIMS[dims];
    if (!part || gx + h > 20 || gy + w > 20 || gz >= 20) {
      rejected.push(line);
      continue;
    }
    const rot: 0 | 90 = h >= w ? 0 : 90;
    parts.push({
      part,
      color,
      x: (gx + h / 2 - 10) * 20,
      y: gz * 24,
      z: (gy + w / 2 - 10) * 20,
      rot,
    });
  }
  return { parts, rejected };
}

/** Builder parts → brick-text (for few-shot examples / round-trips).
 * Only standard unit-height bricks on the 20×20 grid are representable. */
export function partsToBrickText(parts: PlacedPartJson[]): string {
  const DIMS_BY_BRICK = new Map(
    Object.entries(BRICK_BY_DIMS).map(([dims, part]) => [part, dims.split("x").map(Number) as [number, number]]),
  );
  const lines: string[] = [];
  for (const p of parts) {
    const dims = DIMS_BY_BRICK.get(p.part);
    if (!dims || p.m) continue;
    const [a, b] = dims; // a ≤ b
    const h = p.rot === 0 || p.rot === 180 ? b : a;
    const w = p.rot === 0 || p.rot === 180 ? a : b;
    // Invert the placement mapping (x = (gx + h/2 − 10)·20 …)
    const gx = Math.round(p.x / 20 - h / 2 + 10);
    const gy = Math.round(p.z / 20 - w / 2 + 10);
    const gz = Math.round(p.y / 24);
    lines.push(`${h}x${w} (${gx},${gy},${gz})`);
  }
  return lines.join("\n");
}
