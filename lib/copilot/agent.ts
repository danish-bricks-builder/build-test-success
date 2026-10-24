/**
 * Shared copilot agent core.
 *
 * `runAgentTurn` runs ONE assistant turn — the server-side tool loop against
 * a working copy of a build (a {@link BuildSession}) — and reports progress
 * through an `onEvent` callback instead of talking to any transport directly.
 *
 * One caller wires it to a transport:
 *  - `app/api/copilot/route.ts` → the editor copilot and the LeoCAD dock.
 *
 * Keeping the loop here means both surfaces share the exact same tools,
 * validation gate and system prompt — the "brain" the LeoCAD sidecar reuses.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { extentOfParts } from "../engine/footprint";
import { attachChain, attachPart, collisionCount, getPartIndex, collisionReport, jointEdges, jointReport, listConnectors, settleBuild, stabilityReport, unconnectedCount } from "@/lib/copilot/connect";
import { findReferences, referencesBlock } from "@/lib/generate/references";
import { searchParts } from "@/lib/data/partSearch";
import { partCard, placedCard } from "./partCard";
import { renderAvailable } from "@/lib/render";
import { toLdr } from "@/lib/ldraw/serialize";
import { attachOption, attachOptions, freeConnectors, mirrorStamp, silhouetteView } from "./spatial";
import { HEURISTICS, findHeuristics, heuristicsBlock } from "@/lib/copilot/heuristics";
import { metaOf } from "@/lib/engine/geometry";
import { checkSoundness } from "@/lib/engine/soundness";
import { designLayout, type DesignInput } from "@/lib/copilot/design";
import {
  defineAssembly,
  findParts,
  inspectBuild,
  placeAssembly,
  placeParts,
  recolorParts,
  removeParts,
  type BuildSession,
  type PartFilter,
  type PlacementInput,
} from "@/lib/copilot/state";
import { runPartsScript } from "@/lib/copilot/scriptTool";
import { bridgeStructures } from "./bridge";
import { runBuildProgram } from "@/lib/copilot/buildprog";
import { cheapAbove, diagnose, type FailureCtx } from "@/lib/copilot/diagnose";
import { anchorPart, defineModuleFrom, placeOnStuds, runConnectScript, stampModule } from "@/lib/copilot/connect2";
import { createProvider } from "@/lib/copilot/providers";
import { resolveCopilotModel } from "@/lib/copilot/types";
import { assembleTools } from "@/lib/copilot/toolset";
import type { ChatMessage, CopilotEvent, CopilotModel } from "@/lib/copilot/types";

export const MAX_TOOL_ITERATIONS = 28;
const MAX_REPAIR_ROUNDS = 2;
const MAX_STABILITY_ROUNDS = 2;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "place_parts",
    description:
      "Place one or more parts. x_stud/z_stud are the part-origin position in STUD units (1 stud = 20 LDU; use .5 steps for odd-dimension footprints, whole numbers for even). Omit y_ldu to auto-stack on whatever is below (recommended). rot rotates about the vertical axis; at rot 0 a part's long axis runs along X. Batch related placements into one call. Each item reports OK or REJECTED with a reason.",
    input_schema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              part: { type: "string", description: "LDraw part number, e.g. 3001" },
              color: { type: "number", description: "LDraw color code" },
              x_stud: { type: "number" },
              z_stud: { type: "number" },
              rot: { type: "number", enum: [0, 90, 180, 270] },
              y_ldu: { type: "number", description: "Advanced: explicit bottom height in LDU" },
            },
            required: ["part", "color", "x_stud", "z_stud"],
          },
        },
      },
      required: ["parts"],
    },
  },
  {
    name: "remove_parts",
    description:
      "Remove parts by index (indices from inspect_build; they shift down after removal). " +
      "A BULK removal is refused: a validity or stability warning is a list of specific defects to repair, " +
      "not a reason to scrap the build. Set rebuild_from_scratch:true only when you genuinely mean to throw " +
      "the whole model away and start over.",
    input_schema: {
      type: "object",
      properties: {
        indices: { type: "array", items: { type: "number" } },
        rebuild_from_scratch: {
          type: "boolean",
          description:
            "Deliberate override for a bulk removal (default false). Not for fixing reported problems.",
        },
      },
      required: ["indices"],
    },
  },
  {
    name: "recolor_parts",
    description: "Change the color of parts by index.",
    input_schema: {
      type: "object",
      properties: {
        indices: { type: "array", items: { type: "number" } },
        color: { type: "number" },
      },
      required: ["indices", "color"],
    },
  },
  {
    name: "inspect_build",
    description:
      "Get the current build: footprint bounds, overlap warnings, per-course occupancy maps (bigger builds) or exact part list (small builds), remaining inventory when building from a set.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "emit_parts_script",
    description:
      "Your power tool for anything structured or repetitive: write JavaScript that computes placements. The sandbox provides place(part, color, x_stud, z_stud, opts?) where opts = {rot: 0|90|180|270, y: y_ldu} (omit y to auto-stack), and log(msg) for debugging. Loops, functions and math are yours — e.g. running-bond walls: alternate 3001/3010 bricks with offset per course. Max 2000 placements, 2s CPU. Every placement is validated (collision/inventory) and reported like place_parts.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript source" } },
      required: ["code"],
    },
  },
  {
    name: "define_assembly",
    description:
      "Define a named reusable module (window unit, roof segment, wheel corner…) as placements RELATIVE to the assembly's own origin. CALL THIS whenever a substructure will appear 2+ times, and when copying an existing structure the user points at — define it once from the inspected parts, then stamp instances. Valid for this turn; stamp with place_assembly.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              part: { type: "string" },
              color: { type: "number" },
              x_stud: { type: "number" },
              z_stud: { type: "number" },
              rot: { type: "number", enum: [0, 90, 180, 270] },
              y_ldu: { type: "number" },
            },
            required: ["part", "color", "x_stud", "z_stud"],
          },
        },
      },
      required: ["name", "parts"],
    },
  },
  {
    name: "place_assembly",
    description:
      "Stamp a defined assembly at (x_stud, z_stud) rotated by rot about its origin. Prefer define_assembly + repeated place_assembly over re-placing the same parts brick by brick — it is faster, keeps instances identical, and makes symmetric builds (wheels, windows, table legs) line up exactly.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        x_stud: { type: "number" },
        z_stud: { type: "number" },
        rot: { type: "number", enum: [0, 90, 180, 270] },
      },
      required: ["name", "x_stud", "z_stud"],
    },
  },
  {
    name: "find_parts",
    description:
      "Query the CURRENT BUILD's parts by attributes → their indices, for recolor_parts/remove_parts. Filters combine (AND): color (LDraw code), part (number), stud-coordinate region (min/max_x_stud, min/max_z_stud), height band (min/max_y_ldu). E.g. all white parts above y 96: {color:15, min_y_ldu:96}.",
    input_schema: {
      type: "object",
      properties: {
        color: { type: "number" },
        part: { type: "string" },
        min_x_stud: { type: "number" },
        max_x_stud: { type: "number" },
        min_z_stud: { type: "number" },
        max_z_stud: { type: "number" },
        min_y_ldu: { type: "number" },
        max_y_ldu: { type: "number" },
      },
    },
  },
  {
    name: "write_note",
    description:
      "Overwrite your persistent scratchpad note for this chat (plans, measurements, TODOs). It survives across turns — read it back with read_note. Keep it concise.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
  },
  {
    name: "read_note",
    description: "Read your persistent scratchpad note for this chat.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_heuristics",
    description:
      "Retrieve building heuristics (hard-won construction lessons) for a topic: 'roof', 'wheels', 'tower stability', 'SNOT', 'gears'… Use when starting an unfamiliar structure type or after repeated failures.",
    input_schema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
  {
    name: "get_reference",
    description:
      "Retrieve reference designs from a 47k-structure dataset matching a query (e.g. 'car', 'chair', 'sailboat'). Returns real buildable structures as brick-text ('HxW (x,y,z)' per brick, unit-height bricks in a 20x20x20 grid, z=layer). Study proportions and construction before building something you're unsure about — then adapt, don't copy blindly.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "list_connectors",
    description:
      "List a part's connectors (studs, anti-studs, pin holes, axles, clips, wheel pins…) from LDCad connection data. ref='part:4600' for a library part (local coords) or ref='index:3' for a placed part (world coords + axes). Use before attach_part. " +
      "Set show=true to SEE them as well: the part (or the build, for a placed one) rendered from two angles with a numbered glyph on each connector — red cone = stud or pin, blue ring = pocket or hole, ball = clip/finger/joint. Worth it before attaching to something whose geometry you are inferring from its name.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        show: { type: "boolean", description: "also render the connectors as a numbered map (default false)" },
      },
      required: ["ref"],
    },
  },
  {
    name: "attach_part",
    description:
      "EXACTLY attach a new part onto a placed part's connector (wheel onto wheel pin, tire onto wheel, pin into hole, axle into axle hole, plate onto bracket/headlight side studs). Solves position+orientation from connection data — use this instead of guessing coordinates for any non-stud connection. If the result looks flipped, retry with flip=true; slide (LDU) and roll (deg) adjust along/about the joint axis.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "number", description: "index of the placed part" },
        toConnector: { type: "number", description: "connector # from list_connectors" },
        part: { type: "string" },
        color: { type: "number" },
        partConnector: { type: "number", description: "connector # on the new part (omit = auto opposite gender)" },
        slide: { type: "number" },
        roll: { type: "number" },
        flip: { type: "boolean" },
      },
      required: ["to", "toConnector", "part", "color"],
    },
  },
  {
    name: "attach_chain",
    description:
      "Attach a CHAIN of parts atomically: link 1 onto the given connector, each next link onto the previous one (connectors auto-picked). The whole chain is fit-checked against the build — if the LAST link can't fit (e.g. the tire would hit the car body), NOTHING is placed. Use for wheel+tire: attach_chain(to=holder, toConnector=pin#, links=[{part:'4624',color:71},{part:'3641',color:0}]).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "number" },
        toConnector: { type: "number" },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: { part: { type: "string" }, color: { type: "number" } },
            required: ["part", "color"],
          },
        },
      },
      required: ["to", "toConnector", "links"],
    },
  },
  {
    name: "settle_build",
    description:
      "Drop the entire build so its lowest point rests on the ground (y=0). Use after assembling something on wheels so the tires touch the ground.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "join_structures",
    description:
      "TIE SEPARATE STRUCTURES TOGETHER. Parts bond only by STACKING (face to face, half a stud of overlap) — a wall raised beside its neighbour is a separate structure, however close it stands. This finds the separate structures and lays plates across them at a shared level until the build is one piece. Call it when check_validity reports more than one structure. NEVER delete the strays: bridge them.",
    input_schema: {
      type: "object",
      properties: {
        maxSpan: { type: "number", description: "How far apart two structures may be, in studs, and still be bridged (default 8)." },
        color: { type: "number", description: "LDraw colour for the ties (default: the colour of what they land on)." },
      },
    },
  },
  {
    name: "design_layout",
    description:
      "DESIGN BEFORE BUILDING: lay out the build as named subsystems — footprint rectangles (studs) with height bands (bricks). Returns an ASCII top view, per-subsystem dimensions, and a mechanical plan review: envelope violations, same-space overlaps, floating layers. Call this FIRST for any substantial build (copy the mission's size limits into `envelope`), fix the warnings, THEN build one subsystem at a time. The plan is saved to your note.",
    input_schema: {
      type: "object",
      properties: {
        envelope: {
          type: "object",
          properties: {
            maxW: { type: "number", description: "mission footprint limit, studs" },
            maxL: { type: "number" },
            minHeightBricks: { type: "number" },
          },
        },
        subsystems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              x0: { type: "number", description: "min-corner x in studs" },
              z0: { type: "number" },
              w: { type: "number", description: "width in studs" },
              l: { type: "number" },
              y0: { type: "number", description: "bottom, in bricks from ground (0 = on the ground)" },
              h: { type: "number", description: "height in bricks" },
              note: { type: "string" },
            },
            required: ["name", "x0", "z0", "w", "l"],
          },
        },
      },
      required: ["subsystems"],
    },
  },
  {
    name: "check_validity",
    description:
      "Run the full validity check NOW: voxel collisions (cavities respected), joint validation (every part really attached), and groundedness. Free and instant — use it after each building stage instead of guessing. Returns per-part problems with indices.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_stability",
    description:
      "Run the physical-stability check NOW (rigid-body statics): would the build stand unglued under gravity? Reports topple margins and any sub-assembly hanging past its support with WHICH parts and the fix direction. Use after each stage of a tall or overhanging build.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_parts",
    description:
      "Search the part library by name or number. Returns part numbers with footprint sizes. " +
      "Set show=1..3 to also SEE the top hits: a render of each part with a numbered glyph on every " +
      "connector (red cone = stud or pin, blue ring = pocket or hole, ball = clip/finger/joint), plus " +
      "the same connectors as text. Worth it for anything whose shape you are guessing at — a hinge, a " +
      "bracket, a wheel holder — and wasted on a 2x4 brick.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        show: { type: "number", description: "render this many of the top hits as part cards (0-3, default 0)" },
      },
      required: ["query"],
    },
  },
];

/** v2 CONNECTION-FIRST tools — replace the coordinate-authoring tools
 * when toolMode is "connect". */
