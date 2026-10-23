/**
 * The environment conditions of the paper — env, env+gates, env+full — one session per call.
 * (The copilot harness of Danish Bricks Builder, scripts/agent/builder.ts, with paths changed.)
 *
 *   npx tsx env/server.ts                         # the environment, in another terminal
 *   npx tsx env/run.ts --task=tower-square --condition=verifier|bare|none [--eyes=on|off]
 *                      [--model=claude-opus-5] [--base=http://localhost:8788]
 *
 * condition=verifier  env+full:  the validator as tools the agent may call, plus the gates
 * condition=bare      env+gates: no tools; the validator runs when the agent declares completion
 * condition=none      env:       no tools and no gates — each placement is still checked as it is made
 *
 * The session is recorded by the server under sessions/<runId>/; the final build and its grade
 * land in runs/<runId>.json + .ldr, the same shape as the paper's records/. See conditions.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// Long single API calls (big seeds, monumental builds) can go >5 min
// between SSE events; undici's default body timeout kills the stream.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Agent, setGlobalDispatcher } = require("undici");
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
import { join } from "node:path";
import { fromLdr } from "../lib/ldraw/serialize";
import { verifyBuild } from "../lib/engine/verify";
import { validateConnections } from "../lib/engine/connectionGraph";
import { checkStability } from "../lib/engine/stability";
import { getConnections, getVoxels } from "../lib/copilot/connect";
import { parseLdraw } from "../lib/doc/parse";
import { flattenProject } from "../lib/doc/flatten";
import { orthonormalize } from "../lib/editor2/kinematics";
import { expandedConnectors } from "../lib/engine/connectionGraph";
import { inferJoints } from "../lib/editor2/mates";
import type { E2Part, Frame } from "../lib/editor2/kinematics";

const opt = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;

const BASE = opt("base", "http://localhost:8788");
const model = opt("model", "claude-opus-5");
const condition = opt("condition", "verifier");
const eyes = opt("eyes", "on") !== "off";
const taskId = opt("task", "tower-square");

interface Task {
  id: string;
  type?: "build" | "edit" | "inventory";
  set?: string;
  prompt: string;
  post: {
    minParts: number;
    minHeightLdu?: number;
    maxFootprintStuds?: [number, number];
    /** edit tasks: fraction of the ORIGINAL parts that must survive unmoved */
    minPreserved?: number;
    /** vehicle tasks: minimum parts whose catalog NAME matches the regex */
    partNames?: { match: string; min: number }[];
    /** kinematic tasks: minimum UNLOCKED revolute joints (inferred) */
    minMovableJoints?: number;
  };
}

