//#region JSON Pointer (RFC 6901) + Relative JSON Pointer
// JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
// Relative JSON Pointer:
// https://datatracker.ietf.org/doc/html/draft-luff-relative-json-pointer-00
//
// This module implements JSON Pointer as a two-stage compiler, mirroring
// the JSONPath engine in path.js:
//
//   1. `parseJSONPointer` / `parseRelativeJSONPointer` - strict, single-pass
//      char-code parsers enforcing the full RFC 6901 / draft-luff grammar.
//   2. `compileJSONPointer` / `compileRelativeJSONPointer` /
//      `compileDataRef` - compile the parsed form into specialized getter
//      closures. All decisions (member name decoding, array index parsing,
//      absolute-vs-relative dispatch) are taken at compile time; resolution
//      allocates nothing and returns the shared `NOTHING` sentinel when the
//      pointer does not address a location.

import {
  CC_SLASH,
  CC_HASH,
  CC_TILDE,
  CC_0,
  CC_1,
  isDigitCode,
} from '@jarenjs/core/scan';

import { NOTHING } from './segments.js';

/**
 * Sentinel for the absence of a value, as distinct from the JSON value
 * `null`. This is the same sentinel as `JSONPATH_NOTHING` in path.js, so
 * pointer and path results can share checks.
 */
export const JSONPOINTER_NOTHING = NOTHING;

const hasOwn = Object.hasOwn;

/**
 * Error thrown when a (relative) JSON Pointer is not valid RFC 6901 /
 * draft-luff-relative-json-pointer syntax.
 */
export class JSONPointerSyntaxError extends SyntaxError {
  constructor(message, source, position) {
    super(`Invalid JSON Pointer: ${message} at position ${position} in '${source}'`);
    this.name = 'JSONPointerSyntaxError';
    this.source = source;
    this.position = position;
  }
}

//#region parsers

/**
 * Scan the segments of a pointer left to right, decoding `~0`/`~1`.
 * `pos` must sit on the first `/` of the pointer part (or at the end of
 * the source for an empty pointer). A `~` not followed by `0` or `1` is
 * a syntax error (RFC 6901 section 3).
 * @param {string} source - The pointer source text
 * @param {number} pos - Index of the first '/' of the pointer part
 * @returns {string[]} The decoded segments
 */
function scanSegments(source, pos) {
  const len = source.length;
  const segments = [];
  while (pos < len) {
    pos++; // consume '/'
    const start = pos;
    let decoded = null;
    let chunk = start;
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === CC_SLASH)
        break;
      if (c === CC_TILDE) {
        const d = pos + 1 < len ? source.charCodeAt(pos + 1) : -1;
        if (d === CC_0 || d === CC_1) {
          decoded = (decoded === null ? '' : decoded)
            + source.slice(chunk, pos)
            + (d === CC_0 ? '~' : '/');
          pos += 2;
          chunk = pos;
          continue;
        }
        throw new JSONPointerSyntaxError("expected '0' or '1' after '~'", source, pos);
      }
      pos++;
    }
    segments.push(decoded === null
      ? source.slice(start, pos)
      : decoded + source.slice(chunk, pos));
  }
  return segments;
}

/**
 * Parse a JSON Pointer strictly per RFC 6901 into its decoded segments.
 * @param {string} pointer - The JSON Pointer (e.g. `/store/book/0`)
 * @returns {string[]} Array of decoded reference tokens
 * @throws {JSONPointerSyntaxError} When the pointer violates the grammar
 */
export function parseJSONPointer(pointer) {
  if (typeof pointer !== 'string')
    throw new JSONPointerSyntaxError('pointer must be a string', String(pointer), 0);
  if (pointer.length === 0)
    return [];
  if (pointer.charCodeAt(0) !== CC_SLASH)
    throw new JSONPointerSyntaxError("a non-empty pointer must start with '/'", pointer, 0);
  return scanSegments(pointer, 0);
}

/**
 * A parsed Relative JSON Pointer (draft-luff-relative-json-pointer).
 * @typedef {Object} RelativeJsonPointer
 * @property {number} levels - Number of levels to ascend from the current location
 * @property {boolean} hash - True for the `#` form, which addresses the member name or array index itself
 * @property {string[]} segments - Decoded reference tokens applied after ascending
 */

