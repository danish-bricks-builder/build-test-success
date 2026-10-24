/**
 * Grade one LDraw file against one of the paper's tasks — the checks of Sec. 3.6 of
 * "Build, Test, Success", exactly as the paper's harness ran them:
 *
 *   connection validity + collision   verifyBuild      (lib/engine/verify)
 *   stability                         checkStability   (lib/engine/stability)
 *   task requirements                 part count, height, footprint, part names, inventory
 *
 *   npx tsx grade.ts <file.ldr> --task <id>      → one JSON object on stdout
 *
 * Reads the part data under public/data/ (sh fetch-data.sh). Voxel shapes come one file per part from
 * the data bucket, fetched the first time a part is met and cached in public/data/parts/voxels/ — the
 * same table the paper's machine held whole. The output has the same
 * fields as the paper's grade records in records/*.json; baseline.py calls this for every attempt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromLdr } from "./lib/ldraw/serialize";
import { verifyBuild } from "./lib/engine/verify";
import { extentOfParts } from "./lib/engine/footprint";
import { validateConnections } from "./lib/engine/connectionGraph";
import type { ConnectionMap } from "./lib/engine/snapAlign";
import { checkStability } from "./lib/engine/stability";
import type { VoxelData } from "./lib/engine/voxelCollision";
import type { PartMetaMap } from "./lib/data/schemas";

const DATA = join(__dirname, "public", "data");
const ORIGIN = (process.env.DATA_ORIGIN ?? "https://pub-09680f02457547f9bd4034ba506c47d7.r2.dev").replace(/\/$/, "");

interface Task {
  id: string;
  type: "build" | "edit" | "inventory";
  set?: string;
  prompt: string;
  post: {
    minParts: number;
    minHeightLdu?: number;
    maxFootprintStuds?: [number, number];
    partNames?: { match: string; min: number }[];
    minPreserved?: number;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const taskId = args[args.indexOf("--task") + 1];
  if (!file || args.indexOf("--task") < 0 || !taskId) {
    console.error("usage: npx tsx grade.ts <file.ldr> --task <task-id>");
    process.exit(2);
  }
  const { tasks } = JSON.parse(readFileSync(join(__dirname, "tasks.json"), "utf8")) as { tasks: Task[] };
  // a free prompt (try-it-yourself runs): graded on validity and stability alone
  const task = taskId.startsWith("prompt") ? ({ id: taskId, type: "build", prompt: "", post: { minParts: 1 } } as Task) : tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`unknown task ${taskId}; known: ${tasks.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }
  for (const f of ["parts/meta.json", "parts/index.json", "parts/connections.json"])
    if (!existsSync(join(DATA, f))) {
      console.error(`missing public/data/${f} — run: sh fetch-data.sh`);
      process.exit(2);
    }

  const meta = JSON.parse(readFileSync(join(DATA, "parts", "meta.json"), "utf8")) as PartMetaMap;
  const nameIdx = new Map((JSON.parse(readFileSync(join(DATA, "parts", "index.json"), "utf8")) as { p: string; n: string }[]).map((r) => [r.p, r.n]));
  const conns = JSON.parse(readFileSync(join(DATA, "parts", "connections.json"), "utf8")) as ConnectionMap;
  // the voxel table, one file per part (data/parts/voxels/<part>.json = {min, dims, bits}), res 1 LDU
  const vox: VoxelData = { res: 1, parts: {} };

  const out: Record<string, unknown> = { task: task.id, file };
  let parts;
  try {
    parts = fromLdr(readFileSync(file, "utf8"), meta).parts;
  } catch (e) {
    out.parseError = String(e).slice(0, 300);
    out.PASS = false;
    console.log(JSON.stringify(out));
    return;
  }

  await Promise.all(
    [...new Set(parts.map((p) => p.part))].map(async (p) => {
      const cached = join(DATA, "parts", "voxels", `${p}.json`);
      if (!existsSync(cached)) {
        const res = await fetch(`${ORIGIN}/data/parts/voxels/${encodeURIComponent(p)}.json`).catch(() => null);
        if (!res || !res.ok) return; // no shape for this part: the engine treats it as box-only, as the paper's did
        mkdirSync(join(DATA, "parts", "voxels"), { recursive: true });
        writeFileSync(cached, await res.text());
      }
      vox.parts[p] = JSON.parse(readFileSync(cached, "utf8"));
    }),
  );

  // Both checks always run, as in the paper's final grading (the feedback text sent between
  // attempts quotes stability only when the build is valid; see baseline.py).
  const verify = verifyBuild(parts, meta, conns, vox);
  // Edit tasks graded outside the environment (--seed <official set>): the seed's pre-existing
  // complaints are not the model's — validity means no NEW unattached parts or collisions, the
  // same rule the environment's gates and env/run.ts apply.
  const seedArg = process.argv.indexOf("--seed");
  const seedFile = seedArg >= 0 ? process.argv[seedArg + 1] : null;
  let seedParts: typeof parts | null = null;
  if (seedFile) {
    seedParts = fromLdr(readFileSync(seedFile, "utf8"), meta).parts;
    await Promise.all(
      [...new Set(seedParts.map((p) => p.part))].filter((p) => !vox.parts[p]).map(async (p) => {
        const cached = join(DATA, "parts", "voxels", `${p}.json`);
        if (!existsSync(cached)) {
          const res = await fetch(`${ORIGIN}/data/parts/voxels/${encodeURIComponent(p)}.json`).catch(() => null);
          if (!res || !res.ok) return;
          writeFileSync(cached, await res.text());
        }
        vox.parts[p] = JSON.parse(readFileSync(cached, "utf8"));
      }),
    );
    const seedV = verifyBuild(seedParts, meta, conns, vox);
    const newUnattached = verify.unconnected.length - seedV.unconnected.length;
    const newCollisions = verify.collisions.length - seedV.collisions.length;
    out.seedBaseline = { unconnected: seedV.unconnected.length, collisions: seedV.collisions.length };
    out.newProblems = { unconnected: Math.max(0, newUnattached), collisions: Math.max(0, newCollisions) };
    (verify as { ok: boolean }).ok = newUnattached <= 0 && newCollisions <= 0;
  }
  const stability = checkStability(parts, meta, validateConnections(parts, meta, conns), vox);

  // the task requirements, measured the way the paper's harness measured them
  const ext = extentOfParts(parts, meta);
  const maxY = ext.height;
  const fp: [number, number] = ext.footprint;
  const post: Record<string, boolean> = { parts: parts.length >= task.post.minParts };
  if (task.post.minHeightLdu != null) post.height = maxY >= task.post.minHeightLdu;
  if (task.post.maxFootprintStuds)
    post.footprint =
      Math.max(fp[0], fp[1]) <= Math.max(...task.post.maxFootprintStuds) &&
      Math.min(fp[0], fp[1]) <= Math.min(...task.post.maxFootprintStuds) + 0.001;
  if (task.post.partNames)
    for (const req of task.post.partNames) {
      const re = new RegExp(req.match, "i");
      const n = parts.filter((p) => re.test(nameIdx.get(p.part) ?? p.part)).length;
      out[`parts_${req.match}`] = n;
      post[`names(${req.match})`] = n >= req.min;
    }
  if (seedParts && task.post.minPreserved != null) {
    // translation-invariant preservation, as in env/run.ts: the original may be relocated as one
    // rigid unit; find the dominant offset between original and final poses of matching
    // part+color, then count the originals that survive under it.
    const finalsByType = new Map<string, { x: number; y: number; z: number }[]>();
    for (const p of parts) {
      const key = `${p.part}/${p.color}`;
      if (!finalsByType.has(key)) finalsByType.set(key, []);
      finalsByType.get(key)!.push({ x: p.x, y: p.y, z: p.z });
    }
    const votes = new Map<string, number>();
    for (const o of seedParts)
      for (const f of finalsByType.get(`${o.part}/${o.color}`) ?? []) {
        const key = `${Math.round(f.x - o.x)}/${Math.round(f.y - o.y)}/${Math.round(f.z - o.z)}`;
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const [dx, dy, dz] = best ? best[0].split("/").map(Number) : [0, 0, 0];
    const finalPoses = new Set(parts.map((p) => `${p.part}/${p.color}/${Math.round(p.x)}/${Math.round(p.y)}/${Math.round(p.z)}`));
    let kept = 0;
    for (const o of seedParts) if (finalPoses.has(`${o.part}/${o.color}/${Math.round(o.x) + dx}/${Math.round(o.y) + dy}/${Math.round(o.z) + dz}`)) kept++;
    const preserved = kept / Math.max(1, seedParts.length);
    out.preserved = +preserved.toFixed(3);
    out.preservedOffset = [dx, dy, dz];
    post.preserved = preserved >= task.post.minPreserved;
  }
  if (task.type === "inventory" && task.set) {
    const inv = JSON.parse(readFileSync(join(DATA, "inv", `${task.set}.json`), "utf8")) as { parts: { p: string; c: number; q: number; spare: boolean }[] };
    const allowed: Record<string, number> = {};
    for (const r of inv.parts) if (!r.spare) allowed[`${r.p}:${r.c}`] = (allowed[`${r.p}:${r.c}`] ?? 0) + r.q;
    const used: Record<string, number> = {};
    for (const p of parts) used[`${p.part}:${p.color}`] = (used[`${p.part}:${p.color}`] ?? 0) + 1;
    const over = Object.entries(used).filter(([k, n]) => n > (allowed[k] ?? 0));
    out.bomOver = over.slice(0, 8);
    post.bom = over.length === 0;
  }

  out.partCount = parts.length;
  out.heightLdu = Math.round(maxY);
  out.footprintStuds = fp.map((v) => Math.round(v * 2) / 2);
  out.valid = verify.ok;
  // The report names each faulty part: its index, part number, colour, the file's own line for
  // it, and why — the same located complaint the environment's gate gives, so text feedback can
  // act on it (the one-line summary alone told a model nothing it could fix).
  const partLines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /^\s*1\s/.test(l));
  const faulty = verify.perPart.filter((p) => !p.ok);
  const named = faulty.slice(0, 40).map((p) => {
    const q = parts[p.idx];
    const line = partLines[p.idx]?.trim();
    return `  #${p.idx} ${q.part}.dat colour ${q.color}${line ? ` (file line: ${line})` : ""}: ${p.reasons.join("; ")}`;
  });
  out.verifyReport = verify.report + (named.length ? `\n${named.join("\n")}${faulty.length > named.length ? `\n  … and ${faulty.length - named.length} more` : ""}` : "");
  out.stable = stability.ok;
  out.stabilityReport = stability.report;
  out.post = post;
  out.PASS = verify.ok && stability.ok && Object.values(post).every(Boolean);
  // which parts are wrong, by index in the file's part lines — the viewer paints them
  out.faults = {
    unattached: verify.unconnected,
    colliding: [...new Set(verify.collisions.flatMap((c) => [c.a, c.b]))].sort((a, b) => a - b),
    reasons: Object.fromEntries(verify.perPart.filter((p) => !p.ok).map((p) => [p.idx, p.reasons.join("; ")])),
  };
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
