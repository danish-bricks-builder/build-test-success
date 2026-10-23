/**
 * Exact mate detection for editor2 — no semantics, pure geometry.
 *
 * Every engaged connector pair between two parts IS a mate. Engagement is
 * measured, not guessed: calibrated on real sets, engaged connectors
 * coincide at distance 0 (next-nearest cluster ≥8 LDU), so tolerance is
 * 0.5 LDU with no ambiguity band. Clips engage anywhere ALONG a bar, so
 * clip↔cyl uses point-to-axis-line distance.
 *
 * The pair's degree of freedom combines DESIGN INTENT with constraint
 * composition. A lone stud physically allows spin, but a stud is a
 * fastener with incidental slack, not a mechanism — LEGO's intended
 * articulations use dedicated connector classes (hinge fingers, clips on
 * bars, pins in holes, balls, turntables). So stud↔antistud contacts are
 * RIGID regardless of count, axle-in-cross-hole is keyed (rigid), and
 * everything else derives its DOF by constraint composition: all contacts
 * on one common axis line → revolute, any lateral second contact → rigid.
 * Connector classes are read from the shadow-library section specs
 * ("R 6 4" male = stud; square "S" or short-round r6 female = antistud;
 * "A" sections = axle cross; pins are long r6 bodies with r8 collars).
 *
 * Kinematics use a spanning tree (one driving joint per part); every
 * joint stores the REST frame that reproduces the as-built pose exactly,
 * so loading is lossless and the angle is a relative DOF from as-built.
 * Non-tree mates are loop closures (reported, not yet enforced).
 */
import { secSegments, type LocalConnector } from "../engine/connectionGraph";
import {
  compose,
  connFrame,
  mulMV,
  mulMM,
  transpose,
  IDENT,
  type E2Joint,
  type E2Part,
  type Frame,
  type V3,
} from "./kinematics";

const ENGAGE_TOL = 0.5; // LDU — calibrated (real engagements sit at 0)
const AXIS_TOL = 0.995; // |dot| for axis parallelism
const LINE_TOL = 0.75; // LDU — lateral distance for "same axis line"
const RADIUS_TOL = 0.6; // LDU — section radii that count as "the same bore"

/** Parsed shadow-library section spec ("R 6 4   R 8 2 …"). Lead-in
 * chamfers (L_/_L) are excluded — they describe insertion, not the fit. */
interface SecInfo {
  /** radii of real sections, in order */
  rads: number[];
  /** first real section (the engagement-side profile) */
  first: { rad: number; len: number } | null;
  /** total length of real sections */
  total: number;
  hasAxle: boolean; // any A (cross) section
  hasSquare: boolean; // any S (square) section
  roundOnly: boolean; // all real sections are R
}

const SEC_CACHE = new Map<string, SecInfo>();
function secInfo(secs?: string): SecInfo {
  const key = secs ?? "";
  let si = SEC_CACHE.get(key);
  if (si) return si;
  si = { rads: [], first: null, total: 0, hasAxle: false, hasSquare: false, roundOnly: true };
  for (const m of key.matchAll(/(L_|_L|[RSA])\s+([\d.]+)\s+([\d.]+)/g)) {
    const t = m[1];
    if (t === "L_" || t === "_L") continue;
    const rad = Number(m[2]);
    const len = Number(m[3]);
    si.rads.push(rad);
    si.total += len;
    if (!si.first) si.first = { rad, len };
    if (t === "A") si.hasAxle = true;
    if (t === "S") si.hasSquare = true;
    if (t !== "R") si.roundOnly = false;
  }
  SEC_CACHE.set(key, si);
  return si;
}

interface WorldConn {
  partId: number;
  /** library part number — lets callers veto rotation by part class. */
  part: string;
  conn: number;
  kind: string;
  gender?: string;
  radius: number | null;
  /** Blind hole (shadow caps=one): a male enters via the mouth only. */
  blind: boolean;
  /** Raw section spec + layout flag — per-pose section lookups. */
  secs?: string;
  ctr?: 1;
  si: SecInfo;
  pos: V3;
  axis: V3;
}

/**
 * Which SECTION of a male body is engaged with a female at this pose —
 * "R" (round shaft), "A" (axle cross), etc. The female's center is
 * projected onto the male's axis and looked up in his section band
 * (listed sections run along the −axis; center=true centers the band).
 * A friction pin's ridges live on its ROUND pin sections — the axle
 * half of an axle-pin engaged in a bore is a smooth bearing.
 */
function engagedSectionKind(male: WorldConn, female: WorldConn): string | null {
  const segs = secSegments(male.secs);
  if (segs.length === 0) return null;
  const total = segs.reduce((s, x) => s + x.len, 0);
  const d = sub(female.pos, male.pos);
  const c = dot(d, male.axis);
  let at = male.ctr ? total / 2 : 0;
  for (const seg of segs) {
    const lo = at - seg.len;
    if (c >= lo - 0.25 && c <= at + 0.25) return seg.kind;
    at = lo;
  }
  return null;
}

export interface Mate {
  a: WorldConn;
  b: WorldConn;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);