export const CONNECT_TOOLS: Anthropic.Tool[] = [
  {
    name: "free_connectors",
    description:
      "MATE-OCCUPANCY READ: every placed part's FREE (unengaged) connectors, grouped by kind and world " +
      "face (up/down/side), plus engaged counts. Ask this before attaching — it tells you what can be " +
      "built on and where, without rendering.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "attach_options",
    description:
      "Placement as CHOICE: ranked, numbered, collision-free seatings of a part onto placed part [to] " +
      "(optionally restricted to the target's connector C index). Read the list, then commit one with " +
      "attach_option. Prefer this over attach_part guessing.",
    input_schema: {
      type: "object",
      properties: {
        part: { type: "string" },
        to: { type: "number" },
        toConnector: { type: "number", description: "0-based connector index on the target (optional)" },
        limit: { type: "number" },
      },
      required: ["part", "to"],
    },
  },
  {
    name: "attach_option",
    description: "Commit seating #option from the most recent attach_options list, in the given color.",
    input_schema: {
      type: "object",
      properties: { option: { type: "number" }, color: { type: "number" } },
      required: ["option", "color"],
    },
  },
  {
    name: "mirror_stamp",
    description:
      "Bilateral symmetry in ONE op: stamp a defined module MIRRORED across the vertical plane x=at_stud. " +
      "Handed parts (wings/wedges L/R) swap automatically. Build the left wing once, mirror the right.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, at_stud: { type: "number" } },
      required: ["name", "at_stud"],
    },
  },
  {
    name: "silhouette",
    description:
      "SPATIAL-OCCUPANCY READ: orthographic ASCII silhouette of the whole build from top, front, or side " +
      "— exact shape feedback (studs, proportions, gaps) cheaper and sharper than a render.",
    input_schema: {
      type: "object",
      properties: { axis: { type: "string", enum: ["top", "front", "side"] } },
      required: ["axis"],
    },
  },
  {
    name: "anchor_part",
    description:
      "Ground a part on the BASEPLATE at stud coordinates — the ONLY coordinate-based placement. Use it " +
      "for the first part of a structure (or a deliberately separate structure). Everything else must be " +
      "placed relative to existing parts (place_on / attach_part / build_program).",
    input_schema: {
      type: "object",
      properties: {
        part: { type: "string" },
        color: { type: "number" },
        x_stud: { type: "number" },
        z_stud: { type: "number" },
        rot: { type: "number", enum: [0, 90, 180, 270] },
      },
      required: ["part", "color", "x_stud", "z_stud"],
    },
  },
  {
    name: "place_on",
    description:
      "Seat a part ON TOP of an existing part, stud-engaged BY CONSTRUCTION: position derives from the " +
      "TARGET part (dx/dz = stud offset from the target's footprint center, world axes), snaps to the " +
      "legal stud lattice, and is REJECTED unless at least one real stud joint forms (so you cannot place " +
      "onto tiles, slope faces, or thin air). Returns the new part's index for chaining.",
    input_schema: {
      type: "object",
      properties: {
        part: { type: "string" },
        color: { type: "number" },
        onto: { type: "number", description: "index of the target part" },
        dx_studs: { type: "number", description: "stud offset from target center along X (default 0)" },
        dz_studs: { type: "number", description: "stud offset from target center along Z (default 0)" },
        rot: { type: "number", enum: [0, 90, 180, 270] },
      },
      required: ["part", "color", "onto"],
    },
  },
  {
    name: "define_module_from",
    description:
      "Snapshot ALREADY-BUILT parts (by index) as a named reusable MODULE — the connect-mode subassembly " +
      "mechanism. Build one wheel corner (holder + attached wheel + tire), snapshot it, then stamp_module " +
      "three more: identical by construction, matrix poses preserved. USE THIS whenever a substructure " +
      "repeats (wheel corners, seats, wall segments, wing pairs).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        indices: { type: "array", items: { type: "number" }, description: "part indices from inspect_build" },
      },
      required: ["name", "indices"],
    },
  },
  {
    name: "stamp_module",
    description:
      "Stamp a copy of a snapshotted module: its reference point (first part) goes to (x_stud, z_stud), " +
      "rotated by rot about that point; HEIGHTS ARE PRESERVED (a ground-level wheel corner stamps at ground " +
      "level). The whole stamp is collision-checked as a unit — if anything clashes, nothing is placed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        x_stud: { type: "number" },
        z_stud: { type: "number" },
        rot: { type: "number", enum: [0, 90, 180, 270] },
      },
      required: ["name", "x_stud", "z_stud"],
    },
  },
  {
    name: "run_connect_script",
    description:
      "The v2 power tool for walls/floors/roofs/towers: JavaScript where placements EXECUTE LIVE and " +
      "return indices, so courses chain onto previous courses. Sandbox functions: " +
      "anchor(part,color,x_stud,z_stud,rot?) → idx; on(part,color,ontoIdx,dx_studs,dz_studs,rot?) → idx " +
      "(stud-engagement enforced, -1 on rejection); attach(part,color,toIdx,connector#,{flip,slide,roll}?) → idx; " +
      "log(msg). Example running-bond wall: keep an array of the previous course's indices, seat each " +
      "brick with on(...) onto the brick below it, offset by half a brick every other course. " +
      "Max 1200 ops, 2s CPU.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "build_program",
    description:
      "THE PREFERRED WAY TO PLACE MORE THAN ~10 PARTS. Write a small JavaScript PROGRAM with LOOPS " +
      "instead of one line per brick — a 132-brick wall is five lines here. Placements execute live " +
      "and are fit-checked, engagement-checked and inventory-checked exactly like the single-part " +
      "tools, so illegal placements are refused, not created. Rejections are COLLECTED, not fatal — " +
      "one bad brick does not kill a 300-part program (pass strict:true to stop at the first one). " +
      "The result is a one-line summary, never a list of placements.\n" +
      "API (refs are opaque handles; a refused op returns -1, or [] for stamp/mirror):\n" +
      "  anchor(part,color,xStud,zStud,rot?) → ref — ground a part on the baseplate (the only coordinates)\n" +
      "  on(part,color,baseRef,dxStud,dzStud,rot?) → ref — seat on baseRef's studs; dx/dz are CENTRE-TO-CENTRE stud offsets; rejected unless a real stud joint forms\n" +
      "  attach(part,color,baseRef,connIdx,{flip,slide,roll}?) → ref — pin/axle/clip/ball/side-stud, solved from connection data\n" +
      "  seat(part,color,baseRef,{conn,option}?) → ref — let the solver pick the best legal seating\n" +
      "  module(name,[refs]) → bool · stamp(name,xStud,zStud,rot?) → [refs] · mirror(name,xStud) → [refs]\n" +
      "  settle() · count() → parts in the build · log(msg)\n" +
      "REGIONS — say WHAT to build, not where every brick goes. These lay a whole area at once, in running " +
      "bond, mirrored about x=0, each piece landed on whatever is actually under it:\n" +
      "  put(part,color,x,z,rot?) — one part with its LOWER-LEFT cell at (x,z), stacked on what is below\n" +
      "  fill(x,z,w,l,color,{kit,bond,mirror,skip}?) — a solid w×l rectangle, one course; kit: \"bricks\"|\"plates\"|\"tiles\"; skip: [[x,z,w,l]] cells left empty\n" +
      "  ring(x,z,w,l,t,color,opts?) — four walls t studs thick, hollow inside\n" +
      "  walls(x,z,w,l,t,color,courses,opts?) — a ring repeated `courses` high, alternating the bond for you\n" +
      "DOORS AND WINDOWS ARE BUILT, NOT CARVED. Pass openings to walls() and the courses are laid around the hole, " +
      "with a lintel brick bridging the course above it so nothing floats:\n" +
      "  walls(-6,-5,12,10,1,4,5,{openings:[{side:\"front\",at:0,w:2,from:0,h:3},{side:\"right\",at:0,w:2,from:2,h:2}]})\n" +
      "  side: \"front\" is the wall the default render and the front silhouette SHOW — put the door there — then " +
      "\"back\" | \"left\" | \"right\" · at: centre offset along that wall in studs (0 = centred) · " +
      "w: width in studs · from: first open course (0 = ground) · h: height in courses. A door is from:0; a window starts a course or two up.\n" +
      "NEVER build a solid box and then remove_parts to make a doorway: every deletion renumbers the parts, drops the " +
      "support under the course above, and splits the build into separate structures — it is the slowest way to fail. " +
      "A house with a door and two windows is ONE walls() call.\n" +
      "  stack(x,z,part,color,n) · colonnade(xs,z,part,color,n) · row(count,pitch) → centred x positions\n" +
      "  topAt(x,z) → [ref,y,cx,cz] what is under a cell · flat(x,z,w,l) → is that area one level? · size(part) → [w,l,h]\n" +
      "A 24-stud facade with ten columns, a stepped terrace and a dome is about 25 lines of this and lands ~600 " +
      "parts in one call. Check flat() before raising anything: a course laid over an uneven area lands on the " +
      "TALLEST cell it covers and cantilevers over the rest.\n" +
      "CHECK A BIG PROGRAM CHEAPLY: pass dry_run:true and it runs against a throwaway copy — you get the same " +
      "placed/refused report, with the reasons and what would have fitted, and the build is NOT touched. " +
      "That is the cheap way to test a large or risky program: one call, instead of placing it and then " +
      "having to take it out again. A dry run places NOTHING: when it comes back clean you must send the " +
      "SAME program again without dry_run, or the parts never exist. Use it for a program you are unsure " +
      "of, not for every program — a clean one placed directly costs half as many calls.\n" +
      "Refusals come back explained — the reasons are deduped with counts and the commonest ones name the " +
      "seating that WOULD have been accepted. Fix those placements; do not delete what is already standing.\n" +
      "Examples —\n" +
      "  wall (6 courses of 2x4 in running bond): let row=[]; for(let i=0;i<8;i++) row.push(anchor('3001',19,-14+i*4,-10));\n" +
      "    for(let c=1;c<6;c++){ const n=[]; for(const r of row){ const k=on('3001',19,r,c%2?2:0,0); if(k>=0) n.push(k);} row=n; }\n" +
      "  row of 6 round columns, 5 bricks tall: for(let i=0;i<6;i++){ let r=anchor('3941',19,-10+i*4,8); for(let h=0;h<5;h++) r=on('3941',19,r,0,0); }\n" +
      "  mirrored wing: module('wing',[a,b,c]); mirror('wing',0);\n" +
      "Limits: 800 placements, 2s CPU, 8KB of source. No require/import, no filesystem, no network.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source" },
        strict: {
          type: "boolean",
          description: "Stop the program at the first rejected placement (default false: collect and continue)",
        },
        dry_run: {
          type: "boolean",
          description:
            "Run against a throwaway copy of the build and report what WOULD be placed or refused, changing nothing (default false).",
        },
      },
      required: ["code"],
    },
  },
];

