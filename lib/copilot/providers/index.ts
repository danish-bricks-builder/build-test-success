/**
 * Which vendor answers for a given copilot model, and with which key.
 *
 * The model id IS the wire id (`claude-sonnet-5`, `gemini-3.8-flash`), so the
 * vendor is read straight off the prefix — no registry to keep in sync with
 * `COPILOT_MODELS`.
 */
import type { CopilotModel } from "@/lib/copilot/types";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { MissingProviderKeyError, type ModelProvider, type ProviderId } from "./types";

export { MissingProviderKeyError };
export type { ModelProvider, ProviderId, ProviderRequest, ProviderTurn } from "./types";

export function providerOf(model: CopilotModel | string): ProviderId {
  return String(model).startsWith("gemini") ? "gemini" : "anthropic";
}

/**
 * The key for the vendor behind `model`.
 *
 * Anthropic: the caller's key (the browser may supply its own through
 * `x-user-api-key`), else the server's. Gemini: the SERVER's key only —
 * the bring-your-own-key path is Anthropic-only for now, and a user's
 * Anthropic key must never be handed to Google.
 */
export function providerKeyFor(model: CopilotModel | string, callerKey?: string): string {
  if (providerOf(model) === "gemini") {
    return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  }
  return (callerKey || process.env.ANTHROPIC_API_KEY || "").trim();
}

/** Human-readable reason a model cannot run, or null when it can. */
export function missingKeyMessage(model: CopilotModel | string, callerKey?: string): string | null {
  if (providerKeyFor(model, callerKey)) return null;
  return providerOf(model) === "gemini"
    ? "No Gemini key configured on this server — set GEMINI_API_KEY (or GOOGLE_API_KEY) to use Gemini models, or pick a Claude model."
    : "ANTHROPIC_API_KEY not configured";
}

/** Build the provider for a turn. Throws {@link MissingProviderKeyError}. */
export function createProvider(model: CopilotModel | string, callerKey?: string): ModelProvider {
  const id = providerOf(model);
  const key = providerKeyFor(model, callerKey);
  if (!key) throw new MissingProviderKeyError(id, missingKeyMessage(model, callerKey)!);
  return id === "gemini" ? createGeminiProvider(key) : createAnthropicProvider(key);
}
