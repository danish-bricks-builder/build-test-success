/**
 * `build_program` — the LOOP sandbox.
 *
 * Why it exists: the copilot's wall-clock is dominated by the model WRITING
 * TOKENS. A 132-brick wall authored one line per brick is ~1,500–3,000 output
 * tokens (20–40 s at Sonnet speeds) for a structure a five-line loop
 * describes exactly. `run_connect_script` already ran JavaScript, but its
 * surface (anchor/on/attach/log) is thin enough that the model kept unrolling
 * its loops by hand; this tool gives the whole connect vocabulary — including
 * modules, mirroring and settling — plus refs, so a program can express the
 * repetition instead of enumerating it.
 *
 * Everything here is a thin wrapper over the SAME functions the individual
 * tools call (connect2.anchorPart / placeOnStuds / defineModuleFrom /
 * stampModule, connect.attachPart / settleBuild, spatial.attachOptions /
 * attachOption / mirrorStamp). No placement path is duplicated, so every
 * placement is fit-checked, engagement-checked and inventory-checked exactly
 * as it is when the model calls the tool by hand — illegal placements are
 * refused with the same reason strings.
 *
 * SANDBOX. The program runs in QuickJS (quickjs-emscripten), a WASM
 * interpreter with its own heap and an EMPTY global object: there is no
 * require, no import, no process, no fs, no fetch, no timers and no handle on
 * the outer session — only the functions installed below, plus the ECMAScript
 * built-ins (Math, Array, JSON…). That is a stronger guarantee than
 * `node:vm`, which shares the host realm and leaks back to it through
 * constructor chains. Three further limits bound a program: source length
 * ({@link MAX_PROGRAM_CHARS}), placement attempts ({@link MAX_PLACEMENTS})
 * and CPU time ({@link MAX_PROGRAM_MS}, enforced by an interrupt handler, so
 * `while(true){}` dies too).
 *
 * Server-side only (connector library + QuickJS).
 */
import { getQuickJS } from "quickjs-emscripten";
import { checkSoundness } from "../engine/soundness";
import { partBBox } from "../engine/geometry";
import { attachPart, jointEdges, settleBuild } from "./connect";
import { anchorPart, defineModuleFrom, placeOnStuds, stampModule } from "./connect2";
import { cheapAbove, diagnose, type FailureCtx } from "./diagnose";
import { attachOption, attachOptions, mirrorStamp } from "./spatial";
import type { BuildSession } from "./state";

/** Placement ATTEMPTS one program may make (rejections count too, so a loop
 * that only ever gets refused still terminates). */
export const MAX_PLACEMENTS = 800;
/** CPU budget for one program. */
export const MAX_PROGRAM_MS = 2000;
/** Source-length cap — a program longer than this is the token cost the tool
 * exists to avoid. */
export const MAX_PROGRAM_CHARS = 8192;
/** Distinct rejection SHAPES kept for the report (see `family`). */
const MAX_KEPT_REJECTIONS = 25;
/** Distinct rejection reasons quoted in the one-line summary. */
const SUMMARY_REJECTIONS = 3;
/** log() lines kept. */
const MAX_LOGS = 20;
/** Distinct rejection reasons that get a full diagnosis. A program with 30
 * refusals must not answer with 30 diagnoses: the reasons collapse to a
 * handful of shapes, and three worked examples teach the shape. */
const DIAGNOSED_REASONS = 3;
/** Lines of diagnosis printed per reason (REAL REASON + WHAT WORKS + options). */
const DIAGNOSIS_LINES = 4;
/** Wall-clock budget for the whole diagnosis pass. It re-asks the engine
 * (enumerateMates, collision checks), so it is bounded like any other probe. */
const DIAGNOSIS_MS = 6000;


