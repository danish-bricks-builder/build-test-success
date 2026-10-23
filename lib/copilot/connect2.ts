/**
 * Copilot v2 — CONNECTION-FIRST building primitives.
 *
 * The v1 interface makes the model compute world coordinates and judges
 * connections after the fact; this module inverts that: placement is
 * expressed RELATIVE TO EXISTING PARTS and every placement must actually
 * ENGAGE (verified against the LDCad connector graph) or it is rejected
 * with a reason. Coordinates survive only for ANCHORS.
 *
 *   anchorPart    ground a part on the baseplate (the only coordinate op)
 *   placeOnStuds  seat a part on another part's studs, offset in studs,
 *                 snapped to the legal parity lattice, engagement-verified
 *   runConnectScript  QuickJS sandbox with LIVE anchor()/on()/attach() —
 *                 calls mutate the session immediately and return indices,
 *                 so scripts can chain placements
 *
 * Server-side only (connector library + QuickJS).
 */
import { getQuickJS } from "quickjs-emscripten";
import { gridParity, metaOf, partBBox } from "../engine/geometry";
import { STUD_PITCH } from "../engine/types";
import { validateConnections } from "../engine/connectionGraph";
import { checkCollisionsValidated } from "../engine/voxelCollision";
import type { PlacedPartJson } from "../data/schemas";
import { collides, placeParts, type BuildSession } from "./state";
import { attachPart, getConnections, getVoxels } from "./connect";
import { invKey } from "./types";

/* ══════════════════════════════════════════════════════════════════
   MODULES — the connect-mode reuse mechanism.

   v1's define_assembly stamps GRID placements the model authored by
   coordinates; useless in connect mode, where the good stuff (wheel
   corners with attached wheels) is BUILT via connections and carries
   matrix poses. A module is snapshotted FROM BUILT PARTS instead:
   build one wheel corner, snapshot it, stamp three more — identical by
   construction, fit-checked as a unit on every stamp.
   ══════════════════════════════════════════════════════════════════ */

export interface ModuleDef {
  /** Snapshot of the source parts, ABSOLUTE engine placements. */
  parts: PlacedPartJson[];
  /** Reference point (engine LDU): the first part's x/z — stamping
   * places this point at the requested stud position. */
  ref: { x: number; z: number };
}

/** Engine-vertical rotation as an LDraw 3×3 (θ_ldraw = −θ_engine). */
const ROT_L: Record<number, number[]> = {
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  90: [0, 0, -1, 0, 1, 0, 1, 0, 0],
  180: [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  270: [0, 0, 1, 0, 1, 0, -1, 0, 0],
};
const mulMM3 = (a: number[], b: number[]): number[] => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};

/** Snapshot the parts at `indices` as reusable module `name`. */
export function defineModuleFrom(session: BuildSession, indices: number[], name: string): string {
  if (!name) return "REJECTED: module needs a name.";
  const uniq = [...new Set(indices)].sort((a, b) => a - b);
  if (uniq.length === 0) return "REJECTED: give the part indices to snapshot (from inspect_build).";
  const bad = uniq.filter((i) => !session.parts[i]);
  if (bad.length) return `REJECTED: no parts at indices ${bad.join(", ")}.`;
  const parts = uniq.map((i) => ({ ...session.parts[i], m: session.parts[i].m ? [...session.parts[i].m!] : undefined }));
  const ref = { x: parts[0].x, z: parts[0].z };
  if (!session.modules) session.modules = new Map();
  session.modules.set(name, { parts, ref });
  return `module "${name}" snapshotted: ${parts.length} parts (reference at stud ${ref.x / STUD_PITCH}, ${ref.z / STUD_PITCH}). Stamp copies with stamp_module — heights are preserved, so a ground-level module stamps at ground level.`;
}

