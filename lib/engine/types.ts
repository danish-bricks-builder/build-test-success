/**
 * Engine — Layer 1 (Core). Pure types + constants. No React, no Three.js.
 *
 * Coordinate conventions (engine space, Y-up, LDU):
 *  - `x`/`z`: the part's LDraw ORIGIN position. For standard rectangular
 *    parts the origin is the footprint center; asymmetric parts (some
 *    slopes) carry their offset in PartMeta.ox/oz.
 *  - `y`: the BOTTOM of the part body. Ground = 0. A brick on the ground
 *    has y=0; the next course starts at y=24.
 *  - `rot`: rotation about Y in degrees. At rot 0 a part's long axis runs
 *    along X (the LDraw convention).
 *
 * LDraw mapping (used by serialize/parse): LDraw is Y-DOWN with the part
 * origin on the top plane of the body, so originY_ldraw = -(y + h).
 */
import type { PartMeta, PartMetaMap, PlacedPartJson } from "../data/schemas";

export type Rotation = 0 | 90 | 180 | 270;

/** A placed part in the editor. Superset of the project-JSON row. */
export type PlacedPart = PlacedPartJson;

export type { PartMeta, PartMetaMap };

// ─── Unit conventions ───────────────────────────────────────────────

/** LDU per stud in the X/Z plane. */
export const STUD_PITCH = 20;

/** Brick body height in LDU. */
export const BRICK_H = 24;

/** Plate body height in LDU (3 plates = 1 brick). */
export const PLATE_H = 8;

/** Fallback meta for parts missing from meta.json: treat as a 2x4 brick. */
export const FALLBACK_META: PartMeta = { w: 4, l: 2, h: BRICK_H, ox: 0, oz: 0, grid: true };

/** Baseplate size options (studs). */
export const BASEPLATE_SIZES = [16, 32, 48] as const;
