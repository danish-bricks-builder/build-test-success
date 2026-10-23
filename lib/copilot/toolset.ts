/**
 * Which tools the copilot gets for one turn — the pure assembly step,
 * shared by the agent loop (lib/copilot/agent.ts) and the tool catalogue
 * (lib/copilot/catalog.ts), so the settings page and the agent can never
 * disagree about what a mode offers.
 *
 *   mode filter      TOOLS minus the mode's drop set, plus the mode's
 *                    connect-first tools (today's behaviour)
 *   verifier filter  verifierTools === false drops check_validity/_stability
 *   + vision, extras render_view and the route's context tools
 *   allowlist        `allow` (the user's copilot settings): keep only the
 *                    named tools, out of everything the mode OFFERS — which
 *                    also includes the mode's optional tools (off by default)
 *
 * No allowlist = exactly the pre-settings tool list.
 */

export type ToolMode = "coords" | "connect" | "mate";
export const TOOL_MODES: ToolMode[] = ["coords", "connect", "mate"];

interface Named {
  name: string;
}

/** v2 swaps the coordinate-authoring tools for connection-first ones. */
export const V1_ONLY = new Set(["place_parts", "emit_parts_script", "define_assembly", "place_assembly"]);
/** v3 (mate language) is stricter still: no coordinate authoring beyond the
 * single anchor, no script placement, and no reference designs — the build
 * is expressed purely as connector mates. */
export const MATE_DROP = new Set([...V1_ONLY, "get_reference"]);
/** connect mode also drops get_reference: its caption retrieval over the
 * s2b voxel corpus is keyword roulette ("castle watchtower" → a chair with a
 * castle-like backrest) — design_layout replaces it. */
export const CONNECT_DROP = new Set([...V1_ONLY, "get_reference"]);
/** Mate mode keeps anchor_part + place_on from the connect toolset (both
 * express mates), plus the module pair (a stamped module preserves its
 * internal mates — reuse, not coordinate authoring). It drops only
 * run_connect_script (script authoring, not a named mate). */
export const MATE_CONNECT = new Set([
  "anchor_part",
  "place_on",
  "define_module_from",
  "stamp_module",
  "free_connectors",
  "attach_options",
  "attach_option",
  "mirror_stamp",
  "silhouette",
]);
/** Tools a mode leaves OFF by default but the user may switch on in the
 * copilot settings (the dispatcher runs them in any mode). */
export const OPTIONAL_IN: Record<ToolMode, Set<string>> = {
  coords: new Set(),
  connect: new Set(["get_reference"]),
  mate: new Set(["get_reference"]),
};
export const VERIFIER_TOOLS = new Set(["check_validity", "check_stability"]);

export function assembleTools<T extends Named>(o: {
  tools: T[];
  connectTools: T[];
  mode?: ToolMode;
  verifierTools?: boolean;
  vision?: T;
  extra?: T[];
  /** the user's allowlist; undefined = defaults */
  allow?: readonly string[];
}): T[] {
  const mode: ToolMode = o.mode === "mate" ? "mate" : o.mode === "connect" ? "connect" : "coords";
  const allow = o.allow ? new Set(o.allow) : null;
  const drop = mode === "mate" ? MATE_DROP : mode === "connect" ? CONNECT_DROP : null;
  const optional = OPTIONAL_IN[mode];
  let baseTools = o.tools.filter((t) => !drop?.has(t.name) || (allow && optional.has(t.name)));
  // verifier-in-the-loop is a TREATMENT: when off, the model builds blind
  // and the checks run only in the end-of-turn gate (graders-only condition)
  if (o.verifierTools === false) baseTools = baseTools.filter((t) => !VERIFIER_TOOLS.has(t.name));
  const connectExtra =
    mode === "mate" ? o.connectTools.filter((t) => MATE_CONNECT.has(t.name)) : mode === "connect" ? o.connectTools : [];
  const all = [...baseTools, ...connectExtra, ...(o.vision ? [o.vision] : []), ...(o.extra ?? [])];
  return allow ? all.filter((t) => allow.has(t.name)) : all;
}
