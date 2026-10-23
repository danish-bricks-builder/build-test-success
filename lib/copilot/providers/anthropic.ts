/**
 * Anthropic provider — the original code path, lifted out of the loop
 * unchanged.
 *
 * Everything here was `lib/copilot/agent.ts` a moment ago: the same
 * `messages.stream` call with the same arguments, the same two stream
 * listeners, the same `finalMessage()`. Prompt-cache breakpoints ride along
 * on the message/system blocks the loop hands us (we never touch them), so
 * caching behaves exactly as before.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";

export function createAnthropicProvider(apiKey: string): ModelProvider {
  // A stream that stops arriving must fail, not hang: the turn's time budget
  // is only read BETWEEN iterations, so a wedged request blocks the whole
  // turn (and, in a benchmark run, burns its clock in silence).
  const client = new Anthropic({ apiKey, timeout: Number(process.env.COPILOT_API_TIMEOUT_MS ?? 600_000) });
  return {
    id: "anthropic",
    async run(req: ProviderRequest): Promise<ProviderTurn> {
      const response = client.messages.stream(
        {
          model: req.model,
          // Generous: build scripts + assemblies inside tool calls are long;
          // a truncated tool call is discarded wholesale by the API.
          max_tokens: req.maxTokens,
          system: req.system,
          tools: req.tools,
          messages: req.messages,
          // Reasoning depth. Omitted unless the caller asked for one, so the
          // default path sends exactly the request it always did.
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        },
        { signal: req.abortSignal },
      );

      response.on("text", (delta) => req.onText(delta));
      // Tool-call WRITING progress: a long emit_parts_script is minutes of
      // silence otherwise (tool input streams as json deltas, not text).
      response.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
          req.onToolWriteStart(ev.content_block.name);
        } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
          req.onToolWriteDelta(ev.delta.partial_json.length);
        } else if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") {
          req.onThinking?.(ev.delta.thinking);
        }
      });

      const final = await response.finalMessage();
      const u = final.usage;
      return {
        content: final.content,
        toolCalls: final.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
        stopReason: final.stop_reason,
        usage: {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