/**
 * Evaluated inside the sandbox before every program: the region vocabulary.
 *
 * These are the three things that separated a sound, symmetric building from
 * a pile of bricks when this was done by hand:
 *   · running bond — the engine bonds parts that STACK (face to face, half a
 *     stud of overlap); a course laid with its seams above the seams below is
 *     a row of independent columns, which is where "N separate structures"
 *     comes from;
 *   · mirroring — a rectangle that straddles x=0 is tiled outward from the
 *     centre and each piece copied to its mirror image, so the halves match
 *     by construction;
 *   · landing — every piece is placed on the part actually under it
 *     (topAt), so a course never floats over a cell that is lower than the
 *     rest.
 */
const PRELUDE = `
var KITS = {
  plates: ["3028","3036","3035","3032","3031","3795","3020","3022","3710","3023","3024"],
  bricks: ["3001","3002","3003","3010","3622","3004","3005"],
  tiles:  ["6636","87079","2431","3069b","3070b"]
};
function _sz(p){ var s = size(p); return { w: s[0], l: s[1], h: s[2] }; }
/** Place one part with its lower-left cell at (x,z); lands on whatever is under it. */
function put(part, color, x, z, rot){
  rot = rot || 0;
  var s = _sz(part);
  var w = rot === 90 ? s.l : s.w, l = rot === 90 ? s.w : s.l;
  var cx = x + w / 2, cz = z + l / 2;
  var best = null;
  for (var a = 0; a < w; a++) for (var b = 0; b < l; b++){
    var t = topAt(x + a, z + b);
    if (t[0] >= 0 && (!best || t[1] > best[1])) best = t;
  }
  if (!best) {
    // The ground is only free if nothing is standing on this footprint.
    for (var a2 = 0; a2 < w; a2++) for (var b2 = 0; b2 < l; b2++){
      if (topAt(x + a2, z + b2)[4] > 0.6) return -1;   // occupied above: do not bury a part under it
    }
    return anchor(part, color, cx, cz, rot);
  }
  return on(part, color, best[0], cx - best[2], cz - best[3], rot);
}
/** True when every cell of a rectangle presents the same top face. */
function flat(x, z, w, l){
  var y = null;
  for (var i = x; i < x + w; i++) for (var j = z; j < z + l; j++){
    var t = topAt(i, j)[1];
    if (y === null) y = t; else if (Math.abs(t - y) > 0.6) return false;
  }
  return true;
}
/**
 * fill(x, z, w, l, color, opts) — a solid rectangle, one course deep.
 * opts: { kit:"plates"|"bricks"|"tiles", bond:0|1, mirror:true }
 * Rectangles that straddle x=0 are tiled from the centre out and mirrored.
 */
function fill(x, z, w, l, color, opts){
  opts = opts || {};
  var kit = KITS[opts.kit || "bricks"] || KITS.bricks;
  var bond = opts.bond ? 1 : 0;
  var mirror = opts.mirror === false ? false : (x < 0 && x + w > 0);
  var done = {};
  // Cells this course must LEAVE EMPTY — doorways, windows, arches. Marking
  // them as already-taken is all it takes: fits()/pick() route around them,
  // so the course is laid with a hole in it instead of being carved later.
  var skip = opts.skip || [];
  for (var s0 = 0; s0 < skip.length; s0++){
    var r0 = skip[s0];
    for (var a0 = 0; a0 < r0[2]; a0++) for (var b0 = 0; b0 < r0[3]; b0++) done[(r0[0]+a0)+","+(r0[1]+b0)] = 1;
  }
  var mark = function(p, rot, at, j){
    var s = _sz(p), pw = rot === 90 ? s.l : s.w, pl = rot === 90 ? s.w : s.l;
    for (var a = 0; a < pw; a++) for (var b = 0; b < pl; b++) done[(at+a)+","+(j+b)] = 1;
  };
  var fits = function(p, rot, at, j){
    var s = _sz(p), pw = rot === 90 ? s.l : s.w, pl = rot === 90 ? s.w : s.l;
    if (at < x || at + pw > x + w || j + pl > z + l) return false;
    for (var a = 0; a < pw; a++) for (var b = 0; b < pl; b++) if (done[(at+a)+","+(j+b)]) return false;
    return true;
  };
  var pick = function(at, j){
    for (var k = 0; k < kit.length; k++) for (var r = 0; r < 2; r++){
      var rot = r ? 90 : 0;
      if (fits(kit[k], rot, at, j)) return { p: kit[k], rot: rot, w: (rot === 90 ? _sz(kit[k]).l : _sz(kit[k]).w) };
    }
    return null;
  };
  var lay = function(p, rot, at, j){ put(p, color, at, j, rot); mark(p, rot, at, j); };
  for (var j = z; j < z + l; j++){
    if (mirror){
      var want = bond ? 4 : 2, cAt = -Math.floor(want / 2), edge = 0;
      var c = pick(cAt, j);
      if (c) { lay(c.p, c.rot, cAt, j); edge = cAt + c.w; }
      var guard = 0;
      while (edge < x + w && guard++ < 64){
        var p = pick(edge, j);
        if (!p) break;
        lay(p.p, p.rot, edge, j);
        var m = -(edge + p.w);
        if (fits(p.p, p.rot, m, j)) lay(p.p, p.rot, m, j);
        edge += p.w;
      }
    } else {
      var i = x, g2 = 0;
      if (bond && w > 2){ var stub = pick(i, j); if (stub){ lay(stub.p, stub.rot, i, j); i += 1; } }
      while (i < x + w && g2++ < 80){
        if (done[i+","+j]) { i++; continue; }
        var q = pick(i, j);
        if (!q) { i++; continue; }
        lay(q.p, q.rot, i, j);
        i += q.w;
      }
    }
    // anything the mirror could not reach
    for (var i2 = x; i2 < x + w; i2++){
      if (done[i2+","+j]) continue;
      var r2 = pick(i2, j);
      if (r2) lay(r2.p, r2.rot, i2, j);
    }
  }
}
/** Bricks that can bridge an opening: longest first, 1xN for thin walls, 2xN for t>=2. */
var LINTELS_1 = ["3008","3009","3010","3622","3004","3005"];
var LINTELS_2 = ["3007","2456","3001","3002","3003"];
/** _lintel(span, depth) — the SHORTEST brick that spans that many studs at that thickness. */
function _lintel(span, depth){
  var list = depth >= 2 ? LINTELS_2 : LINTELS_1, best = null;
  for (var i = 0; i < list.length; i++){
    var s = _sz(list[i]), long = Math.max(s.w, s.l), thick = Math.min(s.w, s.l);
    if (long >= span && thick >= depth && (!best || long < best.long)) best = { p: list[i], long: long };
  }
  return best;
}
/** ring(x, z, w, l, t, color, opts) — four walls, hollow inside. */
function ring(x, z, w, l, t, color, opts){
  t = t || 2;
  fill(x, z, w, t, color, opts);
  fill(x, z + l - t, w, t, color, opts);
  fill(x, z + t, t, l - 2 * t, color, opts);
  fill(x + w - t, z + t, t, l - 2 * t, color, opts);
}
/** walls(x, z, w, l, t, color, courses, opts) — a ring, N courses tall, in running bond. */
function walls(x, z, w, l, t, color, courses, opts){
  opts = opts || {};
  var ops = opts.openings || [];
  for (var c = 0; c < courses; c++){
    var col = typeof color === "function" ? color(c) : color;
    var skip = [], lintels = [];
    for (var i = 0; i < ops.length; i++){
      var o = ops[i];
      var side = o.side || "front", ow = o.w || 2, at = o.at || 0;
      var from = o.from || 0, h = o.h || 1;
      // Sides are named for the CAMERA: "front" is the wall the default view
      // (and silhouette front) shows, so a door asked for at the front is a
      // door you can see. Compass names still work, for older programs.
      if (side === "north") side = "front"; else if (side === "south") side = "back";
      else if (side === "east") side = "right"; else if (side === "west") side = "left";
      var horiz = (side === "front" || side === "back");
      var start = Math.round((horiz ? x + w / 2 : z + l / 2) + at - ow / 2);
      var rect, lx, lz, lrot;
      if (side === "back"){ rect = [start, z, ow, t];               lx = start - 1; lz = z;             lrot = 0;  }
      else if (side === "front"){ rect = [start, z + l - t, ow, t]; lx = start - 1; lz = z + l - t;     lrot = 0;  }
      else if (side === "left"){ rect = [x, start, t, ow];          lx = x;         lz = start - 1;     lrot = 90; }
      else { rect = [x + w - t, start, t, ow];                      lx = x + w - t; lz = start - 1;     lrot = 90; }
      if (c >= from && c < from + h) skip.push(rect);
      else if (c === from + h) lintels.push({ span: ow + 2, x: lx, z: lz, rot: lrot, depth: t });
    }
    // The course straight above an opening is bridged FIRST: a brick laid by
    // the ordinary fill could land entirely over the void and float.
    for (var k = 0; k < lintels.length; k++){
      var L = lintels[k], pick2 = _lintel(L.span, L.depth);
      if (!pick2) continue;
      put(pick2.p, col, L.x, L.z, L.rot);
      skip.push([L.x, L.z, L.rot === 90 ? L.depth : pick2.long, L.rot === 90 ? pick2.long : L.depth]);
    }
    ring(x, z, w, l, t, col, { kit: opts.kit, bond: c % 2, mirror: opts.mirror, skip: skip });
  }
}
/** stack(x, z, part, color, n) — n of the same part, one on top of the other. */
function stack(x, z, part, color, n){ for (var i = 0; i < n; i++) put(part, color, x, z); }
/** colonnade(xs, z, part, color, n) — a row of columns, each n parts tall. */
function colonnade(xs, z, part, color, n){ for (var i = 0; i < xs.length; i++) stack(xs[i], z, part, color, n); }
/** row(count, pitch) — centred x positions for "count" columns at "pitch" studs apart. */
function row(count, pitch){
  var out = [], span = (count - 1) * pitch;
  for (var i = 0; i < count; i++) out.push(Math.round(-span / 2 + i * pitch));
  return out;
}
`;