function worldConnectors(
  parts: E2Part[],
  frames: Map<number, Frame>,
  connectorsOf: (part: string) => LocalConnector[],
): WorldConn[] {
  const out: WorldConn[] = [];
  for (const p of parts) {
    const f = frames.get(p.id);
    if (!f) continue;
    connectorsOf(p.part).forEach((c, idx) => {
      const ori = c.ori ?? IDENT;
      const pos = mulMV(f.r, c.local).map((v, i) => v + f.o[i]) as V3;
      const axisRaw = mulMV(f.r, mulMV(ori, [0, 1, 0]));
      const n = norm(axisRaw) || 1;
      out.push({
        partId: p.id,
        part: p.part,
        conn: idx,
        kind: c.kind,
        gender: c.gender,
        radius: c.radius,
        blind: c.caps === "one",
        secs: c.secs,
        ctr: c.ctr,
        si: secInfo(c.secs),
        pos,
        axis: [axisRaw[0] / n, axisRaw[1] / n, axisRaw[2] / n],
      });
    });
  }
  return out;
}

function compatible(a: WorldConn, b: WorldConn): boolean {
  const pair = [a.kind, b.kind].sort().join("+");
  if (pair === "cyl+cyl") {
    if (a.gender === b.gender) return false;
    // Any section of one within tolerance of any section of the other:
    // a pin's r6 shaft meets a pinhole's r6 bore even though both START
    // with a different profile (chamfer lead-in / r8 collar seat).
    if (a.si.rads.length && b.si.rads.length) {
      return a.si.rads.some((ra) => b.si.rads.some((rb) => Math.abs(ra - rb) <= RADIUS_TOL));
    }
    if (a.radius != null && b.radius != null && Math.abs(a.radius - b.radius) > RADIUS_TOL)
      return false;
    return true;
  }
  if (pair === "fgr+fgr") return true;
  if (pair === "clp+cyl") return true;
  if (pair === "gen+gen") return a.gender !== b.gender; // ball ↔ socket
  return false;
}

const isR6 = (r: number) => r >= 5.5 && r <= 6.5;

/**
 * Design-intent fastener test for one cyl↔cyl contact. Fasteners hold
 * parts together; their incidental rotational slack is NOT a joint.
 *  - stud (male, all-round sections, has an r6 section, ≤10 LDU total)
 *    into any r6 female (antistud, deep well, even a Technic bore) → rigid
 *  - any all-round male with an r6 section (incl. the stud end of a
 *    stud-pin) into an antistud female (square S box, or short round r6
 *    first profile) → rigid
 *  - axle cross section in axle cross hole → keyed → rigid
 * Pins/pinholes escape: the female's FIRST profile is the r8 collar seat
 * and pins are >10 LDU long. Minifig necks (r6 but 12 long), arms (r5),
 * hips (r3), wrists (r2.5), bars/turntables (r4) all miss the r6 tests
 * and keep their articulation.
 */
function fastenerContact(a: WorldConn, b: WorldConn): "keyed axle" | "stud" | null {
  if (a.kind !== "cyl" || b.kind !== "cyl") return null;
  const m = a.gender === "M" ? a : b;
  const f = a.gender === "M" ? b : a;
  if (m.si.hasAxle && f.si.hasAxle) return "keyed axle"; // keyed axle drive
  // "Any r6 section" not "first section": a round plate's stud spec is
  // "R 10 3   R 6 4" (side disc first, stud second).
  const maleR6Round = m.si.roundOnly && m.si.rads.some(isR6);
  const maleStud = maleR6Round && m.si.total <= 10;
  const femaleAntistud = f.si.hasSquare
    ? f.si.rads.some(isR6)
    : !f.si.hasAxle && f.si.first != null && isR6(f.si.first.rad) && f.si.first.len <= 8;
  if (maleStud && f.si.rads.some(isR6)) return "stud";
  if (maleR6Round && femaleAntistud) return "stud";
  return null;
}

/**
 * Engagement test. Points must coincide; clips may slide along the bar;
 * LONG round bodies (pins, bars, axles — ≥12 LDU of sections) engage any
 * bore whose span overlaps theirs along the shared axis. Calibrated on
 * real pin seatings: hole centers sit ±10/±20 LDU along the pin with
 * lateral 0.00, and centered section spans reproduce every case (min
 * genuine overlap seen: 4 LDU, a half-pin's stud tail in a tile).
 */
