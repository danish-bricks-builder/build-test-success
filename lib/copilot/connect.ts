/**
 * Copilot connection tools — the LDCad-derived snap data + solver exposed
 * to the model, so it can assemble wheels/pins/axles/SNOT exactly instead
 * of guessing coordinates. Server-side only (reads connections.json once).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDataJson } from "../data/serverData";
import type { PartIndexRow } from "../data/schemas";
import { metaOf, partBBox } from "../engine/geometry";
import {
  firstSnap,
  snapWorld,
  solveAttachment,
  solveAttachmentSeated,
  type ConnectionMap,
  type Snap,
} from "../engine/snapAlign";
import { checkStability } from "../engine/stability";
import { checkCollisionsValidated, pairOverlap, type VoxelData } from "../engine/voxelCollision";
import { connectorAsSnap, expandedConnectors, validateConnections } from "../engine/connectionGraph";
import type { BuildSession } from "./state";

/**
 * Server-side catalog caches. Deploys ship no data on disk (the bucket
 * serves /data via DATA_ORIGIN), so the sync getters below read the local
 * checkout when present and otherwise rely on `warmServerData()` having
 * fetched the file — every copilot route awaits it (via loadStatic).
 */
const pub = (...p: string[]) => join(process.cwd(), "public", "data", "parts", ...p);
const EMPTY_VOXELS: VoxelData = { res: 1, parts: {} };

// These tables are large (voxels.json is 264 MB on disk, far more parsed). In `next dev` every hot
// reload of a server module makes a fresh module instance; a plain `let` cache would parse the table
// again per instance while the old copies stay reachable — the dev server climbed past 10 GB that way.
const G = globalThis as unknown as { __dbbVox?: VoxelData | null; __dbbConns?: ConnectionMap | null; __dbbPartIndex?: PartIndexRow[] | null };
let voxMissingLogged = false;
/** Voxel occupancy for collision/stability. Falls back to an EMPTY table
 * (every part "has no voxels" → collision check finds nothing, stability
 * uses bbox bodies) when the 264MB file is neither on disk nor fetched —
 * see `voxelsAvailable()` to say so in reports. */
export function getVoxels(): VoxelData {
  if (!G.__dbbVox) {
    const file = pub("voxels.json");
    // DBB_VOXELS=split: a short-lived tool process (the Brick Viewer plugin) reads only the parts a model
    // uses from the per-part files, instead of parsing the whole 264 MB table for one small model.
    if (existsSync(file) && !(process.env.DBB_VOXELS === "split" && existsSync(pub("voxels")))) G.__dbbVox = JSON.parse(readFileSync(file, "utf8")) as VoxelData;
    else if (existsSync(pub("voxels"))) {
      // The same table, one file per part (public/data/parts/voxels/3001.json
      // = {min, dims, bits}). Read on demand: a checkout that has the split
      // form and not the 264MB aggregate was silently getting NO occupancy at
      // all, so every collision and stability verdict fell back to nominal
      // boxes — which reports a correctly stacked brick as interpenetrating.
      const cache: VoxelData["parts"] = Object.create(null);
      const load = (part: string) => {
        if (part in cache) return cache[part];
        const f = pub("voxels", `${part}.json`);
        cache[part] = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as VoxelData["parts"][string]) : (undefined as never);
        return cache[part];
      };
      G.__dbbVox = {
        res: 1,
        parts: new Proxy(cache, {
          get: (_t, k: string | symbol) => (typeof k === "string" ? load(k) : undefined),
          has: (_t, k: string | symbol) => typeof k === "string" && (k in cache || existsSync(pub("voxels", `${k}.json`))),
        }),
      };
    } else {
      if (!voxMissingLogged) {
        voxMissingLogged = true;
        console.warn("[copilot] no voxel data on this deployment — collision checks degraded");
      }
      return EMPTY_VOXELS;
    }
  }
  return G.__dbbVox;
}
export function voxelsAvailable(): boolean {
  return G.__dbbVox != null || existsSync(pub("voxels.json")) || existsSync(pub("voxels"));
}


