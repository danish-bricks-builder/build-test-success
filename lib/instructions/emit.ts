/**
 * Instruction emitter — translate a set's build sequence + inferred mates
 * into two derived representations:
 *
 *   TEXT  "Step 12 · attach Technic Beam 5 (red) to the build by 2 friction
 *          pins" — the booklet, in words.
 *   MATES the same steps as structured records (part, neighbors, contact
 *          classes, rigid/revolute + rule) — the graph, per step.
 *
 * Both walk the same data: parts in build order; for each part, its mates
 * to parts placed earlier. Pure functions — callers supply the flattened
 * parts, the seq map, and detectMates/inferJoints output.
 */
import type { E2Part } from "@/lib/editor2/kinematics";
import type { Mate, PairRecord, PairRule } from "@/lib/editor2/mates";

/** One connector-class bucket of a part-pair ("stud" × 4). */
export interface ContactGroup {
  label: string;
  count: number;
}

/** One earlier neighbor a new part attaches to. */
export interface Attachment {
  toId: number;
  toPart: string;
  contacts: ContactGroup[];
  kind: "rigid" | "revolute";
  rule: PairRule;
}

/** One placed part in build order, with everything it attached to. */
export interface StepInstruction {
  step: number;
  partId: number;
  part: string;
  color: number;
  attachments: Attachment[];
}

export type WorldEnd = Mate["a"];

/** Human label for one contact — mirror of contactClassLabel, but from the
 * world-connector's precomputed section info (what detectMates returns). */
export function contactLabel(a: WorldEnd, b: WorldEnd): string {
  const kinds = [a.kind, b.kind].sort().join("+");
  if (kinds === "fgr+fgr") return "hinge";
  if (kinds === "clp+cyl") return "bar-in-clip";
  if (kinds === "gen+gen") return "ball";
  if (kinds === "cyl+cyl") {
    const m = a.gender === "M" ? a : b;
    if (m.si.hasAxle) return "axle";
    const r = m.si.first?.rad ?? m.radius ?? 0;
    if (r <= 4.5) return "bar";
    if (r >= 5.5 && r <= 6.5 && m.si.total > 10) return "pin";
    if (r >= 5.5 && r <= 6.5) return "stud";
    return "cyl";
  }
  return kinds;
}

/**
 * Emit per-part instructions in build order. A neighbor counts as
 * "already placed" when its (seq, id) sorts earlier — parts within one
 * step attach to each other in file order, matching how a builder reads
 * a multi-part step.
 */
export function emitInstructions(
  parts: E2Part[],
  seqOf: Map<number, number>,
  mates: Mate[],
  pairs: PairRecord[],
): StepInstruction[] {
  const partOf = new Map(parts.map((p) => [p.id, p]));
  const ruleOf = new Map(
    pairs.map((p) => [`${Math.min(p.a, p.b)}/${Math.max(p.a, p.b)}`, p]),
  );
  const before = (a: number, b: number) => {
    const sa = seqOf.get(a) ?? 0;
    const sb = seqOf.get(b) ?? 0;
    return sa !== sb ? sa < sb : a < b;
  };
  // partId → earlier neighbor id → label → count
  const byPart = new Map<number, Map<number, Map<string, number>>>();
  for (const m of mates) {
    const late = before(m.a.partId, m.b.partId) ? m.b : m.a;
    const early = late === m.a ? m.b : m.a;
    let nbrs = byPart.get(late.partId);
    if (!nbrs) byPart.set(late.partId, (nbrs = new Map()));
    let labels = nbrs.get(early.partId);
    if (!labels) nbrs.set(early.partId, (labels = new Map()));
    const l = contactLabel(m.a, m.b);
    labels.set(l, (labels.get(l) ?? 0) + 1);
  }
  const ordered = [...parts].sort((x, y) => (before(x.id, y.id) ? -1 : 1));
  return ordered.map((p) => {
    const attachments: Attachment[] = [...(byPart.get(p.id) ?? new Map())]
      .map(([toId, labels]: [number, Map<string, number>]) => {
        const key = `${Math.min(p.id, toId)}/${Math.max(p.id, toId)}`;
        const rec = ruleOf.get(key);
        return {
          toId,
          toPart: partOf.get(toId)?.part ?? "?",
          contacts: [...labels].map(([label, count]) => ({ label, count })),
          kind: rec?.kind ?? "rigid",
          rule: rec?.rule ?? ("colinear" as PairRule),
        };
      })
      .sort((a, b) => a.toId - b.toId);
    return { step: seqOf.get(p.id) ?? 0, partId: p.id, part: p.part, color: p.color, attachments };
  });
}

/** "2 studs", "1 axle", "3 bar-in-clips" */
const contactPhrase = (c: ContactGroup) =>
  `${c.count} ${c.label}${c.count === 1 ? "" : "s"}`;

/**
 * Render one instruction as a sentence. `nameOf` maps part number → catalog
 * name, `colorOf` maps LDraw color code → name (from LDConfig).
 */
export function instructionText(
  ins: StepInstruction,
  nameOf: (part: string) => string,
  colorOf: (code: number) => string,
): string {
  const self = `${nameOf(ins.part) || ins.part} (${colorOf(ins.color)})`;
  if (ins.attachments.length === 0) return `place ${self} — no connection detected`;
  const parts = ins.attachments.map((a) => {
    const how = a.contacts.map(contactPhrase).join(" + ");
    const move = a.kind === "revolute" ? " — movable" : "";
    return `${nameOf(a.toPart) || a.toPart} by ${how}${move}`;
  });
  return `attach ${self} to ${parts.join("; and to ")}`;
}

/** Parse `0 !COLOUR <Name> CODE <n> …` lines from LDConfig.ldr. */
export function parseColorNames(ldconfig: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of ldconfig.split("\n")) {
    const m = line.match(/^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)/);
    if (m) out.set(Number(m[2]), m[1].replace(/_/g, " "));
  }
  return out;
}
