/**
 * Google Gemini provider — the same agent loop, a different engine.
 *
 * Why: our wall clock is dominated by model output. Opus 5 writes ~50 output
 * tok/s, Gemini 3.8 Flash ~308. Same tools, same descriptions, same system
 * prompt; only the transport changes, so the comparison stays honest.
 *
 * It speaks the Gemini **Interactions API** (`client.interactions.create`,
 * `@google/genai` ≥ 2.3) in stateless mode (`store: false`): we own the
 * history, exactly as the Anthropic path does, and resend it every iteration.
 *
 * ── What this adapter translates ────────────────────────────────────────
 *   Anthropic                          Gemini Interactions
 *   system: [TextBlockParam]        →  system_instruction: string (joined)
 *   tools[].input_schema            →  tools[] {type:"function", parameters}
 *   user message (string/text)      →  user_input step, text content
 *   image block (base64)            →  user_input step, image content
 *   assistant text                  →  model_output step
 *   tool_use                        →  function_call step (id/name/arguments)
 *   tool_result                     →  function_result step (call_id/result)
 *   max_tokens                      →  generation_config.max_output_tokens
 *   stop_reason "tool_use"          →  derived: the turn produced calls
 *   stop_reason "max_tokens"        →  interaction status "incomplete"
 *
 * One rule the docs do not spell out, found by probing the live API: an
 * echoed `function_call` step is rejected (HTTP 400, "Request contains an
 * invalid argument") unless the `thought` step that preceded it — the one
 * carrying the reasoning signature — is echoed too. See {@link TurnRecorder}.
 *
 * ── What has no equivalent (degraded, on purpose) ───────────────────────
 *   • Anthropic prompt-cache breakpoints (`cache_control`). Ignored. Gemini
 *     caches implicitly; `cacheWrite` is always reported as 0.
 *   • Extended-thinking blocks. Gemini's reasoning is opaque; we ask for a
 *     thinking LEVEL instead (see GEMINI_THINKING_LEVEL below) and echo the
 *     server's `thought` steps back verbatim, which Google requires in
 *     stateless multi-turn so the model keeps its reasoning thread.
 *   • Per-block cache control on tool results and images: not a concept here.
 */
import { GoogleGenAI } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";

// ─── Interactions-API wire shapes ──────────────────────────────────────
// @google/genai does not export its Interactions step/event types (they are
// `declare type`s internal to the bundle), so we mirror the fields we use and
// cast at the SDK boundary. Kept structural on purpose: unknown event types
// are skipped rather than crashing the turn.

type GText = { type: "text"; text: string };
type GImage = { type: "image"; mime_type: string; data: string };
type GContent = GText | GImage;

type GUserInput = { type: "user_input"; content: GContent[] };
type GModelOutput = { type: "model_output"; content: GContent[] };
type GFunctionCall = { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> };
type GFunctionResult = { type: "function_result"; call_id: string; name?: string; result: GContent[] };
type GThought = { type: "thought"; signature?: string; summary?: GContent[] };
type GStep = GUserInput | GModelOutput | GFunctionCall | GFunctionResult | GThought | { type: string };

type GUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
};

type GEvent =
  | { event_type: "interaction.created"; interaction?: { id?: string } }
  | { event_type: "interaction.status_update" }
  | { event_type: "step.start"; index: number; step: GStep }
  | { event_type: "step.delta"; index: number; delta: { type: string; text?: string; arguments?: string; signature?: string } }
  | { event_type: "step.stop"; index: number; usage?: GUsage; step_usage?: GUsage }
  | { event_type: "interaction.completed"; interaction: { status?: string; steps?: GStep[]; usage?: GUsage } }
  | { event_type: "error"; error?: { message?: string; code?: string | number } }
  | { event_type: string };

type GTool = { type: "function"; name: string; description?: string; parameters?: unknown };

interface GCreateParams {
  model: string;
  input: GStep[];
  tools?: GTool[];
  system_instruction?: string;
  generation_config?: { max_output_tokens?: number; thinking_level?: string };
  store: false;
  stream: true;
}

