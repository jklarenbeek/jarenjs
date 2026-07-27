//@ts-check

//#region GeoJSON validity
// The one-call structural judgment over a GeoJSON value: the boolean
// twin of the schema artifacts in `@jarenjs/json`. The portable
// meta-schema states the same grammar declaratively and reports *where*
// a document fails; the Jaren variant adds winding through `$query`.
// This predicate exists for the callers that only need yes-or-no — a
// `format` tester, a guard before an expensive walk — and it includes
// the invariant the portable schema provably cannot express: that every
// linear ring closes.
//
// The traversal helpers in geojson.js stay judgment-free on purpose (a
// measurement that also validated would report the same defect twice);
// this module is where the judgment lives.

import { isRingClosed } from './ring.js';

/**
 * A position: an array of 2 or 3 finite numbers, longitude in
 * `[-180, 180]` and latitude in `[-90, 90]` — the same bounds the
 * meta-schema states, valid because RFC 7946 fixes the reference system
 * to WGS 84.
 */
function isStrictPosition(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3)
    return false;
  const lon = value[0];
  const lat = value[1];
  if (typeof lon !== 'number' || !(lon >= -180 && lon <= 180))
    return false;
  if (typeof lat !== 'number' || !(lat >= -90 && lat <= 90))
    return false;
  return value.length === 2
    || (typeof value[2] === 'number' && Number.isFinite(value[2]));
}

function everyPosition(list) {
  if (!Array.isArray(list))
    return false;
  for (let i = 0; i < list.length; i++) {
    if (!isStrictPosition(list[i]))
      return false;
  }
  return true;
}

/** A line: two or more positions. */
function isLine(list) {
  return Array.isArray(list) && list.length >= 2 && everyPosition(list);
}

/** A linear ring: four or more positions, first equal to last. */
function isRing(list) {
  return Array.isArray(list) && list.length >= 4 && everyPosition(list)
    && isRingClosed(list);
}

function everyOf(list, test) {
  if (!Array.isArray(list))
    return false;
  for (let i = 0; i < list.length; i++) {
    if (!test(list[i]))
      return false;
  }
  return true;
}

function isRings(list) {
  return everyOf(list, isRing);
}

function isGeometryValue(value, depth) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  switch (value.type) {
    case 'Point':
      return isStrictPosition(value.coordinates);
    case 'MultiPoint':
      return everyPosition(value.coordinates);
    case 'LineString':
      return isLine(value.coordinates);
    case 'MultiLineString':
      return everyOf(value.coordinates, isLine);
    case 'Polygon':
      return isRings(value.coordinates);
    case 'MultiPolygon':
      return everyOf(value.coordinates, isRings);
    case 'GeometryCollection':
      // a nesting guard, not a spec rule: RFC 7946 merely discourages
      // nested collections, but unbounded recursion on hostile input is
      // a different problem than an unusual document
      return depth < 8
        && everyOf(value.geometries, (g) => isGeometryValue(g, depth + 1));
    default:
      return false;
  }
}

/**
 * Whether a value is a structurally valid GeoJSON object: one of the
 * seven geometry types, a Feature, or a FeatureCollection, with the
 * coordinate nesting its `type` requires, positions of 2 or 3 numbers
 * inside the WGS 84 bounds, and **every linear ring closed** — the
 * invariant a JSON Schema cannot state.
 *
 * This is the shallow twin of the schema artifacts in `@jarenjs/json`:
 * it answers yes or no in one call, where the meta-schema reports what
 * failed and where, and the Jaren-extended variant also checks winding.
 * Foreign members and a `bbox` are ignored rather than judged, exactly
 * as the meta-schema leaves them open.
 *
 * @param {any} value
 * @returns {boolean}
 * @example
 * isValidGeoJson({ type: 'Point', coordinates: [4.9, 52.4] });        // true
 * isValidGeoJson({ type: 'Polygon',
 *   coordinates: [[[0,0],[1,0],[1,1],[0,0]]] });                      // true
 * isValidGeoJson({ type: 'Polygon',
 *   coordinates: [[[0,0],[1,0],[1,1],[2,2]]] });                      // false (open ring)
 * isValidGeoJson({ type: 'Point', coordinates: [52.4, 4.9, 0, 0] });  // false (4 axes)
 */
export function isValidGeoJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  if (value.type === 'Feature') {
    // `properties` and `geometry` are required members; both may be null
    if (!('properties' in value) || !('geometry' in value))
      return false;
    if (value.properties !== null
      && (typeof value.properties !== 'object' || Array.isArray(value.properties)))
      return false;
    return value.geometry === null || isGeometryValue(value.geometry, 0);
  }
  if (value.type === 'FeatureCollection') {
    return everyOf(value.features, (f) => f !== null && typeof f === 'object'
      && !Array.isArray(f) && f.type === 'Feature' && isValidGeoJson(f));
  }
  return isGeometryValue(value, 0);
}

//#endregion