/** The searchable part index (name/number rows) for search_parts. */
export function getPartIndex(): PartIndexRow[] {
  if (!G.__dbbPartIndex) {
    const file = pub("index.json");
    if (!existsSync(file)) throw new Error("part index not loaded — warmServerData() must run before tools");
    G.__dbbPartIndex = JSON.parse(readFileSync(file, "utf8")) as PartIndexRow[];
  }
  return G.__dbbPartIndex;
}

/**
 * Populate the caches from disk or DATA_ORIGIN. Idempotent and cheap after
 * the first call. voxels.json (264MB) is only fetched when
 * COPILOT_FETCH_VOXELS=1 — by default a deployment without it degrades.
 */
export async function warmServerData(): Promise<void> {
  if (!G.__dbbConns) G.__dbbConns = (await readDataJson("data/parts/connections.json")) as ConnectionMap;
  if (!G.__dbbPartIndex) G.__dbbPartIndex = (await readDataJson("data/parts/index.json")) as PartIndexRow[];
  if (!G.__dbbVox) {
    if (existsSync(pub("voxels.json"))) getVoxels();
    else if (process.env.COPILOT_FETCH_VOXELS === "1") G.__dbbVox = (await readDataJson("data/parts/voxels.json")) as VoxelData;
  }
}

/** Real joint edges for the soundness union (pins/clips ground through joints). */
export function jointEdges(session: BuildSession): [number, number][] {
  return validateConnections(session.parts, session.meta, getConnections()).joints.map(
    (j) => [j.a, j.b] as [number, number],
  );
}

/** Studio-grade joint validation report. */
export function jointReport(session: BuildSession): string {
  const v = validateConnections(session.parts, session.meta, getConnections());
  const lines = [
    `JOINTS: ${v.joints.length} real connections (studs, pins, clips…) · ${v.grounded.length} parts on the ground.`,
  ];
  if (v.unconnected.length > 0) {
    lines.push(
      `⚠ ${v.unconnected.length} parts have NO valid connection and don't touch the ground: indices ${v.unconnected
        .slice(0, 12)
        .join(", ")} — they are not really attached. Re-place them on studs/connectors.`,
    );
  }
  return lines.join("\n");
}

/** Stability verdict for the current build (stability-lite statics):
 * global topple + stud-clutch cantilevers, per connected structure. The
 * report names the hanging parts and the overhang direction so a repair
 * prompt can say WHERE, not just no. */
export function stabilityReport(session: BuildSession): { text: string; severe: boolean } {
  const v = validateConnections(session.parts, session.meta, getConnections());
  const st = checkStability(session.parts, session.meta, v, getVoxels());
  const severe = !st.ok;
  const lines = [st.ok ? `STABILITY: ${st.report}` : `⚠ STABILITY: ${st.report}`];
  for (const i of st.issues) {
    if (!i.severe) continue;
    if (i.kind === "cantilever" && i.cut) {
      lines.push(
        `  fix: support the hanging part(s) [${i.parts.slice(0, 8).join(", ")}${i.parts.length > 8 ? "…" : ""}] from below, or pull them back over the interface at [${i.cut[0]}]↔[${i.cut[1]}] (overhang ${i.overhangLdu.toFixed(0)} LDU).`,
      );
    } else if (i.kind === "topple") {
      lines.push(`  fix: widen the base under the structure, or shift mass back over the footprint (CoM is ${i.overhangLdu === Infinity ? "unsupported" : i.overhangLdu.toFixed(0) + " LDU outside"}).`);
    }
  }
  return { text: lines.join("\n"), severe };
}

/** Human-readable collision report (voxel-true, cavities respected). */
/** Bare counts for gate baselining — a seeded set's PRE-EXISTING problems
 * are the seed's, not the agent's; gates compare against these. */
