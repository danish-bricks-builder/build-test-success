/**
 * Server-side build-state machine for the copilot: executes tool calls
 * against a working copy of the client's build, enforcing the same rules
 * the editor enforces (known parts, collision, inventory), and reports
 * rejections back to the model as tool feedback.
 *
 * Coordinates in the tool interface are STUD units for x/z (1 stud =
 * 20 LDU; .5 steps legal for odd footprints) and LDU for y — but y is
 * normally omitted and auto-derived by terrain stacking.
 */
import { findOverlapping, metaOf, partBBox, terrainY } from "../engine/geometry";
import { checkSoundness, isSupported } from "../engine/soundness";
import { STUD_PITCH } from "../engine/types";
import type { PartMetaMap, PlacedPartJson } from "../data/schemas";
import { invKey } from "./types";

export interface BuildSession {
  parts: PlacedPartJson[];
  /** Remaining inventory, mutated as the session places/removes. Null = free build. */
  inventory: Record<string, number> | null;
  meta: PartMetaMap;
  /** Named reusable modules defined during this turn (relative placements). */
  assemblies: Map<string, PlacementInput[]>;
  /** Connect-mode modules: snapshots of BUILT parts (matrix poses kept),
   * stamped as units — see lib/copilot/connect2.ts. */
  modules?: Map<string, import("./connect2").ModuleDef>;
}

export interface PlacementInput {
  part: string;
  color: number;
  x_stud: number;
  z_stud: number;
  rot?: 0 | 90 | 180 | 270;
  y_ldu?: number;
}

export function collides(candidate: PlacedPartJson, parts: PlacedPartJson[], meta: PartMetaMap): boolean {
  const cb = partBBox(candidate, meta);
  return parts.some((p) => {
    const b = partBBox(p, meta);
    return (
      cb[0] < b[1] - 0.5 && cb[1] > b[0] + 0.5 &&
      cb[2] < b[3] - 0.5 && cb[3] > b[2] + 0.5 &&
      cb[4] < b[5] - 0.5 && cb[5] > b[4] + 0.5
    );
  });
}

/** Place a batch; returns per-item results the model can learn from. */
export function placeParts(session: BuildSession, inputs: PlacementInput[]): string[] {
  const results: string[] = [];
  for (const input of inputs) {
    const { part, color } = input;
    if (!session.meta[part]) {
      results.push(`REJECTED ${part}: unknown part (use search_parts to find valid palette part numbers)`);
      continue;
    }
    const key = invKey(part, color);
    if (session.inventory && (session.inventory[key] ?? 0) <= 0) {
      const anyColor = Object.entries(session.inventory)
        .filter(([k, n]) => k.startsWith(`${part}:`) && n > 0)
        .map(([k, n]) => `color ${k.split(":")[1]}×${n}`);
      results.push(
        `REJECTED ${part} color ${color}: not in remaining inventory` +
          (anyColor.length ? ` (available in: ${anyColor.join(", ")})` : ` (none left in any color)`),
      );
      continue;
    }
    const rot = input.rot ?? 0;
    const candidate: PlacedPartJson = {
      part,
      color,
      x: Math.round(input.x_stud * STUD_PITCH),
      z: Math.round(input.z_stud * STUD_PITCH),
      y: 0,
      rot,
    };
    candidate.y = input.y_ldu ?? terrainY(candidate, session.parts, session.meta);
    if (collides(candidate, session.parts, session.meta)) {
      results.push(
        `REJECTED ${part} at (${input.x_stud}, ${input.z_stud}) y=${candidate.y}: collides with an existing part — inspect_build to see occupancy`,
      );
      continue;
    }
    const supported = isSupported(candidate, session.parts, session.meta);
    session.parts.push(candidate);
    if (session.inventory) session.inventory[key] = (session.inventory[key] ?? 0) - 1;
    results.push(
      `OK ${part} color ${color} placed at (${input.x_stud}, ${input.z_stud}) y=${candidate.y} rot=${rot} → index ${session.parts.length - 1}` +
        (supported ? "" : " ⚠ FLOATING — nothing beneath it; it would fall"),
    );
  }
  return results;
}

export function removeParts(session: BuildSession, indices: number[]): string {
  const valid = [...new Set(indices)].filter((i) => i >= 0 && i < session.parts.length).sort((a, b) => b - a);
  if (valid.length === 0) return "no valid indices";
  for (const i of valid) {
    const [removed] = session.parts.splice(i, 1);
    if (session.inventory) {
      const key = invKey(removed.part, removed.color);
      session.inventory[key] = (session.inventory[key] ?? 0) + 1;
    }
  }
  return `removed ${valid.length} parts (indices shift down after removal — inspect_build for fresh indices)`;
}