/**
 * Reasoning depth. The Anthropic path in this loop runs WITHOUT extended
 * thinking, so "low" is the like-for-like setting (and the fastest, which is
 * the whole point of this provider). Gemini 3.8's own default is "medium";
 * set GEMINI_THINKING_LEVEL=medium|high to trade speed for depth. "minimal"
 * is rejected by the model and is not offered.
 *
 * Read per request, not once at import: in dev the env is reloaded when
 * .env.local changes, and a benchmark that has to restart the server to
 * change one knob is a benchmark nobody runs twice.
 */
const thinkingLevel = () => process.env.GEMINI_THINKING_LEVEL || "low";

// ─── Tool schemas ──────────────────────────────────────────────────────

/**
 * Anthropic tool → Gemini function declaration. The DESCRIPTION is copied
 * byte for byte (this is a like-for-like test, not a Gemini-tuned prompt).
 *
 * The only schema surgery, and it is the whole list:
 *   1. `input_schema` is renamed to `parameters`.
 *   2. A parameter object with NO properties (`inspect_build`, `read_note`,
 *      …) is sent with `parameters` omitted entirely — the API rejects an
 *      empty property bag, and "no parameters" is expressed by absence.
 *   3. `$schema`, `additionalProperties` and `title` are dropped wherever
 *      they appear; the Gemini schema parser does not accept them. Our tools
 *      do not currently set any of the three, so today this is a no-op guard.
 * Everything else (type / properties / items / required / description /
 * enum, nested to any depth) is passed straight through.
 */
export function toGeminiTools(tools: Anthropic.Tool[]): GTool[] {
  return tools.map((t) => {
    const schema = stripUnsupported(t.input_schema as Record<string, unknown>);
    const props = schema?.properties as Record<string, unknown> | undefined;
    const empty = !props || Object.keys(props).length === 0;
    return {
      type: "function" as const,
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(empty ? {} : { parameters: schema }),
    };
  });
}

const DROPPED_SCHEMA_KEYS = new Set(["$schema", "additionalProperties", "title"]);