const COLOR_GUIDE =
  "Common LDraw colors: 0 black, 1 blue, 2 green, 4 red, 14 yellow, 15 white, 19 tan, 25 orange, 27 lime, 6 brown, 70 reddish brown, 71 light bluish gray, 72 dark bluish gray, 320 dark red, 322 medium azure, 5 pink, 47 trans-clear.";

/**
 * The engine's own account of a refused single placement, appended to the
 * refusal the model reads. Same module the build_program report and `./dbb`
 * use (lib/copilot/diagnose.ts) — never a second opinion. Returns "" when
 * there is nothing to add; a diagnosis is a courtesy and never fails a call.
 */
function explainRefusal(ctx: FailureCtx): string {
  try {
    const why = diagnose({ ...ctx, cheap: cheapAbove(ctx.session) });
    return why.length ? `\n${why.map((l) => l.slice(0, 220)).join("\n")}` : "";
  } catch {
    return "";
  }
}

/** A removal this size is always allowed, however small the build — clearing
 * a bad course must never need an override. */
const BULK_REMOVAL_FLOOR = 25;
/** Above the floor, a removal may still take this share of the build. */
const BULK_REMOVAL_SHARE = 0.2;

/**
 * THE PANIC DELETE.
 *
 * Measured failure mode: check_validity reports "21 separate structures,
 * 35 collisions", and the model answers by removing every part it has placed
 * and starting again — 347 parts in one call, then 215, then 268. Each cycle
 * costs a minute of wall clock and re-earns the same warnings, because the
 * warnings were about a handful of parts, not about the build.
 *
 * So a removal that would take more than {@link BULK_REMOVAL_SHARE} of the
 * build (never fewer than {@link BULK_REMOVAL_FLOOR} parts) is refused, and
 * the model is told to repair instead. Starting over stays possible — it just
 * has to be meant, via `rebuild_from_scratch`. Returns the refusal text, or
 * null when the removal may proceed.
 */
export function bulkRemovalRefusal(
  partCount: number,
  indices: number[],
  override: boolean,
): string | null {
  if (override) return null;
  const valid = [...new Set(indices)].filter((i) => i >= 0 && i < partCount);
  const limit = Math.max(BULK_REMOVAL_FLOOR, Math.floor(partCount * BULK_REMOVAL_SHARE));
  if (valid.length <= limit) return null;
  const pct = partCount ? Math.round((valid.length / partCount) * 100) : 100;
  return (
    `REFUSED: that would remove ${valid.length} of ${partCount} parts (${pct}% of the build) — over the ${limit}-part bulk limit. ` +
    `Nothing was removed.\n` +
    `A validity or stability report is a LIST OF SPECIFIC DEFECTS, not a verdict on the build: it names the floating indices, ` +
    `the colliding pairs and the stray structures. Repair those and only those —\n` +
    `  · floating / unconnected parts: re-place them on a stud or connector (build_program \`on\`/\`seat\`), or remove just those indices;\n` +
    `  · colliding pairs: move or remove ONE part of each pair;\n` +
    `  · several separate structures: BRIDGE them with plates spanning the gap — do not delete them.\n` +
    `Call inspect_build or check_validity for fresh indices, then remove at most ${limit} parts at a time. ` +
    `If you truly intend to throw the whole model away and start over, call remove_parts again with rebuild_from_scratch:true.`
  );
}

export interface PromptContext {
  /** The turn's user/assistant messages (string content) — drives heuristics RAG. */
  promptMessages: ChatMessage[];
  baseplate: number;
  /** True when building from a fixed inventory (constrained mode). */
  inventoryMode: boolean;
  /** True when a render_view tool is available (LeoCAD bridge) — adds guidance. */
  visionHint?: boolean;
  /** The eyes cost a pause: looking ends the pass and the picture arrives
   * with the next one (a deployment whose renderer is the user's canvas). */
  visionCostly?: boolean;
  /** True in v2 connection-first mode — swaps the building guidance. */
  connectMode?: boolean;
  /** True in v3 mate-language mode — replaces the building guidance with the
   * connector-to-connector mate language and its tool set. */
  mateMode?: boolean;
  /** check_validity / check_stability are offered — adds the staged
   * verification discipline to the prompt. */
  verifierHint?: boolean;
}

