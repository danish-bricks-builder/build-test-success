/**
 * The copilot's tool catalogue — every tool the in-browser copilot can be
 * given, described for PEOPLE (the model's own descriptions live with the
 * tool schemas). Single source of truth for the settings page
 * (/copilot/settings, via GET /api/copilot/tools) and for the allowlist the
 * editor sends with each copilot request.
 *
 * Modes and defaults are not written by hand: they come from the same
 * assembleTools() the agent uses (lib/copilot/toolset), run over the names
 * here. `checkCatalogue` (called by GET /api/copilot/tools and by the
 * route in dev) asserts the names match the real tool arrays, so an added
 * or renamed tool without an entry here is caught.
 *
 * Client-safe: no server imports.
 */
import { TOOL_MODES, assembleTools, type ToolMode } from "./toolset";

export type { ToolMode };

export const TOOL_GROUPS = [
  "Find parts",
  "Place & connect",
  "Look",
  "Move joints",
  "Check",
  "Plan",
  "Notes",
  "Reference",
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** core = lib/copilot/agent TOOLS, connect = CONNECT_TOOLS, route = added by
 * /api/copilot (eyes, context tools, referee), placeholder = not built yet. */
export type ToolSource = "core" | "connect" | "route" | "placeholder";

export interface CatalogEntry {
  name: string;
  /** one plain-English line for people */
  description: string;
  group: ToolGroup;
  source: ToolSource;
  /** route tools only appear when the request carries their context */
  when?: string;
}

export interface CatalogTool extends CatalogEntry {
  /** per mode: offered by default, available but off by default, or absent */
  modes: Record<ToolMode, "default" | "optional" | null>;
}

const ENTRIES: CatalogEntry[] = [
  // Find parts
  { name: "search_parts", group: "Find parts", source: "core", description: "Search the part library by name or number." },
  { name: "list_connectors", group: "Find parts", source: "core", description: "List a part's studs, holes, pins and axles, to plan an exact attachment." },
  { name: "find_parts", group: "Find parts", source: "core", description: "Find parts in the current build by colour, part number, area or height." },

  // Place & connect — coordinates (v1)
  { name: "place_parts", group: "Place & connect", source: "core", description: "Place parts at stud coordinates." },
  { name: "emit_parts_script", group: "Place & connect", source: "core", description: "Write a small program that places many parts at coordinates (walls, patterns)." },
  { name: "define_assembly", group: "Place & connect", source: "core", description: "Define a reusable sub-assembly from coordinates." },
  { name: "place_assembly", group: "Place & connect", source: "core", description: "Place a copy of a defined sub-assembly." },
  // Place & connect — connection-first (v2/v3)
  { name: "anchor_part", group: "Place & connect", source: "connect", description: "Put the first part of a structure on the baseplate." },
  { name: "place_on", group: "Place & connect", source: "connect", description: "Seat a part on top of another part, studs engaged." },
  { name: "attach_part", group: "Place & connect", source: "core", description: "Attach a part exactly to another part's connector (wheel on pin, pin in hole)." },
  { name: "attach_chain", group: "Place & connect", source: "core", description: "Attach several parts in a chain in one go, or none if the last one won't fit." },
  { name: "attach_options", group: "Place & connect", source: "connect", description: "List the ways a part can be seated on another part, ranked." },
  { name: "attach_option", group: "Place & connect", source: "connect", description: "Pick one seating from that list." },
  { name: "define_module_from", group: "Place & connect", source: "connect", description: "Save already-built parts as a reusable module." },
  { name: "stamp_module", group: "Place & connect", source: "connect", description: "Place a copy of a saved module." },
  { name: "mirror_stamp", group: "Place & connect", source: "connect", description: "Place a mirrored copy of a module (build the left side, mirror the right)." },
  { name: "run_connect_script", group: "Place & connect", source: "connect", description: "Write a small program that builds course on course by connection." },
  { name: "build_program", group: "Place & connect", source: "connect", description: "Write a program with loops that places many parts at once — walls, columns, mirrored halves." },
  { name: "remove_parts", group: "Place & connect", source: "core", description: "Remove parts." },
  { name: "recolor_parts", group: "Place & connect", source: "core", description: "Change the colour of parts." },
  { name: "settle_build", group: "Place & connect", source: "core", description: "Drop the whole build so it rests on the ground." },
  { name: "join_structures", group: "Place & connect", source: "core", description: "Bridge separate structures into one with spanning plates." },

  // Look
  { name: "render_view", group: "Look", source: "route", when: "Needs the renderer on this computer", description: "See the build as a picture from any angle. Off = the copilot works blind (no first look either)." },
  { name: "inspect_build", group: "Look", source: "core", description: "Read the build as a list: footprint, layers, overlaps." },
  { name: "silhouette", group: "Look", source: "connect", description: "See the build's outline from the top, front or side as text." },
  { name: "free_connectors", group: "Look", source: "connect", description: "See which studs, holes and pins are still free to attach to." },
  { name: "highlight_body", group: "Look", source: "route", when: "Only when the model's bodies are detected", description: "Light up rigid bodies in your view to point at them." },
  { name: "highlight_joint", group: "Look", source: "route", when: "Only when the model's bodies are detected", description: "Light up a joint in your view and show it moving." },
  { name: "highlight_region", group: "Look", source: "route", when: "Only when the set has named regions", description: "Light up a named region (“roof”, “driver door”) in your view." },
  { name: "highlight_parts", group: "Look", source: "route", when: "Only when the set has named regions", description: "Light up any chosen parts in your view." },
  { name: "ground_reference", group: "Look", source: "route", when: "Only when the model's bodies are detected", description: "Work out which bodies a phrase like “the roof” means, by looking at renders." },
  { name: "find_similar_bodies", group: "Look", source: "route", when: "Only when the model's bodies are detected", description: "Find every body shaped like a given one (all the wheels, all the containers)." },

  // Move joints
  { name: "set_joint_angle", group: "Move joints", source: "route", when: "Only when the model has movable joints", description: "Turn a joint to an angle (open a door, raise a boom)." },
  { name: "demo_joint", group: "Move joints", source: "route", when: "Only when the model has movable joints", description: "Animate a joint through its range in your view." },

  // Check
  { name: "check_validity", group: "Check", source: "core", description: "Check for collisions, loose parts and floating parts while building." },
  { name: "check_stability", group: "Check", source: "core", description: "Check whether the build would stand up under gravity while building." },
  { name: "grade_build", group: "Check", source: "route", when: "Not in recorded experiments", description: "Run the full referee: geometry, connections, stability, mechanisms, gear trains." },
  { name: "decompile_build", group: "Check", source: "route", when: "Not in recorded experiments", description: "Explain the build as a connection program, to spot parts that aren't really attached." },

  // Plan
  { name: "design_layout", group: "Plan", source: "core", description: "Lay out the build as named sections with sizes before building." },
  { name: "get_heuristics", group: "Plan", source: "core", description: "Look up building tips for a topic (roofs, wheels, gears)." },
  { name: "get_reference", group: "Plan", source: "core", description: "Look up example structures from a 47k-structure dataset (hit and miss)." },
  { name: "view_instructions", group: "Plan", source: "route", when: "Only when the set's instruction booklets are on this computer", description: "Read the set's instruction booklet page by page." },

  // Notes
  { name: "write_note", group: "Notes", source: "core", description: "Write the copilot's scratchpad note for this chat (plans, measurements)." },
  { name: "read_note", group: "Notes", source: "core", description: "Read the scratchpad note back." },

  // Reference — PLACEHOLDER. Not implemented; the design is still being
  // decided. It never reaches the model (source "placeholder").
  { name: "find_references", group: "Reference", source: "placeholder", description: "Search real LEGO sets for sub-assemblies (coming)." },
];

const stub = (source: ToolSource) => ENTRIES.filter((e) => e.source === source).map((e) => ({ name: e.name }));

/** Every tool with its per-mode availability, computed by the agent's own
 * assembly function (defaults = no allowlist; optional = offered only when
 * an allowlist names it). */
export function catalogue(): CatalogTool[] {
  const core = stub("core");
  const connect = stub("connect");
  const route = stub("route");
  const byMode = Object.fromEntries(
    TOOL_MODES.map((mode) => {
      const on = new Set(assembleTools({ tools: core, connectTools: connect, mode, extra: route }).map((t) => t.name));
      const offered = new Set(
        assembleTools({ tools: core, connectTools: connect, mode, extra: route, allow: ENTRIES.map((e) => e.name) }).map((t) => t.name),
      );
      return [mode, { on, offered }];
    }),
  ) as Record<ToolMode, { on: Set<string>; offered: Set<string> }>;
  return ENTRIES.map((e) => ({
    ...e,
    modes: Object.fromEntries(
      TOOL_MODES.map((m) => [m, byMode[m].on.has(e.name) ? "default" : byMode[m].offered.has(e.name) ? "optional" : null]),
    ) as CatalogTool["modes"],
  }));
}

export const CATALOG_NAMES = new Set(ENTRIES.map((e) => e.name));

/** Drift check: the catalogue's core/connect names must equal the agent's
 * real TOOLS / CONNECT_TOOLS, and every route-added tool must have an
 * entry. Returns the problems (empty = in sync). */
export function checkCatalogue(real: { tools: string[]; connectTools: string[]; routeTools?: string[] }): string[] {
  const problems: string[] = [];
  const same = (label: string, want: string[], have: string[]) => {
    for (const n of want) if (!have.includes(n)) problems.push(`${label} tool "${n}" has no catalogue entry`);
    for (const n of have) if (!want.includes(n)) problems.push(`catalogue lists ${label} tool "${n}" that does not exist`);
  };
  same("core", real.tools, ENTRIES.filter((e) => e.source === "core").map((e) => e.name));
  same("connect", real.connectTools, ENTRIES.filter((e) => e.source === "connect").map((e) => e.name));
  const route = new Set(ENTRIES.filter((e) => e.source === "route").map((e) => e.name));
  for (const n of real.routeTools ?? []) if (!route.has(n)) problems.push(`route tool "${n}" has no catalogue entry`);
  return problems;
}

/** Per-mode switches the user changed: name → on/off. */
export type ToolOverrides = Record<string, boolean>;

/** Is a tool on in this mode, given the user's overrides? */
export function toolOn(t: CatalogTool, mode: ToolMode, overrides: ToolOverrides | undefined): boolean {
  if (t.source === "placeholder" || !t.modes[mode]) return false;
  return overrides?.[t.name] ?? t.modes[mode] === "default";
}

/** The allowlist for a request, or undefined when the user changed nothing
 * in this mode (the server then uses its defaults, unchanged). */
export function allowlistFor(mode: ToolMode, overrides: ToolOverrides | undefined, cat = catalogue()): string[] | undefined {
  if (!overrides) return undefined;
  const changed = cat.some((t) => t.modes[mode] && t.source !== "placeholder" && t.name in overrides && overrides[t.name] !== (t.modes[mode] === "default"));
  if (!changed) return undefined;
  return cat.filter((t) => toolOn(t, mode, overrides)).map((t) => t.name);
}