// LDU of span overlap for a long body to count as INSERTED. Calibrated
// on real sets: the shallowest genuine engagement observed is 4 LDU (a
// half-pin's stud tail in a tile). Below that the male is merely
// resting in the mouth — the tip of an axle-pin standing on a bore is
// not a connection, it is a part balanced on another.
const SPAN_OVERLAP_MIN = 4; // LDU
function engaged(a: WorldConn, b: WorldConn): boolean {
  if (Math.abs(dot(a.axis, b.axis)) < AXIS_TOL) return false;
  const d = sub(a.pos, b.pos);
  const pair = [a.kind, b.kind].sort().join("+");
  // INSERTION DIRECTION: a blind FEMALE (caps=one — underside pockets,
  // tube mouths) accepts a male only through its open mouth, so the
  // axes must agree in SIGN. Frame coincidence with anti-aligned axes
  // (an upside-down stud backed against a pocket) is a sham, not a
  // mate. Scope: only SHORT females (≤8 LDU — deep bores are
  // physically through despite some caps=one authoring) and only
  // SHORT males (studs): a LONG two-ended male (pin, axle-pin) has ONE
  // connector whose axis points toward one end, yet either end may
  // legitimately enter the mouth — profile/collision judge those.
  if (pair === "cyl+cyl") {
    const fem = a.gender === "F" ? a : b.gender === "F" ? b : null;
    const male = fem === a ? b : a;
    if (fem?.blind && fem.si.total <= 8 && male.si.total <= 10 && dot(a.axis, b.axis) < AXIS_TOL)
      return false;
  }
  if (pair === "clp+cyl") {
    const bar = a.kind === "cyl" ? a : b;
    const along = dot(d, bar.axis);
    const lat2 = dot(d, d) - along * along;
    return Math.sqrt(Math.max(0, lat2)) <= ENGAGE_TOL && Math.abs(along) <= 40;
  }
  // Origin coincidence is NOT sufficient for cylinders: a stud's BASE
  // origin lies exactly on the pocket's mouth origin when an upside-down
  // part backs against an underside — spans pointing AWAY from each
  // other, zero insertion, yet coincident origins. The band test below
  // measures actual span overlap and correctly rejects that sham (and
  // accepts every real seat), so cyl+cyl must fall through to it.
  if (pair !== "cyl+cyl" && norm(d) <= ENGAGE_TOL) return true;
  // Short r4 pin↔socket (the 2429/2430 swivel-hinge family): the shadow
  // data puts the pin origin and socket origin at OPPOSITE ends, so an
  // engaged pair sits ~4 LDU apart along a perfectly shared axis (Fiat
  // doors: dist 3.99, axdot 1.000). Tip-contact of the spans counts.
  const shortR4 = (w: WorldConn) =>
    w.si.roundOnly &&
    w.si.first != null &&
    w.si.first.rad >= 3.5 &&
    w.si.first.rad <= 4.5 &&
    w.si.total <= 11;
  const longBody = a.si.total >= 12 || b.si.total >= 12;
  const hingePin = shortR4(a) && shortR4(b);
  // SPAN OVERLAP IS THE GENERAL TEST. Origin coincidence only works
  // when both shadows happen to anchor their connector at the same
  // point, which is an authoring accident rather than a rule: 6141's
  // stud is "R 10 3  R 6 4", so its origin sits 3 LDU below the r6 stud
  // proper and 3 LDU from the mating female's origin. Requiring
  // coincidence made every round brick, cone, dish and tile sitting on
  // that stud invisible — 74% of Tile Round 1x1 instances and 47% of
  // 6141's were detected as connected to nothing at all. The long-body
  // and hinge-pin branches below were two earlier patches of this same
  // hole; applying the band test to every cylinder pair subsumes them.
  if (pair === "cyl+cyl") {
    // Span overlap is measured between the two section BANDS, and a
    // band is only centered on its origin when the shadow says
    // center=true; otherwise it runs from the origin along the −axis
    // (an axle hole's 20 LDU reach INTO the arm from its face).
    // Ignoring that offset accepted poses whose spans never touch —
    // an axle "engaged" with a hole it merely points at.
    const bandCenter = (w: WorldConn): V3 => {
      const off = w.ctr ? 0 : -w.si.total / 2;
      return [w.pos[0] + w.axis[0] * off, w.pos[1] + w.axis[1] * off, w.pos[2] + w.axis[2] * off];
    };
    const dc = sub(bandCenter(a), bandCenter(b));
    const along = dot(dc, a.axis);
    const lat2 = dot(dc, dc) - along * along;
    if (Math.sqrt(Math.max(0, lat2)) > ENGAGE_TOL) return false;
    // A shallow receptacle can't demand more depth than it has: a
    // 4-LDU pocket is fully engaged at 4.
    const fem = a.gender === "F" ? a : b;
    const need = hingePin ? -0.5 : Math.min(SPAN_OVERLAP_MIN, fem.si.total);
    return a.si.total / 2 + b.si.total / 2 - Math.abs(along) >= need - 0.01;
  }
  return false;
}

