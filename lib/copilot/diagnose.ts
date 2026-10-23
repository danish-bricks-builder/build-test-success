/**
 * WHY A PLACEMENT WAS REFUSED — and what would have worked.
 *
 * A refusal is only useful if it names the real obstacle. The compiler's own
 * messages are single-sentence guesses written from inside one algorithm:
 * `placeOnStuds` fails whenever its seat walk finds no stud joint and then
 * says "the target's top has no studs there" — even when the target is a 2x10
 * plate covered in studs and the REAL reason is that the mover's underside is
 * stepped (6081's sockets sit at y=16 and y=32, so it cannot rest flat).
 *
 * This module answers the question the model actually has — what do I write
 * instead? — by re-asking the engine, never by re-implementing it:
 *
 *   - the shape facts come from lib/copilot/partdoc, the same connector table
 *     `./dbb connectors` prints,
 *   - "would this fit at all?" is the SAME placeOnStuds, replayed against a
 *     lone base, which separates a shape problem from a collision,
 *   - "what would mate here?" is attachOptions / enumerateMates — the
 *     catalogue search `seat` itself runs — so every option number printed is
 *     the number `seat` will accept,
 *   - "which part is in the way?" is checkCollisionsValidated, the collision
 *     check that refused the placement.
 *
 * Every suggestion is therefore reproducible by the reader: same call, same
 * tables. Where nothing can be established, nothing is printed.
 */
import { ldrawFrameOf } from "../engine/snapAlign";
import { checkCollisionsValidated } from "../engine/voxelCollision";
import { compose, type Frame } from "../editor2/kinematics";
import { enumerateMates, toPlaced } from "../rules/enumerate";
import { placeOnStuds } from "./connect2";
import { attachOptions } from "./spatial";
import { getConnections, getVoxels } from "./connect";
import { describeConnectors, shapeNotes } from "./partdoc";
import type { BuildSession } from "./state";
import type { PlacedPartJson } from "../data/schemas";

/** A throwaway copy: diagnosis must never leave a part in the real build. */
const clone = (s: BuildSession, parts = s.parts): BuildSession => ({
  ...s,
  parts: parts.map((p) => ({ ...p })),
  inventory: null,
});

/** Parts of the build a candidate at this pose interpenetrates. */
function blockers(session: BuildSession, cand: PlacedPartJson, ignore = -1): string[] {
  const all = [...session.parts, cand];
  const i = all.length - 1;
  const hits = checkCollisionsValidated(all, session.meta, getVoxels(), getConnections()).filter(
    (c) => c.a === i || c.b === i,
  );
  return [...new Set(hits.map((c) => (c.a === i ? c.b : c.a)))]
    .filter((k) => k !== ignore)
    .map((k) => `[${k}] ${session.parts[k].part}`);
}

