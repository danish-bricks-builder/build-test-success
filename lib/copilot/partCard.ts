/**
 * A PART CARD: what a part looks like, and where it can be joined.
 *
 * Searching the library by name gives a number and a footprint, which is
 * enough to name a part and not enough to use one — a "hinge brick 1x4
 * [upper]" tells you nothing about which face the fingers are on. The card
 * answers both questions at once: a render of the part alone with a glyph on
 * every connector, numbered, and the same connectors listed as text with the
 * numbers that appear in the picture.
 *
 *   cone (red)   a stud or pin — something seats ON it
 *   ring (blue)  a pocket or hole — something seats IN it
 *   ball         clip (green), hinge finger (orange), ball joint (purple)
 *
 * Shared by both arms: the baseline agent's search_parts and the copilot's,
 * so "let me look at the part first" costs the same in either language.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { expandedConnectors } from "@/lib/engine/connectionGraph";
import type { PartMetaMap } from "@/lib/data/schemas";
import { renderAvailable, renderModel } from "@/lib/render";
import { LON_OFFSET } from "@/lib/render/chromium";
import type { SnapMarker } from "@/lib/render/snapScene";
import { getConnections } from "./connect";

/** Connectors worth drawing: all of them on a small part, a spread sample of
 * each group on a plate with 256 studs (which would otherwise be a fur of
 * identical cones). */
