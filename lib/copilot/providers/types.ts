/**
 * The provider seam for the copilot agent loop.
 *
 * `lib/copilot/agent.ts` owns everything that makes the copilot what it is —
 * the tools, the dispatcher, the validation gate, settling, the SSE event
 * stream. The ONE step that differs between model vendors is "send the
 * conversation, stream the deltas, hand back the assistant message and its
 * tool calls". That step lives behind {@link ModelProvider}.
 *
 * The lingua franca stays Anthropic-shaped (`Anthropic.MessageParam`,
 * `Anthropic.Tool`) because that is what the loop already speaks and what the
 * rest of the repo (recorder, eval harness, LeoCAD bridge) reads. A non-
 * Anthropic provider translates on the way in and on the way out; the loop
 * never learns which vendor answered.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ProviderId = "anthropic" | "gemini";

/** One model call. Everything the loop knows, nothing it doesn't. */
export interface ProviderRequest {
  /** Wire model id (`claude-sonnet-5`, `gemini-3.8-flash`, …). */
  model: string;
  /** System prompt blocks (the Anthropic path also carries cache breakpoints). */
  system: Anthropic.TextBlockParam[];
  /** Tool schemas, Anthropic-shaped (`input_schema`). */
  tools: Anthropic.Tool[];
  /** Full conversation so far. Providers must NOT mutate it. */
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  /**
   * Reasoning depth, per request. Absent = the vendor's own default (what
   * every caller got before this existed).
   *   Anthropic → `output_config.effort` (default "high" on Opus 5 /
   *               Sonnet 5; omitted here means we send no output_config).
   *   Gemini    → `generation_config.thinking_level` (falls back to
   *               GEMINI_THINKING_LEVEL, then "low").
   * The vocabularies differ, so each provider takes only what it accepts.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinkingLevel?: string;
  abortSignal?: AbortSignal;
  /** Assistant prose, token by token. */
  onText: (delta: string) => void;
  /** The model started WRITING a tool call (name known, arguments not yet). */
  onToolWriteStart: (name: string) => void;
  /** More argument bytes arrived for the tool call being written. */
  onToolWriteDelta: (chars: number) => void;
  /** Reasoning text as it streams. The final message keeps only a signature
   * for thinking blocks, so a trace that wants the model's reasoning has to
   * catch the deltas as they go past. Optional: providers that do not stream
   * thinking simply never call it. */
  onThinking?: (delta: string) => void;
}

/** One assistant turn, normalised. */
export interface ProviderTurn {
  /**
   * The assistant message content, in Anthropic block shape — pushed onto
   * the history verbatim by the loop, so a provider that needs extra state
   * (Gemini thought signatures) must key it off this exact array instance.
   */
  content: Anthropic.ContentBlockParam[];
  /** Tool calls in the order the model wrote them. */
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  /** Anthropic stop-reason vocabulary; other vendors map onto it. */
  stopReason: Anthropic.StopReason | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelProvider {
  readonly id: ProviderId;
  run(req: ProviderRequest): Promise<ProviderTurn>;
}

/** No key for the picked model's vendor — the routes turn this into chat text. */
export class MissingProviderKeyError extends Error {
  constructor(public readonly provider: ProviderId, message: string) {
    super(message);
    this.name = "MissingProviderKeyError";
  }
}
