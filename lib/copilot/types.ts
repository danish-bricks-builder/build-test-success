/** Shared copilot types: chat request + SSE event protocol. */
import type { PlacedPartJson } from "../data/schemas";

/** A model id is also its wire id; the prefix picks the vendor
 * (lib/copilot/providers). */
export type CopilotModel =
  | "claude-opus-5-5"
  | "claude-fable-5-1"
  | "claude-fable-5"
  | "claude-opus-5"
  | "claude-opus-4-8"
  | "claude-sonnet-5"
  | "claude-haiku-4-5"
  | "gemini-3.8-flash";

/** Valid model ids; anything else falls back to the cost-efficient default. */
export const COPILOT_MODELS: CopilotModel[] = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gemini-3.8-flash",
];

export function resolveCopilotModel(m: unknown): CopilotModel {
  return COPILOT_MODELS.includes(m as CopilotModel) ? (m as CopilotModel) : "claude-sonnet-5";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Media types the Messages API accepts as a base64 image source. */
export type CopilotImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** One image on the wire: bare base64 (no `data:` prefix), as the API wants. */
export interface CopilotImage {
  mediaType: CopilotImageMediaType;
  data: string;
}

/** At most this many reference images may ride along with one user message. */
export const MAX_REFERENCE_IMAGES = 3;

export interface ChatRequest {
  model: CopilotModel;
  messages: ChatMessage[];
  /** Current build at turn start. */
  parts: PlacedPartJson[];
  /** Remaining inventory ("part:color" → count) when in inventory mode. */
  inventory: Record<string, number> | null;
  baseplate: number;
  /** JPEG screenshot of the canvas at turn start (base64, no data: prefix). */
  screenshot?: string;
  /** Reference photos the user attached to THIS message ("build me this").
   * Attached ahead of the canvas screenshot and labelled separately so the
   * model never confuses "what I want" with "what is on the canvas". */
  images?: CopilotImage[];
  /** Renders of the CURRENT build that the model asked to see last pass
   * (lib/copilot/viewRender). Labelled apart from `images`, which are the
   * user's reference photos — confusing the two ruins a build. */
  views?: { mediaType: CopilotImage["mediaType"]; data: string; caption?: string }[];
  /** The copilot's persistent scratchpad note (per chat session). */
  note?: string;
  /** Dev only: record this turn under evals/exp/runs/<traceId> so the panel
   * can hand the whole trajectory over as a zip. Ignored in public mode. */
  traceId?: string;
  /** True when the client will CARRY ON after this pass ("keep building" is
   * on). A server with no renderer only offers the asking-eyes tool when this
   * is set: otherwise a look would end the build instead of pausing it. */
  canContinue?: boolean;
  /** True when the CLIENT chained this pass onto a turn the user already
   * sent (the clock ran out, or the model asked to see the build). The free
   * tier counts the user's turn, not the copilot's own follow-through. */
  continuation?: boolean;
  /** How long this turn may run before it stops and offers "continue", in ms.
   * Clamped server-side, so a deployment's function limit always wins. */
  turnBudgetMs?: number;
}

/** Server → client SSE events. */
export type CopilotEvent =
  | { type: "text"; delta: string }
  | { type: "note"; note: string }
  | { type: "tool"; name: string; summary: string }
  /** The model is WRITING a tool call (long scripts = long silences).
   * Throttled progress so the UI can show a live "typing" line. */
  | { type: "tool_typing"; name: string; bytes: number }
  /** Server began EXECUTING a tool (client pairs with "tool" for duration). */
  | { type: "tool_start"; name: string }
  | { type: "state"; parts: PlacedPartJson[] }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "error"; message: string }
  /** The turn stopped at its wall-clock budget, not because the work was
   * done: the build so far stands and a "continue" turn picks it up. The
   * client uses this to chain another segment instead of asking the user
   * to notice the line in the transcript. */
  | { type: "limit"; reason: "budget" | "view"; parts: number }
  /** The model asked to SEE the build and this deployment has no renderer:
   * the canvas renders these cameras and the next pass opens with them. */
  | { type: "view_request"; views: { lat: number; lon: number }[] }
  /** What this visitor has left on the house key, and which model they got.
   * Sent once at the start of a turn; absent when they brought their own key. */
  | { type: "quota"; model: CopilotModel; downgraded: boolean; buildsLeft: number }
  | { type: "done" };

export const invKey = (part: string, color: number) => `${part}:${color}`;
