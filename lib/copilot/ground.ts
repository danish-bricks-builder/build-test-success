/**
 * ground_reference — VISUAL GROUNDING as a copilot tool.
 *
 * Resolves a user phrase ("the roof", "the driver door", "the turbine on
 * the wing") to rigid-body numbers + part indices, with a two-pass VLM
 * protocol that never trusts a guess it hasn't SEEN:
 *
 *   pass A  two normal renders + the body table → shortlist ≤5 candidates
 *   pass B  each candidate re-rendered HIGHLIGHTED (candidate red, rest
 *           grey — a pure LDraw color rewrite) → the model picks which
 *           highlight(s) actually match the phrase
 *
 * The confirmed grounding is streamed to the user's viewport as a
 * highlight_body event (the editor frames it live), and the tool returns
 * body numbers + part indices the agent can feed to remove_parts /
 * recolor_parts / set_joint_angle (joint whose child body matches).
 *
 * Known v1 limit: interior bodies that no exterior view shows can't be
 * confirmed visually — the tool says so instead of guessing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { renderModel } from "@/lib/render";

export interface GroundBodyInfo {
  n: number;
  parts: number;
  label: string;
  /** Indices into the exported part list (type-1 line order). */
  memberIdx?: number[];
}

export interface GroundDeps {
  apiKey: string;
  model: string;
  /** Current working model as LDraw text (type-1 line k = part index k). */
  ldrawOf: () => string;
  bodies: GroundBodyInfo[];
  /** Stream an event to the client (highlight_body → live viewport). */
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

const GROUND_TOOL_DEF: Anthropic.Tool = {
  name: "ground_reference",
  description:
    'Resolve a phrase the user used for a PART OF THE MODEL ("the roof", "the driver door", "the left ' +
    "wing') to concrete rigid-body numbers and part indices — by actually LOOKING: it renders the model, " +
    "shortlists candidate bodies, re-renders each candidate highlighted, and visually confirms which one " +
    "the phrase means. Use it whenever the user names a feature you cannot already identify with " +
    "certainty from the joints/bodies/semantic tables. Returns body numbers + part indices (for " +
    "remove_parts / recolor_parts) — for motion, articulate the joint whose CHILD body was grounded " +
    "(set_joint_angle). Also highlights the result in the user's viewport so they see what you resolved.",
  input_schema: {
    type: "object",
    properties: {
      phrase: { type: "string", description: "the user's words for the feature, verbatim" },
    },
    required: ["phrase"],
  },
};

/** Part number per type-1 line, in order — for body composition signatures. */
export function partsOfLines(ldraw: string): string[] {
  const out: string[] = [];
  for (const line of ldraw.split("\n")) {
    const m = line.match(/^\s*1\s+\S+\s+(?:\S+\s+){12}(.+?)\.dat\s*$/i);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/** Composition signature of a body: its part multiset. Two bodies with the
 * same signature are copies of the same object (container stacks, wheels). */
export function bodySignature(lineParts: string[], memberIdx: number[]): string {
  return memberIdx
    .map((i) => lineParts[i] ?? "?")
    .sort()
    .join("|");
}

/** Rewrite type-1 line colors: hot indices → red 4, all others → grey 71. */
function highlightLdraw(ldraw: string, hot: Set<number>): string {
  let k = -1;
  return ldraw
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*1\s+)(\S+)(\s+.*)$/);
      if (!m) return line;
      k++;
      return `${m[1]}${hot.has(k) ? 4 : 71}${m[3]}`;
    })
    .join("\n");
}

/** Hot indices → red 4; everything else KEEPS its color — for visual
 * receipts of a highlight over the normal model. */
export function recolorHot(ldraw: string, hot: Set<number>): string {
  let k = -1;
  return ldraw
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*1\s+)(\S+)(\s+.*)$/);
      if (!m) return line;
      k++;
      return hot.has(k) ? `${m[1]}4${m[3]}` : line;
    })
    .join("\n");
}

/** find_similar_bodies — deterministic set completion: given exemplar
 * bodies, return EVERY body with an identical part multiset. No VLM, no
 * guessing — the tool for "all the X" once one X is known. */