export function recolorParts(session: BuildSession, indices: number[], color: number): string {
  let done = 0;
  for (const i of indices) {
    const p = session.parts[i];
    if (!p) continue;
    if (session.inventory) {
      const newKey = invKey(p.part, color);
      if ((session.inventory[newKey] ?? 0) <= 0) continue; // no stock in target color
      session.inventory[newKey] -= 1;
      session.inventory[invKey(p.part, p.color)] = (session.inventory[invKey(p.part, p.color)] ?? 0) + 1;
    }
    session.parts[i] = { ...p, color };
    done++;
  }
  return `recolored ${done}/${indices.length} parts to color ${color}`;
}

export interface PartFilter {
  color?: number;
  part?: string;
  min_x_stud?: number;
  max_x_stud?: number;
  min_z_stud?: number;
  max_z_stud?: number;
  min_y_ldu?: number;
  max_y_ldu?: number;
}

/** Query parts by attributes → indices (for recolor/remove/inspection). */
export function findParts(session: BuildSession, filter: PartFilter): string {
  const hits: number[] = [];
  session.parts.forEach((p, i) => {
    if (filter.color !== undefined && p.color !== filter.color) return;
    if (filter.part !== undefined && p.part !== filter.part) return;
    const b = partBBox(p, session.meta);
    if (filter.min_x_stud !== undefined && b[1] / STUD_PITCH <= filter.min_x_stud) return;
    if (filter.max_x_stud !== undefined && b[0] / STUD_PITCH >= filter.max_x_stud) return;
    if (filter.min_z_stud !== undefined && b[5] / STUD_PITCH <= filter.min_z_stud) return;
    if (filter.max_z_stud !== undefined && b[4] / STUD_PITCH >= filter.max_z_stud) return;
    if (filter.min_y_ldu !== undefined && b[3] <= filter.min_y_ldu) return;
    if (filter.max_y_ldu !== undefined && b[2] >= filter.max_y_ldu) return;
    hits.push(i);
  });
  if (hits.length === 0) return "no parts match";
  const shown = hits.slice(0, 300);
  return (
    `${hits.length} parts match: indices ${shown.join(",")}` +
    (hits.length > shown.length ? ` … (+${hits.length - shown.length} more — narrow the filter)` : "")
  );
}

/** Define a named assembly (relative placements around its own origin). */
export function defineAssembly(session: BuildSession, name: string, parts: PlacementInput[]): string {
  if (!name || parts.length === 0) return "assembly needs a name and at least one part";
  const unknown = parts.filter((p) => !session.meta[p.part]).map((p) => p.part);
  if (unknown.length) return `REJECTED: unknown parts in assembly: ${[...new Set(unknown)].join(", ")}`;
  session.assemblies.set(name, parts);
  return `assembly "${name}" defined with ${parts.length} parts (valid this turn — place with place_assembly)`;
}

/** Stamp an assembly at a position with a Y rotation (0/90/180/270). */
export function placeAssembly(
  session: BuildSession,
  name: string,
  atX: number,
  atZ: number,
  rot: 0 | 90 | 180 | 270,
): string[] {
  const def = session.assemblies.get(name);
  if (!def) {
    return [
      `REJECTED: no assembly "${name}" — defined this turn: ${[...session.assemblies.keys()].join(", ") || "(none)"}`,
    ];
  }
  const transformed = def.map((p) => {
    let dx = p.x_stud;
    let dz = p.z_stud;
    // Rotate the offset about the assembly origin.
    if (rot === 90) [dx, dz] = [dz, -dx];
    else if (rot === 180) [dx, dz] = [-dx, -dz];
    else if (rot === 270) [dx, dz] = [-dz, dx];
    return {
      ...p,
      x_stud: atX + dx,
      z_stud: atZ + dz,
      rot: (((p.rot ?? 0) + rot) % 360) as PlacementInput["rot"],
    };
  });
  return placeParts(session, transformed);
}