function stripUnsupported(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (DROPPED_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = stripUnsupported(pv) ?? pv;
      }
      out[k] = props;
    } else if (k === "items") {
      out[k] = stripUnsupported(v) ?? v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── History ───────────────────────────────────────────────────────────

/**
 * Gemini requires `thought` steps to be resent verbatim in stateless
 * multi-turn (they carry the signature that keeps the reasoning thread
 * alive). We therefore remember the raw steps the server produced for each
 * assistant message, keyed on the exact content array the loop pushed onto
 * the history. A message whose array we do not recognise (an older turn
 * replayed from the client, or the truncation-salvage path in the loop,
 * which rebuilds the array) is reconstructed from its blocks without
 * signatures — the documented degradation.
 */
type StepMemory = WeakMap<object, GStep[]>;

function contentBlocks(content: Anthropic.MessageParam["content"]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content as Anthropic.ContentBlockParam[];
}

function imageOf(block: Anthropic.ImageBlockParam): GContent {
  const src = block.source;
  if (src.type === "base64") return { type: "image", mime_type: src.media_type, data: src.data };
  // URL / file sources: Gemini wants an uploaded file reference, which this
  // adapter does not do. Say so instead of silently dropping the image.
  return { type: "text", text: "[an image was attached that this model could not read]" };
}

/** tool_result content (string, or text/image blocks) → function_result result. */
function resultContent(content: Anthropic.ToolResultBlockParam["content"]): GContent[] {
  if (content === undefined) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: GContent[] = [];
  for (const b of content) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "image") out.push(imageOf(b));
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

/** The whole Anthropic conversation → a flat Interactions `input` step list. */
export function toGeminiInput(messages: Anthropic.MessageParam[], memory?: StepMemory): GStep[] {
  const steps: GStep[] = [];
  /** tool_use_id → tool name, so function_result can name its function. */
  const callNames = new Map<string, string>();

  for (const m of messages) {
    const blocks = contentBlocks(m.content);
    if (m.role === "assistant") {
      const remembered = memory?.get(blocks as unknown as object);
      if (remembered) {
        for (const b of blocks) if (b.type === "tool_use") callNames.set(b.id, b.name);
        steps.push(...remembered);
        continue;
      }
      const said: GContent[] = [];
      const calls: GStep[] = [];
      for (const b of blocks) {
        if (b.type === "text") said.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          callNames.set(b.id, b.name);
          calls.push({
            type: "function_call",
            id: b.id,
            name: b.name,
            arguments: (b.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      if (said.length) steps.push({ type: "model_output", content: said });
      steps.push(...calls);
      continue;
    }
    // User turn. Anthropic puts tool results and fresh user content in the
    // same message; Gemini wants them as separate steps, in order.
    let pending: GContent[] = [];
    const flush = () => {
      if (pending.length) steps.push({ type: "user_input", content: pending });
      pending = [];
    };
    for (const b of blocks) {
      if (b.type === "tool_result") {
        flush();
        steps.push({
          type: "function_result",
          call_id: b.tool_use_id,
          ...(callNames.get(b.tool_use_id) ? { name: callNames.get(b.tool_use_id) } : {}),
          result: resultContent(b.content),
        });
      } else if (b.type === "text") {
        pending.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        pending.push(imageOf(b));
      }
    }
    flush();
  }
  return steps;
}

/**
 * One streamed model turn, rebuilt step by step.
 *
 * `interaction.completed` does NOT carry the step list back (verified against
 * the live API: `steps` is absent on every completion event), so the stream is
 * the only record of what the model produced — and the history we echo next
 * iteration has to be rebuilt from it, in order and complete.
 *
 * "Complete" is not optional here. The API rejects a `function_call` echoed
 * without the `thought` step that preceded it ("Request contains an invalid
 * argument", HTTP 400): the thought carries the signature that ties the call
 * to the reasoning that produced it. Dropping the call instead is worse — the
 * model then cannot see what it already asked for and calls it again.
 */
class TurnRecorder {
  /** Steps in stream order, indexed by the API's step index. */
  private readonly slots = new Map<number, GStep>();
  /** Accumulated argument JSON per function_call step. */
  private readonly args = new Map<number, string>();

  start(index: number, step: GStep): void {
    const t = step.type;
    if (t === "thought") {
      this.slots.set(index, { type: "thought", signature: (step as GThought).signature ?? "" });
    } else if (t === "model_output") {
      this.slots.set(index, { type: "model_output", content: [{ type: "text", text: "" }] });
    } else if (t === "function_call") {
      const call = step as GFunctionCall;
      this.slots.set(index, { type: "function_call", id: call.id, name: call.name, arguments: {} });
      this.args.set(index, "");
    }
  }

  text(index: number, delta: string): void {
    const slot = this.slots.get(index);
    if (slot?.type === "model_output") {
      const content = (slot as GModelOutput).content;
      const first = content[0] as GText;
      first.text += delta;
    } else {
      // Text before its step.start (or on a step type we did not record).
      this.slots.set(index, { type: "model_output", content: [{ type: "text", text: delta }] });
    }
  }

  signature(index: number, signature: string): void {
    const slot = this.slots.get(index);
    if (slot?.type === "thought") (slot as GThought).signature = signature;
    else this.slots.set(index, { type: "thought", signature });
  }

  argumentChunk(index: number, chunk: string): void {
    this.args.set(index, (this.args.get(index) ?? "") + chunk);
  }

  /** The finished step list, ready to echo back as history. */
  steps(): GStep[] {
    const out: GStep[] = [];
    for (const index of [...this.slots.keys()].sort((a, b) => a - b)) {
      const slot = this.slots.get(index)!;
      if (slot.type === "function_call") {
        const raw = this.args.get(index) ?? "";
        let parsed: Record<string, unknown> = {};
        try {
          if (raw) parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // A malformed argument blob is the model's mistake, not ours: let
          // the call through empty so the tool reports the failure back and
          // the loop keeps going.
        }
        out.push({ ...(slot as GFunctionCall), arguments: parsed });
      } else if (slot.type === "model_output") {
        const said = (slot as GModelOutput).content[0] as GText;
        if (said.text) out.push(slot);
      } else if (slot.type === "thought") {
        // A thought with no signature is not echoable and buys nothing.
        if ((slot as GThought).signature) out.push(slot);
      }
    }
    return out;
  }
}

// ─── The provider ──────────────────────────────────────────────────────

export function createGeminiProvider(apiKey: string): ModelProvider {
  const client = new GoogleGenAI({ apiKey });
  const memory: StepMemory = new WeakMap();

  return {
    id: "gemini",
    async run(req: ProviderRequest): Promise<ProviderTurn> {
      const params: GCreateParams = {
        model: req.model,
        input: toGeminiInput(req.messages, memory),
        tools: toGeminiTools(req.tools),
        system_instruction: req.system.map((b) => b.text).join("\n\n"),
        generation_config: { max_output_tokens: req.maxTokens, thinking_level: req.thinkingLevel || thinkingLevel() },
        store: false,
        stream: true,
      };

      const created = await client.interactions.create(
        params as unknown as Parameters<typeof client.interactions.create>[0],
        req.abortSignal ? { fetchOptions: { signal: req.abortSignal } } : undefined,
      );
      const stream = created as unknown as AsyncIterable<GEvent>;

      const recorder = new TurnRecorder();
      let usage: GUsage | undefined;
      let status = "";

      for await (const ev of stream) {
        switch (ev.event_type) {
          case "step.start": {
            const e = ev as Extract<GEvent, { event_type: "step.start" }>;
            recorder.start(e.index, e.step);
            if (e.step?.type === "function_call") {
              req.onToolWriteStart((e.step as GFunctionCall).name);
            }
            break;
          }
          case "step.delta": {
            const e = ev as Extract<GEvent, { event_type: "step.delta" }>;
            const d = e.delta;
            if (d?.type === "text" && d.text) {
              recorder.text(e.index, d.text);
              req.onText(d.text);
            } else if (d?.type === "arguments_delta" && d.arguments) {
              recorder.argumentChunk(e.index, d.arguments);
              req.onToolWriteDelta(d.arguments.length);
            } else if (d?.type === "thought_signature" && d.signature) {
              recorder.signature(e.index, d.signature);
            }
            break;
          }
          case "interaction.completed": {
            const e = ev as Extract<GEvent, { event_type: "interaction.completed" }>;
            usage = e.interaction?.usage;
            status = e.interaction?.status ?? "";
            break;
          }
          case "error": {
            const e = ev as Extract<GEvent, { event_type: "error" }>;
            throw new Error(`Gemini: ${e.error?.message ?? "stream error"}`);
          }
          default:
            break; // lifecycle chatter we don't need
        }
      }

      // The model's steps, in order — echoed back verbatim next iteration.
      const steps = recorder.steps();
      const content: Anthropic.ContentBlockParam[] = [];
      const toolCalls: ProviderTurn["toolCalls"] = [];
      for (const step of steps) {
        if (step.type === "model_output") {
          const said = (step as GModelOutput).content
            .filter((c): c is GText => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (said) content.push({ type: "text", text: said });
        } else if (step.type === "function_call") {
          const call = step as GFunctionCall;
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
          toolCalls.push({ id: call.id, name: call.name, input: call.arguments });
        }
      }
      memory.set(content as unknown as object, steps);

      const stopReason: Anthropic.StopReason =
        toolCalls.length > 0 ? "tool_use" : status === "incomplete" ? "max_tokens" : "end_turn";

      // Thinking tokens are billed as output but reported separately; the
      // event protocol has no field for them, so they go to the server log.
      if (usage?.total_thought_tokens) {
        console.log(`[copilot gemini] thought tokens: ${usage.total_thought_tokens}`);
      }
      const cacheRead = usage?.total_cached_tokens ?? 0;
      return {
        content,
        toolCalls,
        stopReason,
        usage: {
          // Gemini counts cached tokens INSIDE total_input_tokens; Anthropic
          // reports them apart. Subtract so the two agree.
          input: Math.max(0, (usage?.total_input_tokens ?? 0) - cacheRead),
          output: usage?.total_output_tokens ?? 0,
          cacheRead,
          cacheWrite: 0, // implicit caching: nothing to write, nothing to bill
        },
      };
    },
  };
}