export function collisionCount(session: BuildSession): number {
  return checkCollisionsValidated(session.parts, session.meta, getVoxels(), getConnections()).length;
}
export function unconnectedCount(session: BuildSession): number {
  return validateConnections(session.parts, session.meta, getConnections()).unconnected.length;
}

export function collisionReport(session: BuildSession): string {
  const collisions = checkCollisionsValidated(session.parts, session.meta, getVoxels(), getConnections());
  if (!voxelsAvailable()) return "COLLISIONS: not checked — voxel geometry is unavailable on this deployment.";
  if (collisions.length === 0) return "COLLISIONS: none — no parts interpenetrate.";
  const lines = collisions
    .slice(0, 10)
    .map(
      (c) =>
        `  [${c.a}] ${session.parts[c.a].part} × [${c.b}] ${session.parts[c.b].part}: ~${c.voxels * 8} LDU³ shared`,
    );
  return [
    `⚠ COLLISIONS: ${collisions.length} interpenetrating pair${collisions.length === 1 ? "" : "s"} (real geometry, cavities respected) — physically impossible, fix by moving/removing:`,
    ...lines,
  ].join("\n");
}


export function getConnections(): ConnectionMap {
  if (!G.__dbbConns) {
    const file = pub("connections.json");
    if (!existsSync(file)) throw new Error("connections.json not loaded — warmServerData() must run before tools");
    G.__dbbConns = JSON.parse(readFileSync(file, "utf8")) as ConnectionMap;
  }
  return G.__dbbConns;
}

const fmtV = (v: [number, number, number]) => `(${v.map((n) => Math.round(n * 10) / 10).join(",")})`;

/**
 * List a part's connectors — either a library part ("part:4600") or a
 * placed part ("index:3", with world positions in engine studs/LDU).
 */
