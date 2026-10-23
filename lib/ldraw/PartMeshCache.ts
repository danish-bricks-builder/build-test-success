"use client";

/**
 * PartMeshCache — module-singleton cache of LDraw part geometry.
 *
 * One shared LDrawLoader (materials preloaded from LDConfig.ldr once).
 * Parts load from /ldraw-packed/{part}.dat when available (single HTTP
 * request, all subparts inlined by the pipeline) and fall back to
 * /ldraw/parts/{part}.dat where LDrawLoader resolves subparts/primitives
 * recursively over HTTP (long-tail parts).
 *
 * Loaded groups are cached forever and cloned on checkout; in-flight loads
 * are deduped.
 */
import * as THREE from "three";
import { LDrawLoader } from "three/examples/jsm/loaders/LDrawLoader.js";
import { LDrawConditionalLineMaterial } from "three/examples/jsm/materials/LDrawConditionalLineMaterial.js";

let loaderPromise: Promise<LDrawLoader> | null = null;
const groupCache = new Map<string, Promise<THREE.Group>>();
const materialCache = new Map<number, THREE.Material>();

/** Packed part ids — lets us skip the guaranteed-404 packed attempt for
 * long-tail parts (manifest.json is generated with the packed library). */
let packedSetPromise: Promise<Set<string>> | null = null;
function getPackedSet(): Promise<Set<string>> {
  if (!packedSetPromise) {
    packedSetPromise = fetch("/ldraw-packed/manifest.json")
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .then((ids) => new Set(ids.map((s) => s.toLowerCase())))
      .catch(() => new Set<string>());
  }
  return packedSetPromise;
}

async function getLoader(): Promise<LDrawLoader> {
  if (!loaderPromise) {
    loaderPromise = (async () => {
      // LDrawLoader normalizes subrefs ("s/x"→"parts/s/x", "48/x"→"p/48/x")
      // and THEN tries parts/, p/, models/ prefixes on top — three 404s per
      // subpart before the as-is path wins. Collapse those doubled
      // candidates, and steer known primitives straight to p/, so the
      // FIRST request hits.
      const prims = await fetch("/ldraw/p/manifest.json")
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
        .then((ids) => new Set(ids.map((s) => s.toLowerCase())))
        .catch(() => new Set<string>());
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        const u = url
          .replace(/^\/ldraw\/(?:parts|p|models)\/(parts\/)/, "/ldraw/$1")
          .replace(/^\/ldraw\/(?:parts|p|models)\/(p\/)/, "/ldraw/$1");
        const m = u.match(/^\/ldraw\/(?:parts|models)\/(.+)\.dat$/);
        if (m && prims.has(m[1].toLowerCase())) return `/ldraw/p/${m[1]}.dat`;
        return u;
      });
      const loader = new LDrawLoader(manager);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loader.setConditionalLineMaterial(LDrawConditionalLineMaterial as any);
      // three's LDrawLoader maps its "missing colour" edge material to a conditional-line
      // material that is still null when the constructor runs; setConditionalLineMaterial makes
      // the real one but never updates the map. Any colour code LDConfig lacks (e.g. 361 in
      // OMR 75075-1) then gets a null material and the renderer throws on every frame.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const l = loader as any;
      l.conditionalEdgeMaterialCache.set(l.missingEdgeColorMaterial, l.missingConditionalEdgeColorMaterial);
      // Empty base path: we pass site-absolute URLs to load(); subpart
      // resolution for raw (non-packed) parts goes through partsLibraryPath.
      loader.setPath("");
      loader.setPartsLibraryPath("/ldraw/");
      loader.smoothNormals = true;
      await loader.preloadMaterials("/ldraw/LDConfig.ldr");
      return loader;
    })();
  }
  return loaderPromise;
}

