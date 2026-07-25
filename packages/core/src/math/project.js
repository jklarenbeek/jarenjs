//@ts-check
/**
 * @file 3D → 2D projection helpers, built on `Mat4` and the
 * existing `Vec3f64`. Used by the x·y·z plotter to turn a rotated grid
 * of surface points into screen coordinates and to shade faces.
 */

import { Mat4 } from './mat4.js';
import { Vec3f64 } from './vec3f64.js';

/**
 * @typedef {object} Viewport
 * @property {number} x left edge in pixels
 * @property {number} y top edge in pixels
 * @property {number} width
 * @property {number} height
 */

/**
 * Project a 3D point through `mat` (model·view·projection) and map the
 * resulting normalized device coordinates into `viewport` pixels. The Y
 * axis is flipped so that +Y is up in world space but down in screen
 * space, as SVG expects.
 *
 * @param {{ x: number, y: number, z: number } | import('./vec3f64.js').Vec3f64} point3
 * @param {import('./mat4.js').Mat4Array} mat
 * @param {Viewport} viewport
 * @returns {{ x: number, y: number, z: number, w: number }}
 */
export function project3dTo2d(point3, mat, viewport) {
  const clip = Mat4.transformPoint(mat, +point3.x, +point3.y, +point3.z);
  const sx = viewport.x + (clip.x * 0.5 + 0.5) * viewport.width;
  const sy = viewport.y + (0.5 - clip.y * 0.5) * viewport.height;
  return { x: sx, y: sy, z: clip.z, w: clip.w };
}

/**
 * The (un-normalized) surface normal of triangle `a→b→c`, right-hand
 * winding. Returns a `Vec3f64`.
 * @param {import('./vec3f64.js').Vec3f64} a
 * @param {import('./vec3f64.js').Vec3f64} b
 * @param {import('./vec3f64.js').Vec3f64} c
 * @returns {import('./vec3f64.js').Vec3f64}
 */
export function surfaceNormal(a, b, c) {
  const ab = Vec3f64.sub(b, a);
  const ac = Vec3f64.sub(c, a);
  return Vec3f64.cross(ab, ac);
}
