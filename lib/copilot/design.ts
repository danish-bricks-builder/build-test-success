/**
 * design_layout — the planning stage that replaced get_reference (whose
 * caption retrieval over the s2b corpus returned a "castle-like chair"
 * for "castle watchtower"). Instead of studying someone else's voxel
 * dump, the model DESIGNS: named subsystems as footprint rectangles with
 * height bands, validated mechanically before a single brick is placed.
 *
 * The tool renders an ASCII top view (a letter per subsystem), reports
 * per-subsystem dimensions, and flags what a plan reviewer would:
 * subsystems outside the envelope, overlaps at the same height band,
 * and layers whose support (the band below) doesn't cover them.
 * The rendered plan is returned AND stored in the scratchpad note, so
 * read_note recalls it for the rest of the build.
 */

export interface Subsystem {
  name: string;
  /** footprint in studs; x0/z0 = min corner (may be negative) */
  x0: number;
  z0: number;
  w: number;
  l: number;
  /** vertical band in BRICKS from the ground (y0=0 = sits on the ground) */
  y0?: number;
  h?: number;
  note?: string;
}

export interface DesignInput {
  /** target envelope in studs / bricks — copy the mission's numbers */
  envelope?: { maxW?: number; maxL?: number; minHeightBricks?: number };
  subsystems: Subsystem[];
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function designLayout(input: DesignInput): { text: string; warnings: string[] } {
  const subs = (input.subsystems ?? []).slice(0, 26);
  const warnings: string[] = [];
  if (subs.length === 0) return { text: "design_layout: no subsystems given.", warnings: ["empty plan"] };

  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, topBrick = 0;
  for (const s of subs) {
    x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x0 + s.w);
    z0 = Math.min(z0, s.z0); z1 = Math.max(z1, s.z0 + s.l);
    topBrick = Math.max(topBrick, (s.y0 ?? 0) + (s.h ?? 1));
  }
  const W = x1 - x0, L = z1 - z0;

  const env = input.envelope;
  if (env?.maxW && Math.max(W, L) > Math.max(env.maxW, env.maxL ?? env.maxW))
    warnings.push(`plan footprint ${W}×${L} studs exceeds the envelope ${env.maxW}×${env.maxL ?? env.maxW} — shrink before building`);
  if (env?.maxL && Math.min(W, L) > Math.min(env.maxW ?? env.maxL, env.maxL))
    warnings.push(`plan's smaller side ${Math.min(W, L)} exceeds the envelope's ${Math.min(env.maxW ?? env.maxL, env.maxL)}`);
  if (env?.minHeightBricks && topBrick < env.minHeightBricks)
    warnings.push(`plan tops out at ${topBrick} bricks but the mission needs ≥${env.minHeightBricks}`);

  // overlaps within the same height band; support for raised subsystems
  for (let i = 0; i < subs.length; i++) {
    const a = subs[i];
    const aY0 = a.y0 ?? 0, aY1 = aY0 + (a.h ?? 1);
    if (aY0 > 0) {
      const supported = subs.some((b, j) => {
        if (j === i) return false;
        const bY1 = (b.y0 ?? 0) + (b.h ?? 1);
        const overlapX = Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0);
        const overlapZ = Math.min(a.z0 + a.l, b.z0 + b.l) - Math.max(a.z0, b.z0);
        return bY1 >= aY0 && overlapX >= Math.min(2, a.w) && overlapZ >= Math.min(2, a.l);
      });
      if (!supported) warnings.push(`"${a.name}" starts at brick ${aY0} but nothing below reaches it — it would float`);
    }
    for (let j = i + 1; j < subs.length; j++) {
      const b = subs[j];
      const bY0 = b.y0 ?? 0, bY1 = bY0 + (b.h ?? 1);
      const bandOverlap = Math.min(aY1, bY1) - Math.max(aY0, bY0);
      const overlapX = Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0);
      const overlapZ = Math.min(a.z0 + a.l, b.z0 + b.l) - Math.max(a.z0, b.z0);
      if (bandOverlap > 0 && overlapX > 0 && overlapZ > 0)
        warnings.push(`"${a.name}" and "${b.name}" overlap ${overlapX}×${overlapZ} studs in the same height band — same space twice`);
    }
  }

  // ASCII top view, 1 char per stud (capped)
  const scale = Math.max(1, Math.ceil(Math.max(W, L) / 48));
  const cols = Math.ceil(W / scale), rows = Math.ceil(L / scale);
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill("·"));
  subs.forEach((s, i) => {
    const ch = LETTERS[i];
    for (let z = 0; z < s.l; z++)
      for (let x = 0; x < s.w; x++) {
        const gx = Math.floor((s.x0 - x0 + x) / scale);
        const gz = Math.floor((s.z0 - z0 + z) / scale);
        if (grid[gz]?.[gx] !== undefined) grid[gz][gx] = grid[gz][gx] === "·" ? ch : grid[gz][gx];
      }
  });

  const legend = subs.map((s, i) =>
    `${LETTERS[i]} ${s.name}: ${s.w}×${s.l} studs at (${s.x0},${s.z0}), bricks ${s.y0 ?? 0}–${(s.y0 ?? 0) + (s.h ?? 1)}${s.note ? ` — ${s.note}` : ""}`,
  );
  const text = [
    `DESIGN — footprint ${W}×${L} studs · top at ${topBrick} bricks${scale > 1 ? ` · view 1 char = ${scale} studs` : ""}`,
    ...grid.map((r) => "  " + r.join("")),
    "",
    ...legend,
    ...(warnings.length ? ["", "⚠ PLAN REVIEW:", ...warnings.map((w) => "  ⚠ " + w)] : ["", "plan review: clean — build subsystem by subsystem, check_validity after each."]),
  ].join("\n");
  return { text, warnings };
}
