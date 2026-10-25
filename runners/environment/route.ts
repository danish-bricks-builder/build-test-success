/**
 * The copilot route (streaming). /api/leocad is an alias (next.config.ts).
 *
 * The editor (and the LeoCAD desktop dock) POSTs the current model as LDraw
 * text plus a chat message; this route runs the copilot brain
 * (`runAgentTurn`) and STREAMS progress back as Server-Sent Events so the
 * client shows live tool activity instead of freezing for minutes. Every
 * event is also logged to the dev-server terminal for backend inspection.
 *
 *   client  ──{ message, ldraw }──▶  /api/copilot
 *                                      fromLdr → parts
 *                                      runAgentTurn → stream tool/text events
 *                                      toLdr → final `result` event
 *   client  ◀── SSE: tool/text/error … result{ldraw} … done
 *
 * SSE event shapes (one JSON object per `data:` line):
 *   { type: "tool",   name, summary }     a tool ran
 *   { type: "text",   delta }             streamed narration
 *   { type: "error",  message }
 *   { type: "result", ldraw, partCount }  the finished model (apply this)
 *   { type: "model",  ldraw, partCount, step, tool }
 *                                         the build AS IT GROWS — only with
 *                                         `stream: "model"` in the request
 *                                         (throttled; a watcher fills a viewer)
 *   { type: "done" }                      stream complete
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/copilot/agent";
import { loadStatic } from "@/lib/copilot/staticData";
import { fromLdr, toLdr } from "@/lib/ldraw/serialize";
import { renderAvailable, renderModel } from "@/lib/render";
import { makeGroundTool, makeSimilarTool, recolorHot } from "@/lib/copilot/ground";
import { makeRefereeTools } from "@/lib/copilot/refereeTools";
import { RunRecorder } from "@/lib/exp/recorder";
import { rotAboutLine } from "@/lib/editor2/limits";
import type { Frame } from "@/lib/editor2/kinematics";
import { FALLBACK_META } from "@/lib/engine/types";
import type { BuildSession } from "@/lib/copilot/state";
import { resolveCopilotModel } from "@/lib/copilot/types";
import { CATALOG_NAMES } from "@/lib/copilot/catalog";
import type { ChatMessage, CopilotEvent, CopilotModel } from "@/lib/copilot/types";
import type { PartMetaMap, PlacedPartJson, ProjectJson } from "@/lib/data/schemas";

export const runtime = "nodejs";
export const maxDuration = 300;

// Big desktop builds need more room than the browser's 28.
const DESKTOP_MAX_ITERATIONS = 90; // big staged builds (cars) need headroom

const RENDER_VIEW_TOOL: Anthropic.Tool = {
  name: "render_view",
  description:
    "Render the CURRENT build and SEE it as an image from a camera angle you choose. latitude = up/down tilt in degrees (~25 for a natural 3/4 view, 90 = straight down/top view); longitude = angle around the model in degrees (0–360; step by 90 for front/side/back). Use this LIBERALLY to check your work — orientation, alignment, gaps, collisions, and whether seats/minifigs actually fit — before and after tricky placements. Don't build blind.",
  input_schema: {
    type: "object",
    properties: {
      latitude: { type: "number", description: "up/down tilt, degrees (default 25)" },
      longitude: { type: "number", description: "angle around the model, degrees (default 45)" },
    },
  },
};

interface LeocadRequest {
  message: string;
  ldraw?: string;
  history?: ChatMessage[];
  /** reference pictures sent with the message (PNG/JPEG, base64, at most 4) */
  images?: { mediaType: "image/png" | "image/jpeg"; data: string }[];
  model?: CopilotModel;
  baseplate?: number;
  /** editor2's movable joints — enables the set_joint_angle tool. */
  joints?: AgentJoint[];
  /** editor2's rigid bodies — enables the highlight tools. */
  bodies?: AgentBody[];
  /** Human-labeled semantic hierarchy (golden corpus annotation). */
  semantic?: unknown;
  /** Set id whose LOCAL instruction booklets (public/instructions-pdf/,
   * machine-local, never deployed) the agent may read via
   * view_instructions. Dev-machine only (needs poppler). */
  instructionsFor?: string;
  /** Precomputed grounding regions (public/regions/<set>.json): named,
   * possibly-overlapping part sets; parts = exported-part-list indices.
   * Enables highlight_region / highlight_parts. */
  regions?: { name: string; parts: number[] }[];
  /** Experiment condition — "render": eyes + edit tools only, no
   * structural context/tools. Default "full". */
  toolset?: "render" | "full";
  /** Copilot generation: "coords" (v1, default), "connect" (v2 —
   * connection-first placement; editor2's copilot), or "mate" (v3 —
   * pure connector-to-connector mate language). */
  toolMode?: "coords" | "connect" | "mate";
  /** Offer check_validity/check_stability tools (default true); false = graders-only condition. */
  verifierTools?: boolean;
  /** Run the end-of-turn validity/stability auto-gates + repair rounds
   * (default true); false = TRUE no-verification condition — the build is
   * accepted as the agent leaves it and only graded offline. */
  gates?: boolean;
  /** Offer the render_view eyes (default true); false = blind condition. */
  eyes?: boolean;
  /** Mission footprint/height contract — enforced by the auto-gate (studs/bricks). */
  envelope?: { maxW?: number; maxL?: number; minHeightBricks?: number };
  /** Restricted inventory: remaining stock by "part:color" — placements are
   * hard-rejected once a part+color runs out. */
  inventory?: Record<string, number>;
  /** Flight-record this turn into evals/exp/runs/<runId>/ (multi-turn
   * chats reuse the runId and append). Dev-machine only. */
  record?: { runId: string; taskId?: string; condition?: string; setId?: string };
  /** Tool allowlist from the user's copilot settings (lib/copilot/catalog):
   * only these tools are offered, out of what the mode offers — applied
   * after the mode filter. Absent = the mode's defaults, unchanged. */
  tools?: string[];
  /** Reasoning depth for this turn. Claude reads `effort`
   * (output_config.effort: low|medium|high|xhigh|max — default high);
   * Gemini reads `thinkingLevel` (low|medium|high — default
   * GEMINI_THINKING_LEVEL). Absent = unchanged vendor defaults. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinkingLevel?: string;
  /** How long this turn may run before it stops and offers "continue",
   * in ms. Clamped to COPILOT_TURN_BUDGET_MAX_MS (unset = the server's
   * own budget), so a request can never outlive the function. */
  turnBudgetMs?: number;
  /** Opt in to the LIVE MODEL stream: "model" adds throttled
   * `{type:"model", ldraw, partCount, step, tool}` events after every
   * build-changing tool, so a watcher can fill a 3D viewer in as
   * the build happens. Absent = today's stream, byte for byte. */
  stream?: "model";
}

