/**
 * Design operations — the same functions behind the API routes and the
 * `dbb` CLI, so a design folder on disk can be worked on from VS Code /
 * Claude Code exactly as from the website:
 *
 *   decompileProgramText(ldraw)  build/x.ldr → src/x.mate   (connection language)
 *   decompileKinText(ldraw)      build/x.ldr → kin/x.kin    (bodies & joints)
 *   compileProgramText(source)   src/x.mate  → build/x.ldr  (MATE interpreter)
 *
 * Part names p1…pN are the build-order indices, shared by all three files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromLdr } from "@/lib/ldraw/serialize";
import { ldrawFrameOf } from "@/lib/engine/snapAlign";
import { detectMates, inferJoints } from "@/lib/editor2/mates";
import { compose, connFrame, expandedConnectors, orthonormalize, type E2Part, type Frame } from "@/lib/editor2/kinematics";
import { createMatcher } from "@/lib/rules/match";
import { getConnections, getVoxels } from "@/lib/copilot/connect";
import { loadStatic } from "@/lib/copilot/staticData";
import { runProgram } from "@/lib/copilot/mateprog";
import type { BuildSession } from "@/lib/copilot/state";

const pub = (p: string) => join(process.cwd(), "public", p);
const rT = (r: number[]) => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
const mulMV = (r: number[], v: number[]) => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
const mulMM = (a: number[], b: number[]) => {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
};

export async function decompileProgramText(ldraw: string, name = "design"): Promise<{ program: string; tiers: Record<string, number>; parts: number }> {
  {
    const a = await analyze(ldraw, 5000);
    const lines = [`# ${name} — decompiled connection program`, `# ${a.parts.length} parts · ${Object.entries(a.tiers).map(([k, v]) => `${k} ${v}`).join(" · ")}`, ""];
    const nameOf = (i: number) => `p${i + 1}`;
    for (const w of a.walk) {
      const f = a.frames.get(w.id)!;
      const n = (x: number) => Math.round(x * 1000) / 1000;
      const cat = w.catalog as { idx?: number | null; aConn?: number; label?: string; via?: string | null; exact?: boolean } | null;
      const isSub = /\.(ldr|mpd)$/i.test(w.part);
      if (isSub) {
        lines.push(`submodel ${nameOf(w.id)} "${w.part}" ${w.color} at ${f.o.map(n).join(" ")} m ${f.r.map(n).join(" ")}`);
      } else if (w.tier === "catalog" && w.base != null && cat && cat.idx != null && cat.exact) {
        lines.push(`catalog ${nameOf(w.id)} ${w.part} ${w.color} onto ${nameOf(w.base)} idx ${cat.idx}   # ${cat.label ?? ""}${cat.via ? ` · ${cat.via}` : ""}`);
      } else {
        const why =
          w.tier === "anchor" ? "anchor"
          : w.tier === "catalog" && w.base != null && cat ? `≈ catalog ${cat.label ?? ""} onto ${nameOf(w.base)} idx ${cat.idx}, differs by spin/slide/symmetry`
          : w.tier === "contact" && w.base != null ? `touches ${nameOf(w.base)} — no catalog seating`
          : "no earlier mate";
        lines.push(`raw ${nameOf(w.id)} ${w.part} ${w.color} at ${f.o.map(n).join(" ")} m ${f.r.map(n).join(" ")}   # ${why}`);
      }
    }
    return { program: lines.join("\n") + "\n", tiers: a.tiers, parts: a.parts.length };
  }
}

export async function decompileKinText(ldraw: string, name = "design"): Promise<{ kin: string; bodies: number; joints: number }> {
  {
    const a = await analyze(ldraw, 5000);
    const nameOf = (i: number) => `p${i + 1}`;
    const inf = a.inferred;
    const n = (x: number) => Math.round(x * 100) / 100;
    const lines = [`# ${name} — bodies & joints (derived from the build; part names match src/)`, `# ${a.parts.length} parts · ${inf.clusters} bodies · ${inf.revolute} revolute pairs · ${inf.lockedJoints} pinned by loops`, ""];
    const bodyOf = new Map<number, number>();
    inf.clusterMembers.forEach((m, bi) => {
      m.forEach((id) => bodyOf.set(id, bi + 1));
      lines.push(`body B${bi + 1} = ${m.map(nameOf).join(" ")}`);
    });
    lines.push("");
    for (const j of inf.joints) {
      if (j.kind !== "revolute") continue;
      const pf = a.frames.get(j.parent.partId)!;
      const pc = a.connectorsOf(a.eparts[j.parent.partId].part)[j.parent.conn];
      if (!pc) continue;
      const w = compose(pf, connFrame(pc));
      const ax = mulMV(w.r, [0, 1, 0]);
      const pb = bodyOf.get(j.parent.partId) ?? 0, cb = bodyOf.get(j.child.partId) ?? 0;
      lines.push(`joint J${j.id} revolute B${pb}.${nameOf(j.parent.partId)}.C${j.parent.conn + 1} -> B${cb}.${nameOf(j.child.partId)}.C${j.child.conn + 1} axis ${ax.map(n).join(" ")} pivot ${w.o.map(n).join(" ")} angle ${j.angle ?? 0}${j.locked ? "   # pinned by a loop" : ""}`);
    }
    return { kin: lines.join("\n") + "\n", bodies: inf.clusters, joints: inf.revolute };
  }
}

/** Shared decompile analysis (parts, mates, pairs, per-part walk with catalog joins). */
export async function analyze(ldraw: string, limit: number) {
  const { meta } = await loadStatic(); // warms connections/voxels for the sync getters
  const conns = getConnections();
  const vox = getVoxels();
  const parts = fromLdr(ldraw, meta).parts.slice(0, limit);
  const hOf = (part: string) => meta[part]?.h ?? 24;
  const eparts: E2Part[] = parts.map((p, i) => {
    const f = ldrawFrameOf(p, hOf);
    return { id: i, part: p.part, color: p.color, root: { o: f.o as Frame["o"], r: orthonormalize(f.r) } };
  });
  const frames = new Map(eparts.map((p) => [p.id, p.root!]));
  const connectorsOf = (part: string) => expandedConnectors(part, conns);
  const mates = detectMates(eparts, frames, connectorsOf);
  const inferred = inferJoints(eparts, frames, connectorsOf, { current: eparts.length + 1 }, {});
  const matcher = createMatcher(conns, vox);
  const pairRows = inferred.pairs.map((pr) => ({ a: pr.a, b: pr.b, n: pr.n, kind: pr.kind, rule: pr.rule }));
  const pairsOf = new Map<number, typeof pairRows>();
  for (const pr of pairRows) {
    for (const idx of [pr.a, pr.b]) {
      if (!pairsOf.has(idx)) pairsOf.set(idx, []);
      pairsOf.get(idx)!.push(pr);
    }
  }
  const walk = eparts.map((p) => {
    const earlier = (pairsOf.get(p.id) ?? []).filter((pr) => (pr.a === p.id ? pr.b : pr.a) < p.id);
    if (!earlier.length)
      return { id: p.id, part: p.part, color: p.color, tier: p.id === 0 ? "anchor" : "pose" as string, base: null as number | null, contacts: 0, also: [] as number[], catalog: null as null | Record<string, unknown> };
    earlier.sort((x, y) => y.n - x.n || (x.a === p.id ? x.b : x.a) - (y.a === p.id ? y.b : y.a));
    const prim = earlier[0];
    const base = prim.a === p.id ? prim.b : prim.a;
    const also = earlier.slice(1).map((e) => (e.a === p.id ? e.b : e.a));
    const [p1, p2] = [eparts[base].part, p.part].sort();
    const inst1 = eparts[base].part === p1 ? base : p.id;
    const inst2 = inst1 === base ? p.id : base;
    const f1 = frames.get(inst1)!;
    const f2 = frames.get(inst2)!;
    const r1t = rT(f1.r);
    const relO = mulMV(r1t, [f2.o[0] - f1.o[0], f2.o[1] - f1.o[1], f2.o[2] - f1.o[2]]) as [number, number, number];
    const relR = mulMM(r1t, f2.r);
    const cachePath = pub(`data/census/enum-cache/${p1}__${p2}.json`);
    let catalog: Record<string, unknown> | null = null;
    let tier = "contact";
    if (existsSync(cachePath)) {
      const placements = JSON.parse(readFileSync(cachePath, "utf8"));
      const idxHit = matcher.matchPose(relO, relR, placements, p1, p2);
      if (idxHit >= 0) {
        const pl = placements[idxHit];
        tier = "catalog";
        // exact = the observed pose IS the catalogued one (≤1 LDU, ≤0.06 in the
        // rotation); otherwise it matched up to symmetry / spin / slide and a
        // replay of the bare index would land elsewhere
        const exact = pl.frame.o.every((v: number, i: number) => Math.abs(v - relO[i]) <= 1.01) && pl.frame.r.every((v: number, i: number) => Math.abs(v - relR[i]) <= 0.06);
        catalog = { pair: `${p1}__${p2}`, size: placements.length, idx: idxHit, via: pl.via ?? null, label: pl.label, aConn: pl.aConn, bConn: pl.bConn, inst1, exact };
      } else catalog = { pair: `${p1}__${p2}`, size: placements.length, idx: null };
    } else catalog = { pair: `${p1}__${p2}`, size: 0, idx: null };
    return { id: p.id, part: p.part, color: p.color, tier, base, contacts: prim.n, rule: prim.rule, also, relO: relO.map((v) => +v.toFixed(1)), catalog };
  });
  const tiers: Record<string, number> = {};
  for (const w of walk) {
    const c = w.catalog as { exact?: boolean } | null;
    const key = w.tier === "catalog" ? (c?.exact ? "catalog" : "catalog≈") : w.tier;
    tiers[key] = (tiers[key] ?? 0) + 1;
  }
  return { parts, eparts, frames, connectorsOf, mates, inferred, pairRows, walk, tiers, limit };
}


