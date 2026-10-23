/**
 * Referee types — the benchmark's grader contract.
 *
 *   grade(design, task?) → Verdict
 *
 * A design is LDraw text. The grader ASSUMES IT IS BROKEN: nothing passes
 * a rung without positive evidence, and every failure is located (part
 * indices, joint, angle) so a builder — human or model — can act on it.
 *
 * Rungs are gated: a failed rung stops the ladder (later rungs are
 * "skipped", not "passed"). The three headline columns a paper reports:
 *   valid      = parse + geometry + connectivity
 *   functional = valid + stability + mechanism + actuation
 *   adherent   = functional + task postconditions
 */

export type Severity = "fail" | "warn" | "info";

export interface Finding {
  severity: Severity;
  /** Stable machine code, e.g. "unknown-part", "collision", "gear-unmeshed". */
  code: string;
  msg: string;
  /** Part indices (file order after MPD flattening) the finding points at. */
  parts?: number[];
  /** For sweep findings: driver angle (deg) where it happened. */
  atDeg?: number;
  /** Anything else a UI can show (ratios, distances, ...). */
  data?: Record<string, unknown>;
}

export type RungId = "parse" | "geometry" | "connectivity" | "stability" | "mechanism" | "actuation" | "task";

export interface Rung {
  id: RungId;
  status: "pass" | "fail" | "skip";
  ms: number;
  findings: Finding[];
}

export interface GearInfo {
  part: number;
  partId: string;
  teeth: number;
  kind: "spur" | "bevel" | "crown" | "turntable" | "knob" | "worm" | "rack" | "differential" | "other";
  body: number;
  /** World (LDraw frame) center and unit axis. */
  center: [number, number, number];
  axis: [number, number, number];
  pitchRadius: number;
}

export interface MeshInfo {
  a: number; // gear index into gears[]
  b: number;
  /** signed ratio ω_b/ω_a (about each gear's own axis). */
  ratio: number;
  /** parallel / perpendicular: two gears, tooth on tooth. rack: gear `a` drives rack `b` along its length
   * (ratio is 0; see `slide`). chain: two sprockets joined by a chain of links (same sense when both are inside the loop). */
  geometry: "parallel" | "perpendicular" | "rack" | "chain";
  centerDistance: number;
  expected: number;
  /** rack meshes: the rack moves along `dir` (unit, LDraw frame) by `lduPerRad` per radian of the pinion */
  slide?: { dir: [number, number, number]; lduPerRad: number };
  /** tooth phase: voxels shared as built vs the best roll of gear A over one tooth pitch */
  phase?: { sharedNow: number; sharedBest: number; rollDeg: number; clash: boolean };
}

export interface TrainInfo {
  id: number;
  /** driver gear index */
  driver: number;
  gears: number[];
  bodies: number[];
  /** ω_body / ω_driver per body id */
  ratios: Record<number, number>;
  /** overall ratio driver → slowest/fastest output body, for task checks */
  outputs: { body: number; ratio: number }[];
  sweep: {
    ok: boolean;
    stepDeg: number;
    steps: number;
    /** first jam (driver angle) and the colliding pair, if any */
    jamAtDeg?: number;
    jamParts?: [number, number];
    jamOverlapLdu3?: number;
    ms: number;
    /** the "jam" is against a linkage part the sweep does not move — not a verdict */
    unverifiable?: string;
    /** trains that end in a rack are not asked for a full turn: this is how far the driver turns each way before something stops the rack */
    freeDeg?: { min: number; max: number };
  } | null;
  /** per moving body: how to pose it for a driver angle θ — rotate `parts`
   * about the axis through `center` by ratio·θ (LDraw frame). Lets a viewer
   * animate the train or show the jam pose. */
  drive?: {
    body: number;
    parts: number[];
    axis: [number, number, number];
    center: [number, number, number];
    ratio: number;
    /** a rack: instead of turning, the body moves along `dir` by `lduPerDeg` per degree of the driver */
    slide?: { dir: [number, number, number]; lduPerDeg: number };
  }[];
  /** the links of a chain that joins sprockets of this train (the sweep does not move them, and does not test against them) */
  chain?: number[];
  /** why the train could not be actuated (pinned axle, conflict, floating gear) — a FAILURE */
  blocked?: string;
  /** why the referee cannot judge this train (unmodelled gear kind, library gap) — NOT a failure */
  unverifiable?: string;
}

