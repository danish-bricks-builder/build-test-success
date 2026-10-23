/**
 * MATE PROGRAMMING — a tiny build language for copilot--.
 *
 * Instead of driving tools call-by-call, the model authors the WHOLE build
 * as a program of named mate statements, runs it, and reads a compiler-style
 * listing (per-line verdicts + engine verify). Editing the program IS
 * editing the build: delete a line to remove a part, reorder to restage,
 * rerun from empty every time (deterministic, like the set decompiler's
 * replayer).
 *
 * Grammar (one statement per line, # comments, blank lines ok):
 *
 *   anchor <name> <part> <color> at <x> <z> [rot <0|90|180|270>]
 *   on     <name> <part> <color> onto <base> [dx <n>] [dz <n>] [rot <r>]
 *   attach <name> <part> <color> onto <base>.C<k> [pconn <k>] [flip] [slide <n>] [roll <n>] [force]
 *   seat   <name> <part> <color> onto <base> [conn <k>] [option <n>]
 *   module <mname> = <name1> <name2> ...
 *   stamp  <mname> at <x> <z> [rot <r>]
 *   mirror <mname> at <x>
 *   raw     <name> <part> <color> at <x> <y> <z> [m r0 r1 … r8]    absolute LDraw pose (decompiler residue)
 *   catalog <name> <part> <color> onto <base> idx <k>              the k-th enumerated seating of the pair (exact replay)
 *   submodel <name> <file.ldr> <color> at <x> <y> <z> [m r0 … r8]  a sibling source file placed as one part
 *   settle
 *
 * <name> binds the placed part for later statements. seat = ranked catalog
 * seating (attach_options) committing option <n> (default 1). Distances in
 * studs; C<k> is 1-based like list_connectors output.
 */
import { anchorPart, placeOnStuds, defineModuleFrom, stampModule } from "./connect2";
import { attachPart, settleBuild } from "./connect";
import { attachOption, attachOptions, mirrorStamp } from "./spatial";
import { toPlaced, type MatePlacement } from "../rules/enumerate";
import { ldrawFrameOf } from "../engine/snapAlign";
import { compose, transpose, mulMV, type Frame, type V3 } from "../editor2/kinematics";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const enumCache = new Map<string, MatePlacement[]>();
/** Enumerated seatings of an (unordered, lexicographic) part pair from the census cache. */
function loadEnumCache(p1: string, p2: string): MatePlacement[] {
  const key = `${p1}__${p2}`;
  let hit = enumCache.get(key);
  if (!hit) {
    const path = join(process.cwd(), "public", "data", "census", "enum-cache", `${key}.json`);
    hit = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MatePlacement[]) : [];
    enumCache.set(key, hit);
  }
  return hit;
}
const invFrame = (f: Frame): Frame => {
  const rt = transpose(f.r);
  return { o: mulMV(rt, f.o).map((v) => -v) as V3, r: rt };
};
import type { BuildSession } from "./state";

interface LineResult {
  n: number;
  src: string;
  ok: boolean;
  msg: string;
  why?: string[];
}

/** What a refused placement statement was trying to do — enough for a caller
 * to explain the refusal (see lib/copilot/diagnose.ts). Purely a reporting
 * hook: it runs only on failure and cannot change the build. */
export interface FailInfo {
  session: BuildSession;
  kw: string;
  baseIdx?: number;
  part?: string;
  dx?: number;
  dz?: number;
  rot?: 0 | 90 | 180 | 270;
  toConnector?: number;
  option?: number;
  msg: string;
}

export interface RunOpts {
  /** Extra lines to print under a refused statement. */
  diagnose?: (f: FailInfo) => string[];
}

const ROT = new Set([0, 90, 180, 270]);

/** Parse "key value" option pairs + bare flags from token list. */
function opts(tokens: string[], keys: string[], flags: string[] = []): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (flags.includes(t)) out[t] = true;
    else if (keys.includes(t)) {
      const v = Number(tokens[++i]);
      if (Number.isNaN(v)) throw new Error(`'${t}' needs a number, got "${tokens[i]}"`);
      out[t] = v;
    } else throw new Error(`unexpected token "${tokens[i]}"`);
  }
  return out;
}

function color(tok: string): number {
  const c = Number(tok.replace(/^c/i, ""));
  if (Number.isNaN(c)) throw new Error(`bad color "${tok}"`);
  return c;
}

function rotOf(o: Record<string, number | boolean>): 0 | 90 | 180 | 270 {
  const r = Number(o.rot ?? 0);
  if (!ROT.has(r)) throw new Error(`rot must be 0/90/180/270, got ${r}`);
  return r as 0 | 90 | 180 | 270;
}

/**
 * Execute a mate program against a session (caller passes a FRESH one —
 * a program is the whole build). Failed lines are skipped; later lines
 * that reference their names fail with "undefined ref". Returns the
 * compiler-style listing.
 */
