/**
 * Engine ↔ LDraw frame mapping for oriented (matrix) parts.
 *
 * The world map is X = RotX(π) = diag(1,−1,−1): part geometry is baked
 * through X (PartMeshCache) and whole-model viewers apply the same flip.
 * Consequently for points   p_e = X·p_l  ⇒  (x, −y, −z)
 * and for rotations         R_e = X·R_l·X
 * which negates the row-major entries that mix Y/Z with X:
 *   [a  b  c]      [ a −b −c]
 *   [d  e  f]  →   [−d  e  f]
 *   [g  h  i]      [−g  h  i]
 */

/** LDraw row-major 3×3 → engine row-major 3×3. (Self-inverse.) */
export function engineRotFromLdraw(m: number[]): number[] {
  return [m[0], -m[1], -m[2], -m[3], m[4], m[5], -m[6], m[7], m[8]];
}

/**
 * LDraw matrix for a draft oriented by engine-frame rotations
 * yRot (about Y) then xRot (tilt about X):  R_e = RotY(y)·RotX(x).
 * Under the X = RotX(π) world map, Y-angles negate and X-angles don't:
 *   m_l = RotY_l(−y) · RotX_l(x)
 */
export function ldrawMatrixForDraft(yRotDeg: number, xRotDeg: number): number[] {
  const y = (-yRotDeg * Math.PI) / 180;
  const x = (xRotDeg * Math.PI) / 180;
  const cy = Math.round(Math.cos(y) * 1e9) / 1e9;
  const sy = Math.round(Math.sin(y) * 1e9) / 1e9;
  const cx = Math.round(Math.cos(x) * 1e9) / 1e9;
  const sx = Math.round(Math.sin(x) * 1e9) / 1e9;
  // RotY_l(y) · RotX_l(x), both row-major.
  return [
    cy, sy * sx, sy * cx,
    0, cx, -sx,
    -sy, cy * sx, cy * cx,
  ];
}

/**
 * Compose an ENGINE-frame 90° Y rotation onto an oriented part's stored
 * LDraw matrix: m' = R_ldraw(−θ) · m  (engine +θ maps to LDraw −θ).
 */
export function rotateLdrawMatrixY(m: number[], engineDeg: 90 | 180 | 270): number[] {
  const ldrawDeg = (360 - engineDeg) % 360;
  const c = ldrawDeg === 90 ? 0 : ldrawDeg === 180 ? -1 : 0;
  const s = ldrawDeg === 90 ? 1 : ldrawDeg === 180 ? 0 : -1;
  // R = [c 0 s; 0 1 0; -s 0 c] (row-major), result = R · m
  return [
    c * m[0] + s * m[6], c * m[1] + s * m[7], c * m[2] + s * m[8],
    m[3], m[4], m[5],
    -s * m[0] + c * m[6], -s * m[1] + c * m[7], -s * m[2] + c * m[8],
  ];
}
