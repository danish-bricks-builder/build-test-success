/**
 * Render an LDraw model to a PNG in a BROWSER — the shared renderer behind
 * both pairs of eyes:
 *
 *   headless  lib/render/snap-page.ts bundles this for the Chrome worker
 *             (lib/render/chromium.ts), which is how a machine with Chrome
 *             installed renders for the agent, the thumbnails and the judge.
 *   live      the builder calls it directly (lib/copilot/viewRender.ts) when
 *             the server has no renderer — the deployed site's only eyes.
 *
 * Same geometry path as the site's viewers (PartMeshCache + composeMatrix),
 * so an agent sees what a person sees. Camera: `lat` degrees above the
 * horizon, `lon` degrees around the model, framed on the model's bounds.
 */
import * as THREE from "three";
import { getColorMaterial, getPartGeometry } from "@/lib/ldraw/PartMeshCache";
import { getPartMeta } from "@/lib/data/catalog";
import { fromLdr } from "@/lib/ldraw/serialize";
import { composeMatrix } from "@/lib/engine/scene/compose";

/**
 * A connector to draw on top of the model: a part card's "where can this
 * join" map. Positions and axes are in the LDraw coordinates of the file
 * being rendered (+Y down), the same numbers the connector tools print, so
 * a caller never has to know the renderer's own frame.
 */
export interface SnapMarker {
  pos: [number, number, number];
  axis?: [number, number, number];
  /** cyl / clp / fgr / gen — decides the glyph */
  kind: string;
  /** M = something seats ON it (a stud, a pin), F = something seats IN it */
  gender?: string;
  /** drawn beside the glyph; the connector's index in the tool's own listing */
  label?: string;
}

export interface SnapOpts {
  lat?: number;
  lon?: number;
  width?: number;
  height?: number;
  /** degrees added to lon so presets match the LDraw/LeoCAD convention */
  lonOffset?: number;
  /** "pretty": figure renders — soft light, contact shadow, faint edges, transparent background, 2× pixels */
  style?: "plain" | "pretty";
  /** connector glyphs drawn over the model (part cards) */
  markers?: SnapMarker[];
  /** draw the LDraw origin and its axes — where (0,0,0) sits on the part,
   * which is the one thing a model writing raw coordinates cannot infer */
  axes?: boolean;
}

const MARKER_COLOUR: Record<string, number> = {
  "cyl/M": 0xd8382f, // studs and pins — something seats on these
  "cyl/F": 0x2a6fd8, // pockets and holes — something seats in these
  clp: 0x2e9e4f,     // clips
  fgr: 0xe08a1e,     // hinge fingers
  gen: 0x8a4fd8,     // ball and socket
};

function labelSprite(text: string, colour: number, size: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `#${colour.toString(16).padStart(6, "0")}`;
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.fillStyle = "#111";
  ctx.font = "bold 70px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 70);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }),
  );
  sprite.scale.set(size, size, size);
  sprite.renderOrder = 10;
  return sprite;
}

/** The connector map: one glyph per connector, oriented along its axis, with
 * its index beside it — so "attach to C7" has a picture behind it.
 *
 * Connectors facing away from the camera are dropped: a glyph on the far side
 * of a brick reads as one on the near side, which is worse than not drawing
 * it. That is what the second view is for.
 */
function addMarkers(
  root: THREE.Group,
  markers: SnapMarker[],
  scale: number,
  view: THREE.Vector3,
): { sprite: THREE.Sprite; anchor: THREE.Vector3; leader: THREE.Line }[] {
  const labels: { sprite: THREE.Sprite; anchor: THREE.Vector3; leader: THREE.Line }[] = [];
  for (const m of markers) {
    // LDraw (+Y down) → the renderer's frame
    const pos = new THREE.Vector3(m.pos[0], -m.pos[1], -m.pos[2]);
    const axis = new THREE.Vector3(m.axis?.[0] ?? 0, -(m.axis?.[1] ?? 1), -(m.axis?.[2] ?? 0));
    if (axis.lengthSq() < 1e-9) axis.set(0, 1, 0);
    axis.normalize();
    if (axis.dot(view) < -0.15) continue; // points away from this camera

    const colour = MARKER_COLOUR[`${m.kind}/${m.gender ?? ""}`] ?? MARKER_COLOUR[m.kind] ?? 0x555555;
    const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.95 });
    const female = m.gender === "F";
    const geo =
      m.kind === "cyl" && !female
        ? new THREE.ConeGeometry(scale * 0.55, scale * 1.4, 12)
        : m.kind === "cyl"
        ? new THREE.TorusGeometry(scale * 0.7, scale * 0.22, 8, 16)
        : new THREE.SphereGeometry(scale * 0.6, 12, 8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9;
    mesh.position.copy(pos);
    // cone and torus are both authored about +Y; point them along the axis
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    root.add(mesh);
    if (m.label) {
      const sprite = labelSprite(m.label, colour, scale * 1.9);
      const anchor = pos.clone().addScaledVector(axis, scale * 1.6);
      sprite.position.copy(anchor);
      const leader = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([pos.clone(), anchor.clone()]),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.7, depthTest: false }),
      );
      leader.renderOrder = 8;
      root.add(sprite);
      root.add(leader);
      labels.push({ sprite, anchor, leader });
    }
  }
  return labels;
}

