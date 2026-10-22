/**
 * .ldr export / import for builder projects.
 *
 * Engine space (Y-up, y = part bottom) ↔ LDraw space (Y-down, origin on the
 * top plane of the body): originY_ldraw = -(y + h). Ground sits at LDraw
 * Y=0 with models extending into -Y — the standard convention.
 *
 * Rotations use the four row-major Y-rotation matrices from the LDraw spec.
 */
import type { PartMetaMap, PlacedPartJson, ProjectJson } from "../data/schemas";
import { FALLBACK_META } from "../engine/types";
import type { Rotation } from "../engine/types";

/**
 * LDraw Y-rotation matrices (row-major), keyed by LDRAW-frame degrees.
 * The engine↔LDraw world map is X = RotX(π), which conjugates Y rotations
 * to their negative: engine θ ↔ LDraw −θ. Hence the 90/270 swap in the
 * export/import tables below.
 */
const LDRAW_ROT_MATRICES: Record<Rotation, string> = {
  0: "1 0 0 0 1 0 0 0 1",
  90: "0 0 1 0 1 0 -1 0 0",
  180: "-1 0 0 0 1 0 0 0 -1",
  270: "0 0 -1 0 1 0 1 0 0",
};

/** Engine rot → LDraw matrix string (θ_l = −θ_e). */
const EXPORT_MATRIX: Record<Rotation, string> = {
  0: LDRAW_ROT_MATRICES[0],
  90: LDRAW_ROT_MATRICES[270],
  180: LDRAW_ROT_MATRICES[180],
  270: LDRAW_ROT_MATRICES[90],
};

/** LDraw matrix string → engine rot (θ_e = −θ_l). */
const MATRIX_TO_ENGINE_ROT = new Map<string, Rotation>(
  (Object.entries(LDRAW_ROT_MATRICES) as [string, string][]).map(([ldrawRot, m]) => [
    m,
    ((360 - Number(ldrawRot)) % 360) as Rotation,
  ]),
);

const fmt = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

export function toLdr(project: ProjectJson, meta: PartMetaMap): string {
  const lines = [
    `0 ${project.name || "Untitled"}`,
    `0 Name: ${(project.name || "untitled").replace(/\s+/g, "_")}.ldr`,
    `0 Author: Danish Bricks Builder`,
    `0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt`,
    "",
  ];
  for (const p of project.parts) {
    if (p.m && p.m.length === 9) {
      // Oriented part: (x,y,z) is the LDraw origin mapped by X = RotX(π).
      lines.push(
        `1 ${p.color} ${fmt(p.x)} ${fmt(-p.y)} ${fmt(-p.z)} ${p.m.map(fmt).join(" ")} ${p.part}.dat`,
      );
      continue;
    }
    const h = meta[p.part]?.h ?? FALLBACK_META.h;
    const yLdraw = -(p.y + h);
    lines.push(
      `1 ${p.color} ${fmt(p.x)} ${fmt(yLdraw)} ${fmt(-p.z)} ${EXPORT_MATRIX[p.rot]} ${p.part}.dat`,
    );
  }
  return lines.join("\n") + "\n";
}

export interface LdrImportResult {
  parts: PlacedPartJson[];
  /** Count of placements imported as oriented parts (arbitrary matrix —
   * render/export exact; translate-only editing in the editor). */
  nonGridRotations: number;
  name: string | null;
  /** Submodel instances discovered while expanding (MPD structure that
   * flattening would otherwise lose): each expansion of a submodel section
   * contributes one group covering parts[start..end). depth 1 = the main
   * model's direct children. */
  groups: ImportGroup[];
}

export interface ImportGroup {
  name: string;
  depth: number;
  start: number;
  end: number;
}

// ─── LDraw transform math (translation + row-major 3×3) ─────────────

type LMat = { t: [number, number, number]; r: number[] };
const L_IDENTITY: LMat = { t: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

function lApply(m: LMat, x: number, y: number, z: number): [number, number, number] {
  return [
    m.t[0] + m.r[0] * x + m.r[1] * y + m.r[2] * z,
    m.t[1] + m.r[3] * x + m.r[4] * y + m.r[5] * z,
    m.t[2] + m.r[6] * x + m.r[7] * y + m.r[8] * z,
  ];
}

function lCompose(parent: LMat, child: LMat): LMat {
  const t = lApply(parent, child.t[0], child.t[1], child.t[2]);
  const p = parent.r;
  const c = child.r;
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = p[i * 3] * c[j] + p[i * 3 + 1] * c[3 + j] + p[i * 3 + 2] * c[6 + j];
    }
  }
  return { t, r };
}

/**
 * Parse an .ldr/.mpd into builder parts. MPD submodels are expanded
 * recursively: transforms compose, color 16 inherits from the referencing
 * line. Axis-aligned Y rotations import as editable grid parts; anything
 * else imports as an oriented part (exact matrix, render/export-perfect).
 */