/**
 * A compiled JSON Pointer: returns the value addressed in `root`, or the
 * `JSONPOINTER_NOTHING` sentinel when the pointer does not address a location.
 * @typedef {(root: any) => any} JsonPointerGetter
 */

/**
 * A compiled Relative JSON Pointer / data reference: resolves against the
 * RFC 6901 location `dataPath` inside `dataRoot`, returning the addressed
 * value or the `JSONPOINTER_NOTHING` sentinel.
 * @typedef {(dataRoot: any, dataPath: string) => any} RelativeJsonPointerResolver
 */

/**
 * Parse a Relative JSON Pointer strictly per
 * draft-luff-relative-json-pointer: a non-negative integer without
 * leading zeros, followed by `#` or a JSON Pointer.
 * @param {string} pointer - The relative pointer (e.g. `1/sibling`, `0#`)
 * @returns {RelativeJsonPointer} The parsed relative pointer
 * @throws {JSONPointerSyntaxError} When the pointer violates the grammar
 */
export function parseRelativeJSONPointer(pointer) {
  if (typeof pointer !== 'string')
    throw new JSONPointerSyntaxError('pointer must be a string', String(pointer), 0);
  const len = pointer.length;
  if (len === 0)
    throw new JSONPointerSyntaxError('empty relative pointer', pointer, 0);
  const first = pointer.charCodeAt(0);
  if (!isDigitCode(first))
    throw new JSONPointerSyntaxError('expected a non-negative integer', pointer, 0);
  let pos = 1;
  if (first === CC_0) {
    if (pos < len && isDigitCode(pointer.charCodeAt(pos)))
      throw new JSONPointerSyntaxError('leading zeros are not allowed', pointer, 0);
  }
  else {
    while (pos < len && isDigitCode(pointer.charCodeAt(pos)))
      pos++;
  }
  const levels = Number(pointer.slice(0, pos));
  if (!Number.isSafeInteger(levels))
    throw new JSONPointerSyntaxError('level count out of range', pointer, 0);
  if (pos === len)
    return { levels, hash: false, segments: [] };
  const c = pointer.charCodeAt(pos);
  if (c === CC_HASH) {
    if (pos + 1 !== len)
      throw new JSONPointerSyntaxError("'#' must end the pointer", pointer, pos + 1);
    return { levels, hash: true, segments: [] };
  }
  if (c !== CC_SLASH)
    throw new JSONPointerSyntaxError("expected '#' or a JSON Pointer after the level count", pointer, pos);
  return { levels, hash: false, segments: scanSegments(pointer, pos) };
}

//#endregion

//#region compiler

// Array indexes are bounded by the maximum array length (2^32 - 1), so a
// valid index has at most 10 digits and is strictly below 2^32 - 1.
const MAX_ARRAY_INDEX = 4294967294;

/**
 * Scan `source[start..end)` as an RFC 6901 array index: `0`, or a digit
 * sequence without leading zeros. Returns -1 when the range is not a
 * valid index (`-` is never a valid read index).
 */
function scanArrayIndex(source, start, end) {
  const digits = end - start;
  if (digits === 0 || digits > 10)
    return -1;
  const first = source.charCodeAt(start);
  if (!isDigitCode(first))
    return -1;
  if (first === CC_0)
    return digits === 1 ? 0 : -1;
  let index = first - CC_0;
  for (let i = start + 1; i < end; i++) {
    const c = source.charCodeAt(i);
    if (!isDigitCode(c))
      return -1;
    index = index * 10 + (c - CC_0);
  }
  return index <= MAX_ARRAY_INDEX ? index : -1;
}

/**
 * One pointer hop: an array is addressed by the pre-parsed index, an
 * object by the pre-decoded member name (own properties only), anything
 * else has no addressable children. RFC 6901 requires a segment like "2"
 * to address both `{"2": x}` members and array element 2 - one segment,
 * two pre-computed forms.
 */