export function listConnectors(session: BuildSession, ref: string): string {
  const c = getConnections();
  const hOf = (part: string) => metaOf(part, session.meta).h;

  let part: string;
  let placed: number | null = null;
  if (ref.startsWith("index:")) {
    placed = Number(ref.slice(6));
    const p = session.parts[placed];
    if (!p) return `No placed part at index ${placed}.`;
    part = p.part;
  } else {
    part = ref.replace(/^part:/, "").trim();
  }
  const expanded = expandedConnectors(part, c);
  if (expanded.length === 0) return `${part}: no connector data.`;

  // Resolve each connector's display position (+ world axis for a placed part).
  type Row = {
    i: number;
    kind: string;
    gender: string;
    secs?: string;
    pos: [number, number, number];
    axis?: [number, number, number];
  };
  const rows: Row[] = expanded.map((ec, i) => {
    if (placed !== null) {
      const w = snapWorld(session.parts[placed!], connectorAsSnap(ec), hOf);
      return {
        i,
        kind: ec.kind,
        gender: ec.gender ?? "",
        secs: ec.secs,
        pos: [w.pos[0], -w.pos[1], -w.pos[2]],
        axis: [w.axis[0], -w.axis[1], -w.axis[2]],
      };
    }
    return { i, kind: ec.kind, gender: ec.gender ?? "", secs: ec.secs, pos: [...ec.local] as [number, number, number] };
  });
  const header = `${part}: ${rows.length} connectors${placed !== null ? ` (world coords, placed index ${placed})` : " (part-local coords)"}`;

  // Small parts (wheels, brackets, pins, single bricks): list every connector
  // — the model can read them directly and pick a C-id.
  if (rows.length <= 40) {
    const lines = [header];
    for (const r of rows)
      lines.push(
        `  #${r.i} ${r.kind.toUpperCase()}${r.gender ? `/${r.gender}` : ""} at ${fmtV(r.pos)}${
          r.axis ? ` axis ${fmtV(r.axis)}` : ""
        }${r.secs ? ` [${r.secs}]` : ""}`,
      );
    return lines.join("\n");
  }

  // Big parts (plates, long beams have hundreds of connectors): GROUP by
  // kind+gender so the useful ones aren't buried past a truncation. Male cyl =
  // the STUDS/pins you seat a female connector onto; female = pockets/holes.
  // For each group: the index range, the position span, and a few spread
  // samples so the model can target a spot by picking the nearest sample.
  const roleHint = (kind: string, gender: string) => {
    if (kind === "cyl" && gender === "M") return " — studs/pins (seat a female connector here)";
    if (kind === "cyl" && gender === "F") return " — pockets/holes";
    if (kind === "clp") return " — clips";
    if (kind === "fgr") return " — hinge fingers";
    if (kind === "gen") return " — ball/socket";
    return "";
  };
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.kind}/${r.gender}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const lines = [`${header} — grouped (many identical connectors):`];
  for (const [k, rs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const [kind, gender] = k.split("/");
    const idxs = rs.map((r) => r.i);
    const min = Math.min(...idxs);
    const max = Math.max(...idxs);
    const contiguous = max - min + 1 === rs.length;
    const xs = rs.map((r) => r.pos[0]);
    const ys = rs.map((r) => r.pos[1]);
    const zs = rs.map((r) => r.pos[2]);
    const rng = (a: number[]) => `${Math.round(Math.min(...a))}..${Math.round(Math.max(...a))}`;
    const pick =
      rs.length <= 4
        ? rs
        : [rs[0], rs[Math.floor(rs.length / 3)], rs[Math.floor((2 * rs.length) / 3)], rs[rs.length - 1]];
    const samples = pick.map((r) => `#${r.i}@${fmtV(r.pos)}`).join(" ");
    lines.push(
      `  ${kind.toUpperCase()}/${gender} ×${rs.length}${roleHint(kind, gender)}: #${min}–${max}${
        contiguous ? "" : " (non-contiguous)"
      }  X[${rng(xs)}] Y[${rng(ys)}] Z[${rng(zs)}]`,
    );
    lines.push(`      e.g. ${samples}`);
  }
  lines.push("  (positions LDU; studs are 20 LDU apart — pick the connector whose position is nearest where you want the part.)");
  return lines.join("\n");
}

export interface AttachInput {
  /** Index of the already-placed part to attach onto. */
  to: number;
  /** Connector # on the placed part (from list_connectors). */
  toConnector: number;
  /** Library part to attach. */
  part: string;
  color: number;
  /** Connector # on the new part; omit to auto-pick the opposite gender. */
  partConnector?: number;
  /** Shift along the joint axis, LDU. */
  slide?: number;
  /** Twist about the joint axis, degrees. */
  roll?: number;
  /** Mate anti-parallel (flip the part). */
  flip?: boolean;
  /** Skip the interpenetration check (meshing gear teeth overlap a little by
   * design; the referee's geometry rung excuses detected meshes — the
   * compiler should place, the referee should judge). */
  force?: boolean;
}