export interface JointInfo {
  id: number;
  parent: number;
  child: number;
  kind: "revolute";
  pinned: boolean;
  /** collision-swept free arc (deg), when measured */
  arc?: { min: number; max: number };
  /** parts that move with the child side */
  moving?: number;
  /** which parts those are (indices), so a viewer can turn the joint */
  parts?: number[];
  /** world axis (unit) and pivot of the bearing, from the parent connector frame */
  axis?: [number, number, number];
  pivot?: [number, number, number];
}

export interface MechanismInfo {
  bodies: number;
  bodySizes: number[];
  /** which rigid body each part belongs to (index into bodySizes), so a viewer can show the bodies */
  bodyOf?: number[];
  joints: JointInfo[];
  movable: number;
  pinned: number;
  gears: GearInfo[];
  meshes: MeshInfo[];
  trains: TrainInfo[];
}

export interface TaskSpec {
  id?: string;
  prompt?: string;
  post?: {
    minParts?: number;
    maxParts?: number;
    minHeightLdu?: number;
    maxHeightLdu?: number;
    maxFootprintStuds?: [number, number];
    /** the footprint must be at least this big (studs, either orientation) */
    minFootprintStuds?: [number, number];
    partNames?: { match: string; min: number }[];
    /** bag of parts: the build may use only these ("part/colour" → how many) */
    bag?: { from: string; parts: Record<string, number>; /** also require every bag part to be used (finding code `bag-all`) */ useAll?: boolean; /** require at least this fraction of the bag's pieces to be used (finding code `bag-used`) */ minUsed?: number };
    minMovableJoints?: number;
    /** at least one joint must swing this far (deg), collision-swept */
    minFreeArcDeg?: number;
    minGearTrains?: number;
    /** some train must realise |ratio| ≈ this between driver and an output */
    gearRatio?: { ratio: number; tol?: number };
    /** every detected train must sweep collision-free (default true when trains exist) */
    actuate?: boolean;
    /** the design must be ONE assembly (no separate grounded objects) */
    maxAssemblies?: number;
    /**
     * Named joint requirements (Move-it): at least `min` movable revolute
     * bearings whose collision-swept arc is ≥ minArcDeg and whose axis is
     * vertical / horizontal (within axisTolDeg of the world up axis / plane).
     * Finding code: `joints:<id>`.
     */
    /** edit tasks: fraction of the SEED's parts still at their pose (translate-invariant) */
    minPreserved?: number;
    /** edit tasks, judged RELATIVE to the seed (see lib/grader/edit.ts) */
    edit?: EditSpec;
    /**
     * completion tasks: judge validity against the GOLD (the full set) as well as the seed —
     * failures the official set file itself has (its known interpenetrations, near-miss
     * mates) are inherited, not new. Without an `edit` block this still yields the
     * seed-relative "new-failures" check (and no preservation check).
     */
    baseline?: "gold";
    /** sweep this many movable joints (largest moving side first; default 40) — a spec
     * generated from a big set asks for every functional joint, wheels included */
    maxJointSweeps?: number;
    /** completion tasks: closeness to the GOLD (full) model */
    reference?: { minBomF1?: number; minPoseMatch?: number };
    joints?: {
      id: string;
      min: number;
      minArcDeg?: number;
      axis?: "vertical" | "horizontal" | "any";
      axisTolDeg?: number;
      /** the moving side must carry at least this many parts (a door, not a loose tile) */
      minMoving?: number;
      /** the bearing's pivot must lie inside this box (any of the boxes, when a list) —
       * LDraw coordinates in the SEED's frame; a submission translated as a whole is
       * judged after the dominant offset from the seed */
      pivotIn?: Box3 | Box3[];
    }[];
    /**
     * Count parts whose name (or number) matches `match` (regex, case-insensitive)
     * and whose LDraw origin lies inside `box` (seed frame, offset-corrected like
     * `joints[].pivotIn`); the count must be ≥ min and ≤ max. Finding code `parts-in:<id>`.
     */
    partsIn?: { id: string; match: string; box: Box3; min?: number; max?: number }[];
  };
  /** Move-it: the requirement list a submission is scored against, one row each. */
  requirements?: Requirement[];
  /** Move-it edit / completion tasks: the model handed to the builder as ./seed.mpd —
   * a set id, optionally with a named sub-model removed or cut after a build step. */
  seed?: string | SeedSpec;
}

