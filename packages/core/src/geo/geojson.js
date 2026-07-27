//@ts-check

//#region GeoJSON traversal
// The layer that knows about the `type` discriminator. Everything else
// in this module family works on positions and rings — which ARE a
// GeoJSON geometry's `coordinates` — so this is the only place that has
// to care whether it is holding a Point, a Feature or a whole
// FeatureCollection.
//
// Every function here accepts the three shapes a caller realistically
// has: a bare **position** (`[lon, lat]`), a **geometry**, or a
// **Feature**/**FeatureCollection** wrapping one. Refusing the wrappers
// would push the unwrapping into every call site, and a query operator
// cannot ask its author to unwrap first.
//
// Nothing here validates. A malformed object yields null or 0 rather
// than throwing, because the schema artifacts are where GeoJSON is
// judged; a measurement function that also validated would report the
// same defect twice in two vocabularies.

import { haversineDistance, lineLength, EARTH_RADIUS } from './distance.js';
import { sphericalRingArea, pointInPolygon, isRingClosed } from './ring.js';
import { bboxUnion } from './bbox.js';

/** The geometry types whose `coordinates` is a single position. */
const POINT_TYPES = new Set(['Point']);
/** Types whose `coordinates` is a list of positions. */
const LINE_TYPES = new Set(['MultiPoint', 'LineString']);
/** Types whose `coordinates` is a list of position lists. */
const SURFACE_TYPES = new Set(['MultiLineString', 'Polygon']);

/**
 * Whether a value looks like a bare position: an array of at least two
 * finite numbers.
 * @param {any} value
 * @returns {boolean}
 */
export function isPosition(value) {
  return Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'number' && typeof value[1] === 'number';
}

/**
 * The geometry inside a value: the value itself when it is already one,
 * a Feature's `geometry`, or null when there is none (including a
 * Feature whose geometry is legitimately null).
 *
 * A FeatureCollection has no single geometry and yields null — use
 * {@link eachPosition} or {@link bboxOf}, which handle collections.
 *
 * @param {any} value
 * @returns {object | null}
 */
export function geometryOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  if (value.type === 'Feature')
    return geometryOf(value.geometry);
  return typeof value.type === 'string' && value.type !== 'FeatureCollection'
    ? value
    : null;
}

/**
 * Call `visit(position)` for every position in a GeoJSON value, in
 * document order. Accepts a bare position, a geometry, a Feature, a
 * FeatureCollection or a GeometryCollection.
 * @param {any} value
 * @param {(position: number[]) => void} visit
 */
export function eachPosition(value, visit) {
  if (isPosition(value)) {
    visit(/** @type {number[]} */(value));
    return;
  }
  if (value === null || typeof value !== 'object')
    return;
  if (Array.isArray(value)) { // a nest of coordinates
    for (let i = 0; i < value.length; i++)
      eachPosition(value[i], visit);
    return;
  }
  if (value.type === 'FeatureCollection') {
    const features = value.features;
    if (Array.isArray(features)) {
      for (let i = 0; i < features.length; i++)
        eachPosition(features[i], visit);
    }
    return;
  }
  if (value.type === 'Feature') {
    eachPosition(value.geometry, visit);
    return;
  }
  if (value.type === 'GeometryCollection') {
    const geometries = value.geometries;
    if (Array.isArray(geometries)) {
      for (let i = 0; i < geometries.length; i++)
        eachPosition(geometries[i], visit);
    }
    return;
  }
  eachPosition(value.coordinates, visit);
}

/**
 * The bounding box of any GeoJSON value, as `[west, south, east, north]`.
 * Null when the value contains no positions.
 *
 * A `bbox` member already present on the value is ignored: it is an
 * optimization the producer may have got wrong, and recomputing is the
 * only way to be sure.
 *
 * @param {any} value
 * @returns {number[] | null}
 */
export function bboxOf(value) {
  let box = null;
  eachPosition(value, (p) => {
    const point = [p[0], p[1], p[0], p[1]];
    box = box === null ? point : bboxUnion(box, point);
  });
  return box;
}

/**
 * Every position of a GeoJSON value, flattened into one array.
 * @param {any} value
 * @returns {Array<number[]>}
 */
export function positionsOf(value) {
  const out = [];
  eachPosition(value, (p) => out.push(p));
  return out;
}

/**
 * Geodesic area of a value in square metres: the sum over its polygons
 * of the exterior ring's area less its holes'. Anything with no surface
 * — a point, a line — has area 0 rather than being an error.
 * @param {any} value
 * @param {number} [radius]
 * @returns {number}
 */
export function geometryArea(value, radius = EARTH_RADIUS) {
  if (value === null || typeof value !== 'object')
    return 0;
  if (value.type === 'FeatureCollection') {
    let sum = 0;
    for (const feature of value.features ?? [])
      sum += geometryArea(feature, radius);
    return sum;
  }
  const geometry = geometryOf(value);
  if (geometry === null)
    return 0;
  if (geometry.type === 'GeometryCollection') {
    let sum = 0;
    for (const inner of geometry.geometries ?? [])
      sum += geometryArea(inner, radius);
    return sum;
  }
  if (geometry.type === 'Polygon')
    return polygonArea(geometry.coordinates, radius);
  if (geometry.type === 'MultiPolygon') {
    let sum = 0;
    for (const rings of geometry.coordinates ?? [])
      sum += polygonArea(rings, radius);
    return sum;
  }
  return 0;
}

