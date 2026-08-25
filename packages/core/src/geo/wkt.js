//@ts-check

//#region Well-Known Text
// WKT (ISO 19125 / OGC Simple Features) is the text encoding every
// spatial database speaks, and this module is the round trip between it
// and the suite's representation, which is GeoJSON: `wktToGeoJson`
// parses, `geoJsonToWkt` writes, and `isValidWkt` answers yes-or-no for
// a `format` that only needs the judgment.
//
// **There is one grammar walk and two entry points.** Every scan
// function takes a sink: absent, it validates and allocates nothing;
// present, it appends the value it just recognized. The `wkt` format
// tester runs per value in the validator and per keystroke in the form
// layer, so making it build a geometry to answer a boolean would be a
// regression — and two hand-maintained grammars for one syntax would
// drift. The differential test over the committed corpus asserts the
// two entry points accept exactly the same language.
//
// The grammar is validated strictly: the seven geometry tags and only
// those, an optional Z/M/ZM dimension modifier, `EMPTY` or a
// parenthesized body, and a consistent coordinate count per geometry.
// The dimension rule follows the field rather than the letter of SFA:
// an unmodified tag accepts 2 or 3 coordinates per point (PostGIS reads
// `POINT(1 2 3)` as 3D), `Z` and `M` require exactly 3, `ZM` exactly 4
// — but whichever count the first point establishes, every following
// point must match. Polygon rings must close and carry at least four
// points, as the spec requires. No leading or trailing text is
// tolerated: a format that trims would accept strings a consumer then
// fails on. A GEOMETRYCOLLECTION nests at most eight deep — the bound
// the GeoJSON value gate applies — so hostile nesting is refused, never
// recursed into.
//
// Parsing answers what the text says and judges nothing else: a
// coordinate outside the WGS 84 bounds parses, and `isValidGeoJson` is
// the value gate — a parser that also judged would report the same
// defect twice and would make the two entry points disagree.

import {
  isAsciiLetterCode,
  isDigitCode,
  isWhitespaceCode,
} from '../scan.js';

import { eachPosition, geometryOf, isPosition } from './geojson.js';

// character codes
const LPAREN = 0x28;
const RPAREN = 0x29;
const COMMA = 0x2C;
const PLUS = 0x2B;
const MINUS = 0x2D;
const DOT = 0x2E;

/**
 * The closed tag map, read direction: the GeoJSON type a WKT tag names,
 * or null for anything else. Consulted before the body is scanned, so
 * an unknown tag is refused whether it carries a body or `EMPTY`.
 */
function geoJsonTypeOf(tag) {
  switch (tag) {
    case 'POINT': return 'Point';
    case 'LINESTRING': return 'LineString';
    case 'POLYGON': return 'Polygon';
    case 'MULTIPOINT': return 'MultiPoint';
    case 'MULTILINESTRING': return 'MultiLineString';
    case 'MULTIPOLYGON': return 'MultiPolygon';
    case 'GEOMETRYCOLLECTION': return 'GeometryCollection';
    default: return null;
  }
}

function skipWs(text, at) {
  while (at < text.length && isWhitespaceCode(text.charCodeAt(at)))
    at++;
  return at;
}

/** Read a run of letters, uppercased; returns [word, next] or null. */
function readWord(text, at) {
  let end = at;
  while (end < text.length && isAsciiLetterCode(text.charCodeAt(end)))
    end++;
  return end === at ? null : [text.slice(at, end).toUpperCase(), end];
}

/** Advance past one signed decimal number, or return -1. */
function scanNumber(text, at) {
  let i = at;
  const c = i < text.length ? text.charCodeAt(i) : 0;
  if (c === PLUS || c === MINUS)
    i++;
  let digits = 0;
  while (i < text.length && isDigitCode(text.charCodeAt(i))) {
    i++;
    digits++;
  }
  if (i < text.length && text.charCodeAt(i) === DOT) {
    i++;
    while (i < text.length && isDigitCode(text.charCodeAt(i))) {
      i++;
      digits++;
    }
  }
  if (digits === 0)
    return -1;
  const e = i < text.length ? text.charCodeAt(i) : 0;
  if (e === 0x45 || e === 0x65) { // E e
    let j = i + 1;
    const sign = j < text.length ? text.charCodeAt(j) : 0;
    if (sign === PLUS || sign === MINUS)
      j++;
    let exp = 0;
    while (j < text.length && isDigitCode(text.charCodeAt(j))) {
      j++;
      exp++;
    }
    if (exp === 0)
      return -1;
    i = j;
  }
  return i;
}

