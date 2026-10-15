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
//
// The one refusal is the walk's bound: a value is walked to 100000
// levels of nesting, on the host's stack for the first 256 and on the
// walk's own past them. That is ten times the 10000 `equalsJson` holds,
// because the recursive walk took a collection (two levels) or a Feature
// per host frame and answered nests past 10000 levels on a default host
// stack; no value it answered there is refused. A value nested deeper is
// refused as a `JsonDepthError` `JO2001`, and one the walk follows into a
// cycle as a `JsonCycleError` `JO2002` located at the member that closes
// it — the pointer `locateCycle` answers, and the one `equalsJson` names
// for the same value. A cycle is searched for only once the bound is reached, so
// a geometry pays a depth comparison per container it walks into.

import { haversineDistance, lineLength, EARTH_RADIUS } from './distance.js';
import { sphericalRingArea, pointInPolygon, isRingClosed } from './ring.js';
import { GEOJSON_WALK_DEPTH_CEILING, WALK_CEILING, walkRefusal } from '../walk.js';

// What the traversal cannot do with a value past the bound, as its
// refusals say it.
const GEO_VERB = 'walked as GeoJSON';

/**
 * The traversal's refusal of `value` once a walk reached its bound.
 * @param {any} value - The value the walk started from
 * @returns {Error}
 */
function geoRefusal(value) {
  return walkRefusal(GEO_VERB, [value], undefined, GEOJSON_WALK_DEPTH_CEILING);
}

// The nesting walked on the host's call stack, the fast path every
// ordinary value takes.
const RECURSIVE_GEO_DEPTH = 256;

/**
 * Whether a value looks like a bare position: an array of at least two
 * numbers. Finiteness is not judged here: {@link bboxOf} answers null for
 * a non-finite position, and the writer refuses one.
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
 * @throws {CodedError} `JO2001` for a Feature nested in Features past
 *   100000 levels, `JO2002` for one that holds itself
 */
export function geometryOf(value) {
  let geometry = value;
  // a Feature's geometry may be a Feature: followed in a loop, to the bound
  for (let depth = 1; ; depth++) {
    if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry))
      return null;
    if (depth > GEOJSON_WALK_DEPTH_CEILING)
      throw geoRefusal(value);
    if (geometry.type !== 'Feature')
      return typeof geometry.type === 'string' && geometry.type !== 'FeatureCollection'
        ? geometry
        : null;
    geometry = geometry.geometry;
  }
}

/**
 * Call `visit(position)` for every position in a GeoJSON value, in
 * document order. Accepts a bare position, a geometry, a Feature, a
 * FeatureCollection or a GeometryCollection.
 * @param {any} value
 * @param {(position: number[]) => void} visit
 * @throws {CodedError} `JO2001` past 100000 levels of nesting, `JO2002`
 *   on a cycle the walk follows
 */
export function eachPosition(value, visit) {
  try {
    eachPositionAt(value, visit, 1);
  }
  catch (error) {
    throw error === WALK_CEILING ? geoRefusal(value) : error;
  }
}

/**
 * {@link eachPosition} for a value `depth` containers down from the root.
 * @param {any} value
 * @param {(position: number[]) => void} visit
 * @param {number} depth
 */
function eachPositionAt(value, visit, depth) {
  if (isPosition(value)) {
    visit(/** @type {number[]} */(value));
    return;
  }
  if (value === null || typeof value !== 'object')
    return;
  if (depth > RECURSIVE_GEO_DEPTH) {
    eachPositionWalk(value, visit, depth);
    return;
  }
  if (Array.isArray(value)) { // a nest of coordinates
    // a ring or line is an array OF positions, which is the overwhelming
    // majority of what this walks; classifying each member here saves a
    // call frame and a re-entry per vertex
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (isPosition(item))
        visit(item);
      else
        eachPositionAt(item, visit, depth + 1);
    }
    return;
  }
  if (value.type === 'FeatureCollection') {
    const features = value.features;
    if (Array.isArray(features)) {
      for (let i = 0; i < features.length; i++)
        eachPositionAt(features[i], visit, depth + 2);
    }
    return;
  }
  if (value.type === 'Feature') {
    eachPositionAt(value.geometry, visit, depth + 1);
    return;
  }
  if (value.type === 'GeometryCollection') {
    const geometries = value.geometries;
    if (Array.isArray(geometries)) {
      for (let i = 0; i < geometries.length; i++)
        eachPositionAt(geometries[i], visit, depth + 2);
    }
    return;
  }
  eachPositionAt(value.coordinates, visit, depth + 1);
}

