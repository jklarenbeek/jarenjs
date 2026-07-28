//#region JSON Pointer (RFC 6901) + Relative JSON Pointer
// JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
// Relative JSON Pointer: draft-handrews-relative-json-pointer-01, the
// revision JSON Schema 2020-12 normatively references:
// https://datatracker.ietf.org/doc/html/draft-handrews-relative-json-pointer-01
//
// The newer draft-bhutton-relative-json-pointer-00 adds an index-
// manipulation form (`0+1`, `1-1`) that this grammar deliberately does not
// accept: the official format suite still asserts `+1/foo/bar` INVALID, so
// accepting it would have to arrive together with a dialect gate for the
// `relative-json-pointer` format tester.
//
// This module implements JSON Pointer as a two-stage compiler, mirroring
// the JSONPath engine in path.js:
//
//   1. `parseJSONPointer` / `parseRelativeJSONPointer` - strict, single-pass
//      char-code parsers enforcing the full RFC 6901 / relative-pointer
//      grammar.
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

import { NOTHING, scanArrayIndex } from './segments.js';
import { LabeledSyntaxError } from './errors.js';

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
export class JSONPointerSyntaxError extends LabeledSyntaxError {
  constructor(message, source, position) {
    super('JSONPointerSyntaxError', 'JSON Pointer', message, source, position);
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

const RE_TILDE = /~/g;
const RE_SLASH = /\//g;

/**
 * Encode a single reference token for use inside an RFC 6901 JSON
 * Pointer: `~` becomes `~0` and `/` becomes `~1` (RFC 6901 section 3).
 * The write-side inverse of the parser's decode; the escape-free common
 * case returns the input unchanged.
 * @param {string|number} segment - The raw member name or array index
 * @returns {string} The encoded reference token
 * @example
 * encodeJSONPointerSegment('a/b'); // 'a~1b'
 */
export function encodeJSONPointerSegment(segment) {
  const s = String(segment);
  return (s.indexOf('~') < 0 && s.indexOf('/') < 0)
    ? s
    : s.replace(RE_TILDE, '~0').replace(RE_SLASH, '~1');
}

/**
 * Format decoded reference tokens as an RFC 6901 JSON Pointer; the
 * inverse of `parseJSONPointer`. An empty array formats as the empty
 * (whole-document) pointer.
 * @param {(string|number)[]} segments - Decoded reference tokens
 * @returns {string} The JSON Pointer
 * @example
 * formatJSONPointer(['a/b', 0]); // '/a~1b/0'
 */
export function formatJSONPointer(segments) {
  let out = '';
  for (let i = 0; i < segments.length; i++)
    out += '/' + encodeJSONPointerSegment(segments[i]);
  return out;
}

//#endregion

//#region compiler

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
  const name2 = segments[2];
  const index2 = scanArrayIndex(name2, 0, name2.length);
  if (slen === 3) {
    return function pointerGetter3(root) {
      const v0 = hop(root, name0, index0);
      if (v0 === NOTHING) return NOTHING;
      const v1 = hop(v0, name1, index1);
      return v1 === NOTHING ? NOTHING : hop(v1, name2, index2);
    };
  }
  const name3 = segments[3];
  const index3 = scanArrayIndex(name3, 0, name3.length);
  if (slen === 4) {
    return function pointerGetter4(root) {
      const v0 = hop(root, name0, index0);
      if (v0 === NOTHING) return NOTHING;
      const v1 = hop(v0, name1, index1);
      if (v1 === NOTHING) return NOTHING;
      const v2 = hop(v1, name2, index2);
      return v2 === NOTHING ? NOTHING : hop(v2, name3, index3);
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
 *
 * The root (`end === 0`) has no name, so it yields NOTHING rather than
 * `''` — `''` is a member name a document can genuinely have (`{"": 1}`
 * at `/`), and returning it for the root too would make the two
 * indistinguishable to the caller.
 */
function lastSegmentOf(dataPath, end) {
  if (end === 0)
    return NOTHING;
  const start = dataPath.lastIndexOf('/', end - 1) + 1;
  for (let i = start; i < end; i++) {
    if (dataPath.charCodeAt(i) === CC_TILDE)
      return decodeSegmentRange(dataPath, start, end, i);
  }
  return dataPath.slice(start, end);
}

/**
 * Read and validate the `hashIndex` compile option, defaulting to the
 * historical `'string'`. An unknown value is rejected rather than ignored:
 * silently falling back would hand a caller who meant `'number'` the exact
 * behavior they were opting out of.
 * @param {{ hashIndex?: string }} [options]
 * @returns {'string'|'number'}
 */
function readHashIndexOption(options) {
  if (options === undefined || options === null)
    return 'string';
  const mode = options.hashIndex;
  if (mode === undefined || mode === 'string')
    return 'string';
  if (mode === 'number')
    return 'number';
  throw new TypeError(
    `hashIndex must be 'string' or 'number', got ${JSON.stringify(mode)}`);
}

/**
 * The exclusive end of the *parent* of the location `dataPath.slice(0, end)`,
 * or -1 when that location is the root and so has no parent.
 */
function parentEndOf(dataPath, end) {
  return end === 0 ? -1 : dataPath.lastIndexOf('/', end - 1);
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
 * an RFC 6901 pointer - varies.
 *
 * The root has no name: `0#` there yields `JSONPOINTER_NOTHING`, not `''`,
 * so it stays distinguishable from the member named `''` (`{"": 1}` at
 * `/`), which is a name a document can genuinely have.
 *
 * ### The `#` form and `hashIndex`
 *
 * Relative JSON Pointer says `#` yields the member *name* for an object
 * member and the *index* — a number — for an array element. Telling those
 * apart requires looking at the container, so the two modes cost different
 * things and you choose per compile:
 *
 * - `hashIndex: 'string'` (**default**) answers from `dataPath` alone and
 *   never touches `dataRoot`: an array position comes back as the string
 *   `'1'`. This is the historical behavior the validator's `$data` keyword
 *   relies on, and it is a string operation — tens of nanoseconds.
 * - `hashIndex: 'number'` is the draft's answer. It walks to the parent of
 *   the location to see whether it is an array, and returns `1` rather than
 *   `'1'` when it is. Object member names are unaffected. When the parent
 *   cannot be reached (the location does not exist in `dataRoot`) it falls
 *   back to the string, because nothing proves the position is an index.
 *
 * Neither mode verifies that the location itself exists; the caller is
 * expected to pass a location it actually reached. The non-`#` form must
 * walk regardless, because it returns the value.
 *
 * @param {string} pointer - The relative pointer (e.g. `1/sibling`, `0#`)
 * @param {{ hashIndex?: 'string'|'number' }} [options] - `hashIndex`
 *   selects what the `#` form yields for an array position (default
 *   `'string'`)
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the pointer is not valid
 * @throws {TypeError} When `hashIndex` is neither `'string'` nor `'number'`
 * @example
 * const resolve = compileRelativeJSONPointer('1/limits');
 * resolve({ limits: { min: 2 } , value: 5 }, '/value'); // { min: 2 }
 * @example
 * const spec = compileRelativeJSONPointer('0#', { hashIndex: 'number' });
 * spec({ a: ['x', 'y'] }, '/a/1'); // 1  (the number, per the draft)
 */
export function compileRelativeJSONPointer(pointer, options = undefined) {
  const { levels, hash, segments } = parseRelativeJSONPointer(pointer);
  const numericHash = readHashIndexOption(options) === 'number';
  if (hash) {
    if (!numericHash) {
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
    return function relativeHashIndexResolver(dataRoot, dataPath) {
      if (typeof dataPath !== 'string')
        dataPath = '';
      else if (dataPath.length !== 0 && dataPath.charCodeAt(0) !== CC_SLASH)
        return NOTHING;
      const end = trimLevels(dataPath, levels);
      if (end < 0)
        return NOTHING;
      const name = lastSegmentOf(dataPath, end);
      if (name === NOTHING)
        return NOTHING;
      // An index is only an index when its container is an array; the name
      // of a `{"1": …}` member is the string "1" in every mode.
      const parentEnd = parentEndOf(dataPath, end);
      if (parentEnd < 0)
        return name;
      const parent = walkPointerPrefix(dataRoot, dataPath, parentEnd);
      if (!Array.isArray(parent))
        return name;
      const index = scanArrayIndex(name, 0, name.length);
      return index < 0 ? name : index;
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
 * @param {{ hashIndex?: 'string'|'number' }} [options] - forwarded to
 *   {@link compileRelativeJSONPointer}; only the relative forms read it
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the reference is none of the
 *   accepted forms
 * @throws {TypeError} When `hashIndex` is neither `'string'` nor `'number'`
 */
export function compileDataRef(ref, options = undefined) {
  if (typeof ref !== 'string')
    throw new JSONPointerSyntaxError('a data reference must be a string', String(ref), 0);
  // Validate the option even on the forms that ignore it, so a typo is a
  // compile-time error wherever it appears rather than only on `N#` refs.
  readHashIndexOption(options);
  if (ref.length === 0)
    return getRoot;
  const c = ref.charCodeAt(0);
  if (isDigitCode(c))
    return compileRelativeJSONPointer(ref, options);
  if (c === CC_SLASH)
    return compileSegmentsGetter(scanSegments(ref, 0));
  throw new JSONPointerSyntaxError('a data reference must be empty, a JSON Pointer or a Relative JSON Pointer', ref, 0);
}

//#endregion

//#endregion
