//@ts-check
/**
 * The stage camera: an orbit around the centre of the tape, built on
 * the suite's own 3D kernel (`Mat4` from `@jarenjs/core/math/mat4`, the
 * same column-major matrices the calculator's surface plots use).
 *
 * The matrices are composed once per frame; points are then projected
 * with the matrix entries inline (`project`), because a frame projects a
 * few thousand vertices and `Mat4.transformPoint` allocates a result
 * object per call. The arithmetic is exactly `transformPoint` followed by
 * the viewport map of `project3dTo2d` — Y flipped, `w` kept as depth.
 */

import { Mat4 } from '@jarenjs/core/math/mat4';

/**
 * A camera orbits a point: the centre of the tape unless it names a
 * `target` (a figure it follows, a game's island).
 * @typedef {{ azimuth: number, elevation: number, distance: number, lift: number, fov: number, target?: [number, number, number] }} Camera
 * @typedef {{ matrix: Float64Array, eye: [number, number, number], width: number, height: number, camera: Camera }} View
 */

/** The resting camera: a three-quarter view from above, like a figure
 * drawn on a page tilted toward the viewer. */
export const HOME_CAMERA = /** @type {Readonly<Camera>} */ (Object.freeze({
  azimuth: 0.62, elevation: 0.74, distance: 36, lift: 0.4, fov: 0.62,
}));

/** Orbit limits: never under the floor, never straight down. */
export const ELEVATION_MIN = 0.18;
export const ELEVATION_MAX = 1.32;
export const DISTANCE_MIN = 18;
export const DISTANCE_MAX = 80;

/**
 * Clamp a camera into the orbit's bounds.
 * @param {Camera} camera @returns {Camera}
 */
export function clampCamera(camera) {
  return {
    ...camera,
    elevation: Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, camera.elevation)),
    distance: Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, camera.distance)),
  };
}

/**
 * The view for a camera over a viewport: the model-view-projection
 * matrix and the eye position in world space (for face culling and
 * painter's-order depth).
 * @param {Camera} camera @param {number} width @param {number} height
 * @returns {View}
 */
export function viewOf(camera, width, height) {
  const aspect = width / Math.max(1, height);
  // a narrow portrait screen sees the floor from farther back so the
  // whole tape still fits across it
  const fit = aspect < 1 ? 1 / Math.max(0.55, aspect) : 1;
  const distance = camera.distance * fit;
  const projection = Mat4.perspective(camera.fov, aspect, 0.5, 400);
  const [tx, ty, tz] = camera.target ?? [0, 0, 0];
  let view = Mat4.multiply(
    Mat4.translation(0, -camera.lift, -distance),
    Mat4.multiply(Mat4.rotationX(camera.elevation), Mat4.rotationY(camera.azimuth)));
  if (camera.target) view = Mat4.multiply(view, Mat4.translation(-tx, -ty, -tz));
  const y = camera.lift * Math.cos(camera.elevation) + distance * Math.sin(camera.elevation);
  const z = distance * Math.cos(camera.elevation) - camera.lift * Math.sin(camera.elevation);
  return {
    matrix: Mat4.multiply(projection, view),
    eye: [tx - z * Math.sin(camera.azimuth), ty + y, tz + z * Math.cos(camera.azimuth)],
    width,
    height,
    camera,
  };
}

/**
 * Project a world point into viewport pixels: `[x, y, depth]`, where
 * depth is the clip `w` (the distance along the view axis; larger is
 * farther). Points behind the eye come back with depth ≤ 0.
 * @param {View} v @param {number} x @param {number} y @param {number} z
 * @returns {[number, number, number]}
 */
export function project(v, x, y, z) {
  const m = v.matrix;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  const w = cw === 0 ? 1e-9 : cw;
  return [(cx / w * 0.5 + 0.5) * v.width, (0.5 - cy / w * 0.5) * v.height, cw];
}

/** Distance from the eye to a world point (painter's-order key).
 * @param {View} v @param {number} x @param {number} y @param {number} z */
export function depthOf(v, x, y, z) {
  const dx = x - v.eye[0];
  const dy = y - v.eye[1];
  const dz = z - v.eye[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Orbit by a pointer drag of (dx, dy) pixels.
 * @param {Camera} camera @param {number} dx @param {number} dy @returns {Camera}
 */
export function orbit(camera, dx, dy) {
  return clampCamera({ ...camera, azimuth: camera.azimuth + dx * 0.008, elevation: camera.elevation + dy * 0.006 });
}

/**
 * Dolly in or out by a wheel or pinch factor (> 1 moves away).
 * @param {Camera} camera @param {number} factor @returns {Camera}
 */
export function dolly(camera, factor) {
  return clampCamera({ ...camera, distance: camera.distance * factor });
}