/**
 * {@link eachPosition} for a container `depth` levels down, on an
 * explicit stack of the lists still being walked, so the nesting it
 * reaches is not the host's call stack; a container past
 * `GEOJSON_WALK_DEPTH_CEILING` throws `WALK_CEILING`.
 * @param {object} value - An array or object, not a position
 * @param {(position: number[]) => void} visit
 * @param {number} depth
 */
function eachPositionWalk(value, visit, depth) {
  /** @type {{ items: any[], at: number, depth: number }[]} */
  const lists = [];
  /** @type {any} */
  let next = value;
  let level = depth;
  for (;;) {
    if (next !== null && typeof next === 'object') {
      if (level > GEOJSON_WALK_DEPTH_CEILING)
        throw WALK_CEILING;
      if (isPosition(next))
        visit(next);
      else if (Array.isArray(next))
        lists.push({ items: next, at: 0, depth: level + 1 });
      else if (next.type === 'FeatureCollection') {
        if (Array.isArray(next.features))
          lists.push({ items: next.features, at: 0, depth: level + 2 });
      }
      else if (next.type === 'GeometryCollection') {
        if (Array.isArray(next.geometries))
          lists.push({ items: next.geometries, at: 0, depth: level + 2 });
      }
      else {
        // a Feature's geometry, or a geometry's coordinates: one member
        next = next.type === 'Feature' ? next.geometry : next.coordinates;
        level++;
        continue;
      }
    }
    // on to the next item of the innermost list not yet finished
    for (;;) {
      if (lists.length === 0)
        return;
      const list = lists[lists.length - 1];
      if (list.at < list.items.length) {
        next = list.items[list.at++];
        level = list.depth;
        break;
      }
      lists.pop();
    }
  }
}

/**
 * The bounding box of any GeoJSON value, as `[west, south, east, north]`.
 * Null when the value contains no positions, and null when any position
 * it walks is non-finite — the rule `bboxOfPositions` states, for the
 * same reason: a box that does not bound its input is worse than no
 * box.
 *
 * A `bbox` member already present on the value is ignored: it is an
 * optimization the producer may have got wrong, and recomputing is the
 * only way to be sure.
 *
 * @param {any} value
 * @returns {number[] | null}
 */
export function bboxOf(value) {
  // four scalars rather than a box per position: the obvious spelling
  // (union a fresh [x,y,x,y] into an accumulator) allocates twice for
  // every vertex, which on a 2000-vertex ring is 4000 short-lived arrays
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let seen = false;
  let bounded = true;
  eachPosition(value, (p) => {
    const x = p[0];
    const y = p[1];
    seen = true;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      bounded = false;
      return;
    }
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  });
  return seen && bounded ? [west, south, east, north] : null;
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

// What a measurement's recursion throws past `RECURSIVE_GEO_DEPTH`
// collections or Features: the measurement starts again on
// `foldGeometries`, which walks the value on its own stack, to the bound.
const RECURSION_TOO_DEEP = Object.freeze({ reached: RECURSIVE_GEO_DEPTH });

/**
 * {@link geometryOf} for a measurement's recursion: a Feature in more
 * Features than `RECURSIVE_GEO_DEPTH` throws `RECURSION_TOO_DEEP`.
 * @param {any} value
 * @returns {any}
 */
function nearGeometryOf(value) {
  let geometry = value;
  for (let depth = 0; geometry !== null && typeof geometry === 'object' && !Array.isArray(geometry)
    && geometry.type === 'Feature'; depth++) {
    if (depth === RECURSIVE_GEO_DEPTH)
      throw RECURSION_TOO_DEEP;
    geometry = geometry.geometry;
  }
  return geometryOf(geometry);
}

// The folds of the measurements, each in its own function: a closure over
// a measurement's arguments would allocate a context on every call of the
// function that creates it.

/** @param {any} value @param {number} radius @returns {number} */
function foldArea(value, radius) {
  return foldGeometries(value, (inner) => areaAt(inner, radius, 1), add, 0);
}

/** @param {any} value @param {number} radius @returns {number} */
function foldLength(value, radius) {
  return foldGeometries(value, (inner) => lengthAt(inner, radius, 1), add, 0);
}

