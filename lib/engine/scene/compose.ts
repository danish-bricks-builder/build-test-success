/**
 * Placement → object matrix, engine space. Pure (no React), so headless
 * renderers can share it with the in-app viewers.
 */
import * as THREE from "three";
import { metaOf } from "../geometry";
import { engineRotFromLdraw } from "../orientation";
import type { PartMetaMap, PlacedPart } from "../types";

export function composeMatrix(target: THREE.Object3D, p: PlacedPart, meta: PartMetaMap): void {
  if (p.m && p.m.length === 9) {
    const r = engineRotFromLdraw(p.m);
    const mat = new THREE.Matrix4().set(
      r[0], r[1], r[2], p.x,
      r[3], r[4], r[5], p.y,
      r[6], r[7], r[8], p.z,
      0, 0, 0, 1,
    );
    target.position.setFromMatrixPosition(mat);
    target.quaternion.setFromRotationMatrix(mat);
    target.scale.set(1, 1, 1);
    target.updateMatrix();
    return;
  }
  const h = metaOf(p.part, meta).h;
  target.position.set(p.x, p.y + h, p.z);
  target.rotation.set(0, (p.rot * Math.PI) / 180, 0);
  target.updateMatrix();
}