function hop(v, name, index) {
  if (typeof v !== 'object' || v === null)
    return NOTHING;
  if (Array.isArray(v))
    return (index >= 0 && index < v.length) ? v[index] : NOTHING;
  return hasOwn(v, name) ? v[name] : NOTHING;
}

function getRoot(root) {
  return root;
}

/**
 * Compile decoded segments into a specialized getter, unrolled by
 * segment count like the validator's composition table.
 * @param {string[]} segments - Decoded reference tokens
 * @returns {(root: any) => any} getter returning the value or NOTHING
 */
function compileSegmentsGetter(segments) {
  const slen = segments.length;
  if (slen === 0)
    return getRoot;
  const name0 = segments[0];
  const index0 = scanArrayIndex(name0, 0, name0.length);
  if (slen === 1) {
    return function pointerGetter1(root) {
      return hop(root, name0, index0);
    };
  }
  const name1 = segments[1];
  const index1 = scanArrayIndex(name1, 0, name1.length);
  if (slen === 2) {
    return function pointerGetter2(root) {
      const v = hop(root, name0, index0);
      return v === NOTHING ? NOTHING : hop(v, name1, index1);
    };
  }
  const names = segments;
  const indexes = new Array(slen);
  for (let i = 0; i < slen; i++)
    indexes[i] = scanArrayIndex(segments[i], 0, segments[i].length);
  return function pointerGetterN(root) {
    let v = root;
    for (let i = 0; i < slen; i++) {
      v = hop(v, names[i], indexes[i]);
      if (v === NOTHING)
        return NOTHING;
    }
    return v;
  };
}

/**
 * Compile a JSON Pointer (RFC 6901) into a reusable getter.
 *
 * All decisions are taken at compile time: member names are pre-decoded,
 * array indexes pre-parsed, and the getter is specialized by segment
 * count. Resolution allocates nothing.
 *
 * @param {string} pointer - The JSON Pointer (e.g. `/store/book/0`)
 * @returns {JsonPointerGetter} getter returning the addressed value, or
 *   `JSONPOINTER_NOTHING` when the pointer does not address a location
 * @throws {JSONPointerSyntaxError} When the pointer is not valid RFC 6901
 * @example
 * const get = compileJSONPointer('/limits/min');
 * get({ limits: { min: 2 } }); // 2
 * get({}); // JSONPOINTER_NOTHING
 */
export function compileJSONPointer(pointer) {
  return compileSegmentsGetter(parseJSONPointer(pointer));
}

/**
 * Trim `levels` segments off the end of an RFC 6901 location path by
 * scanning backwards for the N-th '/'. Returns the exclusive end index
 * of the trimmed prefix, or -1 when `levels` exceeds the depth.
 */
function trimLevels(dataPath, levels) {
  let end = dataPath.length;
  for (let i = 0; i < levels; i++) {
    if (end === 0)
      return -1;
    end = dataPath.lastIndexOf('/', end - 1);
    if (end < 0)
      return -1;
  }
  return end;
}

/**
 * Decode `source[start..end)` where `tilde` is the position of the first
 * `~`. Lax decode: invalid escapes are kept literally (location paths are
 * machine-generated; this mirrors the historical decode).
 */
function decodeSegmentRange(source, start, end, tilde) {
  let out = source.slice(start, tilde);
  let pos = tilde;
  let chunk = tilde;
  while (pos < end) {
    if (source.charCodeAt(pos) === CC_TILDE) {
      const d = pos + 1 < end ? source.charCodeAt(pos + 1) : -1;
      if (d === CC_0 || d === CC_1) {
        out += source.slice(chunk, pos) + (d === CC_0 ? '~' : '/');
        pos += 2;
        chunk = pos;
        continue;
      }
    }
    pos++;
  }
  return out + source.slice(chunk, end);
}

/**
 * The last segment of `dataPath.slice(0, end)`, decoded lazily: the
 * common escape-free case allocates nothing beyond the result slice.
 * At the root (`end === 0`) the name of the location is `''`.
 */