/** All mates in the assembly (spatial-hashed; exact). */
export function detectMates(
  parts: E2Part[],
  frames: Map<number, Frame>,
  connectorsOf: (part: string) => LocalConnector[],
): Mate[] {
  const world = worldConnectors(parts, frames, connectorsOf);
  const CELL = 8;
  const buckets = new Map<string, number[]>();
  const keyOf = (p: V3) =>
    `${Math.round(p[0] / CELL)},${Math.round(p[1] / CELL)},${Math.round(p[2] / CELL)}`;
  world.forEach((w, i) => {
    const insert = (p: V3) => {
      const k = keyOf(p);
      const b = buckets.get(k);
      if (!b) buckets.set(k, [i]);
      else if (b[b.length - 1] !== i) b.push(i);
    };
    // Long bodies (axles, bars, pins) engage anywhere along their span,
    // not just at the connector's origin point — rasterize the span into
    // the hash so a socket 40 LDU down a 100 LDU axle still meets it.
    const half = w.si.total / 2;
    if (w.kind === "cyl" && half > CELL) {
      for (let t = -half; t <= half + 1e-6; t += CELL)
        insert([w.pos[0] + w.axis[0] * t, w.pos[1] + w.axis[1] * t, w.pos[2] + w.axis[2] * t]);
    } else insert(w.pos);
  });
  const mates: Mate[] = [];
  const seen = new Set<string>();
  for (const [key, idxs] of buckets) {
    const [cx, cy, cz] = key.split(",").map(Number);
    const neighborhood: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const n = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (n) neighborhood.push(...n);
        }
    for (const i of idxs) {
      for (const j of neighborhood) {
        if (j <= i) continue;
        const a = world[i];
        const b = world[j];
        if (a.partId === b.partId) continue;
        if (!compatible(a, b) || !engaged(a, b)) continue;
        const k = `${Math.min(i, j)}/${Math.max(i, j)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        mates.push({ a, b });
      }
    }
  }
  return mates;
}

/** Caller veto: parts whose rotation is meaningless (round 1×1s). */
export type RigidPartFn = (part: string) => boolean;
/** Caller veto on a contact PAIR (e.g. tyre-on-wheel = solid assembly). */
export type RigidPairFn = (a: string, b: string) => boolean;
export interface InferOpts {
  rigidPart?: RigidPartFn;
  rigidPair?: RigidPairFn;
  /** Friction pins/axle-pins ("with Friction Ridges") — LEGO's own
   * fasten-vs-bearing distinction: friction = structure, smooth = spin.
   * Name-based, so supplied by the caller like the other predicates. */
  frictionPart?: (part: string) => boolean;
  /** Told the parts of a cluster that bridges two others on one axis line: true when it is a SHAFT (an axle
   * carrying a gear or a wheel), not a fastener. Two bodies a shaft passes through are still welded when
   * something else joins them off that line, but the shaft itself goes on turning in them. Default: every
   * bridge is a fastener and is welded in (the editor's reading). */
  shaft?: (parts: string[]) => boolean;
  /** Judge each loop of joints BY ITSELF when deciding whether it braces into a rigid frame. By default
   * every loop that shares a cluster with another is lumped with it, so a planar steering linkage and a
   * drive shaft, which meet only at the chassis, count as one tangle with axes in several directions and
   * are welded solid. With this on, loops are split where they meet at a single cluster (the graph's
   * biconnected blocks): the linkage keeps moving, a triangulated frame still welds. */
  blocks?: boolean;
}

/**
 * Pair DOF: any fastener contact (stud↔antistud, keyed axle) → rigid,
 * regardless of geometry — fastened is fastened. Caller vetoes
 * (rotationally symmetric round 1×1s whose spin is unobservable;
 * tyre-on-wheel pairs that are really one solid assembly) also force
 * rigid. Otherwise all contacts must lie on one common axis line →
 * revolute.
 */
/** Which heuristic decided a pair's DOF — stage-2 provenance for review UIs. */
export type PairRule =
  | "keyed axle" // axle cross in axle hole → driven, rigid
  | "stud" // stud into antistud → fastened, rigid
  | "friction pin" // friction pin in a hole → fastened, rigid (smooth pins spin)
  | "part veto" // caller: rotationally-meaningless part (round 1×1)
  | "pair veto" // caller: solid pair (tyre on wheel)
  | "crossed axes" // contacts on non-parallel axes → geometrically rigid
  | "off-axis" // parallel but non-colinear contacts → rigid
  | "colinear"; // all contacts share one axis line → revolute

function pairDof(
  contacts: Mate[],
  opts?: InferOpts,
): { kind: "rigid" | "revolute"; axisMate: Mate; rule: PairRule } {
  const first = contacts[0];
  for (const m of contacts) {
    const fast = fastenerContact(m.a, m.b);
    if (fast) return { kind: "rigid", axisMate: first, rule: fast };
    if (
      opts?.frictionPart &&
      m.a.kind === "cyl" &&
      m.b.kind === "cyl" &&
      (opts.frictionPart(m.a.part) || opts.frictionPart(m.b.part))
    ) {
      // Friction is a property of the RIDGED sections, not the whole
      // part: an axle-pin's name says friction, but its AXLE half in a
      // round bore is a smooth bearing — only round (ridged) male
      // sections fasten. Engaged A-section → let the geometry decide.
      const male = m.a.gender === "M" ? m.a : m.b;
      const female = male === m.a ? m.b : m.a;
      if (engagedSectionKind(male, female) !== "A")
        return { kind: "rigid", axisMate: first, rule: "friction pin" };
    }
    if (opts?.rigidPart && (opts.rigidPart(m.a.part) || opts.rigidPart(m.b.part)))
      return { kind: "rigid", axisMate: first, rule: "part veto" };
    if (opts?.rigidPair && opts.rigidPair(m.a.part, m.b.part))
      return { kind: "rigid", axisMate: first, rule: "pair veto" };
  }
  const axis = first.a.axis;
  const anchor = first.a.pos;
  for (const m of contacts) {
    if (Math.abs(dot(m.a.axis, axis)) < AXIS_TOL)
      return { kind: "rigid", axisMate: first, rule: "crossed axes" };
    const d = sub(m.a.pos, anchor);
    const along = dot(d, axis);
    const lat2 = dot(d, d) - along * along;
    if (Math.sqrt(Math.max(0, lat2)) > LINE_TOL)
      return { kind: "rigid", axisMate: first, rule: "off-axis" };
  }
  return { kind: "revolute", axisMate: first, rule: "colinear" };
}

/** One part-pair of the contact graph, with its stage-2 classification —
 * the reviewable record: "these two parts touch via N contacts; this rule
 * decided rigid/revolute". aConn/bConn index the first contact's connectors
 * (for class labels). */
export interface PairRecord {
  a: number;
  b: number;
  n: number;
  aConn: number;
  bConn: number;
  kind: "rigid" | "revolute";
  rule: PairRule;
}

export interface InferredJoints {
  joints: E2Joint[];
  /** part ids that stay roots (component anchors). */
  anchors: Set<number>;
  /** The classified contact graph (stage-1 mates grouped per part pair). */
  pairs: PairRecord[];
  matesTotal: number;
  loopMates: number;
  revolute: number;
  /** revolute cluster-edges pinned by cycles in the cluster graph. */
  lockedJoints: number;
  /** rigid bodies after condensation. */
  clusters: number;
  /** Cluster membership (part ids), largest body first — for inspection. */
  clusterMembers: number[][];
}

const invFrame = (f: Frame): Frame => {
  const rt = transpose(f.r);
  const o = mulMV(rt, f.o).map((v) => -v) as V3;
  return { o, r: rt };
};

/**
 * Rigid-body condensation + kinematic tree.
 *
 * 1. Per part-pair DOF from all contacts (constraint composition).
 * 2. Union-find over RIGID pairs → clusters (rigid bodies). This is also
 *    the loop analysis for rigid loops: a "revolute" pair whose ends land
 *    in the same cluster is pinned by the assembly → frozen.
 * 3. Cluster-pair edges recompose ALL contacts between the two bodies:
 *    still colinear → a true movable revolute (a door on two aligned
 *    hinges merges into one axis); not colinear → the clusters are
 *    mutually rigid after all → merge and repeat to fixpoint.
 * 4. Remaining cluster-graph cycles (revolute loops — four-bars etc.):
 *    v1 marks those edges LOCKED (conservative; coupled-motion solve later).
 * 5. Kinematics: BFS cluster tree from the largest cluster (the body of
 *    the model — so doors swing, not the car), parts within a cluster
 *    hang off the cluster's root part via rigid joints, exact rest frames
 *    throughout.
 */
export function inferJoints(
  parts: E2Part[],
  frames: Map<number, Frame>,
  connectorsOf: (part: string) => LocalConnector[],
  nextIdRef: { current: number },
  opts?: InferOpts,
): InferredJoints {
  const mates = detectMates(parts, frames, connectorsOf);

  // Group contacts per unordered part pair.
  const byPair = new Map<string, Mate[]>();
  for (const m of mates) {
    const k = [m.a.partId, m.b.partId].sort((x, y) => x - y).join("/");
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k)!.push(m);
  }

  // Union-find.
  const uf = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (uf.get(r) !== r) r = uf.get(r)!;
    let c = x;
    while (uf.get(c) !== c) {
      const n = uf.get(c)!;
      uf.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: number, b: number) => uf.set(find(a), find(b));
  for (const p of parts) uf.set(p.id, p.id);

  const pairInfo = new Map<string, { kind: "rigid" | "revolute" }>();
  const pairs: PairRecord[] = [];
  for (const [k, contacts] of byPair) {
    const { kind, rule } = pairDof(contacts, opts);
    pairInfo.set(k, { kind });
    const first = contacts[0];
    pairs.push({
      a: first.a.partId,
      b: first.b.partId,
      n: contacts.length,
      aConn: first.a.conn,
      bConn: first.b.conn,
      kind,
      rule,
    });
    if (kind === "rigid") {
      const [x, y] = k.split("/").map(Number);
      union(x, y);
    }
  }

  // Cluster-level recomposition to fixpoint: revolute pairs whose combined
  // cluster-to-cluster contacts are NOT colinear rigidify the clusters.
  const lineColinear = (p1: V3, d1: V3, p2: V3, d2: V3) => {
    if (Math.abs(dot(d1, d2)) < AXIS_TOL) return false;
    const dp = sub(p2, p1);
    const along = dot(dp, d1);
    const lat2 = dot(dp, dp) - along * along;
    return Math.sqrt(Math.max(0, lat2)) <= LINE_TOL;
  };
  for (;;) {
    const byClusterPair = new Map<string, Mate[]>();
    for (const [k, contacts] of byPair) {
      if (pairInfo.get(k)!.kind !== "revolute") continue;
      const [x, y] = k.split("/").map(Number);
      const cx = find(x);
      const cy = find(y);
      if (cx === cy) continue; // pinned inside a rigid body — frozen
      const ck = [cx, cy].sort((a, b) => a - b).join("/");
      if (!byClusterPair.has(ck)) byClusterPair.set(ck, []);
      byClusterPair.get(ck)!.push(...contacts);
    }
    let merged = false;
    for (const [ck, contacts] of byClusterPair) {
      if (pairDof(contacts, opts).kind === "rigid") {
        const [cx, cy] = ck.split("/").map(Number);
        union(cx, cy);
        merged = true;
      }
    }
    if (merged) continue;

    // Multi-path weld (design intent: fastened twice = rigid). Two
    // clusters joined by ≥2 independent single-axis paths — a direct
    // revolute edge, or a degree-2 "fastener bridge" cluster (a pin,
    // whose two end joints share the pin's own axis) — cannot move
    // relative to each other unless ALL the paths lie on ONE axis line
    // (a door on two coaxial hinges). Non-colinear path set → weld the
    // clusters and their bridge pins into one body. A four-bar's
    // coupler link is NOT single-axis (two offset pivot holes), so
    // genuine linkages keep their mobility and fall through to the
    // cycle-lock analysis below.
    const adj = new Map<number, Map<number, Mate[]>>();
    for (const [ck, contacts] of byClusterPair) {
      const [cx, cy] = ck.split("/").map(Number);
      if (!adj.has(cx)) adj.set(cx, new Map());
      if (!adj.has(cy)) adj.set(cy, new Map());
      adj.get(cx)!.set(cy, contacts);
      adj.get(cy)!.set(cx, contacts);
    }
    const axisOf = (contacts: Mate[]) => {
      const m = pairDof(contacts, opts).axisMate;
      return { p: m.a.pos, d: m.a.axis };
    };
    for (const [b, nbrs] of adj) {
      if (merged) break;
      if (nbrs.size !== 2) continue; // bridge candidates: pure two-ended connectors
      const [[x, ex], [y, ey]] = [...nbrs.entries()];
      const ax = axisOf(ex);
      const ay = axisOf(ey);
      if (!lineColinear(ax.p, ax.d, ay.p, ay.d)) continue; // a link, not a fastener
      // Sibling paths between the same (x, y): other single-axis bridges
      // and the direct edge, if any.
      const paths: { p: V3; d: V3; bridge: number | null }[] = [{ ...ax, bridge: b }];
      for (const [b2, nbrs2] of adj) {
        if (b2 === b || nbrs2.size !== 2 || !nbrs2.has(x) || !nbrs2.has(y)) continue;
        const a1 = axisOf(nbrs2.get(x)!);
        const a2 = axisOf(nbrs2.get(y)!);
        if (lineColinear(a1.p, a1.d, a2.p, a2.d)) paths.push({ ...a1, bridge: b2 });
      }
      const direct = adj.get(x)?.get(y);
      if (direct) paths.push({ ...axisOf(direct), bridge: null });
      if (paths.length < 2) continue;
      const allOneLine = paths.every((q) => lineColinear(paths[0].p, paths[0].d, q.p, q.d));
      if (allOneLine) continue; // one shared hinge line — still articulates
      // (clusters are read before the weld: `find` changes with every union)
      const turning = new Set(opts?.shaft ? paths.filter((q) => q.bridge != null && opts.shaft!(parts.filter((pt) => find(pt.id) === q.bridge).map((pt) => pt.part))).map((q) => q.bridge) : []);
      union(x, y);
      for (const q of paths) if (q.bridge != null && !turning.has(q.bridge)) union(x, q.bridge);
      merged = true;
    }
    if (merged) continue;

    // Cycle weld: a cycle system (biconnected set of revolute cluster
    // edges) whose joint axes point in MORE than one direction braces
    // itself — no planar mechanism exists there, the loop is structure
    // (a Technic frame triangulated by pins). All-parallel cycle
    // systems are genuine linkage candidates (four-bars, steering) and
    // fall through to the cycle-lock analysis below instead.
    {
      const edgeKeys = new Map<string, { cx: number; cy: number; contacts: Mate[] }>();
      for (const [ck, contacts] of byClusterPair) {
        const [cx, cy] = ck.split("/").map(Number);
        edgeKeys.set(ck, { cx: find(cx), cy: find(cy), contacts });
      }
      // graph bridges (tree edges) via DFS — non-bridge edges form cycles
      const disc = new Map<number, number>();
      const low = new Map<number, number>();
      const bridgesG = new Set<string>();
      let timer = 0;
      const dfs = (u: number, parentEdge: string | null) => {
        disc.set(u, ++timer);
        low.set(u, timer);
        for (const [v, contacts] of adj.get(u) ?? []) {
          void contacts;
          const ek = [u, v].sort((a2, b2) => a2 - b2).join("/");
          if (ek === parentEdge) continue;
          if (!disc.has(v)) {
            dfs(v, ek);
            low.set(u, Math.min(low.get(u)!, low.get(v)!));
            if (low.get(v)! > disc.get(u)!) bridgesG.add(ek);
          } else {
            low.set(u, Math.min(low.get(u)!, disc.get(v)!));
          }
        }
      };
      for (const u of adj.keys()) if (!disc.has(u)) dfs(u, null);
      // components of the cycle subgraph (non-bridge edges only)
      const comp = new Map<number, number>();
      const cfind = (x2: number): number => {
        let r = x2;
        while (comp.get(r) !== r) r = comp.get(r)!;
        let c2 = x2;
        while (comp.get(c2) !== c2) {
          const n2 = comp.get(c2)!;
          comp.set(c2, r);
          c2 = n2;
        }
        return r;
      };
      for (const u of adj.keys()) comp.set(u, u);
      for (const [ck, e] of edgeKeys) {
        if (bridgesG.has(ck)) continue;
        comp.set(cfind(e.cx), cfind(e.cy));
      }
      const byComp = new Map<number, { clusters: Set<number>; dirs: V3[] }>();
      for (const [ck, e] of edgeKeys) {
        if (bridgesG.has(ck)) continue;
        const r = cfind(e.cx);
        if (!byComp.has(r)) byComp.set(r, { clusters: new Set(), dirs: [] });
        const g = byComp.get(r)!;
        g.clusters.add(e.cx);
        g.clusters.add(e.cy);
        g.dirs.push(axisOf(e.contacts).d);
      }
      if (opts?.blocks) {
        // the same, per block: loops that meet only at one cluster are separate systems
        byComp.clear();
        const d2 = new Map<number, number>();
        const l2 = new Map<number, number>();
        const stack: string[] = [];
        let t2 = 0;
        let blockId = 0;
        const keyOf = (u: number, v: number) => [u, v].sort((a2, b2) => a2 - b2).join("/");
        const go = (u: number, parentEdge: string | null) => {
          d2.set(u, ++t2);
          l2.set(u, t2);
          for (const v of adj.get(u)?.keys() ?? []) {
            const ek = keyOf(u, v);
            if (ek === parentEdge) continue;
            if (!d2.has(v)) {
              stack.push(ek);
              go(v, ek);
              l2.set(u, Math.min(l2.get(u)!, l2.get(v)!));
              if (l2.get(v)! >= d2.get(u)!) {
                const edges: string[] = [];
                for (;;) {
                  const e = stack.pop()!;
                  edges.push(e);
                  if (e === ek) break;
                }
                if (edges.length >= 2) {
                  const g = { clusters: new Set<number>(), dirs: [] as V3[] };
                  for (const e of edges) {
                    const info = edgeKeys.get(e);
                    if (!info) continue;
                    g.clusters.add(info.cx);
                    g.clusters.add(info.cy);
                    g.dirs.push(axisOf(info.contacts).d);
                  }
                  byComp.set(blockId++, g);
                }
              }
            } else if (d2.get(v)! < d2.get(u)!) {
              stack.push(ek);
              l2.set(u, Math.min(l2.get(u)!, d2.get(v)!));
            }
          }
        };
        for (const u of adj.keys()) if (!d2.has(u)) go(u, null);
      }
      for (const g of byComp.values()) {
        if (g.clusters.size < 2) continue;
        const allParallel = g.dirs.every((d2) => Math.abs(dot(d2, g.dirs[0])) >= AXIS_TOL);
        if (allParallel) continue; // possible planar mechanism — leave for lock analysis
        // (a shaft, all of whose bearings lie on one line, goes on turning in whatever the loop welds into)
        const turns = (c: number) => {
          if (!opts?.shaft) return false;
          const lines = [...(adj.get(c)?.values() ?? [])].map(axisOf);
          return lines.every((q) => lineColinear(lines[0].p, lines[0].d, q.p, q.d)) && opts.shaft(parts.filter((pt) => find(pt.id) === c).map((pt) => pt.part));
        };
        const [first, ...rest] = [...g.clusters].filter((c) => !turns(c));
        for (const c2 of rest)
          if (find(first) !== find(c2)) {
            union(first, c2);
            merged = true;
          }
      }
    }
    if (!merged) break;
  }

  // Movable cluster edges (one per cluster pair, contacts unioned).
  const clusterEdges = new Map<string, Mate[]>();
  for (const [k, contacts] of byPair) {
    if (pairInfo.get(k)!.kind !== "revolute") continue;
    const [x, y] = k.split("/").map(Number);
    const cx = find(x);
    const cy = find(y);
    if (cx === cy) continue;
    const ck = [cx, cy].sort((a, b) => a - b).join("/");
    if (!clusterEdges.has(ck)) clusterEdges.set(ck, []);
    clusterEdges.get(ck)!.push(...contacts);
  }

  // Bridge detection on the cluster graph: non-bridge edges sit in cycles
  // (four-bar-style revolute loops) → locked in v1.
  const cAdj = new Map<number, Map<number, string>>();
  for (const ck of clusterEdges.keys()) {
    const [cx, cy] = ck.split("/").map(Number);
    if (!cAdj.has(cx)) cAdj.set(cx, new Map());
    if (!cAdj.has(cy)) cAdj.set(cy, new Map());
    cAdj.get(cx)!.set(cy, ck);
    cAdj.get(cy)!.set(cx, ck);
  }
  const lockedEdges = new Set<string>();
  {
    const disc = new Map<number, number>();
    const low = new Map<number, number>();
    let timer = 0;
    const bridges = new Set<string>();
    const dfs = (u: number, parentEdge: string | null) => {
      disc.set(u, ++timer);
      low.set(u, timer);
      for (const [v, ek] of cAdj.get(u) ?? []) {
        if (ek === parentEdge) continue;
        if (!disc.has(v)) {
          dfs(v, ek);
          low.set(u, Math.min(low.get(u)!, low.get(v)!));
          if (low.get(v)! > disc.get(u)!) bridges.add(ek);
        } else {
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
      }
    };
    for (const c of cAdj.keys()) if (!disc.has(c)) dfs(c, null);
    for (const ek of clusterEdges.keys()) if (!bridges.has(ek)) lockedEdges.add(ek);
  }

  // Cluster membership.
  const members = new Map<number, number[]>();
  for (const p of parts) {
    const c = find(p.id);
    if (!members.has(c)) members.set(c, []);
    members.get(c)!.push(p.id);
  }

  const partById = new Map(parts.map((p) => [p.id, p]));
  const mkJoint = (
    parentPart: number,
    childPart: number,
    contacts: Mate[],
    kind: "rigid" | "revolute",
    locked: boolean,
  ): E2Joint => {
    const axisMate = kind === "revolute" ? pairDof(contacts, opts).axisMate : contacts[0];
    const pSide = axisMate.a.partId === parentPart ? axisMate.a : axisMate.b;
    const cSide = axisMate.a.partId === parentPart ? axisMate.b : axisMate.a;
    const Wp = compose(
      frames.get(parentPart)!,
      connFrame(connectorsOf(partById.get(parentPart)!.part)[pSide.conn]),
    );
    const Wc = compose(
      frames.get(childPart)!,
      connFrame(connectorsOf(partById.get(childPart)!.part)[cSide.conn]),
    );
    return {
      id: nextIdRef.current++,
      parent: { partId: parentPart, conn: pSide.conn },
      child: { partId: childPart, conn: cSide.conn },
      kind,
      angle: 0,
      flip: false,
      rest: compose(invFrame(Wp), Wc),
      ...(locked ? { locked: true } : {}),
    };
  };

  // Part adjacency (pair key per neighbor) for intra-cluster BFS.
  const pAdj = new Map<number, [number, string][]>();
  for (const k of byPair.keys()) {
    const [x, y] = k.split("/").map(Number);
    if (!pAdj.has(x)) pAdj.set(x, []);
    if (!pAdj.has(y)) pAdj.set(y, []);
    pAdj.get(x)!.push([y, k]);
    pAdj.get(y)!.push([x, k]);
  }

  // Intra-cluster part tree (rigid joints), rooted at a given part.
  const joints: E2Joint[] = [];
  const treeVisited = new Set<number>();
  const buildClusterTree = (root: number) => {
    const cluster = find(root);
    treeVisited.add(root);
    const queue = [root];
    while (queue.length) {
      const u = queue.shift()!;
      for (const [v, k] of pAdj.get(u) ?? []) {
        if (treeVisited.has(v) || find(v) !== cluster) continue;
        treeVisited.add(v);
        queue.push(v);
        joints.push(mkJoint(u, v, byPair.get(k)!, "rigid", false));
      }
    }
  };

  // Cluster tree: BFS from the LARGEST cluster of each component.
  const clusterList = [...members.keys()];
  const compSeen = new Set<number>();
  const anchors = new Set<number>();
  let revolute = 0;
  let lockedJoints = 0;

  for (const start of clusterList.sort((a, b) => members.get(b)!.length - members.get(a)!.length)) {
    if (compSeen.has(start)) continue;
    // Anchor: first part of the largest cluster in this component.
    const rootPart = members.get(start)![0];
    anchors.add(rootPart);
    compSeen.add(start);
    buildClusterTree(rootPart);
    const queue = [start];
    while (queue.length) {
      const cu = queue.shift()!;
      for (const [cv, ek] of cAdj.get(cu) ?? []) {
        if (compSeen.has(cv)) continue;
        compSeen.add(cv);
        queue.push(cv);
        const contacts = clusterEdges.get(ek)!;
        const locked = lockedEdges.has(ek);
        // Parent-side part of the driving contact must be in cluster cu.
        const probe = pairDof(contacts, opts).axisMate;
        const pPart = find(probe.a.partId) === cu ? probe.a.partId : probe.b.partId;
        const cPart = find(probe.a.partId) === cu ? probe.b.partId : probe.a.partId;
        joints.push(mkJoint(pPart, cPart, contacts, "revolute", locked));
        if (locked) lockedJoints++;
        else revolute++;
        buildClusterTree(cPart);
      }
    }
  }

  return {
    joints,
    anchors,
    pairs,
    matesTotal: mates.length,
    loopMates: lockedEdges.size,
    revolute,
    lockedJoints,
    clusters: members.size,
    clusterMembers: [...members.values()].sort((a, b) => b.length - a.length),
  };
}

/** Human label for the connector class driving a joint (for joint cards). */
export function contactClassLabel(a: LocalConnector, b: LocalConnector): string {
  const kinds = [a.kind, b.kind].sort().join("+");
  if (kinds === "fgr+fgr") return "hinge";
  if (kinds === "clp+cyl") return "clip·bar";
  if (kinds === "gen+gen") return "ball";
  if (kinds === "cyl+cyl") {
    const m = a.gender === "M" ? a : b;
    const si = secInfo(m.secs);
    if (si.hasAxle) return "axle";
    const r = si.first?.rad ?? m.radius ?? 0;
    if (r <= 4.5) return "bar";
    if (isR6(r) && si.total > 10) return "pin";
    if (isR6(r)) return "stud";
    return "cyl";
  }
  return kinds;
}

/** Sanity check: solved frames must reproduce the imported frames. */
export function verifyRoundTrip(
  original: Map<number, Frame>,
  solved: Map<number, Frame>,
): { maxPosErr: number; maxRotErr: number } {
  let maxPosErr = 0;
  let maxRotErr = 0;
  for (const [id, f] of original) {
    const s = solved.get(id);
    if (!s) continue;
    maxPosErr = Math.max(maxPosErr, norm(sub(s.o, f.o)));
    const d = mulMM(transpose(s.r), f.r);
    maxRotErr = Math.max(maxRotErr, Math.abs(d[0] + d[4] + d[8] - 3));
  }
  return { maxPosErr, maxRotErr };
}