export function runProgram(
  session: BuildSession,
  source: string,
  runOpts: RunOpts = {},
): { listing: string; ok: number; total: number } {
  const names = new Map<string, number>(); // part name → index
  const results: LineResult[] = [];
  const lines = source.split("\n");
  /** Filled in by the placement statements so a refusal can be explained. */
  let fail: Omit<FailInfo, "session" | "msg"> | null = null;
  const explain = (msg: string): string[] | undefined => {
    if (!runOpts.diagnose || !fail) return undefined;
    try {
      const lines = runOpts.diagnose({ ...fail, session, msg });
      return lines.length ? lines : undefined;
    } catch {
      return undefined; // a diagnosis is a courtesy; it never fails a build
    }
  };

  const bind = (name: string, before: number, msg: string): LineResult["ok"] => {
    // part-adding ops report success by growing the parts array
    if (session.parts.length > before) {
      names.set(name, session.parts.length - 1);
      return true;
    }
    void msg;
    return false;
  };
  const ref = (name: string): number => {
    const idx = names.get(name);
    if (idx == null) throw new Error(`undefined ref "${name}" (not bound, or its line failed)`);
    return idx;
  };

  lines.forEach((raw, i) => {
    const src = raw.replace(/#.*$/, "").trim();
    if (!src) return;
    const n = i + 1;
    // quoted tokens ("850 - forks.ldr") stay one token
    const tok = (src.match(/"[^"]*"|\S+/g) ?? []).map((s) => s.replace(/^"|"$/g, ""));
    const kw = tok[0].toLowerCase();
    const before = session.parts.length;
    try {
      let msg = "";
      let ok = true;
      switch (kw) {
        case "anchor": {
          // anchor <name> <part> <color> at <x> <z> [rot r]
          const [, name, part, col, at, x, z, ...rest] = tok;
          if (at?.toLowerCase() !== "at") throw new Error("expected: anchor <name> <part> <color> at <x> <z>");
          const o = opts(rest, ["rot"]);
          msg = anchorPart(session, { part, color: color(col), x_stud: Number(x), z_stud: Number(z), rot: rotOf(o) });
          ok = bind(name, before, msg);
          break;
        }
        case "on": {
          // on <name> <part> <color> onto <base> [dx n] [dz n] [rot r]
          const [, name, part, col, onto, base, ...rest] = tok;
          if (onto?.toLowerCase() !== "onto") throw new Error("expected: on <name> <part> <color> onto <base> …");
          const o = opts(rest, ["dx", "dz", "rot"]);
          const onIn = {
            part,
            color: color(col),
            onto: ref(base),
            dx_studs: Number(o.dx ?? 0),
            dz_studs: Number(o.dz ?? 0),
            rot: rotOf(o),
          };
          fail = { kw, baseIdx: onIn.onto, part, dx: onIn.dx_studs, dz: onIn.dz_studs, rot: onIn.rot };
          msg = placeOnStuds(session, onIn);
          ok = bind(name, before, msg);
          break;
        }
        case "attach": {
          // attach <name> <part> <color> onto <base>.C<k> [pconn k] [flip] [slide n] [roll n]
          const [, name, part, col, onto, baseConn, ...rest] = tok;
          if (onto?.toLowerCase() !== "onto") throw new Error("expected: attach <name> <part> <color> onto <base>.C<k> …");
          const m = baseConn?.match(/^(.+)\.c(\d+)$/i);
          if (!m) throw new Error(`expected <base>.C<k>, got "${baseConn}"`);
          const o = opts(rest, ["pconn", "slide", "roll"], ["flip", "force"]);
          fail = { kw, baseIdx: ref(m[1]), part, toConnector: Number(m[2]) - 1 };
          msg = attachPart(session, {
            to: ref(m[1]),
            toConnector: Number(m[2]) - 1,
            part,
            color: color(col),
            partConnector: o.pconn != null ? Number(o.pconn) - 1 : undefined,
            slide: o.slide as number | undefined,
            roll: o.roll as number | undefined,
            flip: Boolean(o.flip),
            force: Boolean(o.force),
          });
          ok = bind(name, before, msg);
          break;
        }
        case "seat": {
          // seat <name> <part> <color> onto <base> [conn k] [option n]
          const [, name, part, col, onto, base, ...rest] = tok;
          if (onto?.toLowerCase() !== "onto") throw new Error("expected: seat <name> <part> <color> onto <base> …");
          const o = opts(rest, ["conn", "option"]);
          fail = {
            kw,
            baseIdx: ref(base),
            part,
            toConnector: o.conn != null ? Number(o.conn) - 1 : undefined,
            option: Number(o.option ?? 1),
          };
          const listing = attachOptions(session, {
            part,
            to: ref(base),
            toConnector: o.conn != null ? Number(o.conn) - 1 : undefined,
            limit: Math.max(Number(o.option ?? 1), 8),
          });
          // No offer, no commit: attachOption would otherwise report "call
          // attach_options first", which is not why the seat failed.
          if (!/^#\d/m.test(listing)) {
            ok = false;
            msg = listing.split("\n")[0];
            break;
          }
          const commit = attachOption(session, { option: Number(o.option ?? 1), color: color(col) });
          ok = bind(name, before, commit);
          msg = ok ? commit : `${listing.split("\n")[0]} → ${commit}`;
          break;
        }
        case "module": {
          // module <mname> = <name1> <name2> ...
          const [, mname, ...rest] = tok;
          const members = rest.filter((t) => t !== "=");
          if (!members.length) throw new Error("expected: module <mname> = <name1> <name2> …");
          msg = defineModuleFrom(session, members.map(ref), mname);
          ok = session.modules?.has(mname) ?? false;
          break;
        }
        case "stamp": {
          // stamp <mname> at <x> <z> [rot r]
          const [, mname, at, x, z, ...rest] = tok;
          if (at?.toLowerCase() !== "at") throw new Error("expected: stamp <mname> at <x> <z>");
          const o = opts(rest, ["rot"]);
          msg = stampModule(session, mname, Number(x), Number(z), rotOf(o));
          ok = session.parts.length > before;
          break;
        }
        case "mirror": {
          // mirror <mname> at <x>
          const [, mname, at, x, ...rest] = tok;
          if (at?.toLowerCase() !== "at" || rest.length) throw new Error("expected: mirror <mname> at <x>");
          msg = mirrorStamp(session, { name: mname, at_stud: Number(x) });
          ok = session.parts.length > before;
          break;
        }
        case "raw":
        case "submodel": {
          // raw <name> <part> <color> at <x> <y> <z> [m r0 … r8]  — LDraw frame, verbatim
          // submodel <name> <file> <color> at … — same, the "part" is a sibling source file
          const [, name, part, col, at, x, y, z, ...rest] = tok;
          if (at?.toLowerCase() !== "at") throw new Error(`expected: ${kw} <name> <part> <color> at <x> <y> <z> [m r0 … r8]`);
          if (kw === "raw" && !session.meta[part]) throw new Error(`unknown part ${part}`);
          let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
          const mi = rest.findIndex((s) => s.toLowerCase() === "m");
          if (mi >= 0) {
            r = rest.slice(mi + 1, mi + 10).map(Number);
            if (r.length !== 9 || r.some((v) => !Number.isFinite(v))) throw new Error("m needs nine numbers");
          }
          session.parts.push(toPlaced(part, { o: [Number(x), Number(y), Number(z)], r }, color(col)));
          msg = `placed ${part} verbatim as [${session.parts.length - 1}]`;
          ok = bind(name, before, msg);
          break;
        }
        case "catalog": {
          // catalog <name> <part> <color> onto <base> idx <k> — replay enumerated seating k
          // of the (lexicographic) pair; exact by construction, as the decompiler wrote it
          const [, name, part, col, onto, base, idxKw, k] = tok;
          if (onto?.toLowerCase() !== "onto" || idxKw?.toLowerCase() !== "idx") throw new Error("expected: catalog <name> <part> <color> onto <base> idx <k>");
          const bi = ref(base);
          const bp = session.parts[bi];
          const [p1, p2] = [bp.part, part].sort();
          const placements = loadEnumCache(p1, p2);
          const pl = placements[Number(k)];
          if (!pl) throw new Error(`no catalog seating ${k} for ${p1}__${p2}`);
          const hOf = (pp: string) => session.meta[pp]?.h ?? 24;
          const bf = ldrawFrameOf(bp, hOf) as Frame;
          // A = p1 sits at identity, B = p2 at pl.frame. Base is A when its part is p1
          // (ties: same part number → base is A, matching the decompiler).
          const baseIsA = bp.part === p1;
          const world = baseIsA ? compose(bf, pl.frame) : compose(bf, invFrame(pl.frame));
          session.parts.push(toPlaced(part, world, color(col)));
          msg = `placed ${part} as [${session.parts.length - 1}] · catalog ${p1}__${p2} #${k} ${pl.label ?? ""}`;
          ok = bind(name, before, msg);
          break;
        }
        case "settle": {
          msg = settleBuild(session);
          break;
        }
        default:
          throw new Error(`unknown statement "${kw}"`);
      }
      const short = msg.split("\n")[0];
      results.push({ n, src, ok, msg: short, why: ok ? undefined : explain(short) });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      results.push({ n, src, ok: false, msg: m, why: explain(m) });
    }
    fail = null;
  });

  const okCount = results.filter((r) => r.ok).length;
  const width = String(lines.length).length;
  const listing = results
    .map((r) => {
      const pad = " ".repeat(width + 5);
      return (
        `L${String(r.n).padStart(width)} ${r.ok ? "OK " : "ERR"} ${r.src}\n${pad}→ ${r.msg}` +
        (r.why?.length ? r.why.map((w) => `\n${pad}  ↳ ${w}`).join("") : "")
      );
    })
    .join("\n");
  return { listing, ok: okCount, total: results.length };
}