const VIEW_INSTRUCTIONS_TOOL: Anthropic.Tool = {
  name: "view_instructions",
  description:
    "READ the instruction booklet: renders one page (or a zoomed REGION of it) as an image. Navigate like a human builder: go page by page, and when a step's detail is too small (part callouts, counts), zoom into a region — region is {x, y, w, h} as FRACTIONS of the page (0..1, origin top-left), e.g. top-right quadrant = {x:0.5, y:0, w:0.5, h:0.5}. Zoomed views are much sharper than full pages; use them liberally.",
  input_schema: {
    type: "object",
    properties: {
      booklet: { type: "number", description: "booklet number (1-based) when the set has several; default 1" },
      page: { type: "number", description: "page number, 1-based" },
      region: {
        type: "object",
        description: "optional zoom region, fractions of the page",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
        },
      },
    },
    required: ["page"],
  },
};

/** A rigid body of the inferred hierarchy (editor2's browser tree). */
interface AgentBody {
  /** 1-based body number as shown in the UI ("Body 4"). */
  n: number;
  parts: number;
  label: string;
  /** Member indices into the exported part list — enables ground_reference. */
  memberIdx?: number[];
}

const HIGHLIGHT_BODY_TOOL: Anthropic.Tool = {
  name: "highlight_body",
  description:
    "Highlight RIGID BODIES of the inferred hierarchy in the user's live viewport. ONE body (body_number): " +
    "the camera frames it and everything else fades to ghost — walk the hierarchy body by body while " +
    "narrating. MANY bodies (body_numbers): ALL of them light up AT ONCE over the model in its normal colors — use this " +
    "single call for 'highlight all the X' requests (never loop one-by-one; a loop reads as a slideshow). " +
    "It does NOT return an image; use render_view if you need to see for yourself.",
  input_schema: {
    type: "object",
    properties: {
      body_number: { type: "number", description: "1-based number from the RIGID BODIES list (single)" },
      body_numbers: {
        type: "array",
        items: { type: "number" },
        description: "several body numbers — all highlighted simultaneously",
      },
    },
  },
};

const DEMO_JOINT_TOOL: Anthropic.Tool = {
  name: "demo_joint",
  description:
    "DEMONSTRATE one movable joint with a live ANIMATION in the user's viewport: the camera frames the joint and its subtree visibly sweeps back and forth through the measured free arc. Use whenever the user asks to see/show/demonstrate motion or range of motion (doors, hood, levers). Returns the arc numbers so you can narrate them. To demonstrate several joints, call once per joint, in sequence. This animates the VIEW only — it does not change the model's pose (use set_joint_angle for that).",
  input_schema: {
    type: "object",
    properties: { joint_id: { type: "number", description: "id from the MOVABLE JOINTS list" } },
    required: ["joint_id"],
  },
};

const HIGHLIGHT_JOINT_TOOL: Anthropic.Tool = {
  name: "highlight_joint",
  description:
    "Highlight one JOINT of the hierarchy in the user's live viewport: the joint pair lights up (teal parent / orange child) with its axis, the camera frames the swept motion, and the joint animates through its measured arc. Use it to point at articulations while explaining the mechanism.",
  input_schema: {
    type: "object",
    properties: { joint_id: { type: "number", description: "id from the MOVABLE JOINTS list" } },
    required: ["joint_id"],
  },
};

/** A movable joint as editor2 describes it to the agent. Pivot/axis are in
 * LDraw doc coordinates; `subtree` indexes the exported part list. */
interface AgentJoint {
  id: number;
  label: string;
  cls: string;
  angle: number;
  min: number;
  max: number;
  pivot: [number, number, number];
  axis: [number, number, number];
  parentBody: string;
  childBody: string;
  subtree: number[];
}

const SET_JOINT_TOOL: Anthropic.Tool = {
  name: "set_joint_angle",
  description:
    "Rotate one movable joint of the loaded model to an ABSOLUTE angle in degrees (0 = the as-built pose; stay within the joint's free arc from the MOVABLE JOINTS list). The moving subtree really rotates in the working model, so render_view afterwards SHOWS the new pose — always verify visually that the motion did what the user meant (right part, right direction). If it swung the wrong way, move toward the other end of the arc instead. Positive direction is not knowable a priori — check with a render.",
  input_schema: {
    type: "object",
    properties: {
      joint_id: { type: "number", description: "id from the MOVABLE JOINTS list" },
      angle: { type: "number", description: "absolute target angle in degrees (0 = as-built)" },
    },
    required: ["joint_id", "angle"],
  },
};