export function attachPart(session: BuildSession, input: AttachInput): string {
  const c = getConnections();
  const hOf = (part: string) => metaOf(part, session.meta).h;

  const fixed = session.parts[input.to];
  if (!fixed) return `REJECTED: no placed part at index ${input.to}.`;
  // BOTH sides use EXPANDED individual connectors — grid specs store their
  // pos at the grid CENTER, and mating a center to an individual stud
  // misaligns by half a pitch (the misaligned-plate bug).
  const fixedExpanded = expandedConnectors(fixed.part, c);
  const fixedConn = fixedExpanded[input.toConnector];
  if (!fixedConn) return `REJECTED: ${fixed.part} has no connector #${input.toConnector} — call list_connectors first.`;
  const fixedSnap = connectorAsSnap(fixedConn);

  const movingExpanded = expandedConnectors(input.part, c);
  let movingSnap: Snap | undefined;
  if (input.partConnector !== undefined) {
    const mc = movingExpanded[input.partConnector];
    if (!mc) return `REJECTED: ${input.part} has no connector #${input.partConnector}.`;
    movingSnap = connectorAsSnap(mc);
  } else {
    const want = fixedConn.gender === "M" ? "F" : fixedConn.gender === "F" ? "M" : undefined;
    const pick =
      movingExpanded.find((mc) => mc.kind === fixedConn.kind && (want === undefined || mc.gender === want)) ??
      movingExpanded.find((mc) => (want === undefined ? true : mc.gender === want));
    if (!pick) return `REJECTED: ${input.part} has no compatible connector — call list_connectors("part:${input.part}").`;
    movingSnap = connectorAsSnap(pick);
  }

  if (session.inventory) {
    const key = `${input.part}:${input.color}`;
    const left = session.inventory[key] ?? 0;
    if (left <= 0) return `REJECTED: no ${key} left in inventory.`;
    session.inventory[key] = left - 1;
  }

  // Fit check against the WHOLE build: the seat walk clears the candidate
  // against every existing part (mate partner allowed its engagement zone).
  const wholeBuildOverlap = (candidate: import("../data/schemas").PlacedPartJson): number => {
    let total = 0;
    for (let i = 0; i < session.parts.length; i++) {
      const o = pairOverlap(session.parts[i], candidate, session.meta, getVoxels());
      // Joint partner may overlap in its engagement zone (≤480 LDU³ at 2 LDU).
      total += i === input.to ? Math.max(0, o - 60) : o;
    }
    return total;
  };
  const placed =
    input.slide === undefined
      ? solveAttachmentSeated(
          fixed,
          fixedSnap,
          input.part,
          movingSnap,
          input.color,
          hOf,
          wholeBuildOverlap,
          input.roll ?? 0,
          input.flip ?? false,
        )
      : solveAttachment(
          fixed,
          fixedSnap,
          input.part,
          movingSnap,
          input.color,
          hOf,
          input.slide,
          input.roll ?? 0,
          input.flip ?? false,
        );
  session.parts.push(placed);
  const newIdx = session.parts.length - 1;
  const refund = () => {
    if (session.inventory) {
      const key = `${input.part}:${input.color}`;
      session.inventory[key] = (session.inventory[key] ?? 0) + 1;
    }
  };

  // "Attached" must mean JOINTED: verify the mate actually formed (the seat
  // walk is bounded, but belt-and-suspenders — a pose that cleared collisions
  // without engaging the connector is not an attachment).
  const jointFormed = validateConnections(session.parts, session.meta, getConnections()).joints.some(
    (j) => (j.a === input.to && j.b === newIdx) || (j.a === newIdx && j.b === input.to),
  );
  if (!jointFormed) {
    session.parts.pop();
    refund();
    return `CAN'T FIT: no pose of ${input.part} on connector #${input.toConnector} engages the joint — the connector's mouth is blocked, or the mating genders are incompatible.${
      ["4624", "3641", "6014b", "42610", "55981"].includes(input.part)
        ? " Wheels need ~20 LDU of clearance around the pin: build WHEELS FIRST (holder on the ground, wheels on, body on top) — retrofitting wheels under a finished body rarely fits."
        : " Pick a different connector or part."
    }`;
  }

  // HARD fit check via the VALIDATED collision checker — the SAME function
  // inspect_build reports, so attach and inspect always agree. Legal
  // engagement (stud-in-antistud, pin-in-hole), INCLUDING a part that seats
  // across many studs of a big plate, is excused via engagement zones; only
  // true interpenetration blocks. (This replaces a raw voxel-overlap test
  // that miscounted multi-stud seating as a collision and rejected legitimate
  // placements — with an empty blocker list, because the over-count came from
  // the mate partner itself, which that loop skipped.)
  const clashes = input.force
    ? []
    : checkCollisionsValidated(session.parts, session.meta, getVoxels(), getConnections()).filter((cc) => cc.a === newIdx || cc.b === newIdx);
  if (clashes.length) {
    session.parts.pop();
    refund();
    const blockers = clashes.slice(0, 4).map((cc) => {
      const o = cc.a === newIdx ? cc.b : cc.a;
      return `[${o}] ${session.parts[o].part}`;
    });
    return `CAN'T FIT: ${input.part} on index ${input.to} connector #${input.toConnector} truly interpenetrates ${blockers.join(", ")} — that space is already occupied. Use a different connector/location, or clear it (raise or narrow the body, add clearance).`;
  }

  const box = partBBox(placed, session.meta);
  const warn =
    box[2] < -0.5
      ? ` ⚠ the part extends BELOW the ground plane (y ${Math.round(box[2])}) — you probably picked the wrong connector or need flip=true; remove it and retry.`
      : "";
  return `ATTACHED ${input.part} (color ${input.color}) onto index ${input.to} connector #${input.toConnector} → new index ${newIdx}, bbox y ${Math.round(box[2])}–${Math.round(box[3])}.${warn} If it looks flipped, retry with flip=true; use slide/roll to adjust along/about the joint axis.`;
}