/**
 * Push the numbers apart until they can be read.
 *
 * Connectors sit 10 or 20 LDU apart and their labels are the same size
 * whatever the part, so on anything dense they land on top of each other.
 * This spreads them in SCREEN space — where the collision actually is — and
 * leaves a leader line from each number back to the glyph it belongs to.
 */
function separateLabels(
  labels: { sprite: THREE.Sprite; anchor: THREE.Vector3; leader: THREE.Line }[],
  camera: THREE.PerspectiveCamera,
  aspect: number,
  radius: number,
): void {
  if (labels.length < 2) return;
  const pts = labels.map((l) => l.anchor.clone().project(camera));
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = (pts[j].x - pts[i].x) * aspect;
        const dy = pts[j].y - pts[i].y;
        const d = Math.hypot(dx, dy);
        const want = radius * 2;
        if (d >= want) continue;
        moved = true;
        // straight overlap: break the tie along x so the pair separates
        const ux = d < 1e-6 ? 1 : dx / d;
        const uy = d < 1e-6 ? 0 : dy / d;
        const push = (want - d) / 2;
        pts[i].x -= (ux * push) / aspect;
        pts[i].y -= uy * push;
        pts[j].x += (ux * push) / aspect;
        pts[j].y += uy * push;
      }
    }
    if (!moved) break;
  }
  labels.forEach((l, i) => {
    const world = pts[i].clone().unproject(camera);
    l.sprite.position.copy(world);
    (l.leader.geometry as THREE.BufferGeometry).setFromPoints([
      l.anchor.clone().addScaledVector(world.clone().sub(l.anchor).normalize(), 0),
      world,
    ]);
  });
}

/** The origin and the three LDraw axes, drawn on the model itself. */
function addAxes(root: THREE.Group, scale: number): void {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(scale * 0.35, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false }),
  );
  dot.renderOrder = 11;
  root.add(dot);
  // render frame = (x, −y, −z) of LDraw, so +Y (down) points down here too
  const axes: [string, [number, number, number], number][] = [
    ["+X", [1, 0, 0], 0xc026d3],
    ["+Y down", [0, -1, 0], 0x0f766e],
    ["+Z", [0, 0, -1], 0x0369a1],
  ];
  for (const [label, dir, colour] of axes) {
    const end = new THREE.Vector3(...dir).multiplyScalar(scale * 3.2);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false, linewidth: 2 }),
    );
    line.renderOrder = 11;
    root.add(line);
    const tag = labelSprite(label, colour, scale * 2.4);
    tag.position.copy(end).multiplyScalar(1.12);
    root.add(tag);
  }
}

const EDGE = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35 });
const EDGE_SOFT = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08 });