/** LDraw rotation matrix for the engine's grid rot (θ_ldraw = −θ_engine). */
const ENGINE_ROT_TO_LDRAW: Record<number, number[]> = {
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  90: [0, 0, -1, 0, 1, 0, 1, 0, 0],
  180: [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  270: [0, 0, 1, 0, 1, 0, -1, 0, 0],
};

function projectLdraw(parts: PlacedPartJson[], name: string, baseplate: number, meta: PartMetaMap): string {
  const project: ProjectJson = { format: "danish-bricks/v1", name, baseplate, parts };
  return toLdr(project, meta);
}

const execFileP = promisify(execFile);

interface BookletInfo {
  file: string;
  pages: number;
  /** page size in pts (from pdfinfo) */
  pts: [number, number];
  /** "model A" / "model B" when the PDF title reveals it — Technic sets
   * ship alternate-build booklets that construct a DIFFERENT model. */
  label?: string;
}

/** Derive a model label from a booklet PDF's embedded title
 * (e.g. "9393_BI_ModelB_GL.indd" → "model B"). Not exported: route files
 * may only export HTTP handlers. */
function bookletLabel(title: string | undefined): string | undefined {
  // no \b — in "9393_BI_ModelA_GL.indd" the letter is followed by "_", a word char
  const m = title?.match(/model[\s_]*([a-z])(?![a-z])/i);
  return m ? `model ${m[1].toUpperCase()}` : undefined;
}

const bookletCache = new Map<string, BookletInfo[]>();

/** LOCAL instruction booklets for a set (machine-local research copies;
 * dev-machine only — needs poppler's pdfinfo/pdftoppm). */
async function localBooklets(setId: string): Promise<BookletInfo[]> {
  const hit = bookletCache.get(setId);
  if (hit) return hit;
  const dir = path.join(process.cwd(), "public", "instructions-pdf", setId);
  const out: BookletInfo[] = [];
  try {
    const pdfs = fs
      .readdirSync(dir)
      .filter((f) => /^\d[\w-]*\.pdf$/i.test(f)) // numbered booklets only
      .sort();
    for (const f of pdfs) {
      const { stdout } = await execFileP("pdfinfo", [path.join(dir, f)]);
      const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      const size = stdout.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m);
      const label = bookletLabel(stdout.match(/^Title:\s+(.+)$/m)?.[1]);
      if (pages > 0)
        out.push({
          file: path.join(dir, f),
          pages,
          pts: [Number(size?.[1] ?? 595), Number(size?.[2] ?? 842)],
          ...(label ? { label } : {}),
        });
    }
  } catch {
    /* no booklets / no poppler */
  }
  bookletCache.set(setId, out);
  return out;
}

