//@ts-check

//#region Web Mercator
// The projection maps go out through, and the only one this module
// family carries. RFC 7946 fixes the coordinate reference *system* to
// WGS 84, so there is nothing to configure on the way in; a projection
// is what happens on the way **out**, when a sphere has to become a
// rectangle somebody can draw.
//
// Web Mercator (EPSG:3857) is the choice because it is what every tile
// server, every slippy map and every reader's intuition already uses.
// Its costs are worth stating rather than discovering: it is conformal
// (shapes stay locally correct, which is why it looks right) but wildly
// area-distorting toward the poles — Greenland renders about the size of
// Africa and is fourteen times smaller. **Never measure on a projected
// coordinate.** `geometryArea` and `haversineDistance` work on the
// sphere for exactly this reason; these functions are for drawing.
//
// Latitude is clamped to ±85.051129°, where the projection reaches a
// square. Beyond that y runs to infinity, so the poles are not
// representable and a caller asking for them gets the edge instead of a
// NaN that would poison a whole path string.

import { clamp01 } from '../math/float64.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * The latitude where Web Mercator's y reaches the edge of its square.
 * Poleward of this the projection is unbounded.
 */
export const MERCATOR_MAX_LAT = 85.05112877980659;

/**
 * Project a position into the Web Mercator unit square: x and y both in
 * `[0, 1]`, with **y increasing southward** so the result is already in
 * screen order and a renderer needs no flip.
 *
 * Latitude is clamped, longitude is not: a latitude past the Mercator
 * limit has a defensible answer (the edge) while a longitude past ±180
 * is simply invalid under RFC 7946, and folding it silently into range
 * would move a shape to the wrong side of the world rather than let the
 * defect show.
 *
 * @param {number} lon - longitude in degrees, `[-180, 180]`
 * @param {number} lat - latitude in degrees, clamped to ±85.051129
 * @returns {[number, number]} `[x, y]` in the unit square
 * @example
 * projectMercator(0, 0);      // [0.5, 0.5] — null island is the centre
 * projectMercator(-180, 85.05112877980659); // [0, 0] — the north-west corner
 */
export function projectMercator(lon, lat) {
  const clamped = lat > MERCATOR_MAX_LAT
    ? MERCATOR_MAX_LAT
    : (lat < -MERCATOR_MAX_LAT ? -MERCATOR_MAX_LAT : lat);
  const x = (lon + 180) / 360;
  const s = Math.sin(clamped * DEG);
  // atanh(sin lat), spelled out: the log form is the standard one and
  // avoids a tan that runs to infinity as the latitude nears the pole.
  // Clamped because at exactly ±MERCATOR_MAX_LAT the true answer is 0 or
  // 1 and the arithmetic lands an ULP outside — so the clamp is the more
  // accurate value, not a fudge, and it makes the `[0, 1]` range a fact.
  const y = clamp01(0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI));
  return [x, y];
}

/**
 * The inverse of {@link projectMercator}: a unit-square point back to a
 * position. Needed to turn a click or a viewport corner back into
 * longitude and latitude.
 *
 * @param {number} x - 0..1
 * @param {number} y - 0..1, increasing southward
 * @returns {[number, number]} `[longitude, latitude]` in degrees
 */
export function unprojectMercator(x, y) {
  const lon = x * 360 - 180;
  const lat = (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) * RAD;
  return [lon, lat];
}

/**
 * A projection fitted to a geographic bounding box: the transform that
 * maps positions inside `bbox` into `[0, 1]` on both axes, **without
 * distorting the aspect ratio**, centring whichever axis has room left
 * over.
 *
 * Stretching a map to fill its frame is the single most common way to
 * make one look wrong, so the fit is uniform by construction and the
 * spare room becomes margin rather than distortion. `aspect` is the
 * width:height ratio of the frame the result will be drawn into: the fit
 * happens in a box `aspect` wide and 1 tall, then x is divided back down
 * so both outputs are in `[0, 1]` — the same unit-square convention the
 * treemap uses, where the renderer maps height from width by the same
 * ratio.
 *
 * @param {number[]} bbox - `[west, south, east, north]`
 * @param {number} [aspect] - frame width:height (default 1, a square)
 * @returns {(lon: number, lat: number) => [number, number]}
 * @example
 * const fit = fitMercator([4, 52, 5, 53], 1.6);
 * fit(4.5, 52.5); // near [0.5, 0.5] whatever the box's shape
 */
export function fitMercator(bbox, aspect = 1) {
  const [x0, y1] = projectMercator(bbox[0], bbox[1]); // west, south -> y is max
  const [x1, y0] = projectMercator(bbox[2], bbox[3]); // east, north -> y is min
  const width = x1 - x0;
  const height = y1 - y0;
  // one scale for both axes — whichever runs out of frame first sets it
  const scale = Math.min(
    width > 0 ? aspect / width : Infinity,
    height > 0 ? 1 / height : Infinity);
  // a degenerate box (one position, or a box with no extent either way)
  // has nothing to scale by; centre everything rather than divide by zero
  if (!(scale > 0) || !Number.isFinite(scale))
    return () => [0.5, 0.5];
  const padX = (aspect - width * scale) / 2;
  const padY = (1 - height * scale) / 2;
  return (lon, lat) => {
    const [px, py] = projectMercator(lon, lat);
    return [((px - x0) * scale + padX) / aspect, (py - y0) * scale + padY];
  };
}

//#endregion