/**
 * One point: `dim.n` coordinates separated by whitespace. A zero `dim.n`
 * means the modifier allowed 2 or 3, and the first point decides which.
 * With a sink, appends the position; `dim.m` drops the trailing measure,
 * which is not an altitude and has no place in a GeoJSON position.
 * Returns the position after the point, or -1.
 */
function scanPoint(text, at, dim, out) {
  const from = skipWs(text, at);
  let i = scanNumber(text, from);
  if (i < 0)
    return -1;
  // `+ 0` normalizes -0 to 0: the two are the same point, but only one
  // of them survives JSON.stringify, so a parser producing -0 hands the
  // caller a value that changes the moment it is serialized
  const position = out === null ? null : [Number(text.slice(from, i)) + 0];
  let count = 1;
  for (;;) {
    const j = skipWs(text, i);
    if (j === i)
      break; // numbers must be whitespace-separated
    const k = scanNumber(text, j);
    if (k < 0)
      break;
    if (position !== null)
      position.push(Number(text.slice(j, k)) + 0);
    i = k;
    count++;
  }
  if (dim.n === 0) {
    if (count !== 2 && count !== 3)
      return -1;
    dim.n = count;
  }
  else if (count !== dim.n) {
    return -1;
  }
  if (position !== null) {
    if (dim.m)
      position.length = count - 1;
    out.push(position);
  }
  return i;
}

/**
 * A parenthesized, comma-separated list validated by `scanItem`, with at
 * least `min` items. `first` may record where each item's scan started —
 * the hook ring closure uses — and `out` is the sink each item appends
 * its own value to. Returns the position after `)`, or -1.
 */
function scanList(text, at, dim, min, scanItem, starts, out) {
  let i = skipWs(text, at);
  if (i >= text.length || text.charCodeAt(i) !== LPAREN)
    return -1;
  i++;
  let count = 0;
  for (;;) {
    const from = skipWs(text, i);
    if (starts !== null)
      starts.push(from);
    i = scanItem(text, from, dim, out);
    if (i < 0)
      return -1;
    count++;
    i = skipWs(text, i);
    const c = i < text.length ? text.charCodeAt(i) : 0;
    if (c === COMMA) {
      i++;
      continue;
    }
    if (c === RPAREN)
      return count >= min ? i + 1 : -1;
    return -1;
  }
}

/**
 * A list whose items belong to a nesting level of their own: the items
 * fill a fresh array and that array is what this level appends. Every
 * scan function appends exactly one value to its sink, so the caller
 * always reads its result at index 0.
 */
function scanNested(text, at, dim, min, scanItem, out) {
  const items = out === null ? null : [];
  const i = scanList(text, at, dim, min, scanItem, null, items);
  if (i < 0)
    return -1;
  if (out !== null)
    out.push(items);
  return i;
}

/** A point that may also be wrapped in its own parens (MULTIPOINT). */
function scanMultiPointItem(text, at, dim, out) {
  if (at < text.length && text.charCodeAt(at) === LPAREN) {
    const i = scanPoint(text, at + 1, dim, out);
    if (i < 0)
      return -1;
    const j = skipWs(text, i);
    return j < text.length && text.charCodeAt(j) === RPAREN ? j + 1 : -1;
  }
  return scanPoint(text, at, dim, out);
}

function scanLineStringBody(text, at, dim, out) {
  return scanNested(text, at, dim, 2, scanPoint, out);
}

/** A ring: four or more points, and the first equals the last. */
function scanRing(text, at, dim, out) {
  const starts = [];
  const ring = out === null ? null : [];
  const i = scanList(text, at, dim, 4, scanPoint, starts, ring);
  if (i < 0)
    return -1;
  // compare the first and last point textually by re-scanning both
  // spans: closure is a property of the coordinates the text carries,
  // including a measure the built ring does not keep
  const first = pointText(text, starts[0], dim);
  const last = pointText(text, starts[starts.length - 1], dim);
  if (first === null || first !== last)
    return -1;
  if (out !== null)
    out.push(ring);
  return i;
}

/** The point's coordinates as a normalized string, for closure tests. */
function pointText(text, at, dim) {
  const end = scanPoint(text, at, dim, null);
  if (end < 0)
    return null;
  const parts = text.slice(at, end).trim().split(/\s+/);
  return parts.map(Number).join(',');
}