export function fromLdr(content: string, meta: PartMetaMap): LdrImportResult {
  // Split into sections (an .ldr without FILE markers = one main section).
  const sections = new Map<string, string[]>();
  let current = "__main__";
  sections.set(current, []);
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const fileMatch = line.match(/^0 FILE (.+)$/i);
    if (fileMatch) {
      const key = fileMatch[1].trim().toLowerCase().replace(/\\/g, "/");
      // If nothing substantive preceded the first FILE header, drop the
      // placeholder main section so the first named section becomes main.
      const placeholder = sections.get("__main__");
      if (sections.size === 1 && placeholder && placeholder.every((l) => !l.startsWith("1 "))) {
        sections.delete("__main__");
      }
      current = key;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  const mainKey = sections.keys().next().value as string;

  // Model name: first plain comment line of the main section.
  let name: string | null = null;
  for (const line of sections.get(mainKey) ?? []) {
    if (line.startsWith("0 ") && !line.startsWith("0 !")) {
      const title = line.slice(2).trim();
      if (title && !/^(Name|Author):/i.test(title)) {
        name = title;
        break;
      }
    }
  }

  const parts: PlacedPartJson[] = [];
  const groups: ImportGroup[] = [];
  let nonGridRotations = 0;

  const groupName = (key: string) =>
    key
      .replace(/\.(ldr|mpd)$/i, "")
      .replace(/^.*? - /, "") // OMR "10297 - ground floor" → "ground floor"
      .trim() || key;

  const expand = (sectionKey: string, world: LMat, inheritColor: number, depth: number) => {
    if (depth > 24) return; // cycle guard
    for (const line of sections.get(sectionKey) ?? []) {
      if (!line.startsWith("1 ")) continue;
      const tok = line.split(/\s+/);
      if (tok.length < 15) continue;
      const ref = tok.slice(14).join(" ").toLowerCase().replace(/\\/g, "/");
      const lineColor = Number(tok[1]);
      const color = lineColor === 16 ? inheritColor : lineColor;
      const local: LMat = {
        t: [Number(tok[2]), Number(tok[3]), Number(tok[4])],
        r: tok.slice(5, 14).map(Number),
      };
      const combined = lCompose(world, local);

      // Expand only submodel sections (.ldr / extensionless). Embedded .dat
      // sections are custom PART definitions (primitives inside), which the
      // part loader can never fetch standalone — map them to their base
      // library part below instead.
      if (sections.has(ref) && !ref.endsWith(".dat")) {
        const start = parts.length;
        expand(ref, combined, color, depth + 1);
        if (parts.length > start) {
          groups.push({ name: groupName(ref), depth: depth + 1, start, end: parts.length });
        }
        continue;
      }

      let partNum = ref.replace(/\.dat$/i, "").replace(/^.*\//, "");
      if (sections.has(ref) && !meta[partNum]) {
        // OMR names embedded custom parts "<set> - <part>[pattern].dat"
        // (stickered/printed variants, flex sections, combo shortcuts).
        // Use the base library part; the custom detail exists only inside
        // this file. Strip prefixes/suffixes until something is known.
        const base = partNum.split(" - ").pop()!.trim();
        const candidates = [
          base,
          base.replace(/p[a-z0-9]+$/i, ""), // pattern: 3816bp8a → 3816b
          base.replace(/-f\d+$/i, ""), // flex section: 37178-f1 → 37178
          base.replace(/c\d+$/i, ""), // combo/shortcut: 568c01 → 568
        ];
        const hit = candidates.find((c) => c && meta[c]);
        if (hit) {
          partNum = hit;
        } else if (sections.get(ref)!.some((l) => l.startsWith("1 "))) {
          // No library base, but the section is assembled FROM other refs
          // (a shortcut/combo): expand it so its children resolve.
          expand(ref, combined, color, depth + 1);
          continue;
        }
        // Pure-geometry sections (inlined primitives — flex hose segments
        // etc.) stay as placements; the part loader's p/ fallback draws them.
      }
      const [x, yLdraw, z] = combined.t;
      const rounded = combined.r.map((v) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6));
      const rot = MATRIX_TO_ENGINE_ROT.get(rounded.join(" "));
      if (rot === undefined) {
        nonGridRotations++;
        parts.push({ part: partNum, color, x, y: -yLdraw, z: -z, rot: 0, m: rounded });
        continue;
      }
      const h = meta[partNum]?.h ?? FALLBACK_META.h;
      parts.push({ part: partNum, color, x, y: -yLdraw - h, z: -z, rot });
    }
  };

  expand(mainKey, L_IDENTITY, 16, 0);

  // Rare authoring quirk (e.g. OMR 6360-1): the main section is header-only
  // and never references the content sections. Fall back to the union of
  // all unreferenced submodel sections.
  if (parts.length === 0 && sections.size > 1) {
    const referenced = new Set<string>();
    for (const lines of sections.values()) {
      for (const line of lines) {
        if (!line.startsWith("1 ")) continue;
        const tok = line.split(/\s+/);
        if (tok.length >= 15) referenced.add(tok.slice(14).join(" ").toLowerCase().replace(/\\/g, "/"));
      }
    }
    for (const key of sections.keys()) {
      if (key !== mainKey && !key.endsWith(".dat") && !referenced.has(key)) {
        const start = parts.length;
        expand(key, L_IDENTITY, 16, 0);
        if (parts.length > start) {
          groups.push({ name: groupName(key), depth: 1, start, end: parts.length });
        }
      }
    }
  }
  return { parts, nonGridRotations, name, groups };
}
