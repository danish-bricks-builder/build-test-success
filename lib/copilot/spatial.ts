/**
 * Copilot v4 tools: the two-occupancy toolkit.
 *
 * SPATIAL occupancy — silhouette projections (shape feedback without
 * vision flakiness). MATE occupancy — free_connectors (what can be
 * built on, where) and attach_options/attach_option (placement as
 * CHOICE over ranked legal seatings, the human cycler as a tool).
 * Plus mirror_stamp (bilateral symmetry as one op).
 */
import { getConnections, getVoxels } from "./connect";
import { metaOf } from "../engine/geometry";
import type { BuildSession } from "./state";
import { ldrawFrameOf } from "../engine/snapAlign";
import { expandedConnectors } from "../engine/connectionGraph";
import { detectMates } from "../editor2/mates";
import { compose, connFrame, type E2Part, type Frame } from "../editor2/kinematics";
import { enumerateMates, toPlaced, type MatePlacement } from "../rules/enumerate";
import { checkCollisionsValidated, worldCells } from "../engine/voxelCollision";
import type { PlacedPartJson } from "../data/schemas";

const hOfFor = (session: BuildSession) => (part: string) => metaOf(part, session.meta).h;

/** Session parts as editor2 parts with LDraw frames (ids = indices). */
function ldrawParts(session: BuildSession): { parts: E2Part[]; frames: Map<number, Frame> } {
  const hOf = hOfFor(session);
  const parts: E2Part[] = session.parts.map((p, i) => ({
    id: i,
    part: p.part,
    color: p.color,
    root: ldrawFrameOf(p, hOf) as Frame,
  }));
  return { parts, frames: new Map(parts.map((p) => [p.id, p.root as Frame])) };
}

/** World direction class of a connector's axis (LDraw frame: -y is up). */
function faceOf(frame: Frame, c: { ori?: number[] }): "up" | "down" | "side" {
  const r = c.ori ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // connector axis = local +y taken through ori then part rotation
  const ax = [r[1], r[4], r[7]];
  const wy = frame.r[3] * ax[0] + frame.r[4] * ax[1] + frame.r[5] * ax[2];
  if (wy < -0.7) return "up";
  if (wy > 0.7) return "down";
  return "side";
}

/** MATE OCCUPANCY read: every part's engaged vs FREE connectors. */
export function freeConnectors(session: BuildSession): string {
  if (session.parts.length === 0) return "empty build — every connector of the first part will be free";
  const conns = getConnections();
  const cOf = (part: string) => expandedConnectors(part, conns);
  const { parts, frames } = ldrawParts(session);
  const engaged = new Set<string>();
  for (const m of detectMates(parts, frames, cOf)) {
    if (m.a.partId === m.b.partId) continue;
    engaged.add(`${m.a.partId}:${m.a.conn}`);
    engaged.add(`${m.b.partId}:${m.b.conn}`);
  }
  const lines: string[] = [];
  for (const p of parts) {
    const cs = cOf(p.part);
    if (!cs.length) continue;
    const free: Record<string, number> = {};
    let engagedN = 0;
    cs.forEach((c, i) => {
      if (engaged.has(`${p.id}:${i}`)) {
        engagedN++;
        return;
      }
      const g = c.gender === "M" ? (c.kind === "cyl" ? "stud/pin" : c.kind) : c.kind === "cyl" ? "tube/hole" : c.kind;
      // males PROTRUDE opposite their authored axis — flip their face
      let face = faceOf(p.root as Frame, c);
      if (c.gender === "M") face = face === "up" ? "down" : face === "down" ? "up" : "side";
      const key = `${g} ${face}`;
      free[key] = (free[key] ?? 0) + 1;
    });
    const freeTxt = Object.entries(free)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    lines.push(`[${p.id}] ${p.part}: free ${freeTxt || "none"} · engaged ${engagedN}`);
    if (lines.length >= 60) {
      lines.push(`… ${parts.length - 60} more parts`);
      break;
    }
  }
  return lines.join("\n");
}

interface AttachOpt {
  pl: MatePlacement;
  world: Frame;
}

/** Ranked LEGAL seatings of `part` onto placed part [to] — numbered so
 * the model can commit one with attach_option. Every option is
 * enumeration-legal AND collision-checked against the whole build. */