/** Stamp a module: reference point to (x_stud, z_stud), rotated about it. */
export function stampModule(
  session: BuildSession,
  name: string,
  xStud: number,
  zStud: number,
  rot: 0 | 90 | 180 | 270,
): string {
  const def = session.modules?.get(name);
  if (!def) {
    const have = session.modules ? [...session.modules.keys()].join(", ") : "";
    return `REJECTED: no module "${name}"${have ? ` — defined: ${have}` : " — snapshot one with define_module_from first"}.`;
  }
  // inventory: consume up front, refund on rejection
  if (session.inventory) {
    for (const p of def.parts) {
      const key = invKey(p.part, p.color);
      if ((session.inventory[key] ?? 0) <= 0) return `REJECTED: no ${key} left in inventory for the module.`;
      session.inventory[key]--;
    }
  }
  const refund = () => {
    if (!session.inventory) return;
    for (const p of def.parts) session.inventory[invKey(p.part, p.color)]++;
  };

  const R = ROT_L[rot] ?? ROT_L[0];
  const nx = xStud * STUD_PITCH;
  const nz = zStud * STUD_PITCH;
  const stamped: PlacedPartJson[] = def.parts.map((p) => {
    let dx = p.x - def.ref.x;
    let dz = p.z - def.ref.z;
    // engine-vertical rotation of the offset (matches grid-rot semantics)
    if (rot === 90) [dx, dz] = [dz, -dx];
    else if (rot === 180) [dx, dz] = [-dx, -dz];
    else if (rot === 270) [dx, dz] = [-dz, dx];
    const out: PlacedPartJson = {
      ...p,
      x: nx + dx,
      z: nz + dz,
      rot: ((((p.rot ?? 0) + rot) % 360) as PlacedPartJson["rot"]),
    };
    if (p.m) out.m = mulMM3(R, p.m);
    return out;
  });

  // fit-check the WHOLE stamp as a unit: collisions involving any new
  // part (validated checker — legal engagement excused) reject it all.
  const base = session.parts.length;
  session.parts.push(...stamped);
  const clashes = checkCollisionsValidated(session.parts, session.meta, getVoxels(), getConnections()).filter(
    (c) => c.a >= base || c.b >= base,
  );
  if (clashes.length) {
    session.parts.length = base;
    refund();
    const blockers = [...new Set(clashes.map((c) => (c.a >= base ? c.b : c.a)).filter((i) => i < base))]
      .slice(0, 4)
      .map((i) => `[${i}] ${session.parts[i].part}`);
    return `CAN'T FIT: module "${name}" at (${xStud}, ${zStud}) rot ${rot} collides with ${
      blockers.length ? blockers.join(", ") : "itself"
    } — pick a clear position.`;
  }
  return `STAMPED "${name}" at (${xStud}, ${zStud}) rot ${rot} → indices ${base}–${session.parts.length - 1}.`;
}

export interface PlaceOnInput {
  part: string;
  color: number;
  /** Index of the part to seat onto (must be a grid part). */
  onto: number;
  /** Offset from the TARGET's footprint center, in studs, world axes. */
  dx_studs?: number;
  dz_studs?: number;
  rot?: 0 | 90 | 180 | 270;
}