export interface BuildProgramResult {
  placed: number;
  rejected: number;
  /** Distinct rejection reasons, most frequent first, with counts. The top
   * few carry `why`: the engine's own account of what would have fitted. */
  rejections: { reason: string; count: number; why?: string[] }[];
  logs: string[];
  error: string | null;
  /** Parts in the build after the program ran. */
  parts: number;
  /** Separate grounded structures (null when not computed). */
  components: number | null;
  floating: number | null;
  capped: boolean;
  /** The compact line handed back to the model. */
  summary: string;
  /** The summary plus the diagnosed rejection block — what the model reads. */
  report: string;
  /** True when the program ran against a throwaway copy of the build. */
  dryRun: boolean;
}

/** A rejection reason without the specific coordinates, so 40 refusals of
 * the same shape collapse into one quoted line instead of forty. */
function shorten(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 150);
}

/**
 * The SHAPE of a refusal, used to group it.
 *
 * Every refusal names the exact statement that failed — "REJECTED 3001 on 0
 * (3001) at offset (40, 40): NO STUD ENGAGEMENT — …" — so grouping by the
 * whole string groups nothing: thirty refusals of one bad loop come back as
 * thirty distinct reasons. The engine's own explanation follows the first
 * colon and carries no coordinates, so that is the family; the full text of
 * the first member is kept as the worked example.
 */
