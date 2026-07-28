//@ts-check

//#region Well-Known Text
// A validity tester for WKT (ISO 19125 / OGC Simple Features), the text
// encoding every spatial database speaks. Nothing here *parses into* a
// geometry — the suite's representation is GeoJSON, and a WKT string in
// a JSON document is interchange data passing through — but a schema can
// still assert that such a string is well-formed, which is what a
// `format` needs: a plain predicate over the string itself.
//
// The grammar is validated strictly: the seven geometry tags, an
// optional Z/M/ZM dimension modifier, `EMPTY` or a parenthesized body,
// and a consistent coordinate count per geometry. The dimension rule
// follows the field rather than the letter of SFA: an unmodified tag
// accepts 2 or 3 coordinates per point (PostGIS reads `POINT(1 2 3)` as
// 3D), `Z` and `M` require exactly 3, `ZM` exactly 4 — but whichever
// count the first point establishes, every following point must match.
// Polygon rings must close and carry at least four points, as the spec
// requires. No leading or trailing text is tolerated: a format that
// trims would accept strings a consumer then fails on.

import {
  isAsciiLetterCode,
  isDigitCode,
  isWhitespaceCode,
} from '../scan.js';

// character codes
const LPAREN = 0x28;
const RPAREN = 0x29;
const COMMA = 0x2C;
const PLUS = 0x2B;
const MINUS = 0x2D;
const DOT = 0x2E;

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
 * Returns the position after the point, or -1.
 */
function scanPoint(text, at, dim) {
  let i = scanNumber(text, skipWs(text, at));
  if (i < 0)
    return -1;
  let count = 1;
  for (;;) {
    const j = skipWs(text, i);
    if (j === i)
      break; // numbers must be whitespace-separated
    const k = scanNumber(text, j);
    if (k < 0)
      break;
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
  return i;
}

/**
 * A parenthesized, comma-separated list validated by `scanItem`, with at
 * least `min` items. `first` may record where each item's scan started —
 * the hook ring closure uses. Returns the position after `)`, or -1.
 */
function scanList(text, at, dim, min, scanItem, starts) {
  let i = skipWs(text, at);
  if (i >= text.length || text.charCodeAt(i) !== LPAREN)
    return -1;
  i++;
  let count = 0;
  for (;;) {
    const from = skipWs(text, i);
    if (starts !== null)
      starts.push(from);
    i = scanItem(text, from, dim);
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

/** A point that may also be wrapped in its own parens (MULTIPOINT). */
function scanMultiPointItem(text, at, dim) {
  if (at < text.length && text.charCodeAt(at) === LPAREN) {
    const i = scanPoint(text, at + 1, dim);
    if (i < 0)
      return -1;
    const j = skipWs(text, i);
    return j < text.length && text.charCodeAt(j) === RPAREN ? j + 1 : -1;
  }
  return scanPoint(text, at, dim);
}

function scanLineStringBody(text, at, dim) {
  return scanList(text, at, dim, 2, scanPoint, null);
}

/** A ring: four or more points, and the first equals the last. */
function scanRing(text, at, dim) {
  const starts = [];
  const i = scanList(text, at, dim, 4, scanPoint, starts);
  if (i < 0)
    return -1;
  // compare the first and last point textually by re-scanning both spans
  const first = pointText(text, starts[0], dim);
  const last = pointText(text, starts[starts.length - 1], dim);
  return first !== null && first === last ? i : -1;
}

/** The point's coordinates as a normalized string, for closure tests. */
function pointText(text, at, dim) {
  const end = scanPoint(text, at, dim);
  if (end < 0)
    return null;
  const parts = text.slice(at, end).trim().split(/\s+/);
  return parts.map(Number).join(',');
}

function scanPolygonBody(text, at, dim) {
  return scanList(text, at, dim, 1, scanRing, null);
}

/**
 * One tagged geometry: `TAG [Z|M|ZM] (EMPTY | body)`. Returns the
 * position after it, or -1.
 */
function scanGeometry(text, at) {
  const word = readWord(text, skipWs(text, at));
  if (word === null)
    return -1;
  const [tag, afterTag] = word;
  let i = afterTag;
  // an exact count from the modifier, or 0 for "2 or 3, first point decides"
  const dim = { n: 0 };
  const mod = readWord(text, skipWs(text, i));
  if (mod !== null && (mod[0] === 'Z' || mod[0] === 'M' || mod[0] === 'ZM')) {
    dim.n = mod[0] === 'ZM' ? 4 : 3;
    i = mod[1];
  }
  const empty = readWord(text, skipWs(text, i));
  if (empty !== null && empty[0] === 'EMPTY')
    return empty[1];

  switch (tag) {
    case 'POINT': {
      const j = skipWs(text, i);
      if (j >= text.length || text.charCodeAt(j) !== LPAREN)
        return -1;
      const k = scanPoint(text, j + 1, dim);
      if (k < 0)
        return -1;
      const l = skipWs(text, k);
      return l < text.length && text.charCodeAt(l) === RPAREN ? l + 1 : -1;
    }
    case 'LINESTRING':
      return scanLineStringBody(text, i, dim);
    case 'POLYGON':
      return scanPolygonBody(text, i, dim);
    case 'MULTIPOINT':
      return scanList(text, i, dim, 1, scanMultiPointItem, null);
    case 'MULTILINESTRING':
      return scanList(text, i, dim, 1, scanLineStringBody, null);
    case 'MULTIPOLYGON':
      return scanList(text, i, dim, 1, scanPolygonBody, null);
    case 'GEOMETRYCOLLECTION':
      // members are whole tagged geometries with modifiers of their own
      return scanList(text, i, dim, 1, (t, a) => scanGeometry(t, a), null);
    default:
      return -1;
  }
}

/**
 * Whether a string is a well-formed WKT geometry: one of the seven
 * tagged types, `EMPTY` or a body whose nesting matches the tag, a
 * coordinate count consistent with the `Z`/`M`/`ZM` modifier and with
 * itself, closed polygon rings, and nothing before or after.
 *
 * @param {string} text
 * @returns {boolean}
 * @example
 * isValidWkt('POINT (4.9041 52.3676)');                  // true
 * isValidWkt('POLYGON ((0 0, 4 0, 4 4, 0 0))');          // true (closed)
 * isValidWkt('POLYGON ((0 0, 4 0, 4 4, 1 1))');          // false (open ring)
 * isValidWkt('POINT Z (1 2)');                           // false (Z wants 3)
 * isValidWkt('LINESTRING (0 0, 1 1 1)');                 // false (mixed dimension)
 */
export function isValidWkt(text) {
  if (typeof text !== 'string' || text.length === 0 || isWhitespaceCode(text.charCodeAt(0)))
    return false;
  return scanGeometry(text, 0) === text.length;
}

//#endregion