/** @param {any} value @param {number} lon @param {number} lat @returns {boolean} */
function foldContains(value, lon, lat) {
  return foldGeometries(value, (inner) => containsAt(inner, lon, lat, 1), either, false, isTrue);
}

/** @param {any} value @returns {boolean} */
function foldRingsClosed(value) {
  return foldGeometries(value, (inner) => ringsClosedAt(inner, 1), both, true, isFalse);
}

/** @param {number} sum @param {number} part */
const add = (sum, part) => sum + part;
/** @param {boolean} any @param {boolean} part */
const either = (any, part) => any || part;
/** @param {boolean} all @param {boolean} part */
const both = (all, part) => all && part;
/** @param {boolean} answer */
const isTrue = (answer) => answer;
/** @param {boolean} answer */
const isFalse = (answer) => !answer;

/**
 * The measurement of every geometry a value holds, joined in document
 * order: a FeatureCollection's features, a Feature's geometry and a
 * GeometryCollection's geometries are walked, each collection's parts
 * joined from `none` before its total joins the one around it, so a
 * sum adds exactly as nested loops would. Anything that is not a
 * geometry adds `none`; a Feature's geometry that is a FeatureCollection
 * is not a geometry ({@link geometryOf}). A collection's members are
 * iterated as `for...of` iterates them.
 *
 * The walk keeps its own stack, to the bound the module states.
 * @template T
 * @param {any} value
 * @param {(geometry: any) => T} measure - for a geometry that is not a
 *   collection
 * @param {(total: T, part: T) => T} join
 * @param {T} none - the measurement of nothing
 * @param {(total: T) => boolean} [settled] - whether a total already
 *   decides the answer, which then stops the walk
 * @returns {T}
 */
function foldGeometries(value, measure, join, none, settled = undefined) {
  /** @type {{ list: any, at: number, items: Iterator<any> | null, total: T, depth: number }[]} */
  const open = [];
  /** @type {any} */
  let next = value;
  let depth = 1;
  for (;;) {
    // `next` is measured, or opens the collection it is
    /** @type {any} */
    let items = null;
    let part = none;
    if (next !== null && typeof next === 'object') {
      if (depth > GEOJSON_WALK_DEPTH_CEILING)
        throw geoRefusal(value);
      if (next.type === 'FeatureCollection')
        items = next.features ?? [];
      else {
        // a Feature's geometry, followed to the geometry it holds
        let geometry = next;
        while (geometry !== null && typeof geometry === 'object' && !Array.isArray(geometry)
          && geometry.type === 'Feature') {
          geometry = geometry.geometry;
          depth++;
          if (depth > GEOJSON_WALK_DEPTH_CEILING && geometry !== null && typeof geometry === 'object')
            throw geoRefusal(value);
        }
        geometry = geometryOf(geometry);
        if (geometry !== null) {
          if (geometry.type === 'GeometryCollection')
            items = geometry.geometries ?? [];
          else
            part = measure(geometry);
        }
      }
    }
    if (items !== null) {
      // an array is read by index; anything else as `for...of` reads it
      const iterated = Array.isArray(items) ? null : items[Symbol.iterator]();
      open.push({ list: items, at: 0, items: iterated, total: none, depth: depth + 2 });
    }
    else if (open.length === 0)
      return part;
    else {
      const inner = open[open.length - 1];
      inner.total = join(inner.total, part);
    }
    // on to the next member, closing every collection it finishes
    for (;;) {
      const inner = open[open.length - 1];
      if (settled !== undefined && settled(inner.total))
        return inner.total;
      if (inner.items === null) {
        if (inner.at < inner.list.length) {
          next = inner.list[inner.at++];
          depth = inner.depth;
          break;
        }
      }
      else {
        const step = inner.items.next();
        if (!step.done) {
          next = step.value;
          depth = inner.depth;
          break;
        }
      }
      open.pop();
      if (open.length === 0)
        return inner.total;
      const outer = open[open.length - 1];
      outer.total = join(outer.total, inner.total);
    }
  }
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
  try {
    return areaAt(value, radius, 1);
  }
  catch (error) {
    if (error !== RECURSION_TOO_DEEP)
      throw error;
    return foldArea(value, radius);
  }
}

/**
 * {@link geometryArea} for a value `depth` collections down, on the host's
 * stack, to `RECURSIVE_GEO_DEPTH`.
 * @param {any} value
 * @param {number} radius
 * @param {number} depth
 * @returns {number}
 */