function family(reason: string): string {
  const s = shorten(reason);
  const i = s.indexOf(": ");
  return i > 0 && i < 80 ? s.slice(i + 2) : s;
}

/** A throwaway build for `dry_run`: the program's placements land here and
 * are discarded, so a bad program costs one call instead of a rebuild. */
function sandboxOf(session: BuildSession): BuildSession {
  return {
    ...session,
    parts: session.parts.map((p) => ({ ...p })),
    inventory: session.inventory ? { ...session.inventory } : null,
    assemblies: new Map(session.assemblies),
    modules: session.modules ? new Map(session.modules) : undefined,
  };
}

export async function runBuildProgram(
  session: BuildSession,
  code: string,
  opts?: { strict?: boolean; dryRun?: boolean },
): Promise<BuildProgramResult> {
  const strict = !!opts?.strict;
  const dryRun = !!opts?.dryRun;
  // Everything below runs against `session`; in dry-run mode that is a
  // throwaway copy, so no line of the placement path knows the difference
  // and the report is the one the real run would produce.
  if (dryRun) session = sandboxOf(session);
  const logs: string[] = [];
  /** Refusals grouped by {@link family}: how many, one full example, and what
   * that example was trying to do — so the engine can be re-asked what would
   * have fitted instead (lib/copilot/diagnose.ts). */
  const groups = new Map<
    string,
    { example: string; count: number; ctx?: Omit<FailureCtx, "session" | "msg"> }
  >();
  let placed = 0;
  let rejected = 0;
  let attempts = 0;
  let capped = false;
  let error: string | null = null;

  /** The engine's account of the commonest refusals: what really blocked
   * them, and the seating that would have been accepted. Capped three ways —
   * reasons, lines per reason, wall clock — so a 30-rejection program answers
   * with a paragraph, not a wall of text. */
  const explainTop = (
    distinct: { reason: string; count: number; why?: string[] }[],
  ): void => {
    const until = Date.now() + DIAGNOSIS_MS;
    const cheap = cheapAbove(session);
    for (const [i, r] of distinct.slice(0, DIAGNOSED_REASONS).entries()) {
      if (i > 0 && Date.now() > until) break;
      const ctx = groups.get(family(r.reason))?.ctx;
      if (!ctx) continue;
      try {
        const why = diagnose({ ...ctx, session, msg: r.reason, cheap });
        if (why.length) r.why = why.slice(0, DIAGNOSIS_LINES).map((l) => l.slice(0, 220));
      } catch {
        /* a diagnosis is a courtesy; it never fails a program */
      }
    }
  };

  const finish = (): BuildProgramResult => {
    const distinct: { reason: string; count: number; why?: string[] }[] = [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .map((g) => ({ reason: g.example, count: g.count }));
    if (distinct.length) explainTop(distinct);
    // A structural read for free: the model's next question after a big
    // program is always "is it one thing, and is any of it floating?".
    let components: number | null = null;
    let floating: number | null = null;
    if (session.parts.length > 0 && session.parts.length <= 1500) {
      try {
        const sound = checkSoundness(session.parts, session.meta, jointEdges(session));
        components = sound.components;
        floating = sound.floating.length;
      } catch {
        /* structural read is a bonus, never a failure mode */
      }
    }
    const bits = [`placed ${placed}`];
    if (rejected > 0) {
      const quoted = distinct
        .slice(0, SUMMARY_REJECTIONS)
        .map((r) => `"${r.reason}"${r.count > 1 ? ` ×${r.count}` : ""}`)
        .join(", ");
      bits.push(`rejected ${rejected} (first: ${quoted})`);
    }
    bits.push(`build now ${session.parts.length} part${session.parts.length === 1 ? "" : "s"}`);
    if (components !== null)
      bits.push(`${components} separate grounded structure${components === 1 ? "" : "s"}`);
    if (floating) bits.push(`⚠ ${floating} floating`);
    if (capped) bits.push(`⚠ stopped at the ${MAX_PLACEMENTS}-placement cap`);
    if (error) bits.push(`⚠ program error: ${error}`);
    if (logs.length) bits.push(`logs: ${logs.join(" | ")}`);
    const summary = (dryRun ? "DRY RUN (nothing was placed — the build is unchanged) · " : "") + bits.join(" · ");

    // A refusal the model cannot act on is a wasted round-trip. Print, under
    // the summary, the engine's own answer to "what should I have written?".
    const explained = distinct.filter((r) => r.why?.length);
    const detail = explained.length
      ? [
          "",
          "WHY THOSE WERE REFUSED (top reasons — the rest are the same shapes):",
          ...explained.flatMap((r) => [
            `  ×${r.count} ${r.reason}`,
            ...(r.why ?? []).map((l) => `    ${l}`),
          ]),
          distinct.length > explained.length
            ? `  (${distinct.length - explained.length} further reason${distinct.length - explained.length === 1 ? "" : "s"} not diagnosed)`
            : "",
          "Repair these placements — do NOT remove what is already standing.",
        ]
          .filter((l) => l !== "")
          .join("\n")
      : "";

    // MEASURED: given dry_run, a model will happily dry-run 36 programs and
    // commit three — it reads "placed 87" and moves on. The instruction has to
    // be in the RESULT, not only in the tool description.
    const nextStep = dryRun
      ? placed > 0
        ? `\n⚠ NOTHING WAS PLACED. The build still has ${session.parts.length} part${session.parts.length === 1 ? "" : "s"}. ` +
          `To commit these ${placed} placement${placed === 1 ? "" : "s"}, send the SAME program again WITHOUT dry_run.`
        : `\n⚠ NOTHING WAS PLACED, and this program would place nothing${
            rejected === 0
              ? " — and nothing was refused either, so the program never reached a placement. Check the loop bounds and that every helper call is inside it; log() a count to see."
              : ""
          }. Fix it, then send it without dry_run.`
      : "";

    return {
      placed,
      rejected,
      rejections: distinct,
      logs,
      error,
      parts: session.parts.length,
      components,
      floating,
      capped,
      summary,
      report: summary + (detail ? `\n${detail}` : "") + nextStep,
      dryRun,
    };
  };

  if (!code.trim()) {
    error = "empty program";
    return finish();
  }
  if (code.length > MAX_PROGRAM_CHARS) {
    error = `program is ${code.length} characters, over the ${MAX_PROGRAM_CHARS} cap — express the repetition as a loop instead of listing placements`;
    return finish();
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  const deadline = Date.now() + MAX_PROGRAM_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();

  /** Thrown out of a wrapper in strict mode; carries the refusal reason. */
  class Refused extends Error {}

  /** Record one placement op's result string; returns the new ref or -1.
   * `what` is the statement that was refused — kept for the diagnosis pass,
   * which runs after the program, never inside it (re-asking the engine costs
   * far more than the 2 s the sandbox is allowed). */
  const record = (
    result: string,
    ok: boolean,
    what?: Omit<FailureCtx, "session" | "msg">,
  ): number => {
    if (ok) {
      placed++;
      return session.parts.length - 1;
    }
    rejected++;
    noteRejection(result, what);
    if (strict) throw new Refused(shorten(result));
    return -1;
  };

  /** Group one refusal by its shape, keeping the first full text as the
   * example and the statement that produced it for the diagnosis pass. */
  function noteRejection(result: string, what?: Omit<FailureCtx, "session" | "msg">): void {
    const key = family(result);
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (!g.ctx && what) g.ctx = what;
    } else if (groups.size < MAX_KEPT_REJECTIONS) {
      groups.set(key, { example: shorten(result), count: 1, ctx: what });
    }
  }

  /** Budget guard shared by every placing op. */
  const budget = (n = 1): boolean => {
    if (attempts + n > MAX_PLACEMENTS) {
      capped = true;
      return false;
    }
    attempts += n;
    return true;
  };

  try {
    const num = (h: unknown): number => Number(vm.dump(h as never));
    const str = (h: unknown): string => String(vm.dump(h as never));
    const rot4 = (h: unknown): 0 | 90 | 180 | 270 =>
      (h ? (Number(vm.dump(h as never)) as 0 | 90 | 180 | 270) : 0);

    /** Install a sandbox function, mapping a thrown Refused to a VM throw. */
    const install = (
      name: string,
      arity: number,
      fn: (...handles: unknown[]) => unknown,
    ) => {
      void arity;
      const h = vm.newFunction(name, (...args) => {
        try {
          const out = fn(...(args as unknown[]));
          if (out === undefined || out === null) return vm.undefined;
          if (typeof out === "number") return vm.newNumber(out);
          if (typeof out === "boolean") return out ? vm.true : vm.false;
          if (typeof out === "string") return vm.newString(out);
          if (Array.isArray(out)) {
            const arr = vm.newArray();
            out.forEach((v, i) => {
              const el = vm.newNumber(Number(v));
              vm.setProp(arr, i, el);
              el.dispose();
            });
            return arr;
          }
          return vm.undefined;
        } catch (e) {
          if (e instanceof Refused) return { error: vm.newError(`REFUSED: ${e.message}`) };
          throw e;
        }
      });
      vm.setProp(vm.global, name, h);
      h.dispose();
    };

    // ── placement ops ────────────────────────────────────────────────
    install("anchor", 5, (partH, colorH, xH, zH, rotH) => {
      if (!budget()) return -1;
      const r = anchorPart(session, {
        part: str(partH),
        color: num(colorH),
        x_stud: num(xH),
        z_stud: num(zH),
        rot: rot4(rotH),
      });
      return record(r, r.startsWith("OK"));
    });

    install("on", 6, (partH, colorH, baseH, dxH, dzH, rotH) => {
      if (!budget()) return -1;
      const part = str(partH);
      const onto = num(baseH);
      const dx = dxH === undefined ? 0 : num(dxH);
      const dz = dzH === undefined ? 0 : num(dzH);
      const rot = rot4(rotH);
      const r = placeOnStuds(session, { part, color: num(colorH), onto, dx_studs: dx, dz_studs: dz, rot });
      return record(r, r.startsWith("OK"), { kw: "on", baseIdx: onto, part, dx, dz, rot });
    });

    install("attach", 5, (partH, colorH, baseH, connH, optsH) => {
      if (!budget()) return -1;
      const o = optsH
        ? (vm.dump(optsH as never) as { flip?: boolean; slide?: number; roll?: number } | null)
        : null;
      const part = str(partH);
      const to = num(baseH);
      const toConnector = num(connH);
      const r = attachPart(session, {
        part,
        color: num(colorH),
        to,
        toConnector,
        flip: o?.flip,
        slide: o?.slide,
        roll: o?.roll,
      });
      return record(r, r.startsWith("ATTACHED"), { kw: "attach", baseIdx: to, part, toConnector });
    });

    install("seat", 4, (partH, colorH, baseH, optsH) => {
      if (!budget()) return -1;
      const o = optsH ? (vm.dump(optsH as never) as { conn?: number; option?: number } | null) : null;
      const part = str(partH);
      const to = num(baseH);
      const listed = attachOptions(session, {
        part,
        to,
        toConnector: o?.conn,
        limit: Math.max(1, o?.option ?? 1),
      });
      const what = {
        kw: "seat",
        baseIdx: to,
        part,
        toConnector: o?.conn,
        option: o?.option ?? 1,
      };
      if (!/^\d+ collision-free seating/.test(listed)) return record(listed, false, what);
      const r = attachOption(session, { option: o?.option ?? 1, color: num(colorH) });
      return record(r, r.startsWith("placed"), what);
    });

    // ── reuse ────────────────────────────────────────────────────────
    install("module", 2, (nameH, refsH) => {
      const refs = (vm.dump(refsH as never) as unknown[]) ?? [];
      const r = defineModuleFrom(session, refs.map(Number), str(nameH));
      const ok = !r.startsWith("REJECTED");
      if (!ok) {
        rejected++;
        noteRejection(r);
        if (strict) throw new Refused(shorten(r));
      }
      return ok;
    });

    install("stamp", 4, (nameH, xH, zH, rotH) => {
      const before = session.parts.length;
      const size = session.modules?.get(str(nameH))?.parts.length ?? 1;
      if (!budget(size)) return [];
      const r = stampModule(session, str(nameH), num(xH), num(zH), rot4(rotH));
      if (!r.startsWith("STAMPED")) {
        record(r, false);
        return [];
      }
      placed += session.parts.length - before;
      return Array.from({ length: session.parts.length - before }, (_, i) => before + i);
    });

    install("mirror", 2, (nameH, xH) => {
      const before = session.parts.length;
      const size = session.modules?.get(str(nameH))?.parts.length ?? 1;
      if (!budget(size)) return [];
      const r = mirrorStamp(session, { name: str(nameH), at_stud: num(xH) });
      if (!r.startsWith("mirrored")) {
        record(r, false);
        return [];
      }
      placed += session.parts.length - before;
      return Array.from({ length: session.parts.length - before }, (_, i) => before + i);
    });

    // ── surveying: what is already there ─────────────────────────────
    // The region helpers in the prelude are written against these two, so
    // they work over parts placed by earlier programs and by hand, not just
    // the ones this program laid.
    install("topAt", 2, (xH, zH) => {
      const x = num(xH) * 20 + 10;   // centre of stud cell (x,z)
      const z = num(zH) * 20 + 10;
      // Two numbers, and the difference matters: the highest STUDDED face a
      // part can be stacked on (ref + its top), and how high the cell is
      // occupied at all — including oriented/SNOT parts, which have no studs
      // to seat on but are certainly in the way. Ignoring the second is how a
      // helper ends up anchoring a plate on the ground UNDER something that is
      // already standing there.
      let bestRef = -1, bestTop = 0, cx = 0, cz = 0, occupied = 0;
      session.parts.forEach((p, i) => {
        const b = partBBox(p, session.meta);
        if (x < b[0] || x > b[1] || z < b[4] || z > b[5]) return;
        if (b[3] > occupied) occupied = b[3];
        if (p.m) return;                                   // oriented: no stud floor
        if (bestRef === -1 || b[3] > bestTop) {
          bestRef = i;
          bestTop = b[3];
          cx = p.x / 20;
          cz = p.z / 20;
        }
      });
      return [bestRef, bestTop, cx, cz, occupied];
    });

    install("size", 1, (partH) => {
      const m = session.meta[str(partH)];
      return m ? [m.w, m.l, m.h] : [0, 0, 0];
    });

    // ── read / housekeeping ──────────────────────────────────────────
    install("settle", 0, () => settleBuild(session));
    install("count", 0, () => session.parts.length);
    install("log", 1, (msgH) => {
      if (logs.length < MAX_LOGS) logs.push(str(msgH).slice(0, 160));
      return undefined;
    });

    // ── the region prelude ───────────────────────────────────────────
    // Whole walls, decks, rings and colonnades, so a program says WHAT to
    // build instead of enumerating every brick. Three rules are baked in
    // because the engine enforces them and models reliably forget:
    // running bond (parts bond by STACKING, never side by side), mirroring
    // about the centre line, and landing each piece on the part that is
    // actually under it.
    const preludeResult = vm.evalCode(PRELUDE);
    if (preludeResult.error) preludeResult.error.dispose();
    else preludeResult.value.dispose();

    const result = vm.evalCode(code);
    if (result.error) {
      const e = vm.dump(result.error) as { name?: string; message?: string };
      const msg = `${e?.name ?? "Error"}: ${e?.message ?? "program failed"}`;
      // A strict-mode refusal is not a bug in the program — it is the
      // placement the model asked to be told about, loudly.
      error = /^Error: REFUSED: /.test(msg) ? msg.replace(/^Error: /, "") : msg;
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

  return finish();
}