function scanPolygonBody(text, at, dim, out) {
  return scanNested(text, at, dim, 1, scanRing, out);
}

/**
 * How deep a `GEOMETRYCOLLECTION` may nest. A nesting guard, not a spec
 * rule, and the same bound `isValidGeoJson` applies to a GeoJSON
 * `GeometryCollection`: unbounded recursion on hostile input is a
 * different problem than an unusual document, and a WKT string nested
 * deeper than the value gate admits could never become a valid value
 * anyway. Past the bound the walk answers "not WKT" — the same answer
 * both entry points give for any other malformed text — rather than
 * overflowing the stack.
 */
const MAX_COLLECTION_DEPTH = 8;

/** The collection nesting the walk is currently inside (one walk at a
 * time; reset at the entry point, so an aborted walk cannot poison the
 * next). */
let collectionDepth = 0;

/** A collection member is a whole tagged geometry, modifier and all. */
function scanCollectionItem(text, at, dim, out) {
  if (collectionDepth >= MAX_COLLECTION_DEPTH)
    return -1;
  collectionDepth += 1;
  const end = scanGeometry(text, at, out);
  collectionDepth -= 1;
  return end;
}

/**
 * One tagged geometry: `TAG [Z|M|ZM] (EMPTY | body)`. With a sink,
 * appends the GeoJSON geometry it recognized. Returns the position
 * after it, or -1.
 */
function scanGeometry(text, at, out) {
  const word = readWord(text, skipWs(text, at));
  if (word === null)
    return -1;
  const type = geoJsonTypeOf(word[0]);
  if (type === null)
    return -1;
  let i = word[1];
  // an exact count from the modifier, or 0 for "2 or 3, first point
  // decides"; `m` marks the trailing coordinate as a measure
  const dim = { n: 0, m: false };
  const mod = readWord(text, skipWs(text, i));
  if (mod !== null && (mod[0] === 'Z' || mod[0] === 'M' || mod[0] === 'ZM')) {
    dim.n = mod[0] === 'ZM' ? 4 : 3;
    dim.m = mod[0] !== 'Z';
    i = mod[1];
  }
  const empty = readWord(text, skipWs(text, i));
  if (empty !== null && empty[0] === 'EMPTY') {
    if (out !== null) {
      out.push(type === 'GeometryCollection'
        ? { type, geometries: [] }
        : { type, coordinates: [] });
    }
    return empty[1];
  }

  const parts = out === null ? null : [];
  let end;
  switch (type) {
    case 'Point': {
      const j = skipWs(text, i);
      if (j >= text.length || text.charCodeAt(j) !== LPAREN)
        return -1;
      const k = scanPoint(text, j + 1, dim, parts);
      if (k < 0)
        return -1;
      const l = skipWs(text, k);
      if (l >= text.length || text.charCodeAt(l) !== RPAREN)
        return -1;
      end = l + 1;
      break;
    }
    case 'LineString':
      end = scanLineStringBody(text, i, dim, parts);
      break;
    case 'Polygon':
      end = scanPolygonBody(text, i, dim, parts);
      break;
    case 'MultiPoint':
      end = scanNested(text, i, dim, 1, scanMultiPointItem, parts);
      break;
    case 'MultiLineString':
      end = scanNested(text, i, dim, 1, scanLineStringBody, parts);
      break;
    case 'MultiPolygon':
      end = scanNested(text, i, dim, 1, scanPolygonBody, parts);
      break;
    default: // GeometryCollection
      end = scanNested(text, i, dim, 1, scanCollectionItem, parts);
      break;
  }
  if (end < 0)
    return -1;
  if (out !== null) {
    out.push(type === 'GeometryCollection'
      ? { type, geometries: parts[0] }
      : { type, coordinates: parts[0] });
  }
  return end;
}

/**
 * The one entry into the walk: a null sink validates, an array sink
 * builds. Answers whether the whole string was a single geometry.
 */
function scanWkt(text, out) {
  if (typeof text !== 'string' || text.length === 0 || isWhitespaceCode(text.charCodeAt(0)))
    return false;
  collectionDepth = 0;
  return scanGeometry(text, 0, out) === text.length;
}