function areaAt(value, radius, depth) {
  if (value === null || typeof value !== 'object')
    return 0;
  if (depth > RECURSIVE_GEO_DEPTH)
    throw RECURSION_TOO_DEEP;
  if (value.type === 'FeatureCollection') {
    let sum = 0;
    for (const feature of value.features ?? [])
      sum += areaAt(feature, radius, depth + 1);
    return sum;
  }
  const geometry = nearGeometryOf(value);
  if (geometry === null)
    return 0;
  if (geometry.type === 'GeometryCollection') {
    let sum = 0;
    for (const inner of geometry.geometries ?? [])
      sum += areaAt(inner, radius, depth + 1);
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
  try {
    return lengthAt(value, radius, 1);
  }
  catch (error) {
    if (error !== RECURSION_TOO_DEEP)
      throw error;
    return foldLength(value, radius);
  }
}

/**
 * {@link geometryLength} for a value `depth` collections down, on the
 * host's stack, to `RECURSIVE_GEO_DEPTH`.
 * @param {any} value
 * @param {number} radius
 * @param {number} depth
 * @returns {number}
 */
function lengthAt(value, radius, depth) {
  if (value === null || typeof value !== 'object')
    return 0;
  if (depth > RECURSIVE_GEO_DEPTH)
    throw RECURSION_TOO_DEEP;
  if (value.type === 'FeatureCollection') {
    let sum = 0;
    for (const feature of value.features ?? [])
      sum += lengthAt(feature, radius, depth + 1);
    return sum;
  }
  const geometry = nearGeometryOf(value);
  if (geometry === null)
    return 0;
  const { type, coordinates } = geometry;
  if (type === 'GeometryCollection') {
    let sum = 0;
    for (const inner of geometry.geometries ?? [])
      sum += lengthAt(inner, radius, depth + 1);
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
  // typed accumulators, not closure variables: a captured `sum += p[0]`
  // writes a boxed heap number per vertex, and this is two of those per
  // vertex on a walk whose other work is four comparisons
  const acc = new Float64Array(3);
  eachPosition(value, (p) => {
    acc[0] += p[0];
    acc[1] += p[1];
    acc[2]++;
  });
  return acc[2] === 0 ? null : [acc[0] / acc[2], acc[1] / acc[2]];
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
  try {
    return containsAt(value, lon, lat, 1);
  }
  catch (error) {
    if (error !== RECURSION_TOO_DEEP)
      throw error;
    return foldContains(value, lon, lat);
  }
}

/**
 * {@link containsPosition} for a value `depth` collections down, on the
 * host's stack, to `RECURSIVE_GEO_DEPTH`.
 * @param {any} value
 * @param {number} lon
 * @param {number} lat
 * @param {number} depth
 * @returns {boolean}
 */
function containsAt(value, lon, lat, depth) {
  if (value === null || typeof value !== 'object')
    return false;
  if (depth > RECURSIVE_GEO_DEPTH)
    throw RECURSION_TOO_DEEP;
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features ?? []) {
      if (containsAt(feature, lon, lat, depth + 1))
        return true;
    }
    return false;
  }
  const geometry = nearGeometryOf(value);
  if (geometry === null)
    return false;
  if (geometry.type === 'GeometryCollection') {
    for (const inner of geometry.geometries ?? []) {
      if (containsAt(inner, lon, lat, depth + 1))
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
  try {
    return ringsClosedAt(value, 1);
  }
  catch (error) {
    if (error !== RECURSION_TOO_DEEP)
      throw error;
    return foldRingsClosed(value);
  }
}

/**
 * {@link ringsClosed} for a value `depth` collections down, on the host's
 * stack, to `RECURSIVE_GEO_DEPTH`.
 * @param {any} value
 * @param {number} depth
 * @returns {boolean}
 */
function ringsClosedAt(value, depth) {
  if (depth > RECURSIVE_GEO_DEPTH)
    throw RECURSION_TOO_DEEP;
  const geometry = nearGeometryOf(value);
  if (value !== null && typeof value === 'object' && value.type === 'FeatureCollection') {
    for (const feature of value.features ?? []) {
      if (!ringsClosedAt(feature, depth + 1))
        return false;
    }
    return true;
  }
  if (geometry === null)
    return true;
  if (geometry.type === 'GeometryCollection') {
    for (const inner of geometry.geometries ?? []) {
      if (!ringsClosedAt(inner, depth + 1))
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

//#endregion