/** Offsets near (dx,dz) at which `on` DOES succeed against the whole build. */
function freeOffsets(
  session: BuildSession,
  baseIdx: number,
  part: string,
  dx: number,
  dz: number,
  rot: 0 | 90 | 180 | 270,
  want = 3,
): string[] {
  if (session.parts.length > 40) return []; // a sweep over a big build is not worth the seconds
  const ring: [number, number][] = [];
  for (let ox = -5; ox <= 5; ox++) for (let oz = -5; oz <= 5; oz++) if (ox || oz) ring.push([ox, oz]);
  // nearest first, and only as many probes as a refusal is worth
  ring.sort((a, b) => Math.max(...a.map(Math.abs)) - Math.max(...b.map(Math.abs)) || (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
  const hits: string[] = [];
  for (const [ox, oz] of ring.slice(0, 60)) {
    if (hits.length >= want) break;
    const c = clone(session);
    if (placeOnStuds(c, { part, color: 0, onto: baseIdx, dx_studs: dx + ox, dz_studs: dz + oz, rot }).startsWith("OK"))
      hits.push(`dx ${dx + ox} dz ${dz + oz}`);
  }
  return hits;
}

/**
 * The `seat` option list, exactly as `seat` will number it: attachOptions on
 * a copy of the REAL build, so collision-filtered options are already gone.
 */
function seatOptions(session: BuildSession, baseIdx: number, part: string, n = 3): string[] {
  const c = clone(session);
  const listing = attachOptions(c, { part, to: baseIdx, limit: 8 });
  const opts = listing.split("\n").filter((l) => l.startsWith("#"));
  if (!opts.length) return [];
  return opts.slice(0, n).map((l) => l.replace(/^#(\d+)\s*/, (_, k) => `option ${k}  `));
}

/** Base connectors that have at least one legal seating of `part`. */
function acceptingConnectors(session: BuildSession, baseIdx: number, part: string): string {
  const base = session.parts[baseIdx];
  const { placements } = enumerateMates(base.part, part, getConnections(), {
    meta: session.meta,
    vox: getVoxels(),
  });
  if (!placements.length) return "";
  const docs = describeConnectors(base.part);
  const byConn = new Map<number, string>();
  for (const p of placements) if (!byConn.has(p.aConn)) byConn.set(p.aConn, p.label);
  // A 2x4 brick has eight identical stud sockets; printing the label eight
  // times spends the whole line on one word. Group by what the connector IS.
  const byLabel = new Map<string, number[]>();
  for (const [k, label] of byConn) {
    const name = docs[k]?.label ?? label;
    if (!byLabel.has(name)) byLabel.set(name, []);
    byLabel.get(name)!.push(k + 1);
  }
  return [...byLabel.entries()]
    .slice(0, 4)
    .map(([name, ks]) => {
      const shown = ks.slice(0, 6).map((k) => `C${k}`).join(", ");
      return `${name} — ${base.part}.${shown}${ks.length > 6 ? ` (+${ks.length - 6} more)` : ""}`;
    })
    .join("; ");
}

export interface FailureCtx {
  session: BuildSession;
  /** Statement keyword: on / attach / seat. */
  kw: string;
  /** Resolved base index, when the statement named one that exists. */
  baseIdx?: number;
  part?: string;
  dx?: number;
  dz?: number;
  rot?: 0 | 90 | 180 | 270;
  /** attach / seat: 0-based base connector index. */
  toConnector?: number;
  /** seat: the option asked for. */
  option?: number;
  /** The compiler's own refusal. */
  msg: string;
  /**
   * Skip the numbered-seating search on a build too big to afford it.
   *
   * MEASURED: `attachOptions` collision-checks each catalogue candidate by
   * re-running the WHOLE build's validated collision pass — validateConnections
   * over every part, then voxels — so a 184-seating pair against a 574-part
   * build is 184 whole-build passes. One such diagnosis took 316 s of a 250 s
   * turn. Everything else here (the solo replay, enumerateMates, the connector
   * tables) is bounded by the two PARTS, not by the build, and stays on.
   *
   * Set by {@link cheapAbove}; the answer loses the option numbers and keeps
   * the reason plus the connectors that do accept the part.
   */
  cheap?: boolean;
}

/** Above this many parts, a diagnosis drops the numbered-seating search (see
 * {@link FailureCtx.cheap}). Below it, the search's early exit keeps it quick. */
export const DIAGNOSIS_CHEAP_ABOVE = 60;

/** Whether a diagnosis of this build must run in cheap mode. */
export const cheapAbove = (session: BuildSession): boolean =>
  session.parts.length > DIAGNOSIS_CHEAP_ABOVE;

/**
 * Extra lines to print under a refused statement. Returns [] when there is
 * nothing to add beyond what the compiler already said (an unknown part, a
 * syntax error, an unbound name): a guess is worse than silence.
 */
export function diagnose(ctx: FailureCtx): string[] {
  const { session, kw, baseIdx, part } = ctx;
  if (baseIdx == null || part == null) return [];
  const base = session.parts[baseIdx];
  if (!base || !session.meta[part] || !session.meta[base.part]) return [];
  const out: string[] = [];

  if (kw === "on") return onFailure(ctx, base, baseIdx, part, out);
  if (kw === "attach") return attachFailure(ctx, base, baseIdx, part, out);
  if (kw === "seat") return seatFailure(ctx, base, baseIdx, part, out);
  return [];
}

function onFailure(
  ctx: FailureCtx,
  base: PlacedPartJson,
  baseIdx: number,
  part: string,
  out: string[],
): string[] {
  const { session } = ctx;
  const dx = ctx.dx ?? 0;
  const dz = ctx.dz ?? 0;
  const rot = ctx.rot ?? 0;
  const baseNotes = shapeNotes(base.part, session.meta);
  const partNotes = shapeNotes(part, session.meta);

  // Replay the SAME seat search against a lone base: if it works there, the
  // shapes are fine and the build is what refused it.
  const solo = clone(session, [base]);
  const soloOk = placeOnStuds(solo, { part, color: 0, onto: 0, dx_studs: dx, dz_studs: dz, rot }).startsWith("OK");
  if (soloOk) {
    const who = blockers(session, solo.parts[1], baseIdx);
    out.push(
      `REAL REASON: ${part} seats on [${baseIdx}] ${base.part} at this offset when nothing else is there — it is blocked by ` +
        `${who.length ? who.join(", ") : "another part of the build"}.`,
    );
    const free = freeOffsets(session, baseIdx, part, dx, dz, rot);
    if (free.length) out.push(`WHAT WORKS: the same statement at ${free.join(", or ")}.`);
    return out;
  }

  if (!baseNotes.hasTopStuds)
    out.push(`REAL REASON: [${baseIdx}] ${base.part} has no studs on its top face — nothing can be \`on\`-stacked onto it.`);
  else if (partNotes.socketYs.length > 1)
    out.push(
      `REAL REASON: ${part}'s underside is stepped — stud sockets at y=${partNotes.socketYs.join(" and y=")}, not one flat plane. ` +
        `\`on\` drops a part onto the target's stud plane and has no way to sit a two-level underside.`,
    );
  else if (!partNotes.hasBottomSockets)
    out.push(`REAL REASON: ${part} has nothing on its underside to receive a stud — it cannot be stud-stacked at all.`);
  else {
    const bm = session.meta[base.part];
    const pm = session.meta[part];
    out.push(
      `REAL REASON: at offset (${dx}, ${dz}) no stud of [${baseIdx}] ${base.part} (${bm.w}x${bm.l}) lands under a socket of ` +
        `${part} (${pm.w}x${pm.l}) — the footprints miss each other on the stud lattice.`,
    );
  }

  const seats = ctx.cheap ? [] : seatOptions(session, baseIdx, part);
  if (seats.length) {
    out.push(`WHAT WORKS: \`seat <name> ${part} <colour> onto <base> option <n>\` —`);
    for (const s of seats) out.push(`  ${s}`);
    return out;
  }
  if (ctx.cheap) {
    // Catalogue-only, so the cost is set by the two parts, not by the build.
    const accept = acceptingConnectors(session, baseIdx, part);
    out.push(
      accept
        ? `WHAT WORKS: ${part} mates with these connectors of ${base.part}: ${accept}. Seat it there instead of stacking it \`on\`.`
        : `No legal seating of ${part} onto ${base.part} is in the catalogue: these two parts do not mate.`,
    );
    return out;
  }
  const free = freeOffsets(session, baseIdx, part, dx, dz, rot);
  if (free.length) out.push(`WHAT WORKS: \`on\` at ${free.join(", or ")}.`);
  else out.push(`No legal seating of ${part} onto ${base.part} is in the catalogue: these two parts do not mate.`);
  return out;
}

function attachFailure(
  ctx: FailureCtx,
  base: PlacedPartJson,
  baseIdx: number,
  part: string,
  out: string[],
): string[] {
  const { session } = ctx;
  const k = ctx.toConnector ?? 0;
  const baseDocs = describeConnectors(base.part);
  const d = baseDocs[k];
  if (!d) {
    out.push(`${base.part} has ${baseDocs.length} connectors (C1–C${baseDocs.length}) — run \`./dbb connectors ${base.part}\`.`);
    return out;
  }
  out.push(
    `${base.part}.C${k + 1} is a ${d.label} at ${d.c.local.map((v) => Math.round(v * 10) / 10).join(",")} · ${d.axisWords}.`,
  );
  const kinds = [...new Set(describeConnectors(part).map((p) => p.label))];
  out.push(`${part} carries: ${kinds.join(", ") || "no connectors at all"}.`);

  const viaThis = enumerateMates(base.part, part, getConnections(), {
    meta: session.meta,
    vox: getVoxels(),
    aIndices: [k],
  }).placements;
  if (viaThis.length) {
    out.push(
      `REAL REASON: ${part} does mate on C${k + 1} (${viaThis.length} legal seating${viaThis.length === 1 ? "" : "s"}), ` +
        `but not at the pose \`attach\` solved for. Name the part's own connector with \`pconn\`, or turn it round with \`flip\`/\`roll\`/\`slide\`.`,
    );
    out.push(`WHAT WORKS: \`seat <name> ${part} <colour> onto <base> conn ${k + 1} option 1\` (${viaThis[0].label} ${viaThis[0].kind} · ${viaThis[0].via}).`);
    return out;
  }
  out.push(`REAL REASON: no connector of ${part} mates with a ${d.label}.`);
  const accept = acceptingConnectors(session, baseIdx, part);
  if (accept) out.push(`CONNECTORS OF ${base.part} THAT DO ACCEPT ${part}: ${accept}.`);
  else out.push(`${base.part} and ${part} have no legal mate anywhere — pick a different part.`);
  return out;
}

function seatFailure(
  ctx: FailureCtx,
  base: PlacedPartJson,
  baseIdx: number,
  part: string,
  out: string[],
): string[] {
  const { session } = ctx;
  const conns = getConnections();
  const vox = getVoxels();
  const all = enumerateMates(base.part, part, conns, { meta: session.meta, vox });
  if (!all.placements.length) {
    out.push(`REAL REASON: ${base.part} and ${part} have no legal mate in the catalogue at all.`);
    return out;
  }
  if (ctx.toConnector != null) {
    const viaThis = enumerateMates(base.part, part, conns, {
      meta: session.meta,
      vox,
      aIndices: [ctx.toConnector],
    }).placements;
    if (!viaThis.length) {
      const d = describeConnectors(base.part)[ctx.toConnector];
      out.push(
        `REAL REASON: ${base.part}.C${ctx.toConnector + 1}${d ? ` (${d.label})` : ""} takes nothing on ${part}.`,
      );
      const accept = acceptingConnectors(session, baseIdx, part);
      if (accept) out.push(`CONNECTORS OF ${base.part} THAT DO ACCEPT ${part}: ${accept}.`);
      return out;
    }
  }
  if (ctx.cheap) {
    // Both remaining answers below re-check the whole build per candidate;
    // on a build this size that is minutes. Say what the catalogue says.
    const accept = acceptingConnectors(session, baseIdx, part);
    out.push(
      `${all.placements.length} catalogue seating${all.placements.length === 1 ? "" : "s"} of ${part} onto ${base.part} exist` +
        (accept ? `, on ${accept}` : "") +
        `; the one you asked for is not collision-free here. Try another connector, or clear the space.`,
    );
    return out;
  }
  const opts = seatOptions(session, baseIdx, part, 4);
  if (opts.length) {
    out.push(
      `${all.placements.length} catalogue seating${all.placements.length === 1 ? "" : "s"} exist; ` +
        `${ctx.option != null ? `option ${ctx.option} is not among the collision-free ones. ` : ""}These are:`,
    );
    for (const o of opts) out.push(`  ${o}`);
    return out;
  }
  // Every seating collides: say with what.
  const hOf = (p: string) => session.meta[p]?.h ?? 24;
  const tFrame = ldrawFrameOf(base, hOf) as Frame;
  const who = new Set<string>();
  for (const pl of all.placements.slice(0, 32)) {
    for (const b of blockers(session, toPlaced(part, compose(tFrame, pl.frame), 4), baseIdx)) who.add(b);
  }
  out.push(
    `REAL REASON: all ${all.placements.length} catalogue seatings of ${part} onto ${base.part} collide with the build` +
      `${who.size ? ` — ${[...who].slice(0, 5).join(", ")} in the way` : ""}. Clear space, or seat it on a different part.`,
  );
  return out;
}