/** Seat `part` on top of part `onto`, stud-engaged or rejected. */
export function placeOnStuds(session: BuildSession, input: PlaceOnInput): string {
  const { part, color } = input;
  const meta = session.meta;
  const m = meta[part];
  if (!m) return `REJECTED ${part}: unknown part (search_parts to find valid numbers)`;
  const target = session.parts[input.onto];
  if (!target) return `REJECTED: no part at index ${input.onto} (inspect_build for indices)`;
  if (target.m)
    return `REJECTED: part ${input.onto} (${target.part}) is oriented (SNOT/attached) — use attach_part with its connectors instead`;
  if (session.inventory && (session.inventory[invKey(part, color)] ?? 0) <= 0)
    return `REJECTED ${part} color ${color}: not in remaining inventory`;

  const tBox = partBBox(target, meta);
  const rot = input.rot ?? 0;
  // Engagement is RELATIVE: the candidate must land on the TARGET's stud
  // lattice, not the absolute plate lattice. Legal offsets differ by a
  // half-stud when exactly one of the two footprints is odd on an axis.
  const [tpx, tpz] = gridParity(metaOf(target.part, meta), target.rot);
  const [cpx, cpz] = gridParity(metaOf(part, meta), rot);
  const snapRel = (targetOrigin: number, offsetLdu: number, relParity: number) => {
    const rel = ((relParity % STUD_PITCH) + STUD_PITCH) % STUD_PITCH; // 0 or 10
    return (
      targetOrigin + Math.round((offsetLdu - rel) / STUD_PITCH) * STUD_PITCH + rel
    );
  };
  const cx = snapRel(target.x, (input.dx_studs ?? 0) * STUD_PITCH, cpx - tpx);
  const cz = snapRel(target.z, (input.dz_studs ?? 0) * STUD_PITCH, cpz - tpz);

  // SEAT WALK + PARITY RESCUE. Two ways the meta bbox lies about a part:
  // geometry bulging ABOVE the stud plane (4600's pin bosses → box top 10,
  // studs at 8 → a box-rested candidate floats and never engages), and
  // protrusions widening the FOOTPRINT (4600's pins → w=3 → odd parity →
  // the snap shifts the candidate half a stud off the real lattice). The
  // connector graph is the truth, so search it: for each lattice phase
  // (as computed, then +half-stud in x/z/both) walk the seat DOWN from
  // the box top in 2-LDU steps and take the first pose that forms a real
  // stud joint. Refuse only when nothing engages anywhere.
  let cand: PlacedPartJson | null = null;
  // What ENGAGED, not how many joint kinds: validateConnections returns one
  // Joint per (pair, type) with a `count` of matched connector pairs, so a
  // 2x4 brick landing square on a plate is ONE joint of count 8. Reporting
  // "1 stud joint" for eight engaged studs told the model nothing about how
  // well the part was seated — a corner-overlap of one stud read the same.
  let engaged: { type: string; count: number }[] = [];
  let collidedAll = true;
  outer: for (const [px, pz] of [[0, 0], [10, 0], [0, 10], [10, 10]]) {
    for (const drop of [0, 2, 4, 6, 8, 10]) {
      const c: PlacedPartJson = { part, color, x: cx + px, z: cz + pz, y: tBox[3] - drop, rot };
      if (c.y < 0) break;
      if (collides(c, session.parts, meta)) continue;
      collidedAll = false;
      const v = validateConnections([target, c], meta, getConnections());
      if (v.joints.length > 0) {
        cand = c;
        engaged = v.joints.map((j) => ({ type: j.type, count: j.count }));
        break outer;
      }
    }
  }
  if (!cand) {
    if (collidedAll)
      return `REJECTED ${part} on ${input.onto} at offset (${input.dx_studs ?? 0}, ${input.dz_studs ?? 0}): collides with an existing part`;
    // Do NOT name a cause here: this branch is reached whenever the seat walk
    // found no stud joint, and the walk cannot tell a studless target from a
    // stepped underside from a missed offset. Guessing "the target's top has
    // no studs there" was wrong for every 6081 (a stepped brick) placed on a
    // plate covered in studs. lib/copilot/diagnose.ts establishes the cause.
    return (
      `REJECTED ${part} on ${input.onto} (${target.part}) at offset (${input.dx_studs ?? 0}, ${input.dz_studs ?? 0}): ` +
      `NO STUD ENGAGEMENT — no pose of ${part} over ${target.part} at this offset forms a stud joint.`
    );
  }
  session.parts.push(cand);
  if (session.inventory) {
    const key = invKey(part, color);
    session.inventory[key] = (session.inventory[key] ?? 0) - 1;
  }
  const engagedTxt = engaged
    .sort((a, b) => b.count - a.count)
    .map((e) => `${e.count} ${e.type}${e.count === 1 ? "" : "s"} engaged`)
    .join(" + ");
  return (
    `OK ${part} color ${color} seated on ${input.onto} → index ${session.parts.length - 1} ` +
    `(${engagedTxt || "engaged"}, world (${cand.x / 20}, ${cand.z / 20}) y=${cand.y})`
  );
}

/** Anchor: the only coordinate-based placement in v2 — for the FIRST part
 * of a structure (or a deliberately separate structure) on the baseplate. */
