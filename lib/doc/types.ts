/**
 * The nested document model — LeoCAD's ontology (Project → Models → Pieces)
 * in TypeScript, designed for lossless LDraw/MPD round-trips.
 *
 * Unlike the flat builder format (PlacedPartJson[]), a DocProject keeps
 * submodel structure: a model's piece can reference either a library part
 * or another model in the same project. Everything the parser doesn't
 * model (comments, !META lines, embedded part geometry) is preserved as
 * ordered raw items, so serialize(parse(x)) reproduces x.
 *
 * Space: all transforms are native LDraw (Y-down, row-major 3×3 + origin).
 * Conversion to engine/screen space happens at render time only.
 */

export interface DocProject {
  /** Models in file order; models[mainIndex] is the buildable main model. */
  models: DocModel[];
  mainIndex: number;
  /** True when the source had 0 FILE sections (multi-model .mpd). */
  isMpd: boolean;
  fileName: string | null;
}

export interface DocModel {
  /** Name exactly as written in `0 FILE <name>` (or a synthesized one). */
  name: string;
  /** Normalized lookup key: lowercase, backslashes → slashes. */
  key: string;
  /** Original `0 FILE …` header line, reused verbatim while name is unchanged. */
  srcFile?: string;
  /** Ordered contents — pieces, step markers, and passthrough lines. */
  items: DocItem[];
}

export type DocItem = DocPiece | DocStep | DocRaw;

/** A type-1 placement line: a library part OR a submodel reference. */
export interface DocPiece {
  kind: "piece";
  /** LDraw color code as written (16 = inherit; 0x2RRGGBB = direct). */
  color: number;
  /** Translation (LDraw space). */
  t: [number, number, number];
  /** Row-major 3×3 rotation/orientation matrix. */
  r: number[];
  /** File reference exactly as written (e.g. `3001.dat`, `wing - left.ldr`). */
  ref: string;
  /** Normalized ref for submodel lookup (lowercase, slashes). */
  refKey: string;
  /**
   * Original source line. Reused verbatim on serialize while the piece is
   * unmodified; editing ops must clear it so the canonical formatter runs.
   */
  src?: string;
  /** 1-based build step this piece appears in (derived from 0 STEP order). */
  stepShow: number;
}

/** A `0 STEP` marker. */
export interface DocStep {
  kind: "step";
  src: string;
}

/** Any line the document model doesn't interpret — preserved in place. */
export interface DocRaw {
  kind: "raw";
  text: string;
}

// ─── Derived render/build structures (see flatten.ts) ─────────────────

/** One concrete part placement after submodel expansion. */
export interface FlatInstance {
  /** Library part candidates to try in order (quirk-mapped, no `.dat`). */
  partCandidates: string[];
  /** Resolved LDraw color code (16-inheritance applied). */
  color: number;
  /** World transform, LDraw space: translation + row-major 3×3. */
  t: [number, number, number];
  r: number[];
  /** Global build-sequence index (0-based) for the step scrubber. */
  seq: number;
  /** Index into project.models of the model that owns the source piece. */
  modelIndex: number;
  /** Item index of the source piece within that model. */
  itemIndex: number;
  /** Chain of model indices from main to owner, e.g. [0, 3, 5]. */
  modelPath: number[];
  /** Occurrence (concrete submodel instance) that owns this placement. */
  occId: number;
  /** World transform of the owning model instance (world = parent ∘ the piece's own line). */
  parent?: { t: [number, number, number]; r: number[] };
}

/**
 * One concrete instantiation of a model in the expansion — the "folder"
 * of the nested explode view. Two placements of the same submodel are two
 * occurrences of one model.
 */
export interface OccNode {
  id: number;
  modelIndex: number;
  parent: number | null;
  children: number[];
}

/** Submodel usage tree (for the structure panel). */
export interface DocTreeNode {
  modelIndex: number;
  name: string;
  /** Direct part placements in this model (not counting submodels). */
  ownParts: number;
  /** Total parts after full expansion. */
  totalParts: number;
  /** Times this node's model is instantiated at this position in the tree. */
  instanceCount: number;
  children: DocTreeNode[];
}