/** src/x.mate → build/x.ldr through the MATE interpreter on a fresh session. */
export async function compileProgramText(
  source: string,
  name = "main.ldr",
  /** Explain refused placements (lib/copilot/diagnose). Off by default: it
   * re-runs the seat search per failure, which the batch decompiler does not
   * want to pay for. */
  opts: { explain?: boolean } = {},
): Promise<{ ldraw: string; listing: string; ok: number; total: number; parts: number }> {
  const { meta } = await loadStatic();
  const session: BuildSession = { parts: [], inventory: null, meta, assemblies: new Map() };
  const diagnose = opts.explain ? (await import("@/lib/copilot/diagnose")).diagnose : undefined;
  const res = runProgram(session, source, { diagnose });
  const hOf = (p: string) => meta[p]?.h ?? 24;
  const n = (x: number) => Math.round(x * 1e4) / 1e4;
  const lines = [`0 ${name} — compiled from a MATE program`, `0 Name: ${name}`];
  for (const p of session.parts) {
    const f = ldrawFrameOf(p, hOf);
    lines.push(`1 ${p.color} ${f.o.map(n).join(" ")} ${f.r.map(n).join(" ")} ${p.part}.dat`);
  }
  return { ldraw: lines.join("\n") + "\n", listing: res.listing, ok: res.ok, total: res.total, parts: session.parts.length };
}