export function systemPrompt(ctx: PromptContext): string {
  // RAG over the heuristics store: last two user messages drive retrieval.
  const userText = ctx.promptMessages
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");
  const heuristics = findHeuristics(userText, 4);

  // ── v3: MATE LANGUAGE ──
  // A dedicated prompt. The build is authored as connector-to-connector
  // mates only — no coordinates beyond the single anchor, no references.
  if (ctx.mateMode) {
    return [
      "You are the building copilot inside Danish Bricks Builder, a browser LEGO-compatible CAD editor. You and the user build together on a shared baseplate — they see every part you place in real time.",
      "",
      "You build in MATE LANGUAGE. A model is nothing but a graph: parts are nodes, and every join between two parts is an edge — a MATE between one connector on part A and one connector on part B. You never state world coordinates and you never study reference designs. You name connectors and mate them. This is the exact language the corpus enumerator speaks: \"plate C3 stud ↔ brick C1 pocket\", \"beam C2 pin-hole ↔ pin C1 pin\".",
      "",
      "CONNECTORS. Every part carries numbered connectors (C1, C2, …) from its LDCad connection data. Each has a KIND and a GENDER:",
      "- stud (male) ↔ anti-stud / pocket (female): the ordinary brick-on-brick joint. A 2×4 brick has 8 studs on top and 8 anti-studs underneath.",
      "- pin (male) ↔ pin-hole 'R' (female, round bore): a Technic pin pressed into a beam/brick hole.",
      "- axle (male, cross-section '+') ↔ axle-hole 'A' (female, cross bore): a Technic axle keyed into an axle hole so they rotate together.",
      "- bar (male, thin rod) ↔ clip (female, C-jaw): a bar snapped into a clip; a hinge finger ↔ finger.",
      "- ball (male) ↔ socket (female): a ball joint.",
      "- wheel-pin ↔ wheel, and a tyre that wraps a wheel's rim: use attach_chain for these.",
      "A mate only forms between COMPATIBLE, OPPOSITE-gender connectors. Studs never mate into axle holes; a pin never mates into a stud pocket.",
      "",
      "THE ONLY COORDINATE you ever give is the first part's, via anchor_part (grounds it on the baseplate at stud x,z). Everything after that is placed by MATING it onto a part that is already in the build — so the whole model hangs off that one anchor by a chain of mates.",
      "",
      "TWO KINDS OF MATE, two tools:",
      "- STUD MATE → place_on. Seating a brick/plate flat on top of another part's studs is a mate, but you would never name one stud out of a hundred: place_on(part,color,onto,dx_studs,dz_studs,rot?) seats the part on target #onto's studs at a whole-stud offset (dx,dz) from the target's CENTRE, and is REJECTED unless a real stud joint forms (so you can't seat on a tile or in mid-air). This is your workhorse for walls, floors, plates, stacking. Returns the new part's index.",
      "- CONNECTOR MATE → attach_part. For everything that isn't a flat stud stack — pins into pin-holes, axles into axle-holes, bars into clips, balls into sockets, plates onto a headlight's or bracket's SIDE studs, wheels onto wheel-pins — you name the exact connectors. attach_part(to,toConnector,part,color,partConnector?,flip?,slide?,roll?) joins a new part onto placed part #to at its connector #toConnector; omit partConnector to auto-pick the opposite gender. The solver computes the exact pose. Returns the new index; retry flip=true if it mounts the wrong way.",
      "",
      "OTHER TOOLS:",
      "- anchor_part(part,color,x_stud,z_stud,rot?) → grounds the FIRST part of a structure. The only coordinates you state. Use again only to start a deliberately separate sub-structure.",
      "- list_connectors(ref) → a part's numbered connectors. ref='part:3001' = a library part in its own frame; ref='index:5' = a PLACED part with world positions/axes. For a big plate the output is GROUPED (e.g. \"CYL/M ×128 — studs: #233–#360\"); the MALE (M) group is the studs/pins you mate onto, the FEMALE (F) group is pockets/holes. Read this before attach_part to pick the right C-id.",
      "- attach_chain(to,toConnector,links=[{part,color},…]) → mate a chain atomically; if the LAST link can't fit, NOTHING is placed. Canonical use — a wheel then its tyre: attach_chain(to=holder, toConnector=<wheel-pin C-id>, links=[{part:'4624',color:71},{part:'3641',color:0}]).",
      "- define_module_from(name, indices) + stamp_module(name, x_stud, z_stud, rot) → snapshot a BUILT subassembly (its internal mates preserved) and stamp identical copies. Build ONE wheel corner, stamp three. For any substantial build, write_note a plan first (dimensions in studs + subassembly list), then build one subassembly at a time.",
      "- inspect_build() → current parts, JOINTS formed, COLLISIONS. Read it after each stage. search_parts / find_parts / recolor_parts / remove_parts / settle_build / write_note / read_note / get_heuristics as usual.",
      "",
      "WORKFLOW (repeat in small stages):",
      "1. anchor the first part (usually a base plate).",
      "2. STACK with place_on (dx,dz stud offsets from the target's centre) for walls/floors/plates. For a pin/axle/clip/ball/side-stud, list_connectors('index:N') then attach_part onto the right C-id.",
      "3. Read the returned index; build the next parts onto it.",
      "4. Every few mates, inspect_build. A part reported with NO valid connection is FLOATING — it isn't really mated; fix it. Reported COLLISIONS are real interpenetration (stud-in-pocket and pin-in-hole are correctly allowed) — fix them.",
      "5. If a mate is REJECTED: place_on 'no stud engagement' means there are no studs where you aimed (you seated on a tile/slope or off the part) — change dx/dz or the target; attach_part 'no pose engages' means wrong/blocked connector (often you picked a FEMALE underside connector instead of a top stud) — pick from the correct group; 'truly interpenetrates' means that space is occupied — move over.",
      "",
      "VEHICLES / PLANES (mate language): anchor a chassis plate; place_on the body plates and bricks to stack the shape. For each wheel: list_connectors on the wheel holder (4600) to find its wheel-pin C-id, then attach_chain the wheel (4624) + tyre (3641) onto it. For a plane: a long fuselage plate as the anchor, wings place_on'd or side-stud-mated to the sides, a tail at the rear, props/engines mated by pin or axle. Finish anything that stands on wheels with settle_build, then inspect_build — the turn isn't done until the verdict is sound with no floating parts.",
      "",
      COLOR_GUIDE,
      "Geometry, for reference only (you rarely need it): 1 stud = 20 LDU, a brick is 24 LDU tall, a plate 8; the baseplate is " + ctx.baseplate + "×" + ctx.baseplate + " studs centered on (0,0).",
      "",
      ...(heuristics.length
        ? ["Relevant building heuristics (hard-won lessons — follow them):", heuristicsBlock(heuristics), ""]
        : []),
      "STYLE: briefly narrate what you're mating, keep prose short, and build in stages — a few mates, then inspect_build, then continue. Never dump one giant plan. Respect the user's existing parts — never remove or recolor parts you didn't place unless asked.",
    ].join("\n");
  }

  return [
    "You are the building copilot inside Danish Bricks Builder, a browser LEGO-compatible CAD editor. You and the user build together on a shared baseplate — they see every part you place in real time.",
    "",
    "Geometry: 1 stud = 20 LDU horizontally; a brick is 24 LDU tall, a plate 8. Positions are part ORIGINS in stud units (origin = footprint center for normal parts). Even-dimension footprints sit on whole-stud positions, odd dimensions on .5 offsets. Omit y to stack automatically.",
    COLOR_GUIDE,
    `Baseplate: ${ctx.baseplate}×${ctx.baseplate} studs, centered on (0,0) — keep builds roughly within ±${ctx.baseplate / 2} studs.`,
    "",
    ctx.inventoryMode
      ? "MODE: BUILD FROM INVENTORY. You may ONLY use parts remaining in the inventory (specific part+color combinations). Placements outside the inventory are rejected. Check remaining stock with inspect_build and design around what's actually available."
      : "MODE: FREE BUILD. Any palette part in any color is available.",
    "",
    "You may receive a SCREENSHOT of the canvas with the user's message — use it to understand what things look like (which blocks are the roof, where the white pillows are…). Cross-reference visually-identified regions with find_parts (color/region filters) to get exact part indices before recoloring or removing.",
    "",
    ...(ctx.visionHint && ctx.visionCostly
      ? [
          "YOU CAN SEE, and a look costs a short pause. render_view hands the turn to the builder's canvas, which renders exactly the camera you name; this pass ends there and your next one OPENS WITH THE PICTURE a few seconds later, with everything you have built still standing. So look at STAGE BOUNDARIES — once the base and the identifying feature stand, before you commit the roof or dome, and at the end — rather than after every brick. One look per stage is right; two is the most that ever pays. Everything you learned stays in your note (write_note) across the pause.",
          "",
        ]
      : ctx.visionHint
      ? [
          "YOU CAN SEE. Call render_view any time to render the CURRENT build and look at it from a camera angle you pick (latitude ~25 for a 3/4 view, longitude 0–360 to spin around). USE IT LIBERALLY — before and after any tricky placement, to check orientation, gaps, alignment, collisions, and whether seats/minifigs actually fit. Do NOT build blind and guess from coordinates: place a part, render_view, and correct what you see. Spin to a side/top/rear angle when a single view is ambiguous.",
          "",
        ]
      : []),
    ...(heuristics.length
      ? ["Relevant building heuristics (hard-won lessons — follow them):", heuristicsBlock(heuristics), ""]
      : []),
    "Working style:",
    ...(ctx.connectMode
      ? [
          "CONNECTION-FIRST BUILDING (v2): you do NOT compute world coordinates. anchor_part grounds the FIRST part of a structure on the baseplate — that is the only coordinate you ever state. Every other part is placed RELATIVE to an existing part: place_on seats it on a target part's studs (offset in studs from the target's center) and is rejected unless a real stud joint forms; attach_part/attach_chain solve pins/axles/clips exactly. If a placement is rejected for NO STUD ENGAGEMENT, the surface genuinely has no studs there — pick a different target or offset, don't retry blindly.",
          "",
          "COMMON PARTS — use these numbers directly, never look them up; search_parts is only for something unusual:",
          "bricks 3005 1x1, 3004 1x2, 3622 1x3, 3010 1x4, 3009 1x6, 3008 1x8, 3003 2x2, 3002 2x3, 3001 2x4, 2456 2x6, 3007 2x8 · " +
            "plates 3024 1x1, 3023 1x2, 3710 1x4, 3460 1x8, 3022 2x2, 3020 2x4, 3034 2x8, 3031 4x4, 3036 6x8, 91405 16x16 · " +
            "tiles 3069b 1x2, 3068b 2x2 · round 3062b brick 1x1, 3941 brick 2x2, 6141 plate 1x1 · " +
            "slopes 45° 3040b 1x2, 3039 2x2, 3037 2x4, inverted 3665 1x2 · arch 3455 1x6 · technic 3701 brick 1x4, 3705 axle 4 · " +
            "ROUND AND DOMED (a dome costs no searches): plates round 4032 2x2, 60474 4x4, 11213 6x6 · dishes 3960 4x4 inverted, 4285b 6x6 · " +
            "dome tops 553 2x2, 86500 4x4 hemisphere, 57587 7x7 · cones 4589 1x1, 3942c 2x2 · round bricks 3062b 1x1, 3941 2x2, 6222 4x4.",
          "(1xN and 2xN bricks/plates lie along X at rot 0; the 1x2 slopes lie along Z. A brick is 24 LDU tall, a plate 8, a stud 20 wide — so three plates make a brick, and size(part) gives [w,l,h] for anything else.)",
          "",
          "PLAN BEFORE YOU BUILD (any substantial structure — a vehicle, a building, a creature):",
          "1. design_layout ONCE, before the first placement: name the subsystems (base, walls, door bay, roof, platform…), give each a footprint rectangle in studs and a height band in bricks, and copy the mission's size limits into `envelope`. It reviews the plan mechanically — envelope violations, overlaps, floating layers. ONE call per turn: a second call is refused and you build instead. A build without a reviewed plan drifts small, timid, and out of spec.",
          "2. Build ONE subsystem at a time in the plan's order; verify after each; the plan stays in your note (read_note) — follow it.",
          "3. SUBASSEMBLIES THAT REPEAT are modules: build the first one via connections, then define_module_from(indices) + stamp_module at each position. Never hand-rebuild a repeated substructure — stamped copies are identical by construction and fit-checked as a unit.",
          "- ANYTHING OVER ~10 PARTS GOES THROUGH build_program, and inside it use the REGION helpers (fill / ring / walls / colonnade), not one call per brick. A whole building is ~25 lines. Writing placements out by hand is the single biggest waste of a turn.",
          "- DOORS, WINDOWS, ARCHES AND GATEWAYS ARE BUILT, NOT CARVED. walls(...{openings:[…]}) lays each course around the hole and bridges the course above it with a lintel. Building a solid box and then deleting bricks to make the hole is the single most expensive mistake available to you: every removal renumbers the parts, takes the support out from under the course above, and splits the build into separate structures — which then reads as damage you try to repair by deleting more.",
          "- BONDING IS BY STACKING. Two parts bond when one sits ON the other with at least half a stud of overlap — parts side by side in the same course do NOT bond, however tightly they touch. So every course must be laid in running bond (the region helpers do this when you pass bond: c % 2), and anything you raise beside its neighbour is a SEPARATE STRUCTURE until something spans the two.",
          "- ONE STRUCTURE AT THE END. If check_validity reports more than one, call join_structures — it finds the gaps and lays spanning plates, raising the lower side when it has to. NEVER delete the strays: deleting good work to fix a connectivity report is the most expensive mistake available to you.",
          "- COLOUR IS PART OF THE DESIGN, not a default. Pick three or four and give each a job: a dark base (0 black, 72 dark bluish grey), the main material (15 white, 71 light grey, 19 tan, 5 sand), a roof or dome in a contrasting accent (288 dark green patina, 320 dark red, 484 dark orange, 379 sand blue), and trim or detail that pops (297 pearl gold, 14 yellow, 4 red, 0 black for windows). A model built entirely in light grey reads as unfinished even when the shape is right — the accent on the roof, the dark base under it and the dark windows in the wall are what make it look like a set.",
          "- SYMMETRY. Most things worth building are symmetric. Derive every rhythm — columns, windows, bays, wings — from the CENTRE LINE (Math.abs(x) % 3), never from an edge ((x + 12) % 3), or the pattern lands on one half of the model only. fill() already mirrors any rectangle that straddles x=0.",
          "- ORDER OF WORK: base → the STRUCTURE THAT IDENTIFIES the subject (the colonnade, the spire, the arch, the wheels) → the surrounding mass → the roof/dome → detail. The region helpers make plain mass cheap, which is exactly the trap: a turn spent filling a solid block leaves nothing recognisable. Put the identifying feature in before the bulk, so a build that runs out of time still reads as the thing.",
          "- SCALE AND IDIOM. A landmark or building reads best the way the real sets do it: a small footprint (15–25 studs across), PLATE resolution rather than 2×4 bricks, exposed top surfaces tiled, detail in 1×1s, the whole thing on a dark tiled base. 21022 Lincoln Memorial is 273 parts at 15×11 studs; a 58-stud brick-built massing of the same subject looks like a pile.",
          "- Track refs: keep arrays of each course's refs in your program; the RETURN VALUE of on()/anchor()/attach() is the new ref (-1 = rejected — check it).",
          "",
          "AN IMPRESSIVE CAR (the staged recipe — follow the stages, checking each with render_view when available):",
          "  plan: wheelbase 12–16 studs, width 6–8 studs, overall length 20+ — write these down first. Small cars read as toys; commit to the size.",
          "  stage 1 — wheel corners: anchor ONE wheel holder (4600) on the ground at the front-left axle position; attach_chain wheel 4624 + tire 3641 onto its pin. define_module_from those indices as 'corner'; stamp_module at the other three positions (mind rot 180 for the right side so pins face outward).",
          "  stage 2 — chassis: bridge the holders with long plates (place_on across their studs); double-layer for stiffness. The chassis must SPAN axle to axle, not float between.",
          "  stage 3 — body sides: fenders/arches over the wheels, side panels along the chassis edge — leave the wheel wells OPEN (tires need ~1 stud clearance).",
          "  stage 4 — front + cabin + rear: hood mass in front (1–2 bricks high), windscreen slope, cabin with an open or glazed interior, trunk/spoiler behind. Wheelbase ≈ 2/3 of length; cabin between the axles.",
          "  stage 5 — details: lights (1×1 trans round plates), grille tiles, mirrors, exhaust — details are what make it impressive.",
          "  finish: settle_build LAST, then inspect_build — sound, jointed, tires on the ground.",
        ]
      : [
          "- For anything structured or repetitive (walls, floors, roofs, towers), USE emit_parts_script: write clean JS with loops/functions instead of long coordinate lists. Bricklaying rules: alternate brick seams between courses (running bond — offset alternate courses by half a brick); hollow walls, not solid volumes; leave door/window gaps and bridge them with a lintel brick above.",
          "- define_assembly for repeated modules (a window unit, a roof segment), then place_assembly to stamp instances.",
        ]),
    "- After building a stage, inspect_build and READ the verdict + occupancy maps. VERDICT: UNSOUND with floating parts means gravity wins — those parts have no support path to the ground. Roofs must rest on walls (gable ends!), overhangs need columns. Never finish a turn on an UNSOUND build.",
    "- Placements that report ⚠ FLOATING are hovering in mid-air — fix immediately (fill beneath them or move them).",
    "- When you finish, the build is AUTO-VALIDATED (soundness, real joints, collisions), then AUTO-CHECKED FOR STABILITY (would it stand unglued under gravity — topple and stud-clutch cantilever limits). If either fails you'll get the report and must repair — so validate-as-you-go instead of leaving problems for the end.",
    ...(ctx.verifierHint
      ? [
          "- LOOK AT THE SHAPE EARLY. silhouette (front/side/top) is free: call it once the base and the identifying feature are standing, while there is still budget to change the massing. Called only at the end it tells you what you got, not what to fix.",
          "- VERIFICATION DISCIPLINE (free, instant — use them, don't guess): after each building STAGE (not after every script) call check_validity (collisions + attachment + groundedness with part indices), and for anything tall or overhanging call check_stability (statics: names WHICH parts hang and the fix direction). Fix what they report before building the next stage — a problem buried under later courses costs a rebuild.",
        ]
      : []),
    "- SEVERAL SEPARATE GROUNDED STRUCTURES ARE NORMAL while building (a row of columns before the beam that ties them together). That is not a defect: never remove or rebuild sound work because of it. Only FLOATING parts, UNCONNECTED parts and COLLISIONS are defects.",
    "- inspect_build reports JOINTS (real stud/pin/clip connections) — parts listed as having NO valid connection are not attached, even if they visually touch; fix them. It also reports COLLISIONS (true-geometry interpenetration; studs-in-tubes, pins-in-holes, and normal joint engagement are correctly allowed). Reported collisions are REAL problems — fix them. But do not thrash: if the same attach keeps flagging after one retry, accept it and move on.",
    "- If a placement is REJECTED, adapt: different position, color, or part.",
    "- Respect the user's existing work — never remove or recolor parts you didn't place unless asked.",
    "- NARRATION: about 15 words per step, naming only what you are about to do (\"Tan wall, 6 courses, running bond.\"). Do NOT restate the plan, do NOT summarize what you just built, do NOT write a closing recap — the UI already shows every tool call and its result. Prose is the slowest thing you do.",
    "- Parts need support below — omit y to auto-stack. A part placed at ground level when you meant to stack means your x/z missed the part below.",
    ...(ctx.connectMode || ctx.mateMode
      ? []
      : [
          "- BEFORE building any recognizable object (car, chair, boat, animal, building…), FIRST call get_reference with the object type and study a real structure's proportions and layering. Then design your own version — don't copy blindly. Skipping this step produces blobs.",
        ]),
    ctx.connectMode
      ? "- Keep each response SHORT: one line of narration + at most 2-3 tool calls, then wait for results. One build_program per subsystem is right; a program that builds the whole model at once is not (you want the verdict between stages)."
      : "- Keep each response SHORT: brief narration + at most 2-3 tool calls, then wait for results. Never write giant scripts in one go — build in stages.",
    "- NON-STUD connections (wheels, pins, axles, clips, side studs): NEVER guess coordinates. list_connectors → attach_part solves the exact placement from connection data. Vehicle recipe: place the chassis plate a few bricks up (e.g. y=40), stud-mount wheel holders (4600) under/on it with place_parts, then per holder: list_connectors('index:N') → attach_part wheel 4624 onto each wheel-pin connector → attach_part tire 3641 onto the wheel's GEN connector; ALWAYS finish with settle_build as the LAST build action (attaching wheels after settling re-floats the build) and then inspect_build — a vehicle turn is not done until the verdict is SOUND with tires on the ground.",
    "",
    ...(ctx.connectMode
      ? [
          "Example (build_program): a wall, each course seated on the last — this is the shape of ALL bulk building:",
          "  let below = []; for (let i=0;i<5;i++) below.push(anchor('3010', 4, i*4, 0));",
          "  for (let c=1;c<4;c++){ const next=[]; for (let i=0;i<below.length;i++){",
          "    const idx = on('3010', 4, below[i], c%2? 1: 0, 0); if (idx>=0) next.push(idx); }",
          "    below = next; }",
        ]
      : [
          "Example: a 10×8 house shell, walls 4 bricks tall with a door gap:",
          "  const B=(len)=>len===4?'3010':len===3?'3622':len===2?'3004':'3005';",
          "  function row(x0,z,x1,course,color){ /* place 1xN bricks along x with running bond */ }",
          "  // ...loop courses 0..3, skip cells for the door at the south wall, lintel above.",
        ]),
  ].join("\n");
}

