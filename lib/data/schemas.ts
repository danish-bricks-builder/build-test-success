/**
 * Shared data schemas — the contract between the pipeline
 * (scripts/pipeline/*) that generates public/data/** and the app code that
 * consumes it. Keys are single letters where files are large (parts/sets
 * indexes ship to the client whole).
 */

// ─── Colors ─────────────────────────────────────────────────────────

/** public/data/colors.json — Rebrickable colors joined with LDConfig.ldr. */
export interface ColorDef {
  /** Rebrickable/LDraw color id (LDraw code where reconciled). */
  id: number;
  name: string;
  /** Fill color, 6-hex uppercase, no '#'. */
  rgb: string;
  trans: boolean;
  /** LDraw color code to use for rendering (differs from id when reconciled by RGB/name). */
  ldraw: number | null;
  /** Edge color from LDConfig, 6-hex, when known. */
  edge: string | null;
  /** How many sets feature this color (popularity, for picker ordering). */
  numSets: number;
}

// ─── Parts ──────────────────────────────────────────────────────────

/** One row of public/data/parts/index.json. */
export interface PartIndexRow {
  /** part_num */
  p: string;
  /** name */
  n: string;
  /** part_cat_id */
  c: number;
  /** true when public/ldraw/parts/{p}.dat exists (3D view available) */
  ld: boolean;
}

/** public/data/parts/categories.json */
export interface PartCategory {
  id: number;
  name: string;
}

/** public/data/parts/usage.json — part_num → number of sets it appears in. */
export type PartUsage = Record<string, number>;

/** public/data/parts/img-map.json — part_num → representative image URL. */
export type PartImgMap = Record<string, string>;

/**
 * public/data/parts/meta.json — placement metadata for palette parts,
 * measured from real LDraw geometry (engine Y-up space).
 */
export interface PartMeta {
  /** Footprint studs along X at rot=0. */
  w: number;
  /** Footprint studs along Z at rot=0. */
  l: number;
  /** Body height in LDU (brick 24, plate 8...). */
  h: number;
  /** Offset of the geometric bbox center from the part origin, LDU (X/Z), for asymmetric-origin parts. */
  ox: number;
  oz: number;
  /** Snaps to the stud grid (false for odd geometry). */
  grid: boolean;
  /**
   * Solid rectangular-ish volume (plain bricks/plates/tiles/slopes) —
   * only these participate in advisory overlap detection. Container-like
   * parts (window frames, doors, wheels) legally enclose other parts.
   */
  solid?: boolean;
}
export type PartMetaMap = Record<string, PartMeta>;

// ─── Sets ───────────────────────────────────────────────────────────

/** One row of public/data/sets/index.json. */
export interface SetIndexRow {
  /** set_num, e.g. "8094-1" */
  s: string;
  /** name */
  n: string;
  /** year */
  y: number;
  /** theme_id */
  t: number;
  /** num_parts */
  np: number;
  /** set image URL (Rebrickable CDN) */
  img: string | null;
  /** an OMR 3D model exists (written by 03-scrape-omr) */
  omr?: boolean;
}

/** public/data/themes.json */
export interface ThemeDef {
  id: number;
  name: string;
  /** Display path with parents resolved, e.g. "Technic › Model". */
  path: string;
}

/** public/data/inv/{set_num}.json */
export interface SetInventory {
  set: string;
  version: number;
  parts: InventoryPart[];
  minifigs: InventoryMinifig[];
}
export interface InventoryPart {
  /** part_num */
  p: string;
  /** color id */
  c: number;
  /** quantity */
  q: number;
  spare: boolean;
  /** element image URL from inventory_parts.img_url */
  img: string | null;
}
export interface InventoryMinifig {
  fig: string;
  name: string;
  q: number;
  img: string | null;
}

// ─── OMR ────────────────────────────────────────────────────────────

/** public/data/omr/catalog.json */
export interface OmrEntry {
  set: string;
  name: string;
  author: string;
  files: OmrFile[];
}
export interface OmrFile {
  label: string;
  /** Per-file author (B-models often differ from the main model's author). */
  author: string;
  path: string;
  packed: string;
  /** Number of type-1 part references (build size). */
  bricks: number;
}

// ─── StableText2Brick ───────────────────────────────────────────────

/** One row of public/data/s2b/catalog-{NNN}.json */
export interface S2bCatalogRow {
  /** structure_id */
  id: string;
  /** category name */
  cat: string;
  /** first caption */
  caption: string;
  /** brick count */
  nb: number;
}

/** Full record inside public/models/s2b/shard-{NNN}.json */
export interface S2bStructure {
  id: string;
  cat: string;
  captions: string[];
  /** The structure as a builder project part list. */
  parts: PlacedPartJson[];
}

// ─── Project format ─────────────────────────────────────────────────

/** A placed part in project JSON (engine space: Y-up, LDU). */
export interface PlacedPartJson {
  /** LDraw part number, e.g. "3001" */
  part: string;
  /** LDraw color code */
  color: number;
  x: number;
  y: number;
  z: number;
  /** Y-axis rotation, degrees (grid parts; ignored when `m` is present) */
  rot: 0 | 90 | 180 | 270;
  /**
   * Arbitrary orientation: LDraw row-major 3×3 rotation matrix (9 numbers).
   * When present the part is an "oriented part": (x,y,z) is the LDraw
   * origin mapped to engine space (y = −y_ldraw), not the grid-part
   * bottom-plus-footprint convention. Enables SNOT/angled imports.
   */
  m?: number[];
}

export interface ProjectJson {
  format: "danish-bricks/v1";
  name: string;
  created?: string;
  modified?: string;
  baseplate: number;
  parts: PlacedPartJson[];
  source?: { kind: "s2b" | "omr" | "ldr"; id: string };
}

// ─── Dataset stats (landing page counts) ────────────────────────────

/** public/data/stats.json */
export interface DatasetStats {
  parts: number;
  partsWithGeometry: number;
  sets: number;
  colors: number;
  omrModels: number;
  s2bStructures: number;
  generated: string;
}