export function attachOptions(
  session: BuildSession,
  input: { part: string; to: number; toConnector?: number; limit?: number },
): string {
  const conns = getConnections();
  const vox = getVoxels();
  // Drop any previous offer FIRST. A failed call used to leave the last
  // successful one in place, so `seat` on an impossible pair committed the
  // PREVIOUS statement's part instead of failing (a 3001 line that silently
  // placed a second 2780).
  delete (session as BuildSession & { attachOpts?: unknown }).attachOpts;
  const target = session.parts[input.to];
  if (!target) return `no placed part [${input.to}]`;
  const limit = Math.min(input.limit ?? 8, 16);
  // A tool call must come back. Seating a 16x8 panel onto a 16x2 beam is
  // 28,519 connector pairs of voxel work — six minutes, measured — and the
  // caller only ever reads the first handful of seatings. Twenty seconds of
  // search, then say the catalog is partial.
  const { placements, truncated } = enumerateMates(target.part, input.part, conns, {
    meta: session.meta,
    vox,
    aIndices: input.toConnector != null ? [input.toConnector] : undefined,
    maxMs: Number(process.env.DBB_SEATING_BUDGET_MS ?? 20_000),
  });
  if (!placements.length)
    return `no legal seatings of ${input.part} onto [${input.to}] ${target.part}${
      input.toConnector != null ? ` via its connector C${input.toConnector + 1}` : ""
    }${truncated ? " (the search was cut short at 20s — name a connector with toConnector and try again)" : ""}`;
  const hOf = hOfFor(session);
  const tFrame = ldrawFrameOf(target, hOf) as Frame;
  // prefer more contacts, then upright placements
  const ranked = [...placements].sort(
    (a, b) => b.contacts - a.contacts || (a.frame.r[4] > 0.9 ? -1 : 0) - (b.frame.r[4] > 0.9 ? -1 : 0),
  );
  const opts: AttachOpt[] = [];
  for (const pl of ranked) {
    if (opts.length >= limit) break;
    const world = compose(tFrame, pl.frame);
    const cand = toPlaced(input.part, world, 4);
    const all = [...session.parts, cand];
    const hits = checkCollisionsValidated(all, session.meta, vox, conns).filter(
      (c) => c.a === all.length - 1 || c.b === all.length - 1,
    );
    if (hits.length) continue;
    opts.push({ pl, world });
  }
  if (!opts.length) return `${placements.length} catalog seatings exist but ALL collide with the current build`;
  (session as BuildSession & { attachOpts?: { part: string; to: number; opts: AttachOpt[] } }).attachOpts = {
    part: input.part,
    to: input.to,
    opts,
  };
  const lines = opts.map(
    (o, i) =>
      `#${i + 1} ${o.pl.label} ${o.pl.kind} · ${o.pl.desc} · via ${o.pl.via} · ${o.pl.contacts} contact${o.pl.contacts > 1 ? "s" : ""}`,
  );
  return [
    `${opts.length} collision-free seating${opts.length > 1 ? "s" : ""} of ${input.part} onto [${input.to}] ${target.part} (of ${placements.length} legal${truncated ? ", search cut short — this pair has too many connectors to enumerate fully; name a connector with toConnector to search a smaller space" : ""}):`,
    ...lines,
    `commit with attach_option {option: N, color}`,
  ].join("\n");
}

/** Commit a numbered seating from the last attach_options call. */
export function attachOption(session: BuildSession, input: { option: number; color: number }): string {
  const cache = (session as BuildSession & { attachOpts?: { part: string; to: number; opts: AttachOpt[] } })
    .attachOpts;
  if (!cache) return "call attach_options first";
  const o = cache.opts[input.option - 1];
  if (!o) return `option ${input.option} does not exist (1..${cache.opts.length})`;
  const placed = toPlaced(cache.part, o.world, input.color);
  session.parts.push(placed as PlacedPartJson);
  return `placed ${cache.part} as [${session.parts.length - 1}] · ${o.pl.label} ${o.pl.kind} onto [${cache.to}] · ${o.pl.desc}`;
}

/** L/R-handed part pairs that swap under mirroring; unlisted parts are
 * assumed symmetric (true for bricks/plates/most slopes). */