export interface AgentTurnCtx {
  /** Working copy of the build; mutated in place by the tools. */
  session: BuildSession;
  /**
   * "coords" (default) = the v1 interface: the model computes world
   * coordinates (place_parts / emit_parts_script / assemblies).
   * "connect" = the v2 CONNECTION-FIRST interface: coordinates exist only
   * for anchors; everything else is placed relative to existing parts and
   * must ENGAGE (anchor_part / place_on / run_connect_script + attach_*).
   * "mate" = the v3 MATE-LANGUAGE interface: the build is authored purely
   * as connector-to-connector mates — anchor the first part, then every
   * other part is joined by naming a connector on it and a connector on a
   * placed part (attach_part / attach_chain). No coordinates, no stud-offset
   * seating, no references — the same connection language the enumerator
   * speaks ("plate C3 stud ↔ brick C1 pocket").
   */
  toolMode?: "coords" | "connect" | "mate";
  /** Original turn messages (string content) — for the system prompt / RAG. */
  promptMessages: ChatMessage[];
  /** Working message array sent to the API (may include a screenshot image block). */
  messages: Anthropic.MessageParam[];
  model: CopilotModel;
  apiKey: string;
  baseplate: number;
  inventoryMode: boolean;
  palette: { p: string; n: string }[];
  /** Persistent scratchpad note seeded from the caller. */
  note: string;
  onEvent: (event: CopilotEvent) => void;
  /** Wall-clock budget for the whole turn; the loop stops cleanly before it. */
  timeBudgetMs?: number;
  /** Cap on tool-loop iterations (default MAX_TOOL_ITERATIONS). */
  maxIterations?: number;
  /** Reasoning depth for every model call of this turn. Absent = the
   * vendor default, i.e. the request this loop has always sent.
   * Anthropic reads `effort`, Gemini reads `thinkingLevel`. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinkingLevel?: string;
  /** Offer check_validity / check_stability as tools (default true). False =
   * graders-only condition: checks run in the end-of-turn gate alone. */
  verifierTools?: boolean;
  /** The user's tool allowlist (copilot settings, lib/copilot/catalog):
   * only these tools are offered, out of what the mode offers. Absent =
   * the mode's default tools. */
  toolAllowlist?: readonly string[];
  /** The MISSION's size contract; when present the gate enforces it (the
   * model's own design envelope is only a fallback). */
  missionEnvelope?: { maxW?: number; maxL?: number; minHeightBricks?: number };
  /** Session was seeded with an existing model (edit task) — the model's
   * own design envelope covers its ADDITION, not the whole build, so
   * self-plan footprint enforcement must not run. */
  seededSession?: boolean;
  /** Aborts the turn when the client disconnects or cancels. */
  abortSignal?: AbortSignal;
  /**
   * Optional caller-provided "vision" tool (the LeoCAD bridge renders the
   * build). When set, the tool is offered to the model and its handler
   * returns tool_result content (typically an image block).
   */
  visionTool?: {
    tool: Anthropic.Tool;
    handle: (input: Record<string, unknown>) => Promise<Anthropic.ToolResultBlockParam["content"]>;
  };
  /**
   * Asked between iterations: a non-null reason ends the pass cleanly, the
   * way the time budget does. A deployment without a renderer uses it to
   * hand the turn back so the CLIENT can render what the model asked to see
   * (the picture arrives with the next pass).
   */
  stopRequested?: () => "view" | null;
  /**
   * Additional caller-provided tools (e.g. editor2's set_joint_angle).
   * Dispatched like visionTool; `summarize` labels the tool event.
   */
  extraTools?: {
    tool: Anthropic.Tool;
    handle: (input: Record<string, unknown>) => Promise<Anthropic.ToolResultBlockParam["content"]>;
    summarize?: (input: Record<string, unknown>) => string;
  }[];
  /**
   * Mutable gate control: when an extra tool poses parts OFF-GRID on
   * purpose (editor2 joint driving), it sets skipValidation and the
   * end-of-turn settle+validate gate must not run — settling would snap
   * the posed subtree back to the grid and the validator would demand
   * "repairs" of an intentional pose.
   */
  gateControl?: { skipValidation: boolean };
  /**
   * Optional flight recorder (experiment runs): receives every executed
   * tool call with its FULL input and result content. Pure observer.
   */
  recorder?: {
    onTool: (
      name: string,
      input: Record<string, unknown>,
      content: Anthropic.ToolResultBlockParam["content"],
    ) => void;
    /** The assistant's full message for one iteration — thinking included. */
    onAssistant?: (content: unknown, usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
    /** Reasoning text as it streams. */
    onThinking?: (delta: string) => void;
  };
}

/**
 * Run one assistant turn to completion (tool loop + automatic validation
 * gate + end-of-turn settle). Progress is reported through `ctx.onEvent`.
 * Returns the final scratchpad note so callers can persist it.
 */
/**
 * Prompt-caching breakpoint for the growing conversation. The agent loop
 * re-sends the whole message history (incl. images) every iteration, so we
 * cache it: strip any prior breakpoint (to stay under the 4-breakpoint cap)
 * and mark the last block of the last message. Combined with the cached
 * system+tools prefix, each iteration re-reads the prior turns at ~0.1× cost.
 */
function markMessagesCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === "object" && "cache_control" in block) {
          delete (block as { cache_control?: unknown }).cache_control;
        }
      }
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    (last.content[last.content.length - 1] as { cache_control?: unknown }).cache_control = {
      type: "ephemeral",
    };
  }
}