export function makeSimilarTool(deps: {
  ldrawOf: () => string;
  bodies: GroundBodyInfo[];
}): {
  tool: Anthropic.Tool;
  handle: (input: Record<string, unknown>) => Promise<Anthropic.ToolResultBlockParam["content"]>;
  summarize: (input: Record<string, unknown>) => string;
} {
  return {
    tool: {
      name: "find_similar_bodies",
      description:
        "Find EVERY rigid body that is a structural copy (identical part composition) of the given " +
        "exemplar bodies. Deterministic and instant — THE way to complete a set for 'all the X' " +
        "requests: identify one or two clear examples of X (from the table or ground_reference), then " +
        "call this to get every twin, including ones you'd miss reading the table. Returns body " +
        "numbers grouped by shape class.",
      input_schema: {
        type: "object",
        properties: {
          body_numbers: {
            type: "array",
            items: { type: "number" },
            description: "exemplar body numbers (one per shape class of X is enough)",
          },
        },
        required: ["body_numbers"],
      },
    },
    summarize: (input) =>
      `twins of ${(Array.isArray(input.body_numbers) ? input.body_numbers : []).map((n) => `B${n}`).join(",")}`,
    handle: async (input) => {
      const wanted = (Array.isArray(input.body_numbers) ? input.body_numbers : []).map(Number);
      const usable = deps.bodies.filter((b) => b.memberIdx?.length);
      const exemplars = wanted
        .map((n) => usable.find((b) => b.n === n))
        .filter((b): b is NonNullable<typeof b> => !!b);
      if (!exemplars.length) return "No such bodies (or no membership data) — see the RIGID BODIES list.";
      const lineParts = partsOfLines(deps.ldrawOf());
      const sigOf = new Map(usable.map((b) => [b.n, bodySignature(lineParts, b.memberIdx!)]));
      const groups = exemplars.map((ex) => {
        const sig = sigOf.get(ex.n)!;
        const twins = usable.filter((b) => sigOf.get(b.n) === sig).map((b) => b.n);
        return { exemplar: ex, twins };
      });
      const lines = groups.map(
        (g) =>
          `class of Body ${g.exemplar.n} (${g.exemplar.parts} parts, ${g.exemplar.label}): ` +
          `${g.twins.length} bodies — ${g.twins.map((n) => `B${n}`).join(", ")}`,
      );
      const union = [...new Set(groups.flatMap((g) => g.twins))];
      return (
        `${lines.join("\n")}\n` +
        `Union: ${union.length} bodies — ${union.map((n) => `B${n}`).join(", ")}\n` +
        `Highlight them ALL with one highlight_body call (body_numbers), then CHECK the returned ` +
        `render for anything similar that is still unlit (a different shape class needs its own exemplar).`
      );
    },
  };
}

const img = (shot: { dataBase64: string }): Anthropic.ImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: shot.dataBase64 },
});

async function forcedTool<T>(
  client: Anthropic,
  model: string,
  tool: Anthropic.Tool,
  content: Anthropic.ContentBlockParam[],
  system: string,
): Promise<T | null> {
  const msg = await client.messages.create({
    model,
    max_tokens: 1200,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content }],
  });
  const tu = msg.content.find((c) => c.type === "tool_use");
  return tu?.type === "tool_use" ? (tu.input as T) : null;
}