/** Render one booklet page (optionally a zoom region) to a PNG buffer. */
async function renderInstructionPage(
  b: BookletInfo,
  page: number,
  region?: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  // Sharper DPI when zoomed: full page 120, up to 360 for small regions.
  const frac = region ? Math.max(clamp01(region.w), clamp01(region.h)) : 1;
  const dpi = Math.min(360, Math.round(120 / Math.max(0.33, frac)));
  const args = ["-png", "-singlefile", "-r", String(dpi), "-f", String(page), "-l", String(page)];
  if (region) {
    const W = (b.pts[0] / 72) * dpi;
    const H = (b.pts[1] / 72) * dpi;
    args.push(
      "-x", String(Math.round(clamp01(region.x) * W)),
      "-y", String(Math.round(clamp01(region.y) * H)),
      "-W", String(Math.max(32, Math.round(clamp01(region.w) * W))),
      "-H", String(Math.max(32, Math.round(clamp01(region.h) * H))),
    );
  }
  const prefix = path.join(os.tmpdir(), `dbb-instr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  await execFileP("pdftoppm", [...args, b.file, prefix]);
  const png = fs.readFileSync(`${prefix}.png`);
  fs.unlinkSync(`${prefix}.png`);
  return png;
}

export async function POST(request: Request) {
  const userKey = request.headers.get("x-user-api-key")?.trim();
  const apiKey = userKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  let req: LeocadRequest;
  try {
    req = (await request.json()) as LeocadRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!req.message?.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const { meta, palette } = await loadStatic();
  // Eyes need the LeoCAD binary — absent on deploys, so don't offer
  // render_view there (every call would fail and burn a tool turn).
  // Switching render_view off in the copilot settings = blind: no first
  // look at the build either.
  const eyes =
    req.eyes !== false && renderAvailable() && (!Array.isArray(req.tools) || req.tools.includes(RENDER_VIEW_TOOL.name));

  // LeoCAD speaks native LDraw; convert to the engine's part list.
  const imported = req.ldraw?.trim()
    ? fromLdr(req.ldraw, meta)
    : { parts: [], name: null, nonGridRotations: 0, groups: [] };

  const session: BuildSession = {
    parts: [...imported.parts],
    inventory: req.inventory ? { ...req.inventory } : null,
    meta,
    assemblies: new Map(),
  };

  // Placement ↔ LDraw-frame round-trip (for rotating joint subtrees).
  const placementFrame = (p: PlacedPartJson): Frame => {
    if (p.m && p.m.length === 9) return { o: [p.x, -p.y, -p.z], r: [...p.m] };
    const h = meta[p.part]?.h ?? FALLBACK_META.h;
    return { o: [p.x, -(p.y + h), -p.z], r: [...(ENGINE_ROT_TO_LDRAW[p.rot] ?? ENGINE_ROT_TO_LDRAW[0])] };
  };

  // Experiment condition: "render" strips the structural context and tools
  // (joints/bodies/semantic + their tool suite), leaving eyes + edit tools
  // only. Default "full" = everything, unchanged.
  const toolset: "render" | "full" = req.toolset === "render" ? "render" : "full";
  const wantStructure = toolset === "full";
  const originalMessage = req.message; // recorded before context blocks mutate it

  // Movable-joint context: list them in the prompt, enable set_joint_angle.
  if (wantStructure && req.joints?.length) {
    const table = req.joints
      .map(
        (j) =>
          `id ${j.id} · ${j.cls} · ${j.label} · moves ${j.childBody} on ${j.parentBody} · ` +
          `angle ${j.angle}° · free arc ${j.min}°…${j.max}° · pivot (${j.pivot.map((v) => Math.round(v)).join(", ")})`,
      )
      .join("\n");
    req.message +=
      `\n\n[MOVABLE JOINTS of the current model — drive them with set_joint_angle (absolute degrees, 0 = as-built); ` +
      `to SHOW motion, prefer demo_joint (one call = the joint visibly animates through its whole arc in the ` +
      `user's viewport — no need to step angles manually). ` +
      `LDraw coords: -Y is UP, X/Z horizontal. Which joint is "driver side" vs "passenger side" etc. is NOT labeled — ` +
      `infer from the SEMANTIC HIERARCHY when present, else from mirrored pivot coordinates, and VERIFY with render_view.\n${table}]`;
  }
  if (wantStructure && req.bodies?.length) {
    const table = req.bodies
      .map((b) => `Body ${b.n} · ${b.parts} parts · ${b.label}`)
      .join("\n");
    req.message +=
      `\n\n[RIGID BODIES of the inferred hierarchy (largest first; highlight_body points at one in the ` +
      `user's viewport, highlight_joint points at a joint). When the user names a feature ("the roof", ` +
      `"the driver door") that you cannot map to a body with certainty, use ground_reference — it LOOKS ` +
      `at renders and visually verifies which bodies the phrase means, instead of guessing. ` +
      `For PLURAL requests ("all the containers") NEVER enumerate this table by part name — that has ` +
      `produced confidently-wrong subsets. Required flow: identify 1-2 clear exemplars (ground_reference ` +
      `if unsure), find_similar_bodies to complete each shape class deterministically, highlight, then ` +
      `CHECK the returned render for anything still unlit:\n${table}]`;
  }
  if (wantStructure && req.regions?.length) {
    const table = req.regions
      .map((r) => `"${r.name}" · ${r.parts.length} parts`)
      .join("\n");
    req.message +=
      `\n\n[NAMED REGIONS — precomputed visual grounding: named PART SETS (regions may overlap, and may ` +
      `be finer than rigid bodies — a region can be a sub-body area like a roof surface). When the user ` +
      `refers to one of these features, PREFER highlight_region / these part sets over guessing from ` +
      `tables. Use remove_parts/recolor_parts with a region's part indices (get them via highlight_region's ` +
      `result) to edit a region:\n${table}]`;
  }
  if (wantStructure && req.semantic) {
    req.message +=
      `\n\n[SEMANTIC HIERARCHY — human-labeled names for the bodies ("driver door" etc.; body numbers ` +
      `match the RIGID BODIES list; treat "TBD" notes as unverified). Use these names when the user ` +
      `refers to features, and prefer them over guessing from coordinates:\n` +
      `${JSON.stringify(req.semantic)}]`;
  }

  // Local instruction booklets → the view_instructions tool.
  const booklets = req.instructionsFor ? await localBooklets(req.instructionsFor) : [];
  if (booklets.length) {
    const list = booklets
      .map((b, i) => `booklet ${i + 1}: ${b.label ? `${b.label}, ` : ""}${b.pages} pages`)
      .join(" · ");
    const altNote = booklets.some((b) => b.label && b.label !== "model A")
      ? " Alternate-model booklets (model B, C…) build a DIFFERENT model from the same parts — " +
        "the set's main model is model A; use that unless asked for an alternate build."
      : "";
    req.message +=
      `\n\n[INSTRUCTION BOOKLETS available locally for set ${req.instructionsFor} — ${list}.${altNote} ` +
      `Read them with view_instructions (page by page; zoom into regions for part callouts and counts). ` +
      `Follow the build steps in order.]`;
  }

  const promptMessages: ChatMessage[] = [
    ...(req.history ?? []),
    { role: "user", content: req.message },
  ];
  const baseplate = req.baseplate ?? 48;

  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
  const tag = `[leocad ${new Date().toISOString().slice(11, 19)}]`;
  console.log(`${tag} ▶ "${req.message}"  (${imported.parts.length} parts in)`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      // Flight recorder (experiment runs): tees SSE events, full tool I/O,
      // images, and .ldr snapshots to evals/exp/runs/<runId>/.
      let recorder: RunRecorder | null = null;
      const send = (obj: unknown) => {
        recorder?.onEvent(obj);
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // client disconnected — stop trying to write
        }
      };

      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      // Live build streaming: after each mutating tool, push the current
      // projected LDraw so the user's viewport fills in DURING the turn
      // instead of staying empty until the final result. Bound late (needs
      // jointOps/session in scope below).
      let emitPartial: ((toolName: string) => void) | null = null;
      /** Push the model snapshot the throttle is still holding back. */
      let flushModel: (() => void) | null = null;

      // Forward useful events to the dock AND mirror them to the terminal.
      const onEvent = (e: CopilotEvent) => {
        switch (e.type) {
          case "tool":
            console.log(`${tag} ${elapsed()}s  [${e.name}] ${e.summary}`);
            send(e);
            try {
              emitPartial?.(e.name);
            } catch {
              /* partials are best-effort */
            }
            break;
          case "tool_start":
            console.log(`${tag} ${elapsed()}s  ▶ ${e.name}`);
            send(e);
            break;
          case "tool_typing":
            // throttled upstream; forward for the live "writing…" line
            send(e);
            break;
          case "text":
            process.stdout.write(e.delta);
            send(e);
            break;
          case "usage":
            totals.input += e.input;
            totals.output += e.output;
            totals.cacheRead += e.cacheRead;
            totals.cacheWrite += e.cacheWrite;
            console.log(
              `${tag} ${elapsed()}s  usage in=${e.input} out=${e.output} cacheRead=${e.cacheRead} cacheWrite=${e.cacheWrite}`,
            );
            send(e); // token accounting for scripted runs (the editor ignores it)
            break;
          case "error":
            console.error(`${tag} ${elapsed()}s  ERROR: ${e.message}`);
            send(e);
            break;
          // "state" / "note" / "done" are not forwarded per-step.
        }
      };
      // Log a per-turn cost estimate at the end. Prices per 1M tokens; cache
      // reads bill ~0.1× input, cache writes ~1.25×. Adjust MODEL_RATES per model.
      const logCost = (modelId: string) => {
        const rates: Record<string, { in: number; out: number }> = {
          "claude-fable-5": { in: 10, out: 50 },
          "claude-fable-5-1": { in: 10, out: 50 },
          "claude-opus-5": { in: 5, out: 25 },
          "claude-opus-4-8": { in: 5, out: 25 },
          "claude-sonnet-5": { in: 3, out: 15 },
          "claude-haiku-4-5": { in: 1, out: 5 },
        };
        const r = rates[modelId] ?? rates["claude-sonnet-5"];
        const cost =
          (totals.input * r.in +
            totals.cacheRead * r.in * 0.1 +
            totals.cacheWrite * r.in * 1.25 +
            totals.output * r.out) /
          1_000_000;
        const cacheable = totals.cacheRead + totals.cacheWrite + totals.input;
        const hitRate = cacheable ? Math.round((totals.cacheRead / cacheable) * 100) : 0;
        console.log(
          `${tag} 💰 ~$${cost.toFixed(4)} on ${modelId} (${totals.output} out tok, cache hit ${hitRate}%)`,
        );
      };

      const name = imported.name || "LeoCAD build";
      const partsBefore = JSON.stringify(session.parts);

      if (req.record?.runId) {
        try {
          recorder = new RunRecorder(
            path.join(process.cwd(), "runs", "sessions"),
            {
              runId: req.record.runId,
              taskId: req.record.taskId,
              condition: req.record.condition ?? toolset,
              model: resolveCopilotModel(req.model),
              setId: req.record.setId,
            },
            () => projectLdraw(session.parts, name, baseplate, meta),
          );
          recorder.startTurn(originalMessage, { toolset, effort: req.effort, thinkingLevel: req.thinkingLevel, turnBudgetMs: req.turnBudgetMs });
          console.log(`${tag} ● recording → ${recorder.dir}`);
        } catch (e) {
          console.error(`${tag} recorder init failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      try {
        // Give the model an initial look at the current build (its eyes).
        const messages: Anthropic.MessageParam[] = promptMessages.map((m) => ({ role: m.role, content: m.content }));
        const refImages = (req.images ?? []).filter((im) => im.mediaType === "image/png" || im.mediaType === "image/jpeg").slice(0, 4);
        if (refImages.length) {
          const last = messages[messages.length - 1];
          last.content = [
            ...refImages.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
            { type: "text" as const, text: `[${refImages.length} reference picture(s) above, sent with the request]` },
            ...(typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content),
          ];
        }
        if (session.parts.length > 0 && eyes) {
          try {
            const shot = await renderModel(projectLdraw(session.parts, name, baseplate, meta));
            const last = messages[messages.length - 1];
            if (last && last.role === "user" && typeof last.content === "string") {
              last.content = [
                { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.dataBase64 } },
                { type: "text", text: `[Current build rendered above — ${session.parts.length} parts]\n${last.content}` },
              ];
            }
            onEvent({ type: "tool", name: "render_view", summary: "initial view" });
            recorder?.onTool("initial_view", {}, [
              { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.dataBase64 } },
            ]);
          } catch (e) {
            console.error(`${tag} initial render failed: ${e instanceof Error ? e.message : e}`);
          }
        }

        // set_joint_angle: rotate the joint's subtree in the working copy
        // (so render_view shows the pose) and mirror the op to the client.
        const jointState = new Map((req.joints ?? []).map((j) => [j.id, j.angle]));
        let jointOps = 0;
        {
          // The editor's live-apply set (unchanged — it re-imports each
          // snapshot into the document, so it stays deliberately narrow).
          const MUTATING = new Set([
            "place_parts",
            "remove_parts",
            "recolor_parts",
            "emit_parts_script",
            "place_assembly",
            "attach_part",
            "attach_chain",
            "settle_build",
          ]);
          // The `model` stream is just pixels on a watcher's screen, so it
          // covers every tool that can change the build, including the
          // connect/mate placement tools and the end-of-turn repair gates.
          const CHANGES_BUILD = new Set([
            ...MUTATING,
            "anchor_part",
            "place_on",
            "stamp_module",
            "mirror_stamp",
            "attach_option",
            "run_connect_script",
            "build_program",
            "auto_validate",
            "auto_stability",
          ]);
          const wantModel = req.stream === "model";
          /** at most one `model` event per this many ms (a 300-part build
           * would otherwise push ~30 MB of LDraw down the wire) */
          const MODEL_THROTTLE_MS = 400;
          let lastPartial = "";
          let lastModelAt = 0;
          let modelStep = 0;
          let pending: { ldraw: string; parts: number; tool: string } | null = null;
          const sendModel = (ldraw: string, parts: number, tool: string) => {
            lastModelAt = Date.now();
            send({ type: "model", ldraw, partCount: parts, step: ++modelStep, tool });
          };
          flushModel = () => {
            if (!pending) return;
            const p = pending;
            pending = null;
            sendModel(p.ldraw, p.parts, p.tool);
          };
          emitPartial = (toolName: string) => {
            if (jointOps > 0) return;
            const partial = MUTATING.has(toolName);
            const live = wantModel && CHANGES_BUILD.has(toolName);
            if (!partial && !live) return;
            const snapshot = JSON.stringify(session.parts);
            if (snapshot === lastPartial) return; // rejected op — nothing changed
            lastPartial = snapshot;
            const ldraw = projectLdraw(session.parts, name, baseplate, meta);
            const parts = session.parts.length;
            if (partial) send({ type: "partial", ldraw, parts });
            if (!live) return;
            // Throttled, but never dropped: a held-back snapshot goes out
            // with the next one, or on the flush before the final result.
            if (Date.now() - lastModelAt < MODEL_THROTTLE_MS) {
              pending = { ldraw, parts, tool: toolName };
              return;
            }
            pending = null;
            sendModel(ldraw, parts, toolName);
          };
        }
        // The settle+validate gate is for from-scratch build turns. editor2
        // turns (joints/bodies context) operate on imported OMR sets whose
        // baseline never passes the builder validator — and settling would
        // corrupt intentional joint poses. Skip it there.
        const gateControl = { skipValidation: req.gates === false || (req.joints?.length ?? 0) > 0 || (req.bodies?.length ?? 0) > 0 };
        const jointTools = wantStructure && req.joints?.length
          ? [
              {
                tool: SET_JOINT_TOOL,
                summarize: (input: Record<string, unknown>) =>
                  `joint ${input.joint_id} → ${input.angle}°`,
                handle: async (input: Record<string, unknown>) => {
                  const j = (req.joints ?? []).find((x) => x.id === Number(input.joint_id));
                  if (!j) return `no joint with id ${input.joint_id} — see the MOVABLE JOINTS list.`;
                  let angle = Number(input.angle);
                  if (!Number.isFinite(angle)) return "angle must be a number of degrees.";
                  let clampNote = "";
                  if (angle < j.min || angle > j.max) {
                    const clamped = Math.min(j.max, Math.max(j.min, angle));
                    clampNote = ` (requested ${Number(input.angle)}° clamped to the free arc ${j.min}°…${j.max}°)`;
                    angle = clamped;
                  }
                  const cur = jointState.get(j.id) ?? 0;
                  const rot = rotAboutLine(j.axis, j.pivot, angle - cur);
                  let moved = 0;
                  for (const idx of j.subtree) {
                    const p = session.parts[idx];
                    if (!p) continue;
                    const f = rot(placementFrame(p));
                    p.x = f.o[0];
                    p.y = -f.o[1];
                    p.z = -f.o[2];
                    p.rot = 0;
                    p.m = f.r;
                    moved++;
                  }
                  jointState.set(j.id, angle);
                  jointOps++;
                  gateControl.skipValidation = true; // posed off-grid on purpose
                  send({ type: "set_joint", id: j.id, angle });
                  return `${j.label}: angle set to ${angle}°${clampNote} — ${moved} parts moved. Verify the pose with render_view.`;
                },
              },
              {
                tool: DEMO_JOINT_TOOL,
                summarize: (input: Record<string, unknown>) => `animating joint ${input.joint_id}`,
                handle: async (input: Record<string, unknown>) => {
                  const j = (req.joints ?? []).find((x) => x.id === Number(input.joint_id));
                  if (!j) return `no joint with id ${input.joint_id} — see the MOVABLE JOINTS list.`;
                  send({ type: "demo_joint", id: j.id });
                  return (
                    `${j.label} (${j.cls}) is now ANIMATING through its free arc ` +
                    `${j.min}°…${j.max}° (0 = as-built) in the user's viewport — ` +
                    `narrate what they are seeing.`
                  );
                },
              },
            ]
          : undefined;

        // Booklet reading: renders local pages/regions for the agent's
        // own use during the build (local research copies; never stored
        // in traces or served publicly).
        const instructionTools = booklets.length
          ? [
              {
                tool: VIEW_INSTRUCTIONS_TOOL,
                summarize: (input: Record<string, unknown>) => {
                  const r = input.region as { x?: number; y?: number; w?: number; h?: number } | undefined;
                  return `booklet ${input.booklet ?? 1} p${input.page}${r ? ` zoom(${r.x ?? 0},${r.y ?? 0},${r.w ?? 1},${r.h ?? 1})` : ""}`;
                },
                handle: async (input: Record<string, unknown>) => {
                  const bIdx = Math.max(1, Math.min(booklets.length, Number(input.booklet ?? 1))) - 1;
                  const b = booklets[bIdx];
                  const page = Math.max(1, Math.min(b.pages, Number(input.page ?? 1)));
                  const region = input.region as { x: number; y: number; w: number; h: number } | undefined;
                  const png = await renderInstructionPage(b, page, region);
                  return [
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png" as const, data: png.toString("base64") },
                    },
                    {
                      type: "text" as const,
                      text:
                        `booklet ${bIdx + 1}/${booklets.length}, page ${page}/${b.pages}` +
                        (region ? ` — zoomed region; request other regions or the full page as needed.` : ""),
                    },
                  ];
                },
              },
            ]
          : [];

        // Region tools: precomputed grounding as instant lookups.
        const regionTools = wantStructure && req.regions?.length
          ? [
              {
                tool: {
                  name: "highlight_region",
                  description:
                    "Highlight a precomputed NAMED REGION (from the NAMED REGIONS list) in the user's " +
                    "viewport — all its parts light up over the ghosted model. Returns the region's part " +
                    "indices so you can act on them (remove_parts / recolor_parts). Instant — no rendering, " +
                    "no guessing.",
                  input_schema: {
                    type: "object" as const,
                    properties: { name: { type: "string", description: "region name, verbatim from the list" } },
                    required: ["name"],
                  },
                } as Anthropic.Tool,
                summarize: (input: Record<string, unknown>) => `region "${input.name}"`,
                handle: async (input: Record<string, unknown>) => {
                  const wanted = String(input.name ?? "").toLowerCase().trim();
                  const r =
                    (req.regions ?? []).find((x) => x.name.toLowerCase() === wanted) ??
                    (req.regions ?? []).find((x) => x.name.toLowerCase().includes(wanted));
                  if (!r) return `no region "${input.name}" — see the NAMED REGIONS list.`;
                  send({ type: "highlight_parts", indices: r.parts });
                  return (
                    `highlighted region "${r.name}" (${r.parts.length} parts) in the user's viewport. ` +
                    `Part indices: [${r.parts.join(",")}]`
                  );
                },
              },
              {
                tool: {
                  name: "highlight_parts",
                  description:
                    "Highlight an arbitrary set of parts by index (exported part list) in the user's " +
                    "viewport — for selections finer than bodies or regions.",
                  input_schema: {
                    type: "object" as const,
                    properties: {
                      indices: { type: "array", items: { type: "number" } },
                    },
                    required: ["indices"],
                  },
                } as Anthropic.Tool,
                summarize: (input: Record<string, unknown>) =>
                  `${Array.isArray(input.indices) ? input.indices.length : 0} parts`,
                handle: async (input: Record<string, unknown>) => {
                  const idx = (Array.isArray(input.indices) ? input.indices : [])
                    .map(Number)
                    .filter((n) => Number.isFinite(n) && n >= 0 && n < session.parts.length);
                  if (!idx.length) return "no valid part indices.";
                  send({ type: "highlight_parts", indices: idx });
                  return `highlighted ${idx.length} parts in the user's viewport.`;
                },
              },
            ]
          : [];

        // Highlight tools: pure client-side pointers (SSE → inspector).
        const highlightTools = wantStructure && req.bodies?.length
          ? [
              {
                tool: HIGHLIGHT_BODY_TOOL,
                summarize: (input: Record<string, unknown>) =>
                  Array.isArray(input.body_numbers) && input.body_numbers.length
                    ? `Bodies ${(input.body_numbers as number[]).join(", ")}`
                    : `Body ${input.body_number}`,
                handle: async (input: Record<string, unknown>) => {
                  const wanted = (
                    Array.isArray(input.body_numbers) && input.body_numbers.length
                      ? (input.body_numbers as unknown[])
                      : [input.body_number]
                  ).map(Number);
                  const hits = wanted
                    .map((n) => (req.bodies ?? []).find((x) => x.n === n))
                    .filter((b): b is NonNullable<typeof b> => !!b);
                  if (!hits.length)
                    return `no such bodies (${wanted.join(", ")}) — see the RIGID BODIES list.`;
                  if (hits.length === 1) {
                    send({ type: "highlight_body", body: hits[0].n });
                    return `highlighted Body ${hits[0].n} (${hits[0].label}, ${hits[0].parts} parts) in the user's viewport.`;
                  }
                  send({ type: "highlight_bodies", bodies: hits.map((b) => b.n) });
                  const note =
                    hits.length < wanted.length ? ` (${wanted.length - hits.length} unknown numbers skipped)` : "";
                  // Visual receipt: what is ACTUALLY lit, so a partial
                  // selection is caught by the model's own eyes, not the user's.
                  const hotIdx = new Set(hits.flatMap((b) => b.memberIdx ?? []));
                  if (hotIdx.size) {
                    try {
                      const receipt = await renderModel(
                        recolorHot(projectLdraw(session.parts, name, baseplate, meta), hotIdx),
                        { lat: 35, lon: 45, width: 640, height: 480 },
                      );
                      return [
                        {
                          type: "image" as const,
                          source: {
                            type: "base64" as const,
                            media_type: receipt.mediaType,
                            data: receipt.dataBase64,
                          },
                        },
                        {
                          type: "text" as const,
                          text:
                            `highlighted ${hits.length} bodies (${hits.map((b) => `B${b.n}`).join(", ")}) — ` +
                            `the render above shows them in RED over the normal model.${note} CHECK IT: if ` +
                            `anything the user meant is still unlit, find those bodies (find_similar_bodies ` +
                            `with a lit exemplar of that shape, or ground_reference) and call highlight_body ` +
                            `again with the COMPLETE list.`,
                        },
                      ];
                    } catch {
                      /* no renderer on this machine — text receipt below */
                    }
                  }
                  return (
                    `highlighted ${hits.length} bodies AT ONCE in the user's viewport ` +
                    `(${hits.map((b) => `B${b.n}`).join(", ")}) over the model in its normal colors.${note}`
                  );
                },
              },
              {
                tool: HIGHLIGHT_JOINT_TOOL,
                summarize: (input: Record<string, unknown>) => `joint ${input.joint_id}`,
                handle: async (input: Record<string, unknown>) => {
                  const j = (req.joints ?? []).find((x) => x.id === Number(input.joint_id));
                  if (!j) return `no joint with id ${input.joint_id} — see the MOVABLE JOINTS list.`;
                  send({ type: "highlight_joint", id: j.id });
                  return `highlighted ${j.label} (${j.cls}, ${j.childBody} on ${j.parentBody}) — it is now animating through its arc in the user's viewport.`;
                },
              },
            ]
          : [];

        const model = resolveCopilotModel(req.model);

        // The referee and the decompiler (not in recorded experiments, whose
        // toolsets must stay as they were when those runs were made).
        const refereeTools = wantStructure && !req.record
          ? makeRefereeTools(() => projectLdraw(session.parts, name, baseplate, meta))
          : [];

        // Visual grounding: resolve "the roof"-class phrases by rendering,
        // shortlisting, and verifying highlighted candidates. Needs body
        // membership indices from the client.
        const groundTools = wantStructure && req.bodies?.some((b) => b.memberIdx?.length)
          ? [
              makeGroundTool({
                apiKey,
                model,
                ldrawOf: () => projectLdraw(session.parts, name, baseplate, meta),
                bodies: req.bodies ?? [],
                emit: send,
              }),
              makeSimilarTool({
                ldrawOf: () => projectLdraw(session.parts, name, baseplate, meta),
                bodies: req.bodies ?? [],
              }),
            ]
          : [];

        const extraTools = [...(jointTools ?? []), ...highlightTools, ...regionTools, ...instructionTools, ...groundTools, ...refereeTools];
        // Every tool the settings page can switch must be in the catalogue.
        if (process.env.NODE_ENV !== "production")
          for (const t of [RENDER_VIEW_TOOL, ...extraTools.map((e) => e.tool)])
            if (!CATALOG_NAMES.has(t.name)) console.warn(`${tag} tool "${t.name}" has no entry in lib/copilot/catalog.ts`);
        const toolAllowlist = Array.isArray(req.tools) ? req.tools.filter((n): n is string => typeof n === "string") : undefined;
        if (toolAllowlist) console.log(`${tag} tool allowlist: ${toolAllowlist.length} tools`);

        await runAgentTurn({
          session,
          toolMode:
            req.toolMode === "mate" ? "mate" : req.toolMode === "connect" ? "connect" : "coords",
          verifierTools: req.verifierTools,
          missionEnvelope: req.envelope,
          seededSession: !!req.ldraw?.trim(),
          promptMessages,
          messages,
          model,
          apiKey,
          baseplate,
          inventoryMode: !!req.inventory,
          palette,
          note: "",
          onEvent,
          maxIterations: DESKTOP_MAX_ITERATIONS,
          effort: req.effort,
          thinkingLevel: req.thinkingLevel,
          timeBudgetMs: req.turnBudgetMs
            ? Math.min(
                req.turnBudgetMs,
                Number(process.env.COPILOT_TURN_BUDGET_MAX_MS ?? process.env.COPILOT_TURN_BUDGET_MS ?? 250_000),
              )
            : undefined,
          abortSignal: request.signal,
          extraTools,
          toolAllowlist,
          gateControl,
          recorder: recorder ?? undefined,
          visionTool: !eyes ? undefined : {
            tool: RENDER_VIEW_TOOL,
            handle: async (input) => {
              if (session.parts.length === 0) return "The build is empty — nothing to render yet.";
              const lat = input.latitude === undefined ? 25 : Number(input.latitude);
              const lon = input.longitude === undefined ? 45 : Number(input.longitude);
              const shot = await renderModel(projectLdraw(session.parts, name, baseplate, meta), { lat, lon });
              return [
                { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.dataBase64 } },
                { type: "text", text: `Rendered view — latitude ${lat}°, longitude ${lon}°, ${session.parts.length} parts.` },
              ];
            },
          },
        });

        console.log(`${tag} ✓ done in ${elapsed()}s — ${session.parts.length} parts`);
        try {
          flushModel?.(); // the last throttled snapshot, before `result`
        } catch {
          /* live streaming is best-effort */
        }
        logCost(model);
        try {
          recorder?.endTurn();
        } catch {
          /* recording must never break the turn */
        }
        if (jointOps > 0) {
          // Joint ops were mirrored live via set_joint events; a result
          // reimport would bake the pose and destroy the client's joint
          // state, so suppress it (joint-driving and brick-editing don't
          // mix in one turn yet).
          console.log(`${tag} ${jointOps} joint ops — result reimport suppressed`);
        } else if (JSON.stringify(session.parts) === partsBefore) {
          // Q&A / highlight turns: nothing changed — a reimport would only
          // churn the client (and drop its precomputed joint limits).
          console.log(`${tag} parts unchanged — result reimport suppressed`);
        } else {
          send({ type: "result", ldraw: projectLdraw(session.parts, name, baseplate, meta), partCount: session.parts.length });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ✗ failed in ${elapsed()}s: ${message}`);
        try {
          flushModel?.(); // keep whatever was built visible on the failure
        } catch {
          /* live streaming is best-effort */
        }
        send({ type: "error", message });
      }

      send({ type: "done" });
      try {
        if (!closed) controller.close();
      } catch {
        /* already closed by a client disconnect */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