function loadWith(loader: LDrawLoader, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

/**
 * Load a part's THREE.Group (LDraw coords, Y-down — callers apply
 * rotation.x = π). Returns a deep clone; materials are shared.
 */
export async function loadPartGroup(part: string): Promise<THREE.Group> {
  let cached = groupCache.get(part);
  if (!cached) {
    cached = (async () => {
      const [loader, packed] = await Promise.all([getLoader(), getPackedSet()]);
      // Packed only when the manifest says it exists (or the manifest is
      // unavailable — then the old try-everything fallback still applies).
      if (packed.size === 0 || packed.has(part.toLowerCase())) {
        try {
          // Hot path: pipeline-packed single file.
          return await loadWith(loader, `/ldraw-packed/${part}.dat`);
        } catch {
          /* fall through to raw */
        }
      }
      try {
        // Long tail: raw part, recursive subpart resolution over HTTP.
        return await loadWith(loader, `/ldraw/parts/${part}.dat`);
      } catch {
        // Primitives placed as parts (flex-hose segments in OMR models).
        return await loadWith(loader, `/ldraw/p/${part}.dat`);
      }
    })();
    groupCache.set(part, cached);
    cached.catch(() => groupCache.delete(part)); // don't cache failures
  }
  const group = await cached;
  return group.clone();
}

/** LDraw material for a color code (from the preloaded LDConfig library). */
export async function getColorMaterial(code: number): Promise<THREE.Material | null> {
  const hit = materialCache.get(code);
  if (hit) return hit;
  const loader = await getLoader();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mat = (loader as any).getMaterial(String(code)) as THREE.Material | null;
  if (mat) materialCache.set(code, mat);
  return mat;
}

/**
 * Recolor a loaded part group: replace the "Main_Colour" (code 16 /
 * inherit) materials with the given color's material, leaving fixed-color
 * subparts (prints etc.) untouched.
 */
export async function applyColor(group: THREE.Group, code: number): Promise<void> {
  const target = await getColorMaterial(code);
  if (!target) return;
  // Note: LDrawLoader material names carry a leading space (" Main_Colour").
  const isMain = (m: THREE.Material) =>
    m.name.trim() === "Main_Colour" || m.userData?.code === "16";
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.LineSegments).isLineSegments) return;
    if (!mesh.material) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => (isMain(m) ? target : m));
    } else if (isMain(mesh.material)) {
      mesh.material = target;
    }
  });
}

/**
 * Load a full model (.mpd/.ldr) by URL — used for OMR set models. The
 * packed variants are self-contained, so this is one HTTP request.
 *
 * Small/medium models stay UNMERGED so building-step visibility works
 * (LDrawLoader stamps userData.buildingStep per group); huge models are
 * merged into few meshes for draw-call sanity, losing step replay.
 * Not cached: model groups are big and viewed once.
 */
const MERGE_THRESHOLD_MESHES = 4000;

export async function loadModelGroup(
  url: string,
): Promise<{ group: THREE.Group; buildingSteps: number }> {
  const loader = await getLoader();
  const [{ LDrawUtils }, group] = await Promise.all([
    import("three/examples/jsm/utils/LDrawUtils.js"),
    loadWith(loader, url),
  ]);
  const buildingSteps = (group.userData.numBuildingSteps as number | undefined) ?? 1;
  let meshCount = 0;
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshCount++;
  });
  if (buildingSteps <= 1 || meshCount > MERGE_THRESHOLD_MESHES) {
    return { group: LDrawUtils.mergeObject(group), buildingSteps: 1 };
  }
  return { group, buildingSteps };
}

/**
 * Geometry for instanced rendering (builder): the part's triangle geometry
 * merged into one BufferGeometry, transformed to engine space (Y-up).
 * Materials are ignored — the builder renders each (part,color) pair with
 * one material. Cached per part.
 */
const geoCache = new Map<string, Promise<{ tris: THREE.BufferGeometry; edges: THREE.BufferGeometry | null }>>();

export async function getPartGeometry(part: string) {
  let cached = geoCache.get(part);
  if (!cached) {
    cached = (async () => {
      const { mergeGeometries } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
      const group = await loadPartGroup(part);
      group.updateMatrixWorld(true);
      const tris: THREE.BufferGeometry[] = [];
      const lines: THREE.BufferGeometry[] = [];
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          // Instancing shares one material: drop per-geometry groups.
          g.clearGroups();
          tris.push(g);
        } else if (
          (obj as THREE.LineSegments).isLineSegments &&
          obj.type === "LineSegments" &&
          !(obj as { isConditionalLine?: boolean }).isConditionalLine
        ) {
          // Hard edges (type 2) only. Type-5 conditional lines are silhouette
          // lines the shader shows per-view via control points; merged as
          // plain lines they'd draw ALWAYS, hatching every curved part
          // (leaves, wedges, cones) with its tessellation seams.
          const src = (obj as THREE.LineSegments).geometry;
          const positionOnly = new THREE.BufferGeometry();
          positionOnly.setAttribute("position", src.getAttribute("position").clone());
          if (src.index) positionOnly.setIndex(src.index.clone());
          lines.push(positionOnly.applyMatrix4(obj.matrixWorld));
        }
      });
      // LDraw is Y-down; engine space is Y-up.
      const flip = new THREE.Matrix4().makeRotationX(Math.PI);
      const merge = (gs: THREE.BufferGeometry[]) => {
        if (gs.length === 0) return null;
        const merged = mergeGeometries(
          gs.map((g) => (g.index ? g.toNonIndexed() : g)),
          false,
        );
        merged?.applyMatrix4(flip);
        return merged;
      };
      const mergedTris = merge(tris);
      if (!mergedTris) throw new Error(`part ${part}: no triangle geometry`);
      return { tris: mergedTris, edges: merge(lines) };
    })();
    geoCache.set(part, cached);
    cached.catch(() => geoCache.delete(part));
  }
  return cached;
}