const MIRROR_PAIRS: Record<string, string> = {
  "3933": "3934", "3934": "3933", // Wing 8x4 L/R
  "41769": "41770", "41770": "41769", // Wedge Plate 4x2 L/R
  "43722": "43723", "43723": "43722", // Wedge Plate 3x2 L/R
  "2744": "2745", "2745": "2744",
  "54383": "54384", "54384": "54383", // Wedge Plate 6x3 L/R
  "50304": "50305", "50305": "50304",
  "2419": "2419",
};

/** Stamp a module MIRRORED across the plane x = at_stud (bilateral
 * symmetry as one op — wings, stabilizers, gear). */
export function mirrorStamp(session: BuildSession, input: { name: string; at_stud: number }): string {
  const def = session.modules?.get(input.name);
  if (!def) return `no module "${input.name}" — define_module_from first`;
  const planeX = input.at_stud * 20;
  const S = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    return o;
  };
  const assumed: string[] = [];
  const mirrored: PlacedPartJson[] = def.parts.map((p) => {
    const mp = MIRROR_PAIRS[p.part] ?? p.part;
    if (!MIRROR_PAIRS[p.part] && /wedge|wing|left|right/i.test(p.part) === false) {
      /* symmetric assumption is fine for standard parts */
    } else if (!MIRROR_PAIRS[p.part]) assumed.push(p.part);
    const m = p.m ? mul(mul(S, p.m as number[]), S) : undefined;
    const rot = p.m ? p.rot : (((360 - (p.rot ?? 0)) % 360) as PlacedPartJson["rot"]);
    return { ...p, part: mp, x: 2 * planeX - p.x, m: m as PlacedPartJson["m"], rot };
  });
  // whole-stamp fit check
  const vox = getVoxels();
  const conns = getConnections();
  const all = [...session.parts, ...mirrored];
  const n0 = session.parts.length;
  const hits = checkCollisionsValidated(all, session.meta, vox, conns).filter((c) => c.a >= n0 || c.b >= n0);
  if (hits.length) return `mirror of "${input.name}" about x=${input.at_stud} collides (${hits.length} pairs) — pick another plane`;
  session.parts.push(...mirrored);
  const ids = mirrored.map((_, i) => n0 + i);
  return (
    `mirrored "${input.name}" about x=${input.at_stud}: ${mirrored.length} parts placed as [${ids[0]}..${ids[ids.length - 1]}]` +
    (assumed.length ? ` · WARNING handed parts assumed symmetric: ${[...new Set(assumed)].join(", ")}` : "")
  );
}

/** SPATIAL occupancy read: orthographic silhouette as ASCII. */
export function silhouetteView(session: BuildSession, axis: "top" | "front" | "side"): string {
  if (!session.parts.length) return "empty build";
  const vox = getVoxels();
  const hOf = hOfFor(session);
  const proj = new Set<string>();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of session.parts) {
    const cells = worldCells(p, vox, hOf);
    if (!cells) continue;
    for (const key of cells) {
      const cx = (key % 1024) - 512;
      const cy = (((key / 1024) | 0) % 1024) - 512;
      const cz = ((key / (1024 * 1024)) | 0) - 512;
      // engine frame: x right, y up, z toward viewer
      const [u, v] = axis === "top" ? [cx, cz] : axis === "front" ? [cx, -cy] : [cz, -cy];
      proj.add(`${u},${v}`);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
  }
  if (!proj.size) return "no voxel data for these parts";
  const W = maxU - minU + 1;
  const H = maxV - minV + 1;
  const step = Math.max(1, Math.ceil(Math.max(W / 56, H / 28)));
  const rows: string[] = [];
  for (let v = minV; v <= maxV; v += step) {
    let row = "";
    for (let u = minU; u <= maxU; u += step) {
      let hit = false;
      outer: for (let dv = 0; dv < step; dv++)
        for (let du = 0; du < step; du++)
          if (proj.has(`${u + du},${v + dv}`)) {
            hit = true;
            break outer;
          }
      row += hit ? "#" : "·";
    }
    rows.push(row);
  }
  const unit = step === 1 ? "1 LDU" : `${step} LDU`;
  return [`${axis} silhouette · 1 char = ${unit} (20 LDU = 1 stud) · ${Math.round(W / 20)}x${Math.round(H / 20)} studs`, ...rows].join("\n");
}