export async function snapScene(ldraw: string, o: SnapOpts = {}): Promise<{ dataUrl: string; parts: number; failed: string[] }> {
  const width = o.width ?? 720, height = o.height ?? 540;
  const meta = await getPartMeta();
  const parts = fromLdr(ldraw, meta).parts;
  const pretty = o.style === "pretty";
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: pretty });
  renderer.setPixelRatio(pretty ? 2 : 1);
  renderer.setSize(width, height);
  renderer.setClearColor(0xffffff, pretty ? 0 : 1);
  const scene = new THREE.Scene();
  let dir: THREE.DirectionalLight;
  if (pretty) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc9ced6, 2.1));
    dir = new THREE.DirectionalLight(0xffffff, 2.2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.radius = 6;
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6);
    fill.position.set(-400, 200, -300);
    scene.add(fill);
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dde4, 2.4));
    dir = new THREE.DirectionalLight(0xffffff, 1.2);
  }
  dir.position.set(300, 500, 400);
  scene.add(dir);

  const groups = new Map<string, typeof parts>();
  for (const p of parts) {
    const k = `${p.part}/${p.color}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const root = new THREE.Group();
  const dummy = new THREE.Object3D();
  const failed: string[] = [];
  /** The real extent of the model, accumulated per placement.
   * Box3.setFromObject ignores an InstancedMesh's per-instance matrices, so a
   * model built away from the origin measured as a single part at the origin
   * and the camera framed empty space around it — 2% of the frame for a model
   * at world (-240, -48, 190). Accumulate the geometry box per instance
   * instead, which is exact and does not depend on three's traversal. */
  const content = new THREE.Box3();
  for (const [key, placements] of groups) {
    const [part, color] = key.split("/");
    try {
      const [{ tris, edges }, mat] = await Promise.all([getPartGeometry(part), getColorMaterial(Number(color))]);
      const mesh = new THREE.InstancedMesh(tris, mat ?? new THREE.MeshStandardMaterial({ color: 0x8f9aa8 }), placements.length);
      mesh.castShadow = pretty;
      if (!tris.boundingBox) tris.computeBoundingBox();
      placements.forEach((p, i) => {
        composeMatrix(dummy, p, meta);
        mesh.setMatrixAt(i, dummy.matrix);
        if (tris.boundingBox) content.union(tris.boundingBox.clone().applyMatrix4(dummy.matrix));
        if (edges) {
          const line = new THREE.LineSegments(edges, pretty ? EDGE_SOFT : EDGE);
          line.matrixAutoUpdate = false;
          line.matrix.copy(dummy.matrix);
          root.add(line);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      root.add(mesh);
    } catch {
      failed.push(part);
    }
  }
  const viewLat = ((o.lat ?? 25) * Math.PI) / 180;
  const viewLon = (((o.lon ?? 45) + (o.lonOffset ?? 0)) * Math.PI) / 180;
  const viewDir = new THREE.Vector3(
    Math.cos(viewLat) * Math.sin(viewLon),
    Math.sin(viewLat),
    Math.cos(viewLat) * Math.cos(viewLon),
  );
  let labels: { sprite: THREE.Sprite; anchor: THREE.Vector3; leader: THREE.Line }[] = [];
  if (o.axes) {
    const r = Math.max(1, (content.isEmpty() ? new THREE.Box3().setFromObject(root) : content).getBoundingSphere(new THREE.Sphere()).radius);
    addAxes(root, Math.min(10, Math.max(3, r * 0.09)));
  }
  if (o.markers?.length) {
    // sized from the model, not from the viewport: a glyph on a 1x1 plate and
    // one on a 16x16 baseplate should both read
    const r = Math.max(1, (content.isEmpty() ? new THREE.Box3().setFromObject(root) : content).getBoundingSphere(new THREE.Sphere()).radius);
    labels = addMarkers(root, o.markers, Math.min(10, Math.max(3, r * 0.09)), viewDir);
  }
  const box = content.isEmpty() ? new THREE.Box3().setFromObject(root) : content;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1, box.getBoundingSphere(new THREE.Sphere()).radius);
  root.position.sub(center);
  scene.add(root);
  if (pretty) {
    // a shadow-only floor under the model, and the key light's shadow box around it
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 12, radius * 12), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -(center.y - box.min.y) - 0.5;
    floor.receiveShadow = true;
    scene.add(floor);
    dir.position.set(radius * 0.8, radius * 2.2, radius * 1.1);
    const cam = dir.shadow.camera;
    cam.left = cam.bottom = -radius * 2;
    cam.right = cam.top = radius * 2;
    cam.near = radius * 0.1;
    cam.far = radius * 8;
    cam.updateProjectionMatrix();
  }

  const camera = new THREE.PerspectiveCamera(30, width / height, radius / 100, radius * 50);
  const fov = (camera.fov * Math.PI) / 180;
  const dirV = viewDir.clone();
  // Zoom to fit, like LeoCAD: start from the bounding sphere, then pull the
  // camera in until the box's projected corners fill ~90% of the frame.
  let dist = radius / Math.sin(fov / 2);
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x * half.x, y * half.y, z * half.z))));
  for (let i = 0; i < 4; i++) {
    camera.position.copy(dirV).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    let extent = 0;
    for (const c of corners) {
      const q = c.clone().project(camera);
      extent = Math.max(extent, Math.abs(q.x), Math.abs(q.y));
    }
    if (extent <= 0) break;
    dist *= extent / 0.9;
  }
  camera.near = Math.max(0.1, dist - radius * 2);
  camera.far = dist + radius * 2;
  camera.updateProjectionMatrix();
  camera.position.copy(dirV).multiplyScalar(dist);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // the numbers are only useful if they can be told apart
  // a label disc is ~40px across, which on a 440px-tall frame is 0.09 in NDC
  separateLabels(labels, camera, width / height, 0.095);
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  renderer.dispose();
  return { dataUrl, parts: parts.length, failed };
}
