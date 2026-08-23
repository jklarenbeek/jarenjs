//@ts-check

//#region Line simplification
// Real geographic data is drawn at a resolution nobody is looking at. A
// national boundary from OpenStreetMap carries tens of thousands of
// vertices; rendered 400 pixels wide, the overwhelming majority land on
// the same pixel as their neighbour. Emitting them anyway costs path
// bytes, parse time and paint time for a picture that is byte-identical.
//
// Douglas-Peucker is the classic answer and the right one here: it keeps
// the vertices that carry the shape (every corner, every peninsula) and
// drops the ones that only fill in a straight run, so what survives is
// what a reader would have drawn. The tolerance is a distance in the
// input's own units — feed it projected unit-square coordinates and the
// tolerance is a fraction of the frame, which is the only unit a
// renderer can reason about.
//
// The implementation is iterative rather than recursive. A degenerate
// input (a coastline digitized as one long near-straight run) recurses
// once per vertex, and at OSM scale that overflows the stack — a real
// failure, not a theoretical one.

/**
 * Squared distance from a point to a segment. Squared throughout: the
 * comparison against a tolerance is monotonic in the square, so the
 * square root would be one transcendental per vertex per level for an
 * answer nobody reads.
 */
function segmentDistanceSq(px, py, ax, ay, bx, by) {
  let dx = bx - ax;
  let dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      ax = bx;
      ay = by;
    }
    else if (t > 0) {
      ax += dx * t;
      ay += dy * t;
    }
  }
  dx = px - ax;
  dy = py - ay;
  return dx * dx + dy * dy;
}

/**
 * Simplify a line with the Douglas-Peucker algorithm, keeping every
 * vertex further than `tolerance` from the line its neighbours describe.
 *
 * The first and last positions always survive, so a **ring stays closed**
 * — simplification can never turn a valid polygon into an invalid one.
 * Positions are returned by reference, not copied, so any third element
 * (altitude) rides along untouched.
 *
 * @param {Array<number[]>} line - positions
 * @param {number} tolerance - in the input's own coordinate units
 * @returns {Array<number[]>} a new array; the input is not modified
 * @example
 * simplifyLine([[0,0],[1,0.001],[2,0]], 0.01); // [[0,0],[2,0]]
 * simplifyLine([[0,0],[1,1],[2,0]], 0.01);     // all three: the corner carries the shape
 */
export function simplifyLine(line, tolerance) {
  const n = line.length;
  if (n < 3 || !(tolerance > 0))
    return line.slice();

  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // an explicit stack of [first, last] spans still to examine
  const stack = [0, n - 1];
  while (stack.length > 0) {
    const last = /** @type {number} */(stack.pop());
    const first = /** @type {number} */(stack.pop());
    if (last - first < 2)
      continue;
    const ax = line[first][0];
    const ay = line[first][1];
    const bx = line[last][0];
    const by = line[last][1];
    let furthest = -1;
    let furthestSq = toleranceSq;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(line[i][0], line[i][1], ax, ay, bx, by);
      if (d > furthestSq) {
        furthestSq = d;
        furthest = i;
      }
    }
    // nothing in this span strays far enough: the whole run collapses to
    // its endpoints, and neither half needs looking at
    if (furthest < 0)
      continue;
    keep[furthest] = 1;
    stack.push(first, furthest, furthest, last);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1)
      out.push(line[i]);
  }
  return out;
}

/**
 * Simplify a linear ring, refusing to destroy it.
 *
 * A ring needs four positions to bound a surface, so when the tolerance
 * would leave fewer the ring is returned **unsimplified** rather than
 * degenerate. Dropping a small island entirely is a defensible rendering
 * choice, but silently emitting a two-vertex "polygon" is not — a caller
 * wanting the island gone should filter by area first.
 *
 * @param {Array<number[]>} ring - positions, first === last
 * @param {number} tolerance
 * @returns {Array<number[]>}
 */
export function simplifyRing(ring, tolerance) {
  if (ring.length < 5)
    return ring.slice();
  const simplified = simplifyLine(ring, tolerance);
  return simplified.length >= 4 ? simplified : ring.slice();
}

/** Every line/ring of a coordinate nest `depth` levels above the leaf. */
function simplifyNest(value, depth, tolerance, simplify) {
  if (!Array.isArray(value))
    return value;
  if (depth === 0)
    return simplify(value, tolerance);
  const out = new Array(value.length);
  for (let i = 0; i < value.length; i++)
    out[i] = simplifyNest(value[i], depth - 1, tolerance, simplify);
  return out;
}

/**
 * A whole GeoJSON value with its vertices dropped — the same value,
 * reduced. Lines go through {@link simplifyLine} and rings through
 * {@link simplifyRing}, so **a ring stays closed and a line keeps both
 * endpoints**; points and multipoints have no run to collapse and come
 * back untouched.
 *
 * Accepts what the traversal layer accepts: a geometry, a Feature, a
 * FeatureCollection or a GeometryCollection. Foreign members, ids and
 * properties ride along — the value that comes back is the value that
 * went in, with fewer positions, so it can be stored or sent as-is.
 * Anything this does not recognize is returned unchanged rather than
 * dropped.
 *
 * The tolerance is in the coordinate's own units, which for GeoJSON is
 * **degrees** — a planar vertex-dropping threshold, never a distance. A
 * degree of longitude is not a fixed length, so calling it metres would
 * be the planar-for-geodesic confusion the rest of this module exists to
 * prevent.
 *
 * @param {any} value
 * @param {number} tolerance - in degrees
 * @returns {any} a new value; the input is not modified
 * @example
 * simplifyGeometry({ type: 'LineString', coordinates: [[0,0],[1,0.001],[2,0]] }, 0.01);
 * // { type: 'LineString', coordinates: [[0,0],[2,0]] }
 */
export function simplifyGeometry(value, tolerance) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return value;
  if (value.type === 'FeatureCollection') {
    if (!Array.isArray(value.features))
      return value;
    return { ...value, features: value.features.map((f) => simplifyGeometry(f, tolerance)) };
  }
  if (value.type === 'Feature') {
    return { ...value, geometry: simplifyGeometry(value.geometry, tolerance) };
  }
  if (value.type === 'GeometryCollection') {
    if (!Array.isArray(value.geometries))
      return value;
    return { ...value, geometries: value.geometries.map((g) => simplifyGeometry(g, tolerance)) };
  }
  switch (value.type) {
    case 'LineString':
      return { ...value, coordinates: simplifyNest(value.coordinates, 0, tolerance, simplifyLine) };
    case 'MultiLineString':
      return { ...value, coordinates: simplifyNest(value.coordinates, 1, tolerance, simplifyLine) };
    case 'Polygon':
      return { ...value, coordinates: simplifyNest(value.coordinates, 1, tolerance, simplifyRing) };
    case 'MultiPolygon':
      return { ...value, coordinates: simplifyNest(value.coordinates, 2, tolerance, simplifyRing) };
    default: // Point, MultiPoint, and anything unrecognized: nothing to drop
      return value;
  }
}

//#endregion
