//@ts-check

//#region Bounding boxes
// A GeoJSON `bbox` is a flat array `[west, south, east, north]` (RFC
// 7946 section 5): all axes of the most south-westerly position, then
// all axes of the most north-easterly. It stays a plain array here, so a
// computed box can be written straight into a document as its `bbox`
// member.
//
// Boxes are the cheap half of every spatial test. Overlap between two
// boxes is four comparisons, so it rejects the overwhelming majority of
// candidate pairs before any real geometry runs — the same role
// `equirectDistance` plays for distance, and the shape a spatial index
// ultimately accelerates.

/**
 * The bounding box of a list of positions, as `[west, south, east, north]`.
 * Returns null for an empty list — there is no box that bounds nothing,
 * and an all-Infinity placeholder would silently intersect everything.
 *
 * Null too when any position is non-finite. Narrowing would drop it —
 * every comparison against `NaN` is false — and answer with a finite,
 * plausible box that does not contain the input it was asked to bound.
 * A pre-filter built on such a box loses matching rows silently, which
 * is the one failure a two-stage spatial plan cannot survive, so a
 * position that cannot be bounded refuses the box rather than leaving
 * it too small.
 * @param {Array<number[]>} positions
 * @returns {number[] | null}
 */
export function bboxOfPositions(positions) {
  const n = positions.length;
  if (n === 0)
    return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i][0];
    const y = positions[i][1];
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return null;
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return [west, south, east, north];
}

/**
 * Whether two bounding boxes share any area. Boxes that merely touch
 * along an edge count as intersecting, matching `pointInRing`'s
 * treatment of a boundary as inside.
 * @param {number[]} a - [west, south, east, north]
 * @param {number[]} b
 * @returns {boolean}
 */
export function bboxIntersects(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Whether a bounding box contains a position (edges included).
 * @param {number[]} box - [west, south, east, north]
 * @param {number} x - longitude
 * @param {number} y - latitude
 * @returns {boolean}
 */
export function bboxContains(box, x, y) {
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

/**
 * The smallest box containing both inputs.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function bboxUnion(a, b) {
  return [
    a[0] < b[0] ? a[0] : b[0],
    a[1] < b[1] ? a[1] : b[1],
    a[2] > b[2] ? a[2] : b[2],
    a[3] > b[3] ? a[3] : b[3],
  ];
}

//#endregion