export interface ChainLink {
  part: string;
  color: number;
}

/**
 * Attach a CHAIN atomically: link 1 mates onto the given connector of a
 * placed part; each next link mates onto the previous link (auto-picked
 * compatible connectors). The whole chain is fit-checked against the
 * build — if ANY link can't fit, nothing is placed. This is how a wheel
 * and its tire go on together: if the tire would hit the body, the wheel
 * doesn't go on either.
 */
export function attachChain(
  session: BuildSession,
  to: number,
  toConnector: number,
  links: ChainLink[],
): string {
  if (links.length === 0) return "REJECTED: empty chain.";
  const checkpoint = session.parts.length;
  const inventoryBackup = session.inventory ? { ...session.inventory } : null;
  const placedDesc: string[] = [];
  let anchor = to;
  let anchorConn = toConnector;
  for (const [step, link] of links.entries()) {
    const result = attachPart(session, {
      to: anchor,
      toConnector: anchorConn,
      part: link.part,
      color: link.color,
    });
    if (result.startsWith("CAN'T FIT") || result.startsWith("REJECTED")) {
      // Roll back the whole chain.
      session.parts.length = checkpoint;
      if (inventoryBackup) session.inventory = inventoryBackup;
      return `CHAIN REJECTED at link ${step + 1} (${link.part}): ${result} Nothing was placed — the earlier links were rolled back too.`;
    }
    placedDesc.push(`${link.part}→#${session.parts.length - 1}`);
    // Next link mates onto the part just placed; pick its first unused
    // male connector of a NEW family if possible, else first connector.
    anchor = session.parts.length - 1;
    const expanded = expandedConnectors(link.part, getConnections());
    let next = expanded.findIndex((ec) => ec.gender === "M" && ec.kind === "gen");
    if (next === -1) next = expanded.findIndex((ec) => ec.gender === "M");
    if (next === -1) next = 0;
    anchorConn = next;
  }
  return `CHAIN ATTACHED: ${placedDesc.join(" → ")} — all links fit-checked as a unit.`;
}

/** Drop the whole build so its lowest point rests on the ground (y=0). */
export function settleBuild(session: BuildSession): string {
  if (session.parts.length === 0) return "Nothing to settle.";
  let minY = Infinity;
  for (const p of session.parts) {
    if (!session.meta[p.part]) continue;
    minY = Math.min(minY, partBBox(p, session.meta)[2]);
  }
  if (!isFinite(minY) || Math.abs(minY) < 0.01) return "Build already rests on the ground.";
  for (const p of session.parts) p.y -= minY;
  return `Settled: shifted ${session.parts.length} parts by ${-Math.round(minY * 10) / 10} LDU — lowest point now on the ground.`;
}