export function anchorPart(
  session: BuildSession,
  input: { part: string; color: number; x_stud: number; z_stud: number; rot?: 0 | 90 | 180 | 270 },
): string {
  const r = placeParts(session, [
    {
      part: input.part,
      color: input.color,
      x_stud: input.x_stud,
      z_stud: input.z_stud,
      rot: input.rot ?? 0,
    },
  ])[0];
  return r;
}

export interface ConnectScriptResult {
  ops: number;
  ok: number;
  logs: string[];
  rejections: string[];
  error: string | null;
}

const MAX_OPS = 1200;
const MAX_MS = 2000;

/**
 * Connection-first script sandbox. Unlike runPartsScript (collect then
 * apply), calls here execute LIVE against the session and return the new
 * part index (or -1 on rejection) — so scripts can chain: seat a course
 * on the previous course's bricks by index.
 */
export async function runConnectScript(
  session: BuildSession,
  code: string,
): Promise<ConnectScriptResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  const deadline = Date.now() + MAX_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();

  const logs: string[] = [];
  const rejections: string[] = [];
  let ops = 0;
  let ok = 0;
  let error: string | null = null;

  const record = (result: string): number => {
    ops++;
    if (result.startsWith("OK")) {
      ok++;
      return session.parts.length - 1; // the op just pushed this part
    }
    if (rejections.length < 20) rejections.push(result);
    return -1;
  };

  try {
    const anchorFn = vm.newFunction("anchor", (partH, colorH, xH, zH, rotH) => {
      if (ops >= MAX_OPS) return vm.newNumber(-1);
      const idx = record(
        anchorPart(session, {
          part: String(vm.dump(partH)),
          color: Number(vm.dump(colorH)),
          x_stud: Number(vm.dump(xH)),
          z_stud: Number(vm.dump(zH)),
          rot: (rotH ? Number(vm.dump(rotH)) : 0) as 0 | 90 | 180 | 270,
        }),
      );
      return vm.newNumber(idx);
    });
    vm.setProp(vm.global, "anchor", anchorFn);
    anchorFn.dispose();

    const onFn = vm.newFunction("on", (partH, colorH, ontoH, dxH, dzH, rotH) => {
      if (ops >= MAX_OPS) return vm.newNumber(-1);
      const idx = record(
        placeOnStuds(session, {
          part: String(vm.dump(partH)),
          color: Number(vm.dump(colorH)),
          onto: Number(vm.dump(ontoH)),
          dx_studs: dxH ? Number(vm.dump(dxH)) : 0,
          dz_studs: dzH ? Number(vm.dump(dzH)) : 0,
          rot: (rotH ? Number(vm.dump(rotH)) : 0) as 0 | 90 | 180 | 270,
        }),
      );
      return vm.newNumber(idx);
    });
    vm.setProp(vm.global, "on", onFn);
    onFn.dispose();

    const attachFn = vm.newFunction("attach", (partH, colorH, toH, connH, optsH) => {
      if (ops >= MAX_OPS) return vm.newNumber(-1);
      const opts = optsH ? (vm.dump(optsH) as { flip?: boolean; slide?: number; roll?: number } | null) : null;
      const out = attachPart(session, {
        part: String(vm.dump(partH)),
        color: Number(vm.dump(colorH)),
        to: Number(vm.dump(toH)),
        toConnector: Number(vm.dump(connH)),
        flip: opts?.flip,
        slide: opts?.slide,
        roll: opts?.roll,
      });
      const idx = record(out.startsWith("ATTACHED") ? `OK ${out} index ${session.parts.length - 1}` : out);
      return vm.newNumber(idx);
    });
    vm.setProp(vm.global, "attach", attachFn);
    attachFn.dispose();

    const logFn = vm.newFunction("log", (msgH) => {
      if (logs.length < 20) logs.push(String(vm.dump(msgH)));
    });
    vm.setProp(vm.global, "log", logFn);
    logFn.dispose();

    const result = vm.evalCode(code);
    if (result.error) {
      const e = vm.dump(result.error) as { name?: string; message?: string };
      error = `${e?.name ?? "Error"}: ${e?.message ?? "script failed"}`;
      result.error.dispose();
    } else {
      result.value.dispose();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    vm.dispose();
    runtime.dispose();
  }

  return { ops, ok, logs, rejections, error };
}
