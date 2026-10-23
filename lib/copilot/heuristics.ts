/**
 * The builder's heuristics store — hard-won building knowledge, tagged for
 * retrieval. The top matches for a request are auto-injected into the
 * system prompt; the model can pull more with get_heuristics(topic).
 *
 * Add entries freely: each is one actionable lesson, written for the model.
 */

export interface Heuristic {
  id: string;
  title: string;
  keywords: string[];
  body: string;
}

export const HEURISTICS: Heuristic[] = [
  // ── Vehicles ──
  {
    id: "vehicle-wheels-first",
    title: "Vehicles: wheels FIRST, body second",
    keywords: ["car", "truck", "vehicle", "wheel", "van", "bus", "trailer", "pickup"],
    body: "Place wheel holders (4600) directly on the GROUND at the axle positions, attach wheel+tire chains to every pin, THEN build the chassis plate on top of the holders' studs. Retrofitting wheels under a finished body is geometrically impossible — the pin is pinched between ground and chassis and every pose collides.",
  },
  {
    id: "wheel-clearance",
    title: "Wheels need ~20 LDU of free radius",
    keywords: ["wheel", "tire", "clearance", "arch", "fender", "mudguard"],
    body: "A wheel+tire needs roughly 20 LDU of clear space around its pin in every radial direction. Keep the chassis narrower than the wheel track, or leave 2-stud cutouts (wheel arches) in the body side walls above each wheel.",
  },
  {
    id: "vehicle-proportions",
    title: "Car proportions that read as 'car'",
    keywords: ["car", "vehicle", "proportion", "cabin", "hood", "truck"],
    body: "Wheelbase ≈ 2/3 of total length; front wheels near the front bumper. Cabin sits between the axles, never overhanging the front. Add a 1-brick hood mass in front of the windscreen and a shorter trunk/bed behind — a cabin centered on a flat plate reads as a 'rolling box'. Windscreen = trans slope or 3823; roof plate should not overhang the cabin footprint.",
  },
  // ── Walls & buildings ──
  {
    id: "running-bond",
    title: "Walls: running bond, always",
    keywords: ["wall", "house", "building", "tower", "castle", "brick"],
    body: "Offset every course by half a brick like real masonry, and interlock at corners (alternate which wall's brick crosses the corner). A wall of vertically-stacked seams splits into columns — connected-looking but structurally meaningless.",
  },
  {
    id: "hollow-structures",
    title: "Build shells, not solids",
    keywords: ["house", "building", "tower", "wall", "fill", "solid"],
    body: "Buildings are 1-brick-thick shells. Filling volumes wastes parts, looks worse from openings, and hides interior detail. Only fill when a platform must support something above it.",
  },
  {
    id: "lintels",
    title: "Bridge every opening with a lintel",
    keywords: ["door", "window", "opening", "gap", "arch", "lintel"],
    body: "A door or window gap must be bridged ABOVE by a part that lands on both sides (1xN brick/plate spanning the opening, or an arch part). Never let a course dead-end at an opening — the wall above would float.",
  },
  {
    id: "window-door-parts",
    title: "Use real window/door parts, not bare gaps",
    keywords: ["window", "door", "house", "frame", "glass"],
    body: "Prefer real parts: window frames 60592/60593 (1x2x2, 1x2x3), 3853 (1x4x3), doors 3821/3822, door frame 60596. They snap into wall gaps of matching size and instantly read as architecture. Trans-clear 1x2x2 bricks work as glass blocks.",
  },
  {
    id: "roof-gables",
    title: "Roofs rest on gable ends",
    keywords: ["roof", "slope", "house", "gable", "pitched"],
    body: "Slope bricks forming a pitched roof must REST on triangular gable end-walls (stepped courses at the two short walls). Slopes floating on air over the interior will be flagged unsound. Build gables first, then lay slope courses from eave to ridge; crown with a 1xN ridge brick or tile.",
  },
  {
    id: "house-proportions",
    title: "House proportions",
    keywords: ["house", "building", "proportion", "scale"],
    body: "Minifig-scale rule of thumb: door opening 4-5 bricks tall; window sills at course 2-3; walls 5-6 bricks then roof. Footprints of 8x10 to 12x16 studs read well. Leave one stud margin between windows and corners.",
  },
  // ── Structure & stability ──
  {
    id: "plate-arithmetic",
    title: "3 plates = 1 brick",
    keywords: ["plate", "height", "level", "offset", "brick"],
    body: "Heights: brick 24 LDU, plate 8. Three plates equal one brick — use plate stacks for fine height adjustment, ledges, and floors. A plate on top of walls locks courses together like a bond beam.",
  },
  {
    id: "bridge-seams",
    title: "Bridge every seam between base plates",
    keywords: ["chassis", "base", "plate", "seam", "bridge", "join"],
    body: "Two plates laid side-by-side are NOT connected. Bridge the seam with a plate on top that overlaps both by at least 2 studs (a 2x4 across the joint). For vehicle chassis, one long plate beats two short ones.",
  },
  {
    id: "cantilever-support",
    title: "Cantilevers need counterweight or columns",
    keywords: ["overhang", "cantilever", "balcony", "wing", "bridge"],
    body: "Anything overhanging more than 2-3 studs needs a column below or 2x the overhang in anchored studs behind it. One-stud connections cannot hold a moment arm — the verdict will flag it, but design it right the first time.",
  },
  {
    id: "wide-base",
    title: "Towers: widest at the bottom",
    keywords: ["tower", "tall", "stability", "taper", "lighthouse"],
    body: "Tall structures need a base at least 1/4 of their height in width. Taper by stepping in half a brick per course-group using jumpers or plate ledges. Interlock every course — a tall stack of aligned seams is a column waiting to shear.",
  },
  // ── Connections & SNOT ──
  {
    id: "jumper-centering",
    title: "Jumpers give half-stud centering",
    keywords: ["jumper", "center", "offset", "half", "detail"],
    body: "3794 (1x2 jumper) and 87580 (2x2 jumper) shift the grid half a stud — use them to center 1-wide details on even-width bodies (door handles, hood ornaments, noses).",
  },
  {
    id: "snot-parts",
    title: "SNOT: use headlight bricks and brackets",
    keywords: ["snot", "sideways", "side", "stud", "bracket", "headlight"],
    body: "To face studs sideways use 4070 (headlight), 87087 (1x1 side stud), or brackets 99781/44728. Attach side details via attach_part on their side-stud connectors — never approximate sideways geometry with offset normal placements.",
  },
  {
    id: "attach-vs-place",
    title: "attach_part for anything that isn't a stud stack",
    keywords: ["attach", "pin", "axle", "clip", "bar", "connector", "wheel"],
    body: "place_parts is for stud-grid placement only. Wheels on pins, pins in holes, axles, bars in clips, tiles on side studs — always list_connectors then attach_part/attach_chain. Guessed coordinates for non-stud joints are always wrong.",
  },
  {
    id: "chain-wheels",
    title: "Wheel + tire go on as one chain",
    keywords: ["wheel", "tire", "chain", "attach"],
    body: "attach_chain(to=holder, toConnector=pin#, links=[{4624},{3641}]) — the chain is fit-checked as a unit, so a tire that can't fit stops the wheel too. Four pins = four chains.",
  },
  {
    id: "cant-fit-recovery",
    title: "CAN'T FIT means move, not retry",
    keywords: ["fit", "collision", "blocked", "error", "retry"],
    body: "CAN'T FIT is geometric truth: every pose along that joint axis is blocked. Retrying the same connector wastes calls. Move the anchor part, clear the space above/around, or redesign (raise the body, add arches). One retry after an actual change, maximum.",
  },
  // ── Process ──
  {
    id: "reference-first",
    title: "Study a reference before building novel objects",
    keywords: ["reference", "shape", "novel", "animal", "object"],
    body: "Before building any recognizable object, call get_reference with its category. Study the layer-by-layer proportions (where the mass sits, footprint vs height), then design your own — don't copy coordinates blindly.",
  },
  {
    id: "stage-and-inspect",
    title: "Build in stages, inspect between",
    keywords: ["inspect", "stage", "plan", "verify"],
    body: "Build one subsystem (chassis, wall course, roof) per response and inspect_build before the next. The verdict + joints + collisions report catches problems while they're one stage deep, not buried under three more.",
  },
  {
    id: "scripts-for-repetition",
    title: "Scripts for anything repetitive",
    keywords: ["script", "loop", "wall", "repeat", "course"],
    body: "Walls, floors, rows of columns: emit_parts_script with loops and a course function. Hand-listing 40 coordinate placements guarantees a typo; a 10-line loop doesn't.",
  },
  {
    id: "use-assemblies-for-repetition",
    keywords: ["assembly", "repeat", "copy", "mirror", "symmetry", "module", "window", "duplicate"],
    title: "Repeated substructures: define once, stamp many",
    body: "Any substructure appearing 2+ times (windows, wheels+holders, table legs, roof segments, fence posts) should be built ONCE with define_assembly and stamped with place_assembly at each location/rotation. Same when the user asks to copy or mirror part of the build: inspect_build the region, define_assembly from those parts (positions relative to the region's corner), then stamp. Brick-by-brick re-placement drifts by a stud, forgets a piece, and wastes turns; stamped instances are identical by construction.",
  },
  {
    id: "inventory-check",
    title: "Inventory mode: design around actual stock",
    keywords: ["inventory", "stock", "parts", "available"],
    body: "In inventory mode, check remaining stock BEFORE designing (inspect_build lists it). Design to the dominant brick sizes available; substitute 2x 1xN for missing 2xN early rather than mid-wall.",
  },
  // ── Technic ──
  {
    id: "gear-spacing",
    title: "Gear meshing distances",
    keywords: ["gear", "mesh", "technic", "ratio"],
    body: "Gears mesh when center distance = sum of pitch radii: 8T=10 LDU, 24T=30, 40T=50. Classic pairs: 8T+24T at 40 LDU (2 studs), 8T+40T at 60 (3 studs), 24T+24T at 60. Half-tooth roll (360/teeth/2) interleaves teeth visually.",
  },
  {
    id: "pin-vs-axle",
    title: "Pins spin, axles drive",
    keywords: ["pin", "axle", "technic", "rotate", "drive"],
    body: "Friction pins (2780) hold structure; frictionless (3673) allow rotation. Axles (X cross-section) transmit torque through axle holes; round pin holes let axles spin freely. Choose by whether the joint must rotate.",
  },
];

/** Retrieve the top-k heuristics for a free-text query (token overlap). */
export function findHeuristics(query: string, k = 3): Heuristic[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  if (words.size === 0) return [];
  const scored = HEURISTICS.map((h) => {
    let score = 0;
    for (const kw of h.keywords) if (words.has(kw)) score += 3;
    for (const w of words) {
      if (h.title.toLowerCase().includes(w)) score += 1;
      if (h.id.includes(w)) score += 1;
    }
    return { h, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.h);
}

export const heuristicsBlock = (hs: Heuristic[]): string =>
  hs.map((h) => `▸ ${h.title}: ${h.body}`).join("\n");
