//@ts-check

//#region Rings, areas and containment
// A GeoJSON linear ring is an array of at least four positions whose
// first and last are identical (RFC 7946 section 3.1.6). A Polygon's
// `coordinates` is an array of rings — exterior first, holes after — so
// everything here takes plain position arrays and needs no knowledge of
// the `type` discriminator.
//
// The two invariants JSON Schema provably cannot express live here:
// `isRingClosed` and `ringWinding`. The official GeoJSON schema says so
// outright, which is why every validator in the ecosystem bolts on code
// of its own — and unclosed rings and reversed winding (which makes a
// renderer fill the whole globe instead of the polygon) are among the
// commonest defects in real data.

import { orient2d } from './predicates.js';
import { EARTH_RADIUS } from './distance.js';

const DEG = Math.PI / 180;

/**
 * Whether a ring is closed: its last position repeats its first.
 *
 * Compares longitude and latitude only. A position may legally carry a
 * third element (altitude), and RFC 7946 does not require it to match
 * for the ring to close.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {boolean}
 * @example
 * isRingClosed([[0,0],[1,0],[1,1],[0,0]]); // true
 * isRingClosed([[0,0],[1,0],[1,1]]);       // false
 */
export function isRingClosed(ring) {
  const n = ring.length;
  if (n < 2)
    return false;
  const first = ring[0];
  const last = ring[n - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Twice the signed planar area of a ring (the shoelace sum), in squared
 * degrees. **Positive is counter-clockwise.**
 *
 * The sign is the useful part and is exact for the purpose: it is a sum
 * of `orient2d` determinants about the ring's first vertex, so a ring
 * whose vertices are near-collinear still winds the way this says. The
 * magnitude is a planar quantity in degree-space and is NOT an area on
 * the Earth — use `sphericalRingArea` for that.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {number} twice the signed area; positive = counter-clockwise
 */
export function ringSignedArea(ring) {
  const n = ring.length;
  if (n < 3)
    return 0;
  // fan the triangles from vertex 0 so each term is an orientation
  // determinant rather than a bare cross product
  const [ox, oy] = ring[0];
  let sum = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    sum += orient2d(ox, oy, a[0], a[1], b[0], b[1]);
  }
  return sum;
}

/**
 * The winding direction of a ring: `1` counter-clockwise, `-1`
 * clockwise, `0` degenerate (zero area).
 *
 * RFC 7946 section 3.1.6 requires exterior rings to be counter-clockwise
 * and holes clockwise — the right-hand rule. Parsers are told to accept
 * non-conforming data, so this reports rather than rejects.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {number} 1, -1 or 0
 */
export function ringWinding(ring) {
  return Math.sign(ringSignedArea(ring));
}

/**
 * Geodesic area of a ring on the sphere, in square metres, always
 * non-negative.
 *
 * Uses the spherical excess of the polygon (the standard formula for a
 * ring of great-circle edges), so unlike `ringSignedArea` this is a real
 * measurement. Accurate to the sphere approximation — under half a
 * percent, the same bound as `haversineDistance`.
 *
 * @param {Array<number[]>} ring - positions
 * @param {number} [radius]
 * @returns {number} square metres
 */
export function sphericalRingArea(ring, radius = EARTH_RADIUS) {
  const n = ring.length;
  if (n < 4)
    return 0; // fewer than 3 distinct positions bounds no area
  let total = 0;
  // consecutive edges share a vertex, so its sine is carried forward
  // rather than recomputed: one transcendental per vertex, not two
  let sinA = Math.sin(ring[0][1] * DEG);
  for (let i = 0; i < n - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const sinB = Math.sin(b[1] * DEG);
    total += (b[0] - a[0]) * DEG * (2 + sinA + sinB);
    sinA = sinB;
  }
  return Math.abs(total * radius * radius * 0.5);
}

/**
 * Whether a position lies inside a ring, by the even-odd (crossing)
 * rule. A position exactly on an edge or vertex counts as **inside**,
 * which is the convention that makes adjacent polygons tile without
 * gaps.
 *
 * The ray cast runs in the ring's own coordinate space, so this is a
 * planar test on longitude/latitude. That is what GeoJSON consumers
 * mean by containment, and it is correct for any ring that does not
 * cross the antimeridian — which RFC 7946 tells producers to cut.
 *
 * @param {number} x - longitude
 * @param {number} y - latitude
 * @param {Array<number[]>} ring - positions
 * @returns {boolean}
 */
export function pointInRing(x, y, ring) {
  const n = ring.length;
  if (n < 3)
    return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    // Two cheap tests decide whether the exact predicate is needed at
    // all. An edge that neither straddles the ray nor spans the point
    // can affect neither answer, and on a large ring that is almost
    // every edge - so the robust orientation runs a handful of times
    // instead of twice per vertex.
    const straddles = (yi > y) !== (yj > y);
    const spans = (xi < x) === (x <= xj) && (yi < y) === (y <= yj);
    if (!straddles && !spans)
      continue;
    const side = orient2d(xi, yi, xj, yj, x, y);
    // exactly on this edge, and within its extent rather than its line
    if (side === 0 && spans)
      return true;
    // the crossing test itself: is the edge to the right of the point
    if (straddles && side !== 0 && (side > 0) === (yj > yi))
      inside = !inside;
  }
  return inside;
}

/**
 * Whether a position lies inside a polygon: inside its exterior ring and
 * outside every hole.
 * @param {number} x - longitude
 * @param {number} y - latitude
 * @param {Array<Array<number[]>>} rings - a GeoJSON Polygon's coordinates
 * @returns {boolean}
 */
export function pointInPolygon(x, y, rings) {
  if (rings.length === 0 || !pointInRing(x, y, rings[0]))
    return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i]))
      return false; // in a hole
  }
  return true;
}

//#endregion