export function inspectBuild(session: BuildSession, jointEdges?: [number, number][]): string {
  const { parts, meta } = session;
  if (parts.length === 0) {
    return session.inventory
      ? `Empty build. Remaining inventory:\n${formatInventory(session.inventory)}`
      : "Empty build — the baseplate is clear.";
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 0;
  const boxes = parts.map((p) => {
    const b = partBBox(p, meta);
    minX = Math.min(minX, b[0]); maxX = Math.max(maxX, b[1]);
    minZ = Math.min(minZ, b[4]); maxZ = Math.max(maxZ, b[5]);
    maxY = Math.max(maxY, b[3]);
    return b;
  });
  const overlaps = findOverlapping(parts, meta);

  const soundness = checkSoundness(parts, meta);
  const header =
    soundness.report +
    `\nfootprint studs x[${minX / STUD_PITCH}..${maxX / STUD_PITCH}] ` +
    `z[${minZ / STUD_PITCH}..${maxZ / STUD_PITCH}] · height ${maxY} LDU` +
    (overlaps.size ? `\n⚠ overlapping indices: ${[...overlaps].join(", ")}` : "");

  // Small builds: exact list. Bigger builds: per-course occupancy maps —
  // structure at a glance instead of coordinate soup.
  let body: string;
  if (parts.length <= 30) {
    body = parts
      .map(
        (p, i) =>
          `${i}: ${p.part} color=${p.color} at (${p.x / STUD_PITCH}, ${p.z / STUD_PITCH}) y=${p.y} rot=${p.rot}${p.m ? " (oriented)" : ""}`,
      )
      .join("\n");
  } else {
    const x0 = Math.floor(minX / STUD_PITCH);
    const x1 = Math.ceil(maxX / STUD_PITCH);
    const z0 = Math.floor(minZ / STUD_PITCH);
    const z1 = Math.ceil(maxZ / STUD_PITCH);
    const width = x1 - x0;
    const depth = z1 - z0;
    if (width > 64 || depth > 64) {
      body = "(build too wide for occupancy maps — use coordinates from placement results)";
    } else {
      // Cells are keyed by COLOR (legend below) — recoloring and structure
      // questions both need "what color is where"; use find_parts for indices.
      const colorLetters = new Map<number, string>();
      const letterFor = (color: number) => {
        let ch = colorLetters.get(color);
        if (!ch) {
          ch = String.fromCharCode(97 + (colorLetters.size % 26));
          colorLetters.set(color, ch);
        }
        return ch;
      };
      const nCourses = Math.min(Math.ceil(maxY / 24), 12);
      const maps: string[] = [];
      for (let c = 0; c < nCourses; c++) {
        const yLo = c * 24;
        const yHi = yLo + 24;
        const grid: string[][] = Array.from({ length: depth }, () => Array(width).fill("."));
        let any = false;
        parts.forEach((p, i) => {
          const b = boxes[i];
          if (b[2] >= yHi - 0.5 || b[3] <= yLo + 0.5) return;
          const gx0 = Math.max(0, Math.round(b[0] / STUD_PITCH) - x0);
          const gx1 = Math.min(width, Math.round(b[1] / STUD_PITCH) - x0);
          const gz0 = Math.max(0, Math.round(b[4] / STUD_PITCH) - z0);
          const gz1 = Math.min(depth, Math.round(b[5] / STUD_PITCH) - z0);
          const ch = letterFor(p.color);
          for (let gz = gz0; gz < gz1; gz++) {
            for (let gx = gx0; gx < gx1; gx++) {
              grid[gz][gx] = ch;
              any = true;
            }
          }
        });
        if (any) {
          maps.push(
            `course ${c} (y ${yLo}..${yHi}), x ${x0}→${x1}, each row = z ${z0}…:\n` +
              grid.map((row) => row.join("")).join("\n"),
          );
        }
      }
      const legend = [...colorLetters.entries()]
        .map(([color, ch]) => `${ch}=color ${color}`)
        .join(" ");
      const counts = new Map<string, number>();
      for (const p of parts) counts.set(p.part, (counts.get(p.part) ?? 0) + 1);
      const tally = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([k, n]) => `${k}×${n}`)
        .join(" ");
      const colorTally = new Map<number, number>();
      for (const p of parts) colorTally.set(p.color, (colorTally.get(p.color) ?? 0) + 1);
      const colorLine = [...colorTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `color ${c}×${n}`)
        .join(" ");
      body = `parts: ${tally}\ncolors: ${colorLine}\nmap legend (cell = color): ${legend}\n${maps.join("\n")}\n(use find_parts to get part INDICES by color/region for recolor/remove)`;
    }
  }

  return [
    header,
    body,
    session.inventory ? `Remaining inventory:\n${formatInventory(session.inventory)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatInventory(inv: Record<string, number>): string {
  const rows = Object.entries(inv)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "(nothing left)";
  const shown = rows.slice(0, 80).map(([k, n]) => {
    const [part, color] = k.split(":");
    return `${part} color=${color} ×${n}`;
  });
  return shown.join("\n") + (rows.length > 80 ? `\n… and ${rows.length - 80} more lines` : "");
}

/** Fallback meta reference for a part in tool results/search. */
export function partSummary(part: string, name: string, meta: PartMetaMap): string {
  const m = metaOf(part, meta);
  return `${part} "${name}" ${m.w}x${m.l} studs, ${m.h} LDU tall`;
}