/**
 * Whether a string is a well-formed WKT geometry: one of the seven
 * tagged types, `EMPTY` or a body whose nesting matches the tag, a
 * coordinate count consistent with the `Z`/`M`/`ZM` modifier and with
 * itself, closed polygon rings, and nothing before or after.
 *
 * This is the non-allocating half of the walk {@link wktToGeoJson}
 * builds with, so the two accept exactly the same language.
 *
 * @param {string} text
 * @returns {boolean}
 * @example
 * isValidWkt('POINT (4.9041 52.3676)');                  // true
 * isValidWkt('POLYGON ((0 0, 4 0, 4 4, 0 0))');          // true (closed)
 * isValidWkt('POLYGON ((0 0, 4 0, 4 4, 1 1))');          // false (open ring)
 * isValidWkt('POINT Z (1 2)');                           // false (Z wants 3)
 * isValidWkt('LINESTRING (0 0, 1 1 1)');                 // false (mixed dimension)
 * isValidWkt('CIRCLE EMPTY');                            // false (not one of the seven)
 */
export function isValidWkt(text) {
  return scanWkt(text, null);
}

/**
 * The GeoJSON geometry a WKT string names, or `null` when the text is
 * not well-formed WKT — the same judgment {@link isValidWkt} makes,
 * from the same walk. `null` rather than a throw is the kernel's
 * posture for "no answer" (`bboxOf`, `centroidOf`, `geohashBounds` all
 * answer it), so no call site has to wrap this in a try.
 *
 * Three rules decide what a lenient parser would silently lose:
 *
 * - `EMPTY` becomes an empty coordinate array (`POINT EMPTY` →
 *   `{ type: 'Point', coordinates: [] }`), never `null`: unparseable
 *   and validly empty are different answers.
 * - The `M` measure is dropped and `Z` is kept. RFC 7946 §3.1.1 defines
 *   a position's third element as altitude, and a measure is not one —
 *   writing it there would be a lie. `POINT ZM (1 2 3 4)` → `[1, 2, 3]`,
 *   `POINT M (1 2 3)` → `[1, 2]`.
 * - Coordinate ranges are not judged. `POINT (999 999)` parses;
 *   `isValidGeoJson` is the value gate.
 *
 * @param {string} text
 * @returns {object | null}
 * @example
 * wktToGeoJson('POINT (4.9041 52.3676)');
 * // { type: 'Point', coordinates: [4.9041, 52.3676] }
 * wktToGeoJson('POLYGON ((0 0, 4 0, 4 4, 0 0))');
 * // { type: 'Polygon', coordinates: [[[0,0],[4,0],[4,4],[0,0]]] }
 * wktToGeoJson('POINT EMPTY');       // { type: 'Point', coordinates: [] }
 * wktToGeoJson('POLYGON ((0 0))');   // null
 */
export function wktToGeoJson(text) {
  const out = [];
  return scanWkt(text, out) ? out[0] : null;
}

/**
 * The closed tag map, write direction: the WKT tag each GeoJSON type
 * takes, the nesting depth of its body, and whether its leaf positions
 * are parenthesized. ISO 19125 spells a `<point text>` with its own
 * parentheses — which POINT and MULTIPOINT carry and a position inside
 * a line or ring does not.
 */
const WKT_BODY = {
  Point: { tag: 'POINT', depth: 0, wrap: true },
  LineString: { tag: 'LINESTRING', depth: 1, wrap: false },
  Polygon: { tag: 'POLYGON', depth: 2, wrap: false },
  MultiPoint: { tag: 'MULTIPOINT', depth: 1, wrap: true },
  MultiLineString: { tag: 'MULTILINESTRING', depth: 2, wrap: false },
  MultiPolygon: { tag: 'MULTIPOLYGON', depth: 3, wrap: false },
};

/**
 * One position. `String(n)` is the shortest round-tripping spelling and
 * the one JSON.stringify uses, so a coordinate written here parses back
 * to the same number; a fixed precision would move it.
 */
function writePosition(position, hasZ) {
  if (!Array.isArray(position) || position.length < 2)
    return null;
  const x = position[0];
  const y = position[1];
  if (typeof x !== 'number' || !Number.isFinite(x))
    return null;
  if (typeof y !== 'number' || !Number.isFinite(y))
    return null;
  if (!hasZ)
    return `${x} ${y}`;
  const z = position[2];
  if (typeof z !== 'number' || !Number.isFinite(z))
    return null;
  return `${x} ${y} ${z}`;
}