export async function runAgentTurn(ctx: AgentTurnCtx): Promise<{ note: string }> {
  const { session, messages, onEvent } = ctx;
  const emit = onEvent;
  const meta = session.meta;
  const palette = ctx.palette;
  let note = ctx.note;
  let lastDesign: DesignInput | null = null;
  /** design_layout calls this turn — only the first one runs. */
  let designCalls = 0;

  const model = resolveCopilotModel(ctx.model);
  // The mode's tools (lib/copilot/toolset), then the user's allowlist from
  // the copilot settings. No allowlist = the historical tool list exactly.
  const tools = assembleTools({
    tools: TOOLS,
    connectTools: CONNECT_TOOLS,
    mode: ctx.toolMode,
    verifierTools: ctx.verifierTools,
    vision: ctx.visionTool?.tool,
    extra: ctx.extraTools?.map((e) => e.tool),
    allow: ctx.toolAllowlist,
  });
  const offered = new Set(tools.map((t) => t.name));
  const promptCtx: PromptContext = {
    promptMessages: ctx.promptMessages,
    baseplate: ctx.baseplate,
    inventoryMode: ctx.inventoryMode,
    // hints follow what is actually offered (identical without an allowlist)
    visionHint: !!ctx.visionTool && offered.has(ctx.visionTool.tool.name),
    visionCostly: !!ctx.stopRequested,
    connectMode: ctx.toolMode === "connect",
    mateMode: ctx.toolMode === "mate",
    verifierHint: ctx.verifierTools !== false && (!ctx.toolAllowlist || offered.has("check_validity") || offered.has("check_stability")),
  };
  const maxIterations = ctx.maxIterations ?? MAX_TOOL_ITERATIONS;
  // Serverless functions are killed at a hard wall (300 s on Vercel). A turn
  // that runs into it loses its last state and shows the user a broken stream,
  // so stop of our own accord a little before it and hand back a clean build
  // the user can continue from.
  const turnStarted = Date.now();
  const timeBudgetMs = ctx.timeBudgetMs ?? Number(process.env.COPILOT_TURN_BUDGET_MS ?? 250_000);
  let ranOutOfTime = false;
  /** Set when a caller's stopRequested() ended the pass (today: "view"). */
  let stoppedFor: "view" | null = null;

  // Cache the system prompt + tool schemas (stable for the whole turn). The
  // breakpoint on the last system block caches tools+system together, so the
  // large fixed prefix is re-read at ~0.1× instead of resent full-price each
  // of the up-to-60 iterations.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt(promptCtx), cache_control: { type: "ephemeral" } },
  ];

  let sawAnything = false;
  try {
    // Which vendor answers this turn (lib/copilot/providers). The loop below
    // is identical either way — only "call the model and stream the deltas"
    // sits behind the seam. A missing key for the picked vendor throws here
    // and is reported to the chat as an error event, not a crash.
    const provider = createProvider(model, ctx.apiKey);
    let repairRounds = 0;
    let stabilityRounds = 0;
    // Seeded (edit) sessions may legitimately arrive as several structures;
    // the gate only complains when the count GROWS past the baseline.
    const baselineComponents = session.parts.length
      ? checkSoundness(session.parts, session.meta, jointEdges(session)).components
      : 1;
    // Seeded (edit) sessions arrive with the official set AS IS — its
    // pre-existing floaters, collisions and unverifiable parts belong to
    // the SEED, not the agent. The gates demand only that the agent adds
    // no NEW problems: every count is compared against this baseline.
    const gateBaseline = (() => {
      if (!ctx.seededSession || session.parts.length === 0)
        return { floating: 0, unverifiable: 0, collisions: 0, unconnected: 0 };
      const s0 = checkSoundness(session.parts, session.meta, jointEdges(session));
      return {
        floating: s0.floating.length,
        unverifiable: session.parts.length - s0.parts,
        collisions: collisionCount(session),
        unconnected: unconnectedCount(session),
      };
    })();

    // Structural honesty: parts the soundness check cannot see, and
    // structure count — "2 separate structures, fine if intentional" is
    // exactly how a ghost ends up NOT standing on its pedestal.
    const structuralProblems = (sound: ReturnType<typeof checkSoundness>): string[] => {
      const out: string[] = [];
      const unverifiable = session.parts.length - sound.parts;
      if (unverifiable > gateBaseline.unverifiable)
        out.push(
          `⚠ UNVERIFIABLE: ${unverifiable} part(s) have unknown geometry and could not be support-checked — treat them as floating until they are stud-seated on checked parts.`,
        );
      if (sound.components > baselineComponents)
        out.push(
          `⚠ STRUCTURES: the build is ${sound.components} separate structures (started as ${baselineComponents}) — everything you added must connect into ONE structure with what it serves; join them or remove the strays.`,
        );
      return out;
    };
    let truncations = 0;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (ctx.abortSignal?.aborted) break;
      if (Date.now() - turnStarted > timeBudgetMs) {
        ranOutOfTime = true;
        break;
      }
      const asked = ctx.stopRequested?.();
      if (asked) {
        stoppedFor = asked;
        break;
      }
      markMessagesCacheBreakpoint(messages);
      const tModel = Date.now();
      // Tool-call WRITING progress: a long emit_parts_script is minutes of
      // silence otherwise (tool input streams as json deltas, not text).
      let typingName = "";
      let typingBytes = 0;
      let typingLastEmit = 0;
      const final = await provider.run({
        model,
        // Generous: build scripts + assemblies inside tool calls are long;
        // a truncated tool call is discarded wholesale by the API.
        maxTokens: 32000,
        effort: ctx.effort,
        thinkingLevel: ctx.thinkingLevel,
        system: systemBlocks,
        tools,
        messages,
        abortSignal: ctx.abortSignal,
        onText: (delta) => {
          sawAnything = true;
          emit({ type: "text", delta });
        },
        onToolWriteStart: (name) => {
          typingName = name;
          typingBytes = 0;
          typingLastEmit = Date.now();
          emit({ type: "tool_typing", name: typingName, bytes: 0 });
        },
        onToolWriteDelta: (chars) => {
          typingBytes += chars;
          if (Date.now() - typingLastEmit > 1500) {
            typingLastEmit = Date.now();
            emit({ type: "tool_typing", name: typingName, bytes: typingBytes });
          }
        },
        // Reasoning goes to the RECORDER only, never to the client: the
        // final message keeps just a signature for thinking blocks, so a
        // trace that is supposed to explain a turn has to catch the deltas.
        onThinking: ctx.recorder
          ? (delta) => {
              try {
                ctx.recorder?.onThinking?.(delta);
              } catch {
                /* recording must never break a turn */
              }
            }
          : undefined,
      });
      const modelMs = Date.now() - tModel;

      // Cost/cache visibility: cached prefixes read at ~0.1× — cache_read
      // should climb across iterations once the prefix is warm.
      const u = final.usage;
      emit({
        type: "usage",
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
      });

      const toolUses = final.toolCalls;
      if (toolUses.length > 0) sawAnything = true;
      // Cut off at the length limit: keep what was said, ask it to carry on in
      // smaller pieces, instead of ending the turn with nothing (a few times).
      if (final.stopReason === "max_tokens" && truncations < 3) {
        truncations++;
        const said = final.content.filter((b): b is Anthropic.TextBlockParam => b.type === "text");
        messages.push({ role: "assistant", content: said.length ? said : [{ type: "text", text: "(cut off)" }] });
        messages.push({
          role: "user",
          content:
            "Your last response hit the length limit and was cut off before its tool call finished, so nothing was run. " +
            "Continue from where you were, and split long work into several smaller tool calls.",
        });
        emit({ type: "tool", name: "note", summary: "response cut at the length limit — continuing in smaller steps" });
        continue;
      }
      if (final.stopReason !== "tool_use" || toolUses.length === 0) {
        if (final.stopReason === "max_tokens") {
          emit({
            type: "error",
            message:
              "Response hit the length limit mid-thought — ask again (perhaps in smaller steps).",
          });
        } else if (!sawAnything) {
          emit({
            type: "error",
            message: `Model returned an empty response (stop: ${final.stopReason ?? "unknown"}). Try again.`,
          });
        }

        // Design adherence: the built footprint vs the model's own planned
        // envelope — the plan is only worth its review if the build is
        // held to it (a clean 8×8 plan drifting to a 13-stud build is the
        // observed failure mode).
        const designAdherence = (): string | null => {
          const env = ctx.missionEnvelope?.maxW ? ctx.missionEnvelope : ctx.seededSession ? undefined : lastDesign?.envelope;
          const label = ctx.missionEnvelope?.maxW ? "the MISSION's size limit" : "YOUR OWN design envelope";
          if (!env?.maxW || session.parts.length === 0) return null;
          const [fw, fl] = extentOfParts(session.parts, session.meta).footprint;
          const maxSide = Math.max(env.maxW, env.maxL ?? env.maxW);
          const minSide = Math.min(env.maxW, env.maxL ?? env.maxW);
          if (Math.max(fw, fl) > maxSide + 0.01 || Math.min(fw, fl) > minSide + 0.01)
            return `⚠ FOOTPRINT: the build is ${fw.toFixed(1)}×${fl.toFixed(1)} studs but ${label} is ${env.maxW}×${env.maxL ?? env.maxW} — find the parts sticking out (find_parts by the outermost stud rows) and pull them in or remove them.`;
          return null;
        };

        // ── AUTOMATIC VALIDATION GATE ──
        // The model thinks it's done. Settle, run the full validator, and if
        // the build fails, force a bounded repair round — the turn cannot end
        // on a broken build.
        if (session.parts.length > 0 && !ctx.gateControl?.skipValidation) {
          settleBuild(session);
          const problems: string[] = [];
          const edges = jointEdges(session);
          const soundness = checkSoundness(session.parts, session.meta, edges);
          if (!soundness.sound && soundness.floating.length > gateBaseline.floating) {
            problems.push(soundness.report + (gateBaseline.floating ? `\n(the loaded set already had ${gateBaseline.floating} unsupported part(s) — those are NOT yours to fix; only the NEW ones are)` : ""));
          }
          problems.push(...structuralProblems(soundness));
          const joints = jointReport(session);
          if (joints.includes("⚠") && unconnectedCount(session) > gateBaseline.unconnected) problems.push(joints);
          const colls = collisionReport(session);
          if (colls.includes("⚠") && collisionCount(session) > gateBaseline.collisions) problems.push(colls);
          const adhere = designAdherence();
          if (adhere) problems.push(adhere);
          if (problems.length > 0 && repairRounds < MAX_REPAIR_ROUNDS) {
            repairRounds++;
            emit({ type: "state", parts: session.parts });
            emit({
              type: "tool",
              name: "auto_validate",
              summary: `FAILED — repair round ${repairRounds}/${MAX_REPAIR_ROUNDS}`,
            });
            messages.push({ role: "assistant", content: final.content.length ? final.content : [{ type: "text", text: "(done)" }] });
            messages.push({
              role: "user",
              content: `AUTOMATIC VALIDATION FAILED (round ${repairRounds}/${MAX_REPAIR_ROUNDS}) — the build is not acceptable yet:\n\n${problems.join("\n\n")}\n\nMake the CHEAPEST fix that resolves the listed problems: remove floating parts, or nudge them onto support. Do NOT redesign, reinforce with new substructures, or investigate with renders/connector queries — a few placement fixes at most, then stop for re-validation.`,
            });
            continue;
          }
          if (problems.length > 0) {
            // Repairs exhausted: NEVER ship broken work silently — the
            // user gets the verdict in the chat, loudly.
            emit({
              type: "tool",
              name: "auto_validate",
              summary: `⚠ UNRESOLVED after ${MAX_REPAIR_ROUNDS} repair rounds — build ships with problems`,
            });
            emit({
              type: "text",
              delta: `\n\n⚠ VALIDATION UNRESOLVED — I could not fully fix the build:\n${problems
                .map((p) => p.split("\n").find((l) => l.includes("⚠")) ?? p.split("\n")[0])
                .join("\n")}`,
            });
          } else {
            // ── GATE 2: physical stability (only once validity is clean).
            // The repair prompt carries the grader's own diagnosis — which
            // parts hang, in which direction — a verifier that says WHERE.
            const stab = stabilityReport(session);
            if (stab.severe && stabilityRounds < MAX_STABILITY_ROUNDS) {
              stabilityRounds++;
              emit({ type: "state", parts: session.parts });
              emit({
                type: "tool",
                name: "auto_stability",
                summary: `FAILED — stability repair round ${stabilityRounds}/${MAX_STABILITY_ROUNDS}`,
              });
              messages.push({ role: "assistant", content: final.content.length ? final.content : [{ type: "text", text: "(done)" }] });
              messages.push({
                role: "user",
                content: `AUTOMATIC STABILITY CHECK FAILED (round ${stabilityRounds}/${MAX_STABILITY_ROUNDS}) — the build is valid but would NOT stand under gravity:\n\n${stab.text}\n\nMake the CHEAPEST fix following the listed directions: add support columns under hanging parts, widen the base course, or pull overhanging mass back. A few placements at most, then stop for re-check.`,
              });
              continue;
            }
            if (stab.severe) {
              emit({
                type: "tool",
                name: "auto_stability",
                summary: `⚠ UNRESOLVED after ${MAX_STABILITY_ROUNDS} stability rounds — build ships unstable`,
              });
              emit({
                type: "text",
                delta: `\n\n⚠ STABILITY UNRESOLVED — the build is valid but would not stand:\n${stab.text.split("\n")[0]}`,
              });
            } else {
              emit({ type: "tool", name: "auto_validate", summary: "PASSED — sound, jointed, collision-free, stable" });
            }
          }
        }
        emit({ type: "done" });
        break;
      }

      messages.push({ role: "assistant", content: final.content });
      ctx.recorder?.onAssistant?.(final.content, u);
      const results: Anthropic.ToolResultBlockParam[] = [];
      const tTools = Date.now();
      const toolTimes: string[] = [];
      for (const tu of toolUses) {
        const input = tu.input as Record<string, unknown>;
        emit({ type: "tool_start", name: tu.name });

        // Switched off in the copilot settings (the system prompt may still
        // name it). Only with an allowlist — without one, dispatch is as before.
        if (ctx.toolAllowlist && !offered.has(tu.name)) {
          emit({ type: "tool", name: tu.name, summary: "turned off in copilot settings" });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `${tu.name} is turned off in the user's copilot settings — use the tools you were given.`,
          });
          continue;
        }

        // Caller-provided extra tools (e.g. set_joint_angle).
        const extra = ctx.extraTools?.find((e) => e.tool.name === tu.name);
        if (extra) {
          try {
            const content = await extra.handle(input);
            emit({ type: "tool", name: tu.name, summary: extra.summarize?.(input) ?? tu.name });
            results.push({ type: "tool_result", tool_use_id: tu.id, content });
          } catch (err) {
            emit({ type: "tool", name: tu.name, summary: "failed" });
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `${tu.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }

        // Caller-provided vision tool returns image content, not text.
        if (ctx.visionTool && tu.name === ctx.visionTool.tool.name) {
          try {
            const content = await ctx.visionTool.handle(input);
            emit({ type: "tool", name: tu.name, summary: "rendered a view" });
            results.push({ type: "tool_result", tool_use_id: tu.id, content });
          } catch (err) {
            // Surface the real cause in the server log — the one-word
            // summary made these undiagnosable.
            console.error(`[copilot] render_view failed: ${err instanceof Error ? err.message : err}`);
            emit({ type: "tool", name: tu.name, summary: "render failed" });
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `render failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }

        let output = "";
        switch (tu.name) {
          case "place_parts": {
            const items = (input.parts ?? []) as PlacementInput[];
            output = placeParts(session, items).join("\n");
            emit({
              type: "tool",
              name: "place_parts",
              summary: `${items.length} placement${items.length === 1 ? "" : "s"}`,
            });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "remove_parts": {
            const asked = (input.indices ?? []) as number[];
            const refusal = bulkRemovalRefusal(
              session.parts.length,
              asked,
              Boolean(input.rebuild_from_scratch),
            );
            if (refusal) {
              output = refusal;
              emit({ type: "tool", name: "remove_parts", summary: "refused — bulk delete, repair instead" });
              break;
            }
            output = removeParts(session, asked);
            // The commonest reason a model deletes good parts is a
            // connectivity warning it thinks it cannot repair. Say the
            // alternative at the moment of deletion.
            if (session.parts.length > 0) {
              const after = checkSoundness(session.parts, session.meta, jointEdges(session));
              if (after.components > 1)
                output += `\n(The build still has ${after.components} separate structures. If that is what you were deleting towards: join_structures bridges them instead, and keeps the parts.)`;
            }
            emit({ type: "tool", name: "remove_parts", summary: output.split("\n")[0] });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "recolor_parts": {
            output = recolorParts(
              session,
              (input.indices ?? []) as number[],
              Number(input.color),
            );
            emit({ type: "tool", name: "recolor_parts", summary: output });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "inspect_build":
            output = inspectBuild(session, jointEdges(session)) + "\n" + jointReport(session) + "\n" + collisionReport(session);
            emit({ type: "tool", name: "inspect_build", summary: `${session.parts.length} parts` });
            break;
          case "design_layout": {
            // ONE plan per turn. The measured baseline spent three calls,
            // ~2,300 output tokens and ~28 s re-planning the same building;
            // the plan is already in the note, so the second call is a
            // refusal, not a run.
            if (designCalls > 0) {
              designCalls++;
              output =
                "already planned — build now. design_layout runs ONCE per turn; your plan is in the note (read_note). " +
                "Place the next subsystem with build_program.";
              emit({ type: "tool", name: "design_layout", summary: "already planned — build now" });
              break;
            }
            designCalls++;
            lastDesign = input as unknown as DesignInput;
            const d = designLayout(lastDesign);
            output = d.text;
            note = note ? `${note.split("\n\n== DESIGN ==")[0]}\n\n== DESIGN ==\n${d.text}` : `== DESIGN ==\n${d.text}`;
            emit({ type: "note", note });
            emit({ type: "tool", name: "design_layout", summary: d.warnings.length ? `⚠ ${d.warnings.length} plan warning(s)` : "plan clean" });
            break;
          }
          case "check_validity": {
            const edges = jointEdges(session);
            const sound = checkSoundness(session.parts, session.meta, edges);
            const structural = structuralProblems(sound);
            const joints = jointReport(session);
            const colls = collisionReport(session);
            // MEASURED: a model that reads "N separate structures" reaches for
            // remove_parts. Name the remedy in the result, where it cannot be
            // missed, not only in the tool list.
            const tie =
              sound.components > 1
                ? [
                    `→ ${sound.components} separate structures. Call join_structures: it finds the gaps and lays the spanning plates for you, raising the lower side when the levels differ. Do NOT delete parts to make this number go down.`,
                  ]
                : [];
            output = [sound.report, ...structural, ...tie, joints, colls].join("\n");
            // Only real defects count: floating parts, unconnected parts and
            // collisions. Several grounded structures mid-build is expected.
            const defects =
              sound.floating.length > 0 || structural.length > 0 || joints.includes("⚠") || colls.includes("⚠");
            emit({ type: "tool", name: "check_validity", summary: defects ? "⚠ problems found" : "clean" });
            break;
          }
          case "check_stability": {
            const st = stabilityReport(session);
            output = st.text;
            emit({ type: "tool", name: "check_stability", summary: st.severe ? "⚠ unstable" : "stable" });
            break;
          }
          case "anchor_part": {
            output = anchorPart(session, {
              part: String(input.part ?? ""),
              color: Number(input.color ?? 4),
              x_stud: Number(input.x_stud ?? 0),
              z_stud: Number(input.z_stud ?? 0),
              rot: (Number(input.rot ?? 0) as 0 | 90 | 180 | 270),
            });
            emit({ type: "tool", name: "anchor_part", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "place_on": {
            const part = String(input.part ?? "");
            const onto = Number(input.onto ?? -1);
            const dx = input.dx_studs === undefined ? 0 : Number(input.dx_studs);
            const dz = input.dz_studs === undefined ? 0 : Number(input.dz_studs);
            const rot = Number(input.rot ?? 0) as 0 | 90 | 180 | 270;
            output = placeOnStuds(session, { part, color: Number(input.color ?? 4), onto, dx_studs: dx, dz_studs: dz, rot });
            if (!output.startsWith("OK"))
              output += explainRefusal({ session, kw: "on", baseIdx: onto, part, dx, dz, rot, msg: output });
            emit({ type: "tool", name: "place_on", summary: output.slice(0, 90) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "define_module_from": {
            output = defineModuleFrom(
              session,
              ((input.indices ?? []) as number[]).map(Number),
              String(input.name ?? ""),
            );
            emit({ type: "tool", name: "define_module_from", summary: output.slice(0, 80) });
            break;
          }
          case "stamp_module": {
            output = stampModule(
              session,
              String(input.name ?? ""),
              Number(input.x_stud ?? 0),
              Number(input.z_stud ?? 0),
              (Number(input.rot ?? 0) as 0 | 90 | 180 | 270),
            );
            emit({ type: "tool", name: "stamp_module", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "run_connect_script": {
            const r = await runConnectScript(session, String(input.code ?? ""));
            output = [
              r.error ? `SCRIPT ERROR: ${r.error}` : null,
              r.logs.length ? `logs:\n${r.logs.join("\n")}` : null,
              `${r.ok}/${r.ops} operations succeeded` +
                (r.rejections.length ? `\nrejections:\n${r.rejections.join("\n")}` : ""),
            ]
              .filter(Boolean)
              .join("\n");
            emit({
              type: "tool",
              name: "run_connect_script",
              summary: r.error ? "script error" : `${r.ok}/${r.ops} ops engaged`,
            });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "build_program": {
            const r = await runBuildProgram(session, String(input.code ?? ""), {
              strict: Boolean(input.strict),
              dryRun: Boolean(input.dry_run),
            });
            // COMPACT on purpose: echoing the program or listing placements
            // would put the tokens this tool saves straight back. The only
            // thing worth its tokens is WHY a placement was refused.
            output = r.report;
            emit({
              type: "tool",
              name: "build_program",
              summary:
                (r.dryRun ? "dry run: " : "") +
                (r.error
                  ? `program error · placed ${r.placed}`
                  : `${r.dryRun ? "would place" : "placed"} ${r.placed}${r.rejected ? ` · ${r.rejected} rejected` : ""}`),
            });
            // A dry run changes nothing, so there is no new state to push.
            if (!r.dryRun) emit({ type: "state", parts: session.parts });
            break;
          }
          case "emit_parts_script": {
            const { placements, logs, error } = await runPartsScript(String(input.code ?? ""));
            const scriptResults = placements.length ? placeParts(session, placements) : [];
            const ok = scriptResults.filter((r) => r.startsWith("OK")).length;
            output = [
              error ? `SCRIPT ERROR: ${error}` : null,
              logs.length ? `logs:\n${logs.join("\n")}` : null,
              placements.length
                ? `${ok}/${placements.length} placements succeeded` +
                  (ok < placements.length
                    ? `\n${scriptResults.filter((r) => !r.startsWith("OK")).slice(0, 20).join("\n")}`
                    : "")
                : "script emitted no placements",
            ]
              .filter(Boolean)
              .join("\n");
            emit({
              type: "tool",
              name: "emit_parts_script",
              summary: error ? "script error" : `${ok}/${placements.length} placed`,
            });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "define_assembly":
            output = defineAssembly(
              session,
              String(input.name ?? ""),
              (input.parts ?? []) as PlacementInput[],
            );
            emit({ type: "tool", name: "define_assembly", summary: output.slice(0, 60) });
            break;
          case "place_assembly": {
            const asmResults = placeAssembly(
              session,
              String(input.name ?? ""),
              Number(input.x_stud),
              Number(input.z_stud),
              (Number(input.rot ?? 0) as 0 | 90 | 180 | 270),
            );
            const ok = asmResults.filter((r) => r.startsWith("OK")).length;
            output = asmResults.join("\n");
            emit({
              type: "tool",
              name: "place_assembly",
              summary: `${input.name}: ${ok}/${asmResults.length} placed`,
            });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "find_parts": {
            output = findParts(session, input as PartFilter);
            emit({
              type: "tool",
              name: "find_parts",
              summary: output.split(":")[0],
            });
            break;
          }
          case "write_note": {
            note = String(input.note ?? "");
            output = `note saved (${note.length} chars)`;
            emit({ type: "tool", name: "write_note", summary: output });
            emit({ type: "note", note });
            break;
          }
          case "read_note":
            output = note || "(note is empty)";
            emit({ type: "tool", name: "read_note", summary: `${note.length} chars` });
            break;
          case "get_heuristics": {
            const topic = String(input.topic ?? "");
            const hs = findHeuristics(topic, 5);
            output = hs.length
              ? heuristicsBlock(hs)
              : `No heuristics match "${topic}" — available topics: ${HEURISTICS.map((h) => h.id).join(", ")}`;
            emit({ type: "tool", name: "get_heuristics", summary: `"${topic}" → ${hs.length}` });
            break;
          }
          case "get_reference": {
            const refs = await findReferences(String(input.query ?? ""), 3);
            output = referencesBlock(refs);
            emit({ type: "tool", name: "get_reference", summary: `"${String(input.query ?? "")}" → ${refs.length} designs` });
            break;
          }
          case "list_connectors": {
            const ref = String(input.ref ?? "");
            output = listConnectors(session, ref);
            // "show me": the same connectors as a picture. For a PLACED part
            // the picture is the whole build with that part's connectors
            // numbered — what you are attaching to, in the place it sits.
            if (input.show && renderAvailable()) {
              const placed = ref.startsWith("index:") ? Number(ref.slice(6)) : null;
              const cards =
                placed !== null && session.parts[placed]
                  ? await placedCard(
                      toLdr({ format: "danish-bricks/v1", name: "build", baseplate: ctx.baseplate, parts: session.parts }, meta),
                      placed,
                      meta,
                    )
                  : await partCard(ref.replace(/^part:/, "").trim(), meta);
              emit({ type: "tool", name: "list_connectors", summary: `${ref} — with a map` });
              results.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: [{ type: "text", text: output }, ...cards],
              });
              continue;
            }
            emit({ type: "tool", name: "list_connectors", summary: ref });
            break;
          }
          case "attach_part": {
            const part = String(input.part);
            const to = Number(input.to);
            const toConnector = Number(input.toConnector);
            output = attachPart(session, {
              to,
              toConnector,
              part,
              color: Number(input.color),
              partConnector: input.partConnector === undefined ? undefined : Number(input.partConnector),
              slide: input.slide === undefined ? undefined : Number(input.slide),
              roll: input.roll === undefined ? undefined : Number(input.roll),
              flip: Boolean(input.flip),
            });
            if (!output.startsWith("ATTACHED"))
              output += explainRefusal({ session, kw: "attach", baseIdx: to, part, toConnector, msg: output });
            emit({ type: "tool", name: "attach_part", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "attach_chain": {
            output = attachChain(
              session,
              Number(input.to),
              Number(input.toConnector),
              (input.links ?? []) as { part: string; color: number }[],
            );
            emit({ type: "tool", name: "attach_chain", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "free_connectors": {
            output = freeConnectors(session);
            emit({ type: "tool", name: "free_connectors", summary: `${session.parts.length} parts scanned` });
            break;
          }
          case "attach_options": {
            output = attachOptions(session, {
              part: String(input.part),
              to: Number(input.to),
              toConnector: input.toConnector === undefined ? undefined : Number(input.toConnector),
              limit: input.limit === undefined ? undefined : Number(input.limit),
            });
            emit({ type: "tool", name: "attach_options", summary: output.split("\n")[0].slice(0, 80) });
            break;
          }
          case "attach_option": {
            output = attachOption(session, { option: Number(input.option), color: Number(input.color) });
            emit({ type: "tool", name: "attach_option", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "mirror_stamp": {
            output = mirrorStamp(session, { name: String(input.name), at_stud: Number(input.at_stud) });
            emit({ type: "tool", name: "mirror_stamp", summary: output.slice(0, 80) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "silhouette": {
            output = silhouetteView(session, (input.axis === "front" || input.axis === "side" ? input.axis : "top") as "top" | "front" | "side");
            emit({ type: "tool", name: "silhouette", summary: String(input.axis ?? "top") });
            break;
          }
          case "settle_build": {
            output = settleBuild(session);
            emit({ type: "tool", name: "settle_build", summary: output.slice(0, 60) });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "join_structures": {
            const joined = bridgeStructures(session, {
              maxSpan: input.maxSpan != null ? Number(input.maxSpan) : undefined,
              color: input.color != null ? Number(input.color) : undefined,
            });
            output = joined.report;
            emit({
              type: "tool",
              name: "join_structures",
              summary: `${joined.before} → ${joined.after} structures, ${joined.placed} tie(s)`,
            });
            emit({ type: "state", parts: session.parts });
            break;
          }
          case "search_parts": {
            const q = String(input.query ?? "");
            // connection-first builds can use any library part (the same index `dbb search` uses);
            // coordinate builds stay on the curated palette
            const rows = ctx.toolMode === "coords" || !ctx.toolMode ? palette.map((r) => ({ p: r.p, n: r.n, c: -1, ld: true })) : getPartIndex();
            const found = searchParts(rows, q, { meta }, 20);
            const hits = found.map((r) => {
              const m = meta[r.p];
              return `${r.p} "${r.n}" ${m ? `${m.w}x${m.l} studs, ${m.h} LDU` : ""}`;
            });
            // "show me": the top hits as PART CARDS — the part rendered with
            // its connectors marked and numbered, so a bracket's fingers are
            // something you looked at rather than inferred from its name.
            const show = Math.min(3, Math.max(0, Math.round(Number(input.show ?? 0)) || 0));
            if (show > 0 && found.length > 0) {
              const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [
                { type: "text", text: hits.join("\n") },
              ];
              for (const r of found.slice(0, show)) content.push(...(await partCard(r.p, meta)));
              emit({ type: "tool", name: "search_parts", summary: `"${q}" → ${found.length} hits, ${show} card(s)` });
              results.push({ type: "tool_result", tool_use_id: tu.id, content });
              continue;
            }
            output = hits.length ? hits.join("\n") : "no parts match — try dims like '2x8' or a different word";
            emit({ type: "tool", name: "search_parts", summary: `"${q}" → ${hits.length} hits` });
            break;
          }
          default:
            output = `unknown tool ${tu.name}`;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      // Flight recorder: results align 1:1 with toolUses (every branch
      // pushes exactly one), so pair them up for the full-fidelity log.
      if (ctx.recorder) {
        for (let i = 0; i < toolUses.length && i < results.length; i++) {
          try {
            ctx.recorder.onTool(
              toolUses[i].name,
              toolUses[i].input as Record<string, unknown>,
              results[i].content ?? "",
            );
          } catch {
            /* recording must never break the turn */
          }
        }
      }
      // Where the wall-clock goes, per iteration: waiting for the model vs
      // running its tools. Read with: grep "\[copilot t\]" in the server log.
      console.log(
        `[copilot t] it${iteration} model ${modelMs}ms · tools ${Date.now() - tTools}ms [${toolUses.map((t) => t.name).join(",")}] · out ${u.output}tok · in ${u.input}+${u.cacheRead}cached`,
      );
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    // A client-initiated abort is expected — don't surface it as an error.
    if (!ctx.abortSignal?.aborted) {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    // Deterministic guarantee: a finished turn never leaves the build
    // hovering — if the lowest point is above the ground, settle it.
    // (Skipped for editor2-context turns: imported sets may legitimately
    // contain floating components, and settling would move them.)
    try {
      if (ranOutOfTime || stoppedFor) {
        emit({ type: "limit", reason: stoppedFor ?? "budget", parts: session.parts.length });
        emit({
          type: "text",
          delta: stoppedFor === "view"
            ? `\n\n👁 Looking at the build (${session.parts.length} parts) — the canvas is rendering the view asked for, and building carries on with it in a moment.`
            : `\n\n⏳ Stopped at the time limit with ${session.parts.length} parts — the build so far is saved. Say “continue” to carry on from here.`,
        });
      }
      if (session.parts.length > 0 && !ctx.gateControl?.skipValidation) {
        // Deterministic guarantee #2: a finished turn leaves ONE structure
        // where it can. A model that runs out of time (or forgets) used to
        // hand back a field of separate pieces; the ties are mechanical, so
        // the loop lays them itself rather than spending a turn asking.
        try {
          const sound = checkSoundness(session.parts, session.meta, jointEdges(session));
          if (sound.components > 1) {
            const joined = bridgeStructures(session, { maxTies: 24 });
            if (joined.placed > 0) {
              emit({ type: "state", parts: session.parts });
              emit({
                type: "tool",
                name: "join_structures",
                summary: `auto-joined at end of turn: ${joined.before} → ${joined.after} structures with ${joined.placed} tie(s)`,
              });
            }
          }
        } catch {
          /* joining is a courtesy; it never fails a turn */
        }
        const settled = settleBuild(session);
        if (!settled.startsWith("Build already") && !settled.startsWith("Nothing")) {
          emit({ type: "state", parts: session.parts });
          emit({ type: "tool", name: "settle_build", summary: "auto-settled at end of turn" });
        }
      }
    } catch {
      /* best effort */
    }
    emit({ type: "done" });
  }

  return { note };
}