/** An axis-aligned box in LDraw coordinates (y down); an omitted axis is unbounded. */
export interface Box3 {
  x?: [number, number];
  y?: [number, number];
  z?: [number, number];
}

export interface SeedSpec {
  /** OMR set id, e.g. "850-1" */
  set: string;
  /** drop the sub-model whose file name contains this (case-insensitive), and every reference to it */
  removeSub?: string;
  /** keep only the main model's lines up to and including the N-th "0 STEP" */
  uptoStep?: number;
  /** take the set apart: every piece laid out loose on the table, as for a build from a parts bag */
  layout?: boolean;
  /**
   * a build cut part-way: keep the first ⌊f·N⌋ of the N parts in the FLATTENED build
   * order (sub-models expanded where referenced, each with its own steps in order),
   * written as one flat model at their final poses. 0 = an empty table.
   */
  buildFraction?: number;
}

/**
 * An edit judged against its seed. Coordinates are LDraw (y down: "higher"
 * means more negative y), in the seed's frame; a submission translated as a
 * whole is matched after the dominant offset.
 */
export interface EditSpec {
  /** where the change is expected: a seed part whose origin lies in this box
   * (x and z ranges, and y above `yAbove`) may be changed freely */
  zone: { x: [number, number]; z: [number, number]; yAbove: number };
  /** further change zones, same shape — a seed part in ANY of them may change */
  zones?: { x: [number, number]; z: [number, number]; yAbove: number }[];
  /** sub-model file-name fragments whose parts are protected even inside the zone */
  protectFiles?: string[];
  /** fraction of protected seed parts that must stay at their exact pose */
  minKept: number;
  /** fraction of the seed's movable joints between protected parts that must survive */
  minJointsKept?: number;
  /** nothing may reach higher than `maxTop` (LDraw y) above this x/z rectangle */
  openTop?: { x: [number, number]; z: [number, number]; maxTop: number };
}

export interface EditReport {
  offset: [number, number, number];
  protectedParts: number;
  kept: number;
  newFailures: number;
  inheritedFailures: number;
  seedFailures: number;
  jointsProtected?: number;
  jointsKept?: number;
  openTopViolations?: number;
  seedOpenTopViolations?: number;
}

export interface Requirement {
  id: string;
  /** metric/kinematic decide by task-rung finding codes; structural = the referee's functional verdict
   * (or, when `codes` is given, those task-rung findings — edit tasks judge validity relative to the seed);
   * visual = the VLM judge */
  kind: "metric" | "structural" | "kinematic" | "visual";
  text: string;
  codes?: string[];
}

export interface Verdict {
  ok: boolean;
  valid: boolean;
  functional: boolean;
  adherent: boolean | null;
  source: string;
  parts: number;
  ms: number;
  rungs: Rung[];
  mechanism: MechanismInfo | null;
  /** one-paragraph human summary */
  summary: string;
  /** edit tasks: the seed-relative judgement */
  edit?: EditReport;
}