export function makeGroundTool(deps: GroundDeps): {
  tool: Anthropic.Tool;
  handle: (input: Record<string, unknown>) => Promise<Anthropic.ToolResultBlockParam["content"]>;
  summarize: (input: Record<string, unknown>) => string;
} {
  return {
    tool: GROUND_TOOL_DEF,
    summarize: (input) => `grounding "${String(input.phrase ?? "")}"`,
    handle: async (input) => {
      const phrase = String(input.phrase ?? "").trim();
      if (!phrase) return "ground_reference needs a phrase.";
      const usable = deps.bodies.filter((b) => b.memberIdx?.length);
      if (!usable.length)
        return "No body membership data available in this session — ground_reference is unavailable.";
      const client = new Anthropic({ apiKey: deps.apiKey });
      const ldraw = deps.ldrawOf();

      // ── pass A: shortlist from two overview renders + the table ──
      const [vA, vB] = await Promise.all([
        renderModel(ldraw, { lat: 25, lon: 45, width: 640, height: 480 }),
        renderModel(ldraw, { lat: 30, lon: 225, width: 640, height: 480 }),
      ]);
      const table = usable
        .map((b) => `Body ${b.n} · ${b.parts} parts · ${b.label}`)
        .join("\n");
      const shortlist = await forcedTool<{ candidates?: number[]; why?: string }>(
        client,
        deps.model,
        {
          name: "shortlist_candidates",
          description: "Bodies that might be what the phrase refers to.",
          input_schema: {
            type: "object",
            properties: {
              candidates: {
                type: "array",
                items: { type: "integer" },
                description:
                  "body numbers, most likely first — up to 40 for plural/collective phrases ('all the containers'), a handful for singular ones",
              },
              why: { type: "string" },
            },
            required: ["candidates", "why"],
          },
        },
        [
          img(vA),
          img(vB),
          {
            type: "text",
            text:
              `Two views of a LEGO model (front-right and back-left). Rigid bodies:\n${table}\n\n` +
              `Shortlist the bodies that might be "${phrase}" (up to 40 for a plural phrase, a few for a ` +
              `singular one). Prefer recall over precision — candidates are visually verified next.`,
          },
        ],
        "You shortlist which rigid bodies of a LEGO model a phrase might refer to. Use the images for what things look like and the table for sizes/labels.",
      );
      let candidates = (shortlist?.candidates ?? [])
        .map(Number)
        .filter((n) => usable.some((b) => b.n === n))
        .slice(0, 40);
      if (!candidates.length)
        return `Grounding "${phrase}": no plausible candidate bodies found. ${shortlist?.why ?? ""}`;

      // ── structural-twin expansion: bodies with an IDENTICAL part
      // multiset are copies of the same object (container stacks, wheels)
      // — if any candidate has twins outside the shortlist, pull them in.
      const lineParts = partsOfLines(ldraw);
      const sigOf = new Map(usable.map((b) => [b.n, bodySignature(lineParts, b.memberIdx!)]));
      const candSigs = new Set(candidates.map((n) => sigOf.get(n)));
      const twins = usable
        .map((b) => b.n)
        .filter((n) => !candidates.includes(n) && candSigs.has(sigOf.get(n)));
      candidates = [...candidates, ...twins].slice(0, 80);

      // ── pass B: visual verification ──
      // ≤3 candidates: one highlighted render pair EACH (precise, for
      // singular references). More: ONE render pair with ALL candidates
      // lit at once — for "all the X" the question is "is this the full
      // set?", not "which one is it?".
      let verifyContent: Anthropic.ContentBlockParam[];
      if (candidates.length <= 3) {
        const shots = await Promise.all(
          candidates.map(async (n) => {
            const hot = new Set(usable.find((b) => b.n === n)!.memberIdx!);
            const hl = highlightLdraw(ldraw, hot);
            const [s1, s2] = await Promise.all([
              renderModel(hl, { lat: 30, lon: 45, width: 560, height: 420 }),
              renderModel(hl, { lat: 30, lon: 225, width: 560, height: 420 }),
            ]);
            return { n, s1, s2 };
          }),
        );
        verifyContent = shots.flatMap((s) => [
          { type: "text", text: `Candidate Body ${s.n} highlighted in RED (two views):` } as const,
          img(s.s1),
          img(s.s2),
        ]);
      } else {
        const hot = new Set(
          candidates.flatMap((n) => usable.find((b) => b.n === n)!.memberIdx!),
        );
        const hl = highlightLdraw(ldraw, hot);
        const [s1, s2] = await Promise.all([
          renderModel(hl, { lat: 30, lon: 45, width: 720, height: 540 }),
          renderModel(hl, { lat: 30, lon: 225, width: 720, height: 540 }),
        ]);
        verifyContent = [
          {
            type: "text",
            text:
              `ALL ${candidates.length} candidate bodies highlighted in RED at once ` +
              `(${candidates.map((n) => `B${n}`).join(", ")}), two views:`,
          },
          img(s1),
          img(s2),
        ];
      }
      verifyContent.push({
        type: "text",
        text:
          `Which candidate bodies together are exactly "${phrase}"? Pick ALL that a human would mean ` +
          `(an assembly can span several bodies; a plural phrase means every instance). Exclude ` +
          `candidates whose red parts are clearly NOT part of "${phrase}"; report none if nothing ` +
          `matches. If red parts are not visible in either view the body is interior — do not confirm ` +
          `it visually.`,
      });
      const verdict = await forcedTool<{ bodies?: number[]; why?: string }>(
        client,
        deps.model,
        {
          name: "confirm_grounding",
          description: "The bodies whose highlights match the phrase.",
          input_schema: {
            type: "object",
            properties: {
              bodies: { type: "array", items: { type: "integer" } },
              why: { type: "string" },
            },
            required: ["bodies", "why"],
          },
        },
        verifyContent,
        "You verify visual grounding: confirm only highlights you can actually see matching the phrase.",
      );
      const confirmed = (verdict?.bodies ?? []).map(Number).filter((n) => candidates.includes(n));
      if (!confirmed.length)
        return (
          `Grounding "${phrase}": candidates ${candidates.map((n) => `B${n}`).join(", ")} were checked ` +
          `visually but none matched. ${verdict?.why ?? ""} The feature may be interior or the phrase ` +
          `may need the semantic table instead.`
        );

      // Live pointer in the user's viewport — every confirmed body at once.
      if (confirmed.length > 1) deps.emit({ type: "highlight_bodies", bodies: confirmed });
      else deps.emit({ type: "highlight_body", body: confirmed[0] });

      const allIdx = confirmed.flatMap((n) => usable.find((x) => x.n === n)!.memberIdx!);
      const rows =
        confirmed.length <= 6
          ? confirmed
              .map((n) => {
                const b = usable.find((x) => x.n === n)!;
                return `Body ${n} "${b.label}" — part indices [${b.memberIdx!.join(",")}]`;
              })
              .join("\n")
          : `bodies ${confirmed.map((n) => `B${n}`).join(", ")}\n` +
            `combined part indices (${allIdx.length}): [${allIdx.join(",")}]`;
      const twinNote = twins.length
        ? `\n(${twins.filter((n) => confirmed.includes(n)).length} of these were found by structural-twin ` +
          `expansion — identical part composition to shortlisted candidates.)`
        : "";
      return (
        `GROUNDED "${phrase}" → ${confirmed.length} bod${confirmed.length === 1 ? "y" : "ies"}\n${rows}${twinNote}\n` +
        `Reasoning: ${verdict?.why ?? ""}\n` +
        `Use the indices with remove_parts/recolor_parts; for motion use set_joint_angle on a joint ` +
        `whose child body is one of these. All confirmed bodies are now highlighted in the user's viewport.`
      );
    },
  };
}