/** A coordinate nest `depth` levels deep, or null if it cannot be written. */
function writeCoordinates(value, depth, hasZ, wrap) {
  if (depth === 0) {
    const text = writePosition(value, hasZ);
    if (text === null)
      return null;
    return wrap ? `(${text})` : text;
  }
  if (!Array.isArray(value) || value.length === 0)
    return null;
  const parts = [];
  for (let i = 0; i < value.length; i++) {
    const text = writeCoordinates(value[i], depth - 1, hasZ, wrap);
    if (text === null)
      return null;
    parts.push(text);
  }
  return `(${parts.join(', ')})`;
}

/** Whether every position of a value carries a third element. */
function isEvery3D(value) {
  let seen = false;
  let all = true;
  eachPosition(value, (position) => {
    seen = true;
    if (position.length < 3)
      all = false;
  });
  return seen && all;
}

/** One tagged geometry, modifier and all, or null. */
function writeGeometry(geometry, dim) {
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry))
    return null;
  const type = geometry.type;
  if (type === 'GeometryCollection') {
    const geometries = geometry.geometries;
    if (!Array.isArray(geometries))
      return null;
    if (geometries.length === 0)
      return 'GEOMETRYCOLLECTION EMPTY';
    const parts = [];
    for (let i = 0; i < geometries.length; i++) {
      // each member carries its own modifier, which is the only place
      // WKT lets the dimension change inside one value
      const text = writeGeometry(geometries[i], dim);
      if (text === null)
        return null;
      parts.push(text);
    }
    return `GEOMETRYCOLLECTION (${parts.join(', ')})`;
  }
  if (typeof type !== 'string' || !Object.hasOwn(WKT_BODY, type))
    return null;
  const body = WKT_BODY[type];
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates))
    return null;
  if (coordinates.length === 0)
    return `${body.tag} EMPTY`;
  const hasZ = dim === 3 && isEvery3D(geometry);
  const text = writeCoordinates(coordinates, body.depth, hasZ, body.wrap);
  return text === null ? null : `${body.tag}${hasZ ? ' Z' : ''} ${text}`;
}

/**
 * The geometry a value carries, following the traversal layer's
 * unwrapping posture: a Feature yields its geometry, a
 * FeatureCollection a GeometryCollection of its features', a bare
 * position a Point.
 */
function geometryToWrite(value) {
  if (isPosition(value))
    return { type: 'Point', coordinates: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  if (value.type === 'FeatureCollection') {
    const features = Array.isArray(value.features) ? value.features : [];
    const geometries = [];
    for (let i = 0; i < features.length; i++) {
      // a Feature with a null geometry is a located-nowhere record;
      // WKT cannot say that, so it contributes nothing to the collection
      const inner = geometryToWrite(features[i]);
      if (inner !== null)
        geometries.push(inner);
    }
    return { type: 'GeometryCollection', geometries };
  }
  return geometryOf(value);
}

/**
 * A GeoJSON value as a WKT string, or `null` for a value with no
 * geometry to write. Accepts what the traversal layer accepts: a bare
 * position, a geometry, a Feature or a FeatureCollection.
 *
 * `options.dim` is 2 (the default) or 3. At 3, a geometry whose every
 * position carries a third element is written with a `Z` modifier;
 * anything else is written 2D with the third elements dropped, because
 * one WKT geometry carries one modifier for all of its coordinates. The
 * decision is made per tagged geometry, so a GeometryCollection may mix
 * 2D and 3D members — each writes its own modifier. Invalid WKT is
 * never emitted.
 *
 * A non-finite coordinate yields `null`: a value that cannot be written
 * is not written approximately.
 *
 * @param {any} value
 * @param {{ dim?: number }} [options]
 * @returns {string | null}
 * @example
 * geoJsonToWkt({ type: 'Point', coordinates: [4.9041, 52.3676] });
 * // 'POINT (4.9041 52.3676)'
 * geoJsonToWkt([4.9041, 52.3676]);          // 'POINT (4.9041 52.3676)'
 * geoJsonToWkt({ type: 'Point', coordinates: [] });    // 'POINT EMPTY'
 * geoJsonToWkt({ type: 'Point', coordinates: [1, 2, 3] }, { dim: 3 });
 * // 'POINT Z (1 2 3)'
 * geoJsonToWkt({ type: 'Point', coordinates: [NaN, 2] });         // null
 */
export function geoJsonToWkt(value, options = {}) {
  const geometry = geometryToWrite(value);
  if (geometry === null)
    return null;
  return writeGeometry(geometry, options.dim === 3 ? 3 : 2);
}

//#endregion