// exterior ring less holes
function polygonArea(rings, radius) {
  if (!Array.isArray(rings) || rings.length === 0)
    return 0;
  let area = sphericalRingArea(rings[0], radius);
  for (let i = 1; i < rings.length; i++)
    area -= sphericalRingArea(rings[i], radius);
  return area > 0 ? area : 0;
}

/**
 * Great-circle length of a value in metres: the sum of its line
 * lengths, and of its polygon ring perimeters. A point has length 0.
 * @param {any} value
 * @param {number} [radius]
 * @returns {number}
 */
export function geometryLength(value, radius = EARTH_RADIUS) {
  if (value === null || typeof value !== 'object')
    return 0;
  if (value.type === 'FeatureCollection') {
    let sum = 0;
    for (const feature of value.features ?? [])
      sum += geometryLength(feature, radius);
    return sum;
  }
  const geometry = geometryOf(value);
  if (geometry === null)
    return 0;
  const { type, coordinates } = geometry;
  if (type === 'GeometryCollection') {
    let sum = 0;
    for (const inner of geometry.geometries ?? [])
      sum += geometryLength(inner, radius);
    return sum;
  }
  if (type === 'LineString')
    return lineLength(coordinates ?? [], radius);
  if (type === 'MultiLineString' || type === 'Polygon') {
    let sum = 0;
    for (const line of coordinates ?? [])
      sum += lineLength(line, radius);
    return sum;
  }
  if (type === 'MultiPolygon') {
    let sum = 0;
    for (const rings of coordinates ?? []) {
      for (const ring of rings ?? [])
        sum += lineLength(ring, radius);
    }
    return sum;
  }
  return 0;
}

/**
 * The centroid of a value's positions, as a GeoJSON position. Null when
 * there are none.
 *
 * This is the mean of the vertices, NOT the area-weighted centre of
 * mass: it is the cheap answer, it always lies in the convex hull, and
 * for a concave shape it can fall outside the polygon. Labelling and
 * clustering want this; a physics centre of mass does not.
 *
 * @param {any} value
 * @returns {[number, number] | null}
 */
export function centroidOf(value) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  eachPosition(value, (p) => {
    sumX += p[0];
    sumY += p[1];
    count++;
  });
  return count === 0 ? null : [sumX / count, sumY / count];
}

/**
 * Whether a position lies inside a value's surface. Only polygons have
 * an inside, so a point or a line always answers false.
 * @param {any} value - a Polygon, MultiPolygon, Feature or collection
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
export function containsPosition(value, lon, lat) {
  if (value === null || typeof value !== 'object')
    return false;
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features ?? []) {
      if (containsPosition(feature, lon, lat))
        return true;
    }
    return false;
  }
  const geometry = geometryOf(value);
  if (geometry === null)
    return false;
  if (geometry.type === 'GeometryCollection') {
    for (const inner of geometry.geometries ?? []) {
      if (containsPosition(inner, lon, lat))
        return true;
    }
    return false;
  }
  if (geometry.type === 'Polygon')
    return pointInPolygon(lon, lat, geometry.coordinates ?? []);
  if (geometry.type === 'MultiPolygon') {
    for (const rings of geometry.coordinates ?? []) {
      if (pointInPolygon(lon, lat, rings))
        return true;
    }
    return false;
  }
  return false;
}

/**
 * The distance in metres between two GeoJSON values, measured between
 * their **representative positions**: a bare position or Point is
 * itself, anything else is its centroid. Null when either side has no
 * positions.
 *
 * This is deliberately not the minimum distance between two shapes,
 * which needs point-to-segment geodesics and is a different (and much
 * larger) piece of work. Callers wanting "how far is this point from
 * that region" should test containment first.
 *
 * @param {any} a
 * @param {any} b
 * @param {number} [radius]
 * @returns {number | null}
 */
export function geoDistance(a, b, radius = EARTH_RADIUS) {
  const pa = isPosition(a) ? a : centroidOf(a);
  const pb = isPosition(b) ? b : centroidOf(b);
  if (pa === null || pb === null)
    return null;
  return haversineDistance(pa[0], pa[1], pb[0], pb[1], radius);
}

/**
 * Whether every linear ring of a value is closed — the invariant the
 * portable GeoJSON schema cannot express. True for values with no rings.
 * @param {any} value
 * @returns {boolean}
 */
export function ringsClosed(value) {
  const geometry = geometryOf(value);
  if (value !== null && typeof value === 'object' && value.type === 'FeatureCollection') {
    for (const feature of value.features ?? []) {
      if (!ringsClosed(feature))
        return false;
    }
    return true;
  }
  if (geometry === null)
    return true;
  if (geometry.type === 'GeometryCollection') {
    for (const inner of geometry.geometries ?? []) {
      if (!ringsClosed(inner))
        return false;
    }
    return true;
  }
  if (geometry.type === 'Polygon')
    return (geometry.coordinates ?? []).every(isRingClosed);
  if (geometry.type === 'MultiPolygon')
    return (geometry.coordinates ?? []).every((rings) => (rings ?? []).every(isRingClosed));
  return true;
}

/** The geometry-type groups, exported for consumers that dispatch on shape. */
export const GEO_POINT_TYPES = POINT_TYPES;
export const GEO_LINE_TYPES = LINE_TYPES;
export const GEO_SURFACE_TYPES = SURFACE_TYPES;

//#endregion