function chooseMarkers(
  cons: { kind: string; gender?: string; local: [number, number, number]; ori?: number[]; secs?: string }[],
  max: number,
): { index: number; con: (typeof cons)[number] }[] {
  const all = cons.map((con, index) => ({ index, con }));
  if (all.length <= max) return all;
  const groups = new Map<string, typeof all>();
  for (const row of all) {
    const k = `${row.con.kind}/${row.con.gender ?? ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(row);
  }
  const per = Math.max(2, Math.floor(max / groups.size));
  const out: typeof all = [];
  for (const rows of groups.values()) {
    if (rows.length <= per) out.push(...rows);
    else for (let i = 0; i < per; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (per - 1))]);
  }
  return out;
}

/**
 * The connector's axis, pointed OUT of the part.
 *
 * The shadow library stores an axis, not a side: a stud on a brick's top face
 * and a pocket on its bottom carry the same [0,1,0]. Drawn literally, half the
 * arrows point into the brick. So the sign is chosen geometrically — away from
 * the part's centre — which is the direction the mating part comes from.
 */
const axisOf = (
  ori: number[] | undefined,
  pos: [number, number, number],
  centre: [number, number, number],
): [number, number, number] => {
  const a: [number, number, number] = ori && ori.length === 9 ? [ori[1], ori[4], ori[7]] : [0, 1, 0];
  const d = [pos[0] - centre[0], pos[1] - centre[1], pos[2] - centre[2]];
  const dot = a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  return dot < 0 ? [-a[0], -a[1], -a[2]] : a;
};

const ROLE: Record<string, string> = {
  "cyl/M": "stud or pin (something seats ON it)",
  "cyl/F": "pocket or hole (something seats IN it)",
  clp: "clip",
  fgr: "hinge finger",
  gen: "ball or socket",
};

export interface PartCardOpts {
  /** most connectors to draw and number (the rest are summarised) */
  max?: number;
  /** how many camera angles (1-3). One view hides every connector on the far
   * side of the part, which is exactly the half a builder needs. */
  views?: number;
}

/** Candidate cameras. Which ones are used is decided by the part: a bracket
 * with every connector on one face gains nothing from a view of its blank
 * back, and an empty picture is worse than no picture. */
const CANDIDATE_VIEWS: [number, number][] = [
  [30, 45], [30, 135], [30, 225], [30, 315],
  [-30, 45], [-30, 135], [-30, 225], [-30, 315],
  [75, 45], [-75, 45],
];

const viewDir = (lat: number, lon: number): [number, number, number] => {
  const a = ((lat + 0) * Math.PI) / 180;
  const b = ((lon + LON_OFFSET) * Math.PI) / 180;
  return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)];
};

/** The renderer's frame for a marker's axis: LDraw is +Y down. */
const renderAxis = (m: SnapMarker): [number, number, number] => [m.axis?.[0] ?? 0, -(m.axis?.[1] ?? 1), -(m.axis?.[2] ?? 0)];

const sees = (m: SnapMarker, dir: [number, number, number]) => {
  const a = renderAxis(m);
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return (a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2]) / n >= -0.15;
};

const named = (lat: number, lon: number) =>
  `${lat >= 60 ? "from straight above" : lat <= -60 ? "from straight below" : lat >= 0 ? "from above" : "from below"}, ` +
  `${["the front", "the right", "the back", "the left"][Math.round(((lon % 360) + 360) % 360 / 90) % 4]}`;

/**
 * Pick the cameras that between them SHOW the connectors: the view that sees
 * the most, then the view that adds the most of what the first one missed.
 */
function chooseViews(markers: SnapMarker[], want: number): [string, number, number][] {
  const left = new Set(markers.map((_, i) => i));
  const picked: [string, number, number][] = [];
  for (let n = 0; n < want && left.size > 0; n++) {
    let best: { lat: number; lon: number; covers: number[] } | null = null;
    for (const [lat, lon] of CANDIDATE_VIEWS) {
      const dir = viewDir(lat, lon);
      const covers = [...left].filter((i) => sees(markers[i], dir));
      if (!best || covers.length > best.covers.length) best = { lat, lon, covers };
    }
    if (!best || best.covers.length === 0) break;
    picked.push([named(best.lat, best.lon), best.lat, best.lon]);
    for (const i of best.covers) left.delete(i);
  }
  // Every connector already seen, but a second angle still tells a builder
  // what the part IS — so fill the rest with the most different directions
  // from the ones already chosen.
  while (picked.length < want) {
    const chosenDirs = picked.map(([, lat, lon]) => viewDir(lat, lon));
    let best: { lat: number; lon: number; far: number } | null = null;
    for (const [lat, lon] of CANDIDATE_VIEWS) {
      if (picked.some(([, la, lo]) => la === lat && lo === lon)) continue;
      const d = viewDir(lat, lon);
      // ...but it must still show the map: the most different angle is often
      // the blank back of the part, which teaches nothing.
      if (markers.length > 0 && markers.filter((m) => sees(m, d)).length < markers.length / 3) continue;
      // how unlike every view already picked this one is
      const far = Math.min(...chosenDirs.map((c) => 1 - (c[0] * d[0] + c[1] * d[1] + c[2] * d[2])));
      if (!best || far > best.far) best = { lat, lon, far };
    }
    if (!best) break;
    picked.push([named(best.lat, best.lon), best.lat, best.lon]);
  }
  // a part with no connector data at all still deserves a picture
  if (picked.length === 0) picked.push([named(30, 45), 30, 45]);
  return picked;
}

/**
 * Tool-result content for one part: the picture, then the key to it. Falls
 * back to text alone where there is no renderer (a deployment), so the caller
 * never has to ask whether eyes are available.
 */
export async function partCard(
  part: string,
  meta: PartMetaMap,
  opts: PartCardOpts = {},
): Promise<(Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]> {
  const max = opts.max ?? 16;
  const cons = expandedConnectors(part, getConnections());
  const m = meta[part];
  const head = `${part}${m ? ` — ${m.w}x${m.l} studs, ${m.h} LDU tall` : ""}`;
  if (cons.length === 0) {
    return [{ type: "text", text: `${head}. No connector data for this part: nothing can be seated on it by name.` }];
  }

  const chosen = chooseMarkers(cons, max);
  // the part's own box, in its local LDraw frame (origin on the top face, +Y down)
  const centre: [number, number, number] = [0, (m?.h ?? 24) / 2, 0];
  const markers: SnapMarker[] = chosen.map(({ index, con }) => ({
    pos: con.local,
    axis: axisOf(con.ori, con.local, centre),
    kind: con.kind,
    gender: con.gender,
    label: String(index),
  }));

  const fmt = (v: [number, number, number]) => `(${v.map((n) => Math.round(n)).join(", ")})`;
  const lines = chosen.map(
    ({ index, con }) =>
      `  ${index}  ${con.kind.toUpperCase()}${con.gender ? `/${con.gender}` : ""} at ${fmt(con.local)}` +
      `${ROLE[`${con.kind}/${con.gender ?? ""}`] ?? ROLE[con.kind] ? ` — ${ROLE[`${con.kind}/${con.gender ?? ""}`] ?? ROLE[con.kind]}` : ""}`,
  );
  const counts = new Map<string, number>();
  for (const c of cons) counts.set(`${c.kind}/${c.gender ?? ""}`, (counts.get(`${c.kind}/${c.gender ?? ""}`) ?? 0) + 1);
  const tally = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ");

  const text =
    `${head}. ${cons.length} connectors: ${tally}.\n` +
    (chosen.length < cons.length
      ? `The picture numbers ${chosen.length} of them (a spread sample; identical connectors repeat):\n`
      : "The numbers in the picture are these, in part-local LDraw coordinates:\n") +
    lines.join("\n");

  if (!renderAvailable()) return [{ type: "text", text: `${text}\n(no renderer here, so no picture)` }];
  const out: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  const wanted = Math.max(1, Math.min(3, Math.round(opts.views ?? 2)));
  for (const [name, lat, lon] of chooseViews(markers, wanted)) {
    try {
      const shot = await renderModel(`1 71 0 0 0 1 0 0 0 1 0 0 0 1 ${part}.dat\n`, {
        lat,
        lon,
        width: 560,
        height: 440,
        markers,
      });
      out.push({ type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.dataBase64 } });
      out.push({ type: "text", text: `${part} — ${name}. A connector is only drawn in a view it faces.` });
    } catch (e) {
      out.push({ type: "text", text: `(${name}: the renderer failed — ${e instanceof Error ? e.message : String(e)})` });
    }
  }
  out.push({ type: "text", text });
  return out;
}

/**
 * The same map, for a part ALREADY IN THE BUILD: the whole model rendered with
 * the connectors of one placed part marked and numbered, so the thing being
 * attached TO is as legible as the thing being attached.
 *
 * The connector positions are computed from the very LDraw text being
 * rendered — the placement's own translation and matrix — so the glyphs
 * cannot drift from the picture.
 */
export async function placedCard(
  ldraw: string,
  index: number,
  meta: PartMetaMap,
  opts: PartCardOpts = {},
): Promise<(Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]> {
  const lines = ldraw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("1 "));
  const line = lines[index];
  if (!line) return [{ type: "text", text: `No placed part at index ${index} to draw.` }];
  const tok = line.split(/\s+/);
  const t = [Number(tok[2]), Number(tok[3]), Number(tok[4])] as [number, number, number];
  const r = tok.slice(5, 14).map(Number);
  const part = tok.slice(14).join(" ").replace(/\.dat$/i, "").replace(/^.*\//, "");
  const cons = expandedConnectors(part, getConnections());
  if (cons.length === 0) return [{ type: "text", text: `[${index}] ${part}: no connector data.` }];

  const chosen = chooseMarkers(cons, opts.max ?? 16);
  const m = meta[part];
  const centre: [number, number, number] = [0, (m?.h ?? 24) / 2, 0];
  const apply = (v: [number, number, number], translate: boolean): [number, number, number] => [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2] + (translate ? t[0] : 0),
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2] + (translate ? t[1] : 0),
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2] + (translate ? t[2] : 0),
  ];
  const markers: SnapMarker[] = chosen.map(({ index: i, con }) => ({
    pos: apply(con.local, true),
    axis: apply(axisOf(con.ori, con.local, centre), false),
    kind: con.kind,
    gender: con.gender,
    label: String(i),
  }));

  const fmt = (v: [number, number, number]) => `(${v.map((n) => Math.round(n)).join(", ")})`;
  const text =
    `[${index}] ${part} in the build — ${cons.length} connectors, ${chosen.length} numbered in the picture ` +
    `(world LDraw coordinates):\n` +
    chosen
      .map(({ index: i, con }) => {
        const role = ROLE[`${con.kind}/${con.gender ?? ""}`] ?? ROLE[con.kind];
        return `  ${i}  ${con.kind.toUpperCase()}${con.gender ? `/${con.gender}` : ""} at ${fmt(apply(con.local, true))}${role ? ` — ${role}` : ""}`;
      })
      .join("\n");

  if (!renderAvailable()) return [{ type: "text", text: `${text}\n(no renderer here, so no picture)` }];
  const out: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  const wanted = Math.max(1, Math.min(3, Math.round(opts.views ?? 2)));
  for (const [name, lat, lon] of chooseViews(markers, wanted)) {
    try {
      const shot = await renderModel(ldraw, { lat, lon, width: 620, height: 480, markers });
      out.push({ type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.dataBase64 } });
      out.push({ type: "text", text: `The build ${name}, with the connectors of [${index}] ${part} numbered.` });
    } catch (e) {
      out.push({ type: "text", text: `(${name}: the renderer failed — ${e instanceof Error ? e.message : String(e)})` });
    }
  }
  out.push({ type: "text", text });
  return out;
}
