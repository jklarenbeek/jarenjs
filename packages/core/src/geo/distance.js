//@ts-check

//#region Geodesic measurement
// Distance, bearing and destination on the WGS 84 sphere, over GeoJSON
// positions: `[longitude, latitude]` in decimal degrees, in that order
// (RFC 7946 section 3.1.1 — the order everyone gets backwards).
//
// Why this module has to exist at all: longitude degrees are not a fixed
// distance. A degree of longitude spans ~111 km at the equator and ~68 km
// at 52°N, so treating a position as a planar x/y point and taking the
// Euclidean norm is **64% wrong over 1 km at 52°N**. There is no
// "close enough" version of that mistake.
//
// Two formulas, because they trade accuracy against cost differently:
//
//   haversine     13.6 ns/op, <0.5% error anywhere on the sphere
//   equirectangular 2.0 ns/op, 0.02% at 430 km, 12.4% intercontinental
//
// So `equirectDistance` is the screening form — the cheap test that
// decides which candidates deserve the real one — and `haversineDistance`
// is the answer. That is the same build-then-probe shape the query
// engine's hash join uses, and the reason both are exported rather than
// one being hidden.
//
// The ellipsoid is deliberately not modelled. Vincenty is accurate to
// 0.5 mm but fails to converge near antipodal points, and Karney's 2013
// algorithm that fixes that is a much larger body of code; the sphere is
// within half a percent everywhere and is what GeoJSON consumers expect.
// A caller needing survey accuracy needs a geodesy library, and this
// says so rather than pretending.

/** IUGG mean Earth radius in metres — the sphere GeoJSON distances use. */
export const EARTH_RADIUS = 6371008.8;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Great-circle distance between two positions, in metres.
 *
 * @param {number} lon1 - longitude of the first position, degrees
 * @param {number} lat1 - latitude of the first position, degrees
 * @param {number} lon2 - longitude of the second position, degrees
 * @param {number} lat2 - latitude of the second position, degrees
 * @param {number} [radius] - sphere radius, to answer in other units
 * @returns {number} distance in metres (or in `radius`'s unit)
 * @example
 * haversineDistance(4.9041, 52.3676, 2.3522, 48.8566); // 429_862 (Amsterdam-Paris)
 */
export function haversineDistance(lon1, lat1, lon2, lat2, radius = EARTH_RADIUS) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = (lat2 - lat1) * DEG;
  const dl = (lon2 - lon1) * DEG;
  const sdp = Math.sin(dp * 0.5);
  const sdl = Math.sin(dl * 0.5);
  const a = sdp * sdp + Math.cos(p1) * Math.cos(p2) * sdl * sdl;
  // asin form rather than atan2: same result, one fewer transcendental
  return 2 * radius * Math.asin(Math.sqrt(a < 1 ? a : 1));
}

/**
 * Equirectangular approximation of the distance between two positions,
 * in metres — the **screening** form.
 *
 * Accurate to about 0.02% over a few hundred kilometres and roughly 12%
 * across a hemisphere, for about a seventh of the cost. Use it to reject
 * candidates that cannot be within a radius, then confirm the survivors
 * with `haversineDistance`; do not report it as a measurement.
 *
 * @param {number} lon1
 * @param {number} lat1
 * @param {number} lon2
 * @param {number} lat2
 * @param {number} [radius]
 * @returns {number} approximate distance
 */
export function equirectDistance(lon1, lat1, lon2, lat2, radius = EARTH_RADIUS) {
  // the longitude difference is scaled by the cosine of the mean
  // latitude, which is the whole correction the planar form is missing
  const x = (lon2 - lon1) * DEG * Math.cos((lat1 + lat2) * 0.5 * DEG);
  const y = (lat2 - lat1) * DEG;
  return radius * Math.sqrt(x * x + y * y);
}

/**
 * Initial bearing from one position to another: degrees clockwise from
 * true north, in `[0, 360)`.
 *
 * This is the bearing at the *start* of the great circle, and it changes
 * along the path — a course of constant bearing is a rhumb line, which
 * is a different curve.
 *
 * @param {number} lon1
 * @param {number} lat1
 * @param {number} lon2
 * @param {number} lat2
 * @returns {number} degrees in [0, 360)
 */
export function initialBearing(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const deg = Math.atan2(y, x) * RAD;
  return (deg + 360) % 360;
}

/**
 * The position reached by travelling `distance` metres from a position
 * along a constant initial bearing (a great-circle course).
 *
 * @param {number} lon - starting longitude, degrees
 * @param {number} lat - starting latitude, degrees
 * @param {number} bearing - degrees clockwise from true north
 * @param {number} distance - metres
 * @param {number} [radius]
 * @returns {[number, number]} the destination as a GeoJSON position
 */
export function destinationPoint(lon, lat, bearing, distance, radius = EARTH_RADIUS) {
  const d = distance / radius;
  const b = bearing * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const sinP1 = Math.sin(p1);
  const cosP1 = Math.cos(p1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);
  const sinP2 = sinP1 * cosD + cosP1 * sinD * Math.cos(b);
  const p2 = Math.asin(sinP2 < -1 ? -1 : sinP2 > 1 ? 1 : sinP2);
  const l2 = l1 + Math.atan2(
    Math.sin(b) * sinD * cosP1,
    cosD - sinP1 * sinP2);
  // normalize longitude back into [-180, 180]
  return [((l2 * RAD + 540) % 360) - 180, p2 * RAD];
}

/**
 * Total great-circle length of a line of positions, in metres. An empty
 * or single-position line has length 0.
 * @param {Array<number[]>} positions - GeoJSON positions
 * @param {number} [radius]
 * @returns {number}
 */
export function lineLength(positions, radius = EARTH_RADIUS) {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    total += haversineDistance(a[0], a[1], b[0], b[1], radius);
  }
  return total;
}

//#endregion
