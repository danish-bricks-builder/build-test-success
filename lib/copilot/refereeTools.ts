/**
 * The referee and the decompiler as copilot tools — the same checks the
 * Move-it agents get from `./dbb grade` / `./dbb decompile`, so the
 * website copilot and the benchmark share one set of instruments.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Verdict } from "@/lib/grader/types";

/** The referee's verdict as the plain-text report agents read. */
export function verdictText(v: Verdict): string {
  const mark = (s: string) => (s === "pass" ? "PASS" : s === "fail" ? "FAIL" : "skip");
  const lines = [`${v.source} — ${v.parts} parts`, `valid ${v.valid ? "✓" : "✗"}  functional ${v.functional ? "✓" : "✗"}`];
  for (const r of v.rungs) {
    lines.push(`  ${mark(r.status).padEnd(4)} ${r.id}`);
    for (const f of r.findings) lines.push(`${f.severity === "fail" ? "  ✗" : f.severity === "warn" ? "  !" : "  ·"} ${f.msg}`);
  }
  lines.push(`  → ${v.summary}`);
  return lines.join("\n");
}

const GRADE_TOOL: Anthropic.Tool = {
  name: "grade_build",
  description:
    "Run the referee on the CURRENT build: parse → geometry (parts inside each other) → connectivity (everything attached) → stability → mechanism (bodies, bearings, gears) → actuation (gear trains turned). Returns every failure with the part numbers it concerns (1-based line order of the build). Slower than check_validity; use it before you say a mechanical build is done.",
  input_schema: {
    type: "object",
    properties: {
      sweep_joints: { type: "boolean", description: "also swing every movable joint through its range (slower; default false)" },
    },
  },
};

const DECOMPILE_TOOL: Anthropic.Tool = {
  name: "decompile_build",
  description:
    "Explain the CURRENT build as a connection program: one statement per part (p1…pN in line order), `catalog` when it sits on an earlier part in a known seating, `raw` with the reason when nothing explains it (anchor, near miss, touching only, loose). Use it to find parts that are not really connected.",
  input_schema: { type: "object", properties: {} },
};

export function makeRefereeTools(ldrawOf: () => string) {
  return [
    {
      tool: GRADE_TOOL,
      summarize: (input: Record<string, unknown>) => (input.sweep_joints ? "with joint sweeps" : "validity and gear trains"),
      handle: async (input: Record<string, unknown>) => {
        const { loadGraderData } = await import("@/lib/grader/data");
        const { gradeLdraw } = await import("@/lib/grader/grade");
        const v = gradeLdraw(ldrawOf(), await loadGraderData(), undefined, {
          source: "copilot build",
          maxJointSweeps: input.sweep_joints ? 40 : 0,
        });
        return verdictText(v);
      },
    },
    {
      tool: DECOMPILE_TOOL,
      summarize: () => "connection program",
      handle: async () => {
        const { decompileProgramText } = await import("@/lib/design/ops");
        const out = await decompileProgramText(ldrawOf(), "build");
        const text = out.program;
        return text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (${out.parts} parts; truncated)` : text;
      },
    },
  ];
}