async function runOnce() {
  const started = Date.now();
  const { tasks } = JSON.parse(readFileSync("tasks.json", "utf8")) as { tasks: Task[] };
  const prompt = opt("prompt", "");
  // a free prompt (try-it-yourself runs): no requirements beyond validity and stability
  const task: Task | undefined = prompt
    ? { id: opt("runId", `prompt_${Date.now().toString(36)}`), type: "build", prompt, post: { minParts: 1 } }
    : tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId} — have: ${tasks.map((t) => t.id).join(", ")}`);
  const cond = `${condition}${eyes ? "" : "-noeyes"}`;
  const runId = prompt ? task.id : `build-${task.id}_${cond}_${Date.now().toString(36)}`;

  // edit tasks: seed the session with the official set, loaded as-is
  let seedLdr: string | undefined;
  let originalPoses: Set<string> | null = null;
  const meta = JSON.parse(readFileSync(join("public", "data", "parts", "meta.json"), "utf8"));
  let inventory: Record<string, number> | null = null;
  if (task.type === "inventory") {
    const inv = JSON.parse(readFileSync(join("public", "data", "inv", `${task.set}.json`), "utf8")) as {
      parts: { p: string; c: number; q: number; spare: boolean }[];
    };
    inventory = {};
    for (const r of inv.parts) if (!r.spare) inventory[`${r.p}:${r.c}`] = (inventory[`${r.p}:${r.c}`] ?? 0) + r.q;
  }
  if (task.type === "edit") {
    const omrIndex = JSON.parse(readFileSync(join("public", "data", "omr-index.json"), "utf8"));
    const file = omrIndex[task.set!] ?? `${task.set}.mpd`;
    seedLdr = readFileSync(join("public", "models", "omr", task.set!, file), "utf8");
    const orig = fromLdr(seedLdr, meta).parts;
    originalPoses = new Set(orig.map((p) => `${p.part}/${p.color}/${Math.round(p.x)}/${Math.round(p.y)}/${Math.round(p.z)}`));
  }

  const res = await fetch(`${BASE}/api/copilot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: task.prompt,
      model,
      toolMode: "connect",
      toolset: "full",
      baseplate: "none",
      verifierTools: condition === "verifier",
      // condition=none: TRUE no-verification arm — no tools AND no auto-gates
      ...(condition === "none" ? { gates: false } : {}),
      eyes,
      ...(seedLdr ? { ldraw: seedLdr } : {}),
      ...(inventory ? { inventory } : {}),
      ...(task.post.maxFootprintStuds
        ? { envelope: { maxW: task.post.maxFootprintStuds[0], maxL: task.post.maxFootprintStuds[1], minHeightBricks: task.post.minHeightLdu ? Math.round(task.post.minHeightLdu / 24) : undefined } }
        : {}),
      record: { runId, taskId: `build-${task.id}`, condition: cond, model },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalLdr: string | null = null;
  let lastError: string | null = null;
  const toolCounts = new Map<string, number>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // tokens over every turn, from the environment's usage events
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data: ")) continue;
      let ev: { type: string; ldraw?: string; message?: string; name?: string; summary?: string };
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.type === "usage") { const u = ev as unknown as Record<string, number>; for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[k] += Number(u[k] ?? 0); }
      else if (ev.type === "result" && ev.ldraw) finalLdr = ev.ldraw;
      else if (ev.type === "tool" && ev.name) {
        toolCounts.set(ev.name, (toolCounts.get(ev.name) ?? 0) + 1);
        process.stdout.write(ev.name.startsWith("auto_") ? `\n[${ev.name}] ${ev.summary ?? ""}\n` : ".");
      } else if (ev.type === "error") lastError = ev.message ?? "unknown";
    }
  }
  process.stdout.write("\n");

  // ── grade the final artifact (independent of anything the agent said)
  mkdirSync("runs", { recursive: true });
  const grades: Record<string, unknown> = { runId, task: task.id, condition: cond, model, prompt: task.prompt, seconds: Math.round((Date.now() - started) / 1000), tools: Object.fromEntries(toolCounts), usage, error: lastError };
  if (finalLdr) {
    writeFileSync(join("runs", `${runId}.ldr`), finalLdr);
    // export for the viewers: /assemblies/build:<runId> · /steps2?set=build:<runId> · /editor?set=build:<runId>
    const { parts } = fromLdr(finalLdr, meta);
    const verify = verifyBuild(parts, meta, getConnections(), getVoxels());
    // Edit tasks: the seed's PRE-EXISTING validator complaints are not the
    // agent's — validity means "no NEW problems" (same rule as the gates).
    if (task.type === "edit" && seedLdr) {
      const seedParts = fromLdr(seedLdr, meta).parts;
      const seedV = verifyBuild(seedParts, meta, getConnections(), getVoxels());
      const newUnattached = verify.unconnected.length - seedV.unconnected.length;
      const newCollisions = verify.collisions.length - seedV.collisions.length;
      grades.seedBaseline = { unconnected: seedV.unconnected.length, collisions: seedV.collisions.length };
      grades.newProblems = { unconnected: Math.max(0, newUnattached), collisions: Math.max(0, newCollisions) };
      (verify as { ok: boolean }).ok = newUnattached <= 0 && newCollisions <= 0;
    }
    const stability = checkStability(parts, meta, validateConnections(parts, meta, getConnections()), getVoxels());
    // postconditions from geometry (engine frame: y up, stud = 20 LDU)
    let maxY = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of parts) {
      const m = meta[p.part] ?? { w: 2, l: 2, h: 24 };
      maxY = Math.max(maxY, p.y + m.h);
      minX = Math.min(minX, p.x - (m.w * 20) / 2);
      maxX = Math.max(maxX, p.x + (m.w * 20) / 2);
      minZ = Math.min(minZ, p.z - (m.l * 20) / 2);
      maxZ = Math.max(maxZ, p.z + (m.l * 20) / 2);
    }
    const fp: [number, number] = [(maxX - minX) / 20, (maxZ - minZ) / 20];
    const post: Record<string, boolean> = { parts: parts.length >= task.post.minParts };
    if (task.post.minHeightLdu != null) post.height = maxY >= task.post.minHeightLdu;
    if (task.post.maxFootprintStuds) {
      post.footprint =
        Math.max(fp[0], fp[1]) <= Math.max(...task.post.maxFootprintStuds) &&
        Math.min(fp[0], fp[1]) <= Math.min(...task.post.maxFootprintStuds) + 0.001;
    }
    if (task.post.partNames) {
      const nameIdx = new Map(
        (JSON.parse(readFileSync(join("public", "data", "parts", "index.json"), "utf8")) as { p: string; n: string }[]).map((r) => [r.p, r.n]),
      );
      for (const req of task.post.partNames) {
        const re = new RegExp(req.match, "i");
        const n = parts.filter((p) => re.test(nameIdx.get(p.part) ?? p.part)).length;
        grades[`parts_${req.match}`] = n;
        post[`names(${req.match})`] = n >= req.min;
      }
    }
    if (task.post.minMovableJoints != null) {
      // the moat rung: does the mechanism actually MOVE — inferred rigid
      // bodies + revolute joints from the same pipeline the editor uses
      const conns2 = getConnections();
      const project = parseLdraw(finalLdr);
      const flat = flattenProject(project, (id) => !!meta[id]);
      const eparts: E2Part[] = flat.instances.map((inst, i) => ({
        id: i + 1,
        part: inst.partCandidates[0],
        color: inst.color,
        root: { o: [...inst.t] as [number, number, number], r: orthonormalize(inst.r) } as Frame,
      }));
      const frames = new Map(eparts.map((p) => [p.id, p.root!]));
      const inferred = inferJoints(eparts, frames, (part) => expandedConnectors(part, conns2), { current: eparts.length + 1 }, {});
      const movable = inferred.joints.filter((j) => j.kind === "revolute" && !j.locked).length;
      grades.movableJoints = movable;
      post.movable = movable >= task.post.minMovableJoints;
    }
    if (inventory) {
      // BOM-subset: the final build must fit inside the set's inventory
      const used: Record<string, number> = {};
      for (const p of parts) used[`${p.part}:${p.color}`] = (used[`${p.part}:${p.color}`] ?? 0) + 1;
      const over = Object.entries(used).filter(([k, n]) => n > (inventory![k] ?? 0));
      grades.bomOver = over.slice(0, 8);
      post.bom = over.length === 0;
    }
    if (originalPoses && task.post.minPreserved != null && task.type === "edit") {
      // translation-invariant preservation: the original arrangement may be
      // relocated as one rigid unit (a pedestal LIFTS the ghost); find the
      // dominant offset between original and final poses of matching
      // part+color, then count survivors under that offset.
      const origList = [...originalPoses].map((k) => {
        const [part, color, x, y, z] = k.split("/");
        return { part, color: Number(color), x: Number(x), y: Number(y), z: Number(z) };
      });
      const finalsByType = new Map<string, { x: number; y: number; z: number }[]>();
      for (const p of parts) {
        const key = `${p.part}/${p.color}`;
        if (!finalsByType.has(key)) finalsByType.set(key, []);
        finalsByType.get(key)!.push({ x: p.x, y: p.y, z: p.z });
      }
      const offsetVotes = new Map<string, number>();
      for (const o of origList)
        for (const f of finalsByType.get(`${o.part}/${o.color}`) ?? []) {
          const key = `${Math.round(f.x - o.x)}/${Math.round(f.y - o.y)}/${Math.round(f.z - o.z)}`;
          offsetVotes.set(key, (offsetVotes.get(key) ?? 0) + 1);
        }
      const best = [...offsetVotes.entries()].sort((a, b) => b[1] - a[1])[0];
      const [dx, dy, dz] = best ? best[0].split("/").map(Number) : [0, 0, 0];
      const finalPoses = new Set(parts.map((p) => `${p.part}/${p.color}/${Math.round(p.x)}/${Math.round(p.y)}/${Math.round(p.z)}`));
      let kept = 0;
      for (const o of origList)
        if (finalPoses.has(`${o.part}/${o.color}/${o.x + dx}/${o.y + dy}/${o.z + dz}`)) kept++;
      const preserved = kept / origList.length;
      grades.preserved = +preserved.toFixed(3);
      grades.preservedOffset = [dx, dy, dz];
      post.preserved = preserved >= task.post.minPreserved;
    }
    grades.partCount = parts.length;
    grades.heightLdu = Math.round(maxY);
    grades.footprintStuds = fp.map((v) => Math.round(v * 2) / 2);
    grades.valid = verify.ok;
    grades.verifyReport = verify.report;
    grades.stable = stability.ok;
    grades.stabilityReport = stability.report.slice(0, 300);
    grades.post = post;
    grades.PASS = verify.ok && stability.ok && Object.values(post).every(Boolean);
  } else {
    grades.PASS = false;
    grades.verifyReport = "no final model produced";
  }
  const transportFailure = !finalLdr && toolCounts.size === 0 && !!lastError && /connection|fetch failed|ECONN|ETIMEDOUT|socket/i.test(lastError);
  if (transportFailure) {
    console.log(`transport failure: ${lastError} — not grading`);
    return false;
  }
  writeFileSync(join("runs", `${runId}.json`), JSON.stringify(grades, null, 1));
  console.log(`\n${runId}`);
  console.log(` valid=${grades.valid ?? "—"} stable=${grades.stable ?? "—"} post=${JSON.stringify(grades.post ?? {})} PASS=${grades.PASS}`);
  console.log(` → runs/${runId}.json · session in sessions/${runId}/ · python3 serve.py to look at it`);
  return true;
}

async function main() {
  // one retry on transport-level failures (a transient network drop killed
  // a 16-run overnight queue in under a minute)
  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await runOnce();
    if (ok) return;
    console.log(`transport failure — retrying in 60s (attempt ${attempt + 2}/2)…`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.error("giving up after retries");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