function lastSegmentOf(dataPath, end) {
  if (end === 0)
    return '';
  const start = dataPath.lastIndexOf('/', end - 1) + 1;
  for (let i = start; i < end; i++) {
    if (dataPath.charCodeAt(i) === CC_TILDE)
      return decodeSegmentRange(dataPath, start, end, i);
  }
  return dataPath.slice(start, end);
}

/**
 * Walk `root` along the location path prefix `path.slice(0, end)`.
 * Segments are decoded lazily per hop (escape-free segments are sliced
 * directly; array indexes are scanned in place without allocating).
 */
function walkPointerPrefix(root, path, end) {
  let v = root;
  let pos = 0;
  while (pos < end) {
    pos++; // consume '/'
    const start = pos;
    let tilde = -1;
    while (pos < end) {
      const c = path.charCodeAt(pos);
      if (c === CC_SLASH)
        break;
      if (c === CC_TILDE && tilde < 0)
        tilde = pos;
      pos++;
    }
    if (typeof v !== 'object' || v === null)
      return NOTHING;
    if (Array.isArray(v)) {
      const index = scanArrayIndex(path, start, pos);
      if (index < 0 || index >= v.length)
        return NOTHING;
      v = v[index];
    }
    else {
      const name = tilde < 0 ? path.slice(start, pos) : decodeSegmentRange(path, start, pos, tilde);
      if (!hasOwn(v, name))
        return NOTHING;
      v = v[name];
    }
  }
  return v;
}

/**
 * Compile a Relative JSON Pointer into a reusable resolver.
 *
 * The relative part (level count, `#` form, trailing segments) compiles
 * once; per call only `dataPath` - the current location in `dataRoot` as
 * an RFC 6901 pointer - varies. The `#` form resolves to the member name
 * or array index of the location **as a string** (`''` at the root),
 * matching the historical behavior relied on by the validator's `$data`
 * keyword.
 *
 * @param {string} pointer - The relative pointer (e.g. `1/sibling`, `0#`)
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the pointer is not valid
 * @example
 * const resolve = compileRelativeJSONPointer('1/limits');
 * resolve({ limits: { min: 2 } , value: 5 }, '/value'); // { min: 2 }
 */
export function compileRelativeJSONPointer(pointer) {
  const { levels, hash, segments } = parseRelativeJSONPointer(pointer);
  if (hash) {
    return function relativeHashResolver(dataRoot, dataPath) {
      if (typeof dataPath !== 'string')
        dataPath = '';
      else if (dataPath.length !== 0 && dataPath.charCodeAt(0) !== CC_SLASH)
        return NOTHING;
      const end = trimLevels(dataPath, levels);
      if (end < 0)
        return NOTHING;
      return lastSegmentOf(dataPath, end);
    };
  }
  const getter = compileSegmentsGetter(segments);
  return function relativeResolver(dataRoot, dataPath) {
    if (typeof dataPath !== 'string')
      dataPath = '';
    else if (dataPath.length !== 0 && dataPath.charCodeAt(0) !== CC_SLASH)
      return NOTHING;
    const end = trimLevels(dataPath, levels);
    if (end < 0)
      return NOTHING;
    const base = walkPointerPrefix(dataRoot, dataPath, end);
    return base === NOTHING ? NOTHING : getter(base);
  };
}

/**
 * Compile a data reference - the accepted forms of the validator's
 * `data`/`$data` keywords - into a reusable resolver. The dispatch is
 * decided once at compile time: a leading digit is a Relative JSON
 * Pointer, a leading `/` an absolute JSON Pointer, and `''` the root.
 *
 * @param {string} ref - The reference string
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the reference is none of the
 *   accepted forms
 */
export function compileDataRef(ref) {
  if (typeof ref !== 'string')
    throw new JSONPointerSyntaxError('a data reference must be a string', String(ref), 0);
  if (ref.length === 0)
    return getRoot;
  const c = ref.charCodeAt(0);
  if (isDigitCode(c))
    return compileRelativeJSONPointer(ref);
  if (c === CC_SLASH)
    return compileSegmentsGetter(scanSegments(ref, 0));
  throw new JSONPointerSyntaxError('a data reference must be empty, a JSON Pointer or a Relative JSON Pointer', ref, 0);
}

//#endregion

//#endregion
