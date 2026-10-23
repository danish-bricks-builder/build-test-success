/**
 * RunRecorder — server-side flight recorder for copilot turns.
 *
 * When a chat request carries `record: {runId, ...}`, the leocad route
 * instantiates one of these and every artifact of the run lands in
 * evals/exp/runs/<runId>/ :
 *
 *   run.json          meta + one entry per turn (multi-turn runs append)
 *   events.jsonl      every SSE event the client saw (text deltas, tool
 *                     summaries, highlights, joint ops) — the experience
 *   toolLog.jsonl     every tool call with FULL input and result — the truth
 *   blobs/<sha>.png   every image the model saw, content-addressed
 *   snapshots/NNN.ldr the working model after every state-changing call
 *
 * Replay = walk toolLog/events in order, loading the snapshot named by
 * each entry. Nothing here changes model or UI behavior — pure tee.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunMeta {
  runId: string;
  taskId?: string;
  condition?: string;
  model?: string;
  setId?: string;
}

/** Widest possible — SDK block-param arrays, strings, undefined all land
 * here (parameter contravariance: `unknown` accepts every caller type). */
type ToolResultContent = unknown;

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex").slice(0, 24);

export class RunRecorder {
  readonly dir: string;
  private turn = 0;
  private toolIdx = 0;
  private snapIdx = 0;
  private lastSnapshotHash = "";
  private getLdraw: () => string;

  constructor(root: string, meta: RunMeta, getLdraw: () => string) {
    this.dir = join(root, meta.runId.replace(/[^\w.-]/g, "_"));
    this.getLdraw = getLdraw;
    mkdirSync(join(this.dir, "blobs"), { recursive: true });
    mkdirSync(join(this.dir, "snapshots"), { recursive: true });
    // run.json survives across turns of the same runId (multi-turn chats).
    const runPath = join(this.dir, "run.json");
    const run = existsSync(runPath)
      ? JSON.parse(readFileSync(runPath, "utf8"))
      : { ...meta, createdAt: new Date().toISOString(), turns: [] };
    this.turn = run.turns.length;
    writeFileSync(runPath, JSON.stringify(run, null, 1));
  }

  /** Start a turn: log the user's ORIGINAL message (before context blocks). */
  startTurn(userMessage: string, extra: Record<string, unknown> = {}): void {
    const runPath = join(this.dir, "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    run.turns.push({ i: this.turn, userMessage, startedAt: new Date().toISOString(), ...extra });
    writeFileSync(runPath, JSON.stringify(run, null, 1));
    this.snapshot("turn-start");
  }

  endTurn(): void {
    const runPath = join(this.dir, "run.json");
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    const t = run.turns[this.turn];
    if (t) t.endedAt = new Date().toISOString();
    writeFileSync(runPath, JSON.stringify(run, null, 1));
    this.snapshot("turn-end");
    this.turn++;
  }

  /** Tee of the SSE stream — what the human/client experienced. */
  onEvent(event: unknown): void {
    this.append("events.jsonl", { t: Date.now(), turn: this.turn, ...(event as object) });
  }

  /**
   * The assistant's own message for one iteration — every block it produced,
   * thinking included, plus what the turn spent. Without this a trace shows
   * what the model DID and not what it was thinking while it did it, which
   * is the half you need when the doing looks irrational.
   */
  onAssistant(content: unknown, usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    this.append("assistant.jsonl", { t: Date.now(), turn: this.turn, content, usage });
  }

  /** The images that came IN with the user's message (reference photos, the
   * canvas screenshot): the model saw them, so a trace must hold them too. */
  onInputImages(images: { mediaType: string; data: string }[], label: string): void {
    const refs: string[] = [];
    for (const img of images) {
      const data = Buffer.from(img.data, "base64");
      const ref = `${sha(data)}.${img.mediaType.includes("png") ? "png" : "jpg"}`;
      const path = join(this.dir, "blobs", ref);
      if (!existsSync(path)) writeFileSync(path, data);
      refs.push(ref);
    }
    if (refs.length) this.append("inputs.jsonl", { t: Date.now(), turn: this.turn, label, images: refs });
  }

  /** Reasoning text, as it streams, coalesced into one line per burst. */
  onThinking(delta: string): void {
    this.append("thinking.jsonl", { t: Date.now(), turn: this.turn, delta });
  }

  /** Full-fidelity tool record; images swapped for content-addressed refs. */
  onTool(name: string, input: Record<string, unknown>, content: ToolResultContent): void {
    let result: unknown;
    const images: string[] = [];
    if (!Array.isArray(content)) {
      result = content ?? "";
    } else {
      result = content.map((block: { type?: string; source?: { data?: string } }) => {
        if (block?.type === "image") {
          const data = block.source?.data ? Buffer.from(block.source.data, "base64") : Buffer.alloc(0);
          const ref = `${sha(data)}.png`;
          const path = join(this.dir, "blobs", ref);
          if (!existsSync(path)) writeFileSync(path, data);
          images.push(ref);
          return { type: "image", imageRef: ref };
        }
        return block;
      });
    }
    this.append("toolLog.jsonl", {
      t: Date.now(),
      turn: this.turn,
      idx: this.toolIdx++,
      name,
      input,
      result,
      ...(images.length ? { images } : {}),
      snapshot: this.snapshot(`after-${name}`),
    });
  }

  /** Write a snapshot iff the model state changed; returns its filename. */
  private snapshot(label: string): string | null {
    let ldr: string;
    try {
      ldr = this.getLdraw();
    } catch {
      return null;
    }
    const h = sha(ldr);
    if (h === this.lastSnapshotHash) return null;
    this.lastSnapshotHash = h;
    const name = `${String(this.snapIdx++).padStart(3, "0")}-${label.replace(/[^\w-]/g, "_")}.ldr`;
    writeFileSync(join(this.dir, "snapshots", name), ldr);
    return name;
  }

  private append(file: string, obj: unknown): void {
    appendFileSync(join(this.dir, file), JSON.stringify(obj) + "\n");
  }
}
