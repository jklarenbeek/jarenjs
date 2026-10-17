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
import { DEG } from './angle.js';

/**
 * Whether a ring is closed: its last position repeats its first.
 *
 * Compares longitude and latitude only. A position may legally carry a
 * third element (altitude), and RFC 7946 does not require it to match
 * for the ring to close. A ring whose first or last member is not a
 * position, a list whose first two members are numbers (`5`, `'12'`,
 * `[null, null]`), is not closed, and neither is a value that is not a list.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {boolean}
 * @example
 * isRingClosed([[0,0],[1,0],[1,1],[0,0]]); // true
 * isRingClosed([[0,0],[1,0],[1,1]]);       // false
 */
export function isRingClosed(ring) {
  const n = ring?.length;
  if (!(n >= 2))
    return false;
  const first = ring[0];
  const last = ring[n - 1];
  const x = first?.[0];
  const y = first?.[1];
  return x === last?.[0] && y === last?.[1] && typeof x === 'number' && typeof y === 'number'
    && first.length >= 2 && last.length >= 2;
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
 * A ring of three or more holding a member that is not a position of
 * finite numbers (`null`, a hole in the list, `'12'`, `[null, null]`,
 * `NaN`, an object with members `0` and `1`), or that is not a list, has no
 * area: `NaN`. Fewer than three
 * members are `0`.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {number} twice the signed area; positive = counter-clockwise
 */
export function ringSignedArea(ring) {
  if (!Array.isArray(ring))
    return NaN;
  const n = ring.length;
  if (n < 3)
    return 0;
  // fan the triangles from vertex 0 so each term is an orientation
  // determinant rather than a bare cross product; each vertex is read,
  // and checked, once
  // a position is a list of two or more, as the other ring readers read it
  const origin = ring[0];
  const first = ring[1];
  const ox = origin?.[0];
  const oy = origin?.[1];
  let ax = first?.[0];
  let ay = first?.[1];
  if (!(Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(ax) && Number.isFinite(ay)
    && origin.length >= 2 && first.length >= 2))
    return NaN;
  let sum = 0;
  for (let i = 2; i < n; i++) {
    const position = ring[i];
    const bx = position?.[0];
    const by = position?.[1];
    if (!(Number.isFinite(bx) && Number.isFinite(by) && position.length >= 2))
      return NaN;
    sum += orient2d(ox, oy, ax, ay, bx, by);
    ax = bx;
    ay = by;
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
 * A ring that has no area (`ringSignedArea` is `NaN`: a member that is not
 * a position of finite numbers) winds neither way: `0`.
 *
 * @param {Array<number[]>} ring - positions
 * @returns {number} 1, -1 or 0
 */
export function ringWinding(ring) {
  const area = ringSignedArea(ring);
  return area > 0 ? 1 : area < 0 ? -1 : 0;
}

/**
 * Geodesic area of a ring on the sphere, in square metres, always
 * non-negative.
 *
 * Uses the spherical excess of the polygon (the standard formula for a
 * ring of great-circle edges), so unlike `ringSignedArea` this is a real
 * measurement. Accurate to the sphere approximation — under half a
 * percent, the same bound as `haversineDistance`. A ring of four or more
 * holding a member that is not a position, a list whose first two
 * members are numbers, has area NaN, as one holding a coordinate that is
 * not finite does.
 *
 * @param {Array<number[]>} ring - positions
 * @param {number} [radius]
 * @returns {number} square metres
 */
export function sphericalRingArea(ring, radius = EARTH_RADIUS) {
  const n = ring?.length;
  if (!(n >= 0))
    return NaN; // not a list: no area
  if (n < 4)
    return 0; // fewer than 3 distinct positions bounds no area
  // consecutive edges share a vertex, so its longitude and sine are
  // carried forward rather than read and recomputed: one transcendental
  // and one test that it is a position per vertex, not two
  // a missing position throws on its read, which costs nothing until it
  // happens, where a test per position would cost every ring
  try {
    let position = ring[0];
    let ax = position[0];
    const ay = position[1];
    if (typeof ax !== 'number' || typeof ay !== 'number' || !(position.length >= 2))
      return NaN;
    let total = 0;
    let sinA = Math.sin(ay * DEG);
    for (let i = 1; i < n; i++) {
      position = ring[i];
      const bx = position[0];
      const by = position[1];
      if (typeof bx !== 'number' || typeof by !== 'number' || !(position.length >= 2))
        return NaN;
      const sinB = Math.sin(by * DEG);
      total += (bx - ax) * DEG * (2 + sinA + sinB);
      sinA = sinB;
      ax = bx;
    }
    return Math.abs(total * radius * radius * 0.5);
  }
  catch (error) {
    if (error instanceof TypeError)
      return NaN;
    throw error;
  }
}

/**
 * Where a position lies against a ring: 0 outside, 1 on an edge or
 * vertex, 2 strictly inside (even-odd rule), and -1 for a ring holding a
 * member that is not a position of finite numbers (a list whose first two
 * members are finite numbers; not `5`, `'12'`, `{ 0: 1, 1: 2 }`, `[null,
 * null]` or `[NaN, 0]`), or missing one: its edges are not edges, an
 * even-odd count over them reports containment that is not there, and
 * nothing lies inside it. A ring that is not a list (`null`, `5`) is read
 * the same way.
 * @param {number} x
 * @param {number} y
 * @param {Array<number[]>} ring
 * @returns {number}
 */
function locateInRing(x, y, ring) {
  const n = ring?.length;
  if (!(n >= 3)) // a ring that is not a list has no length: it cannot be read
    return n >= 0 && readsFinite(ring, 0) ? 0 : -1;
  let inside = false;
  // each position is read once, as the end of one edge and carried as
  // the start of the next, which pays for the finiteness test it gets
  let position = ring[n - 1];
  let xj = position[0];
  let yj = position[1];
  for (let i = 0; i < n; i++) {
    position = ring[i];
    const xi = position[0];
    const yi = position[1];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !(position.length >= 2))
      return -1;
    // Two cheap tests decide whether the exact predicate is needed at
    // all. An edge that neither straddles the ray nor holds the point
    // inside its closed bounding box can affect neither answer, and on
    // a large ring that is almost every edge - so the robust
    // orientation runs a handful of times instead of twice per vertex.
    const straddles = (yi > y) !== (yj > y);
    const spans = (xi < xj ? xi <= x && x <= xj : xj <= x && x <= xi)
      && (yi < yj ? yi <= y && y <= yj : yj <= y && y <= yi);
    if (straddles || spans) {
      const side = orient2d(xi, yi, xj, yj, x, y);
      // exactly on this edge, and within its extent rather than its
      // line; the positions after it still have to be read
      if (side === 0 && spans)
        return readsFinite(ring, i + 1) ? 1 : -1;
      // the crossing test itself: is the edge to the right of the point
      if (straddles && side !== 0 && (side > 0) === (yj > yi))
        inside = !inside;
    }
    xj = xi;
    yj = yi;
  }
  return inside ? 2 : 0;
}

/**
 * Whether every member of a ring from `from` on is a position of finite
 * numbers, as {@link locateInRing} reads one; a missing position is not.
 * @param {Array<number[]>} ring
 * @param {number} from
 * @returns {boolean}
 */
function readsFinite(ring, from) {
  for (let i = from; i < ring.length; i++) {
    const position = ring[i];
    if (position == null || !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !(position.length >= 2))
      return false;
  }
  return true;
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
 * A ring holding a member that is not a position of finite numbers (a
 * number, text, an object, a one-element array, `[null, null]`, `NaN`),
 * or missing one (`null`, a hole in the list), contains nothing, and so
 * does a ring that is not a list.
 *
 * @param {number} x - longitude
 * @param {number} y - latitude
 * @param {Array<number[]>} ring - positions
 * @returns {boolean}
 */
export function pointInRing(x, y, ring) {
  try {
    return locateInRing(x, y, ring) > 0;
  }
  catch (error) {
    return missingPosition(error);
  }
}

/**
 * The answer for a ring a read of a missing position threw on: it
 * contains nothing. A test per position would cost every ring a check
 * the throw costs nothing until it happens.
 * @param {unknown} error
 * @returns {false}
 */
function missingPosition(error) {
  if (error instanceof TypeError)
    return false;
  throw error;
}

/**
 * Whether a position lies inside a polygon: inside its exterior ring and
 * not strictly inside any hole. The boundary counts as inside for the
 * polygon as for a ring, so a position on a hole's edge or vertex is on
 * the polygon's own boundary and is inside; a polygon that fills the
 * hole claims it too, and the two tile without a gap. A polygon any of
 * whose rings holds a member that is not a position of finite numbers,
 * misses one, or is not a list, contains nothing: a hole that cannot be read cannot say
 * which points it removes, and a fence that answers inside for them is
 * the costly mistake.
 * @param {number} x - longitude
 * @param {number} y - latitude
 * @param {Array<Array<number[]>>} rings - a GeoJSON Polygon's coordinates
 * @returns {boolean}
 */
export function pointInPolygon(x, y, rings) {
  try {
    if (rings.length === 0 || locateInRing(x, y, rings[0]) <= 0)
      return false;
    for (let i = 1; i < rings.length; i++) {
      const at = locateInRing(x, y, rings[i]);
      if (at === 2 || at < 0)
        return false; // strictly inside a hole, or a hole that cannot be read
    }
    return true;
  }
  catch (error) {
    return missingPosition(error);
  }
}

//#endregion
