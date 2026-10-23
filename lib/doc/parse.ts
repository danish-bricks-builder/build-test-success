import type { DocItem, DocModel, DocPiece, DocProject } from "./types";

/**
 * Parse .ldr/.mpd text into a DocProject WITHOUT flattening: submodel
 * structure, step markers, and every uninterpreted line survive in order.
 *
 * Fidelity contract: serialize(parse(text)) === text, modulo CRLF→LF, a
 * stripped BOM, and a guaranteed trailing newline. The round-trip script
 * (scripts/doc/roundtrip.ts) enforces this over the whole OMR corpus.
 */

export const normalizeRefKey = (ref: string) =>
  ref.trim().toLowerCase().replace(/\\/g, "/");

const FILE_RE = /^\s*0\s+FILE\s+(.+?)\s*$/i;
const STEP_RE = /^\s*0\s+STEP\s*$/i;

export function parseLdraw(content: string, fileName: string | null = null): DocProject {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  // A trailing newline yields one empty final element — that's the newline
  // serialize() re-adds, not an empty source line.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const models: DocModel[] = [];
  let current: DocModel | null = null;
  let step = 1;

  const openModel = (name: string, srcFile?: string): DocModel => {
    const model: DocModel = { name, key: normalizeRefKey(name), items: [] };
    if (srcFile !== undefined) model.srcFile = srcFile;
    models.push(model);
    step = 1;
    return model;
  };

  for (const line of lines) {
    const fileMatch = line.match(FILE_RE);
    if (fileMatch) {
      // Drop the implicit unnamed model if it collected nothing before the
      // first 0 FILE header. If it did collect lines (comments before the
      // header), it stays: a nameless model serializes without a FILE line,
      // so those lines are preserved in place.
      if (models.length === 1 && current && current.name === "" && current.items.length === 0) {
        models.pop();
      }
      current = openModel(fileMatch[1], line);
      continue;
    }

    if (!current) current = openModel("");

    if (STEP_RE.test(line)) {
      step++;
      current.items.push({ kind: "step", src: line });
      continue;
    }

    const piece = parseType1Line(line, step);
    if (piece) {
      current.items.push(piece);
      continue;
    }

    current.items.push({ kind: "raw", text: line });
  }

  const isMpd = models.length > 1 || (models.length === 1 && models[0].name !== "");
  if (models.length === 0) openModel("");

  return { models, mainIndex: 0, isMpd, fileName };
}

/** Parse a `1 <color> x y z a..i <ref>` line; null if it isn't one. */
function parseType1Line(line: string, stepShow: number): DocPiece | null {
  if (!/^\s*1\s/.test(line)) return null;
  const tok = line.trim().split(/\s+/);
  if (tok.length < 15) return null;
  const nums = tok.slice(1, 14).map(Number);
  if (nums.some((n) => Number.isNaN(n))) return null;
  const ref = tok.slice(14).join(" ");
  return {
    kind: "piece",
    color: nums[0],
    t: [nums[1], nums[2], nums[3]],
    r: nums.slice(4, 13),
    ref,
    refKey: normalizeRefKey(ref),
    src: line,
    stepShow,
  };
}

/** Model lookup by normalized reference key. */
export function modelIndexByKey(project: DocProject): Map<string, number> {
  const map = new Map<string, number>();
  project.models.forEach((m, i) => {
    if (!map.has(m.key)) map.set(m.key, i);
  });
  return map;
}

/** Count direct part placements (piece items that are NOT submodel refs). */
export function countOwnParts(model: DocModel, submodels: Map<string, number>): number {
  let n = 0;
  for (const item of model.items) {
    if (item.kind === "piece" && !submodels.has(item.refKey)) n++;
  }
  return n;
}

export type { DocItem };
