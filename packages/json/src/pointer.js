//#region JSON Pointer (RFC 6901) + Relative JSON Pointer
// JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
// Relative JSON Pointer: draft-handrews-relative-json-pointer-01, the
// revision JSON Schema 2020-12 normatively references:
// https://datatracker.ietf.org/doc/html/draft-handrews-relative-json-pointer-01
//
// The newer draft-bhutton-relative-json-pointer-00 adds an index
// manipulation form (`0+1`, `1-1`). It is opt-in per call through
// `{ dialect: 'bhutton-00' }`; the default grammar stays handrews-01
// exactly, because the official format suite still asserts `+1/foo/bar`
// INVALID and the `relative-json-pointer` format tester answers by default.
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
  CC_PLUS,
  CC_MINUS,
  CC_TILDE,
  CC_0,
  CC_1,
  isDigitCode,
} from '@jarenjs/core/scan';

import { NOTHING, scanArrayIndex } from './segments.js';
import { LabeledSyntaxError } from './errors.js';
import { readIndexShiftDialect } from './relative-dialect.js';

/**
 * Sentinel for the absence of a value, as distinct from the JSON value
 * `null`. This is the same sentinel as `JSONPATH_NOTHING` in path.js, so
 * pointer and path results can share checks.
 */
export const JSONPOINTER_NOTHING = NOTHING;

const hasOwn = Object.hasOwn;

/**
 * Error thrown when a (relative) JSON Pointer is not valid RFC 6901 /
 * draft-handrews-relative-json-pointer-01 syntax
 * (or draft-bhutton-relative-json-pointer-00 where the dialect is on).
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
 * A parsed Relative JSON Pointer (draft-handrews-relative-json-pointer-01,
 * or draft-bhutton-relative-json-pointer-00 where the dialect is on).
 * @typedef {Object} RelativeJsonPointer
 * @property {number} levels - Number of levels to ascend from the current location
 * @property {boolean} hash - True for the `#` form, which addresses the member name or array index itself
 * @property {string[]} segments - Decoded reference tokens applied after ascending
 * @property {number} [shift] - The index manipulation (`+1` is 1, `-1` is -1)
 *   applied to the array item reached after ascending. Present only when the
 *   pointer wrote one, which only the `'bhutton-00'` dialect accepts; `0+0`
 *   is `0`, so a zero shift is told apart from none.
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
 * Options of the Relative JSON Pointer parser and compilers.
 * @typedef {Object} RelativeJsonPointerOptions
 * @property {'handrews-01'|'bhutton-00'} [dialect] - The grammar revision:
 *   `'handrews-01'` (default) is draft-handrews-relative-json-pointer-01;
 *   `'bhutton-00'` is draft-bhutton-relative-json-pointer-00, which adds the
 *   index manipulation (`0+1`, `1-1/name`, `0-1#`)
 */

/**
 * Parse a Relative JSON Pointer strictly per
 * draft-handrews-relative-json-pointer-01: a non-negative integer without
 * leading zeros, followed by `#` or a JSON Pointer. With
 * `{ dialect: 'bhutton-00' }` the integer may be followed by an index
 * manipulation, a `+` or `-` and another non-negative integer
 * (draft-bhutton-relative-json-pointer-00), which lands in `shift`.
 * @param {string} pointer - The relative pointer (e.g. `1/sibling`, `0#`)
 * @param {RelativeJsonPointerOptions} [options]
 * @returns {RelativeJsonPointer} The parsed relative pointer
 * @throws {JSONPointerSyntaxError} When the pointer violates the grammar
 * @throws {TypeError} When `dialect` is neither accepted spelling
 * @example
 * parseRelativeJSONPointer('1-1/name', { dialect: 'bhutton-00' });
 * // { levels: 1, hash: false, segments: ['name'], shift: -1 }
 */
export function parseRelativeJSONPointer(pointer, options = undefined) {
  const shiftAllowed = readIndexShiftDialect(options);
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
  /** @type {RelativeJsonPointer} */
  const parsed = { levels, hash: false, segments: [] };
  if (shiftAllowed && pos < len) {
    const sign = pointer.charCodeAt(pos);
    if (sign === CC_PLUS || sign === CC_MINUS) {
      const start = ++pos;
      if (pos >= len || !isDigitCode(pointer.charCodeAt(pos)))
        throw new JSONPointerSyntaxError('expected a non-negative integer after the sign', pointer, pos);
      if (pointer.charCodeAt(pos++) === CC_0) {
        if (pos < len && isDigitCode(pointer.charCodeAt(pos)))
          throw new JSONPointerSyntaxError('leading zeros are not allowed', pointer, start);
      }
      else {
        while (pos < len && isDigitCode(pointer.charCodeAt(pos)))
          pos++;
      }
      const magnitude = Number(pointer.slice(start, pos));
      if (!Number.isSafeInteger(magnitude))
        throw new JSONPointerSyntaxError('index shift out of range', pointer, start);
      parsed.shift = sign === CC_MINUS ? 0 - magnitude : magnitude;
    }
  }
  if (pos === len)
    return parsed;
  const c = pointer.charCodeAt(pos);
  if (c === CC_HASH) {
    if (pos + 1 !== len)
      throw new JSONPointerSyntaxError("'#' must end the pointer", pointer, pos + 1);
    parsed.hash = true;
    return parsed;
  }
  if (c !== CC_SLASH)
    throw new JSONPointerSyntaxError("expected '#' or a JSON Pointer after the level count", pointer, pos);
  parsed.segments = scanSegments(pointer, pos);
  return parsed;
}

const RE_TILDE = /~/g;
const RE_SLASH = /\//g;
const RE_ESCAPED_SLASH = /~1/g;
const RE_ESCAPED_TILDE = /~0/g;

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
 * Decode one RFC 6901 reference token: `~1` becomes `/` and `~0` becomes
 * `~`. The order is normative (RFC 6901 section 4) and not an accident of
 * implementation — decoding `~0` first would turn `~01` into `~1` and then
 * into `/`, so a member literally named `~1` would come back as `/`.
 * The escape-free common case returns the input unchanged.
 * @param {string} token - One encoded reference token (no `/` separators)
 * @returns {string} The decoded member name
 * @example
 * decodeJSONPointerSegment('a~1b'); // 'a/b'
 */
export function decodeJSONPointerSegment(token) {
  return token.indexOf('~') < 0
    ? token
    : token.replace(RE_ESCAPED_SLASH, '/').replace(RE_ESCAPED_TILDE, '~');
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

/**
 * Parse a JSON Pointer into a path array, narrowing every canonical array
 * index to a number and leaving all other tokens as decoded strings.
 *
 * RFC 6901 has no types: `/items/0/id` addresses element 0 of an array and
 * member `"0"` of an object with the same token. This function resolves that
 * lexically, not against a document — a token is a number when it is `0` or a
 * digit sequence without leading zeros within the array-index range, which is
 * the same rule the pointer compiler uses to pre-parse indexes. `"01"`,
 * `"1e0"`, `"-"` and `"1abc"` therefore stay strings.
 *
 * The result is the `(string|number)[]` shape that error reporters and
 * diffing tools use for data locations, so it pairs directly with a
 * validation error's `instancePath`. `formatJSONPointer` is the inverse.
 * @param {string} pointer - The JSON Pointer (e.g. `/store/book/0`)
 * @returns {(string|number)[]} Decoded tokens with array indexes as numbers
 * @throws {JSONPointerSyntaxError} When the pointer violates the grammar
 * @example
 * parseJSONPointerPath('/items/0/id');  // ['items', 0, 'id']
 * parseJSONPointerPath('/items/01');    // ['items', '01']
 * parseJSONPointerPath('/a~1b');        // ['a/b']
 */
export function parseJSONPointerPath(pointer) {
  const segments = parseJSONPointer(pointer);
  /** @type {(string|number)[]} */
  const path = segments;
  for (let i = 0; i < segments.length; i++) {
    const token = segments[i];
    const index = scanArrayIndex(token, 0, token.length);
    if (index !== -1) path[i] = index;
  }
  return path;
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
 * The resolver of a pointer with an index manipulation
 * (draft-bhutton-relative-json-pointer-00, section "Evaluation"): ascend
 * `levels`, require the value reached to be an item of an array, move to the
 * item `shift` positions away, then yield its index (`#`) or resolve
 * `segments` from it. Every failure the draft names - the root, a value that
 * is not an array item, an index outside the array - is `NOTHING`; so is a
 * location that does not exist in `dataRoot`, which the shift cannot be
 * measured from. Unlike the plain `#` form this one must read the document,
 * since the array's length decides whether the target exists.
 */
function compileShiftedResolver(levels, hash, segments, shift, numericHash) {
  const getter = compileSegmentsGetter(segments);
  return function relativeShiftResolver(dataRoot, dataPath) {
    if (typeof dataPath !== 'string')
      dataPath = '';
    else if (dataPath.length !== 0 && dataPath.charCodeAt(0) !== CC_SLASH)
      return NOTHING;
    const end = trimLevels(dataPath, levels);
    if (end <= 0)
      return NOTHING;
    const array = walkPointerPrefix(dataRoot, dataPath, parentEndOf(dataPath, end));
    if (!Array.isArray(array))
      return NOTHING;
    const index = scanArrayIndex(dataPath, dataPath.lastIndexOf('/', end - 1) + 1, end);
    if (index < 0 || index >= array.length)
      return NOTHING;
    const target = index + shift;
    if (target < 0 || target >= array.length)
      return NOTHING;
    if (!hash)
      return getter(array[target]);
    return numericHash ? target : String(target);
  };
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
 * ### Index manipulation and `dialect`
 *
 * `{ dialect: 'bhutton-00' }` accepts draft-bhutton-relative-json-pointer-00's
 * index manipulation: `0+1` is the next item of the array the location is an
 * item of, `1-1/name` the `name` member of the previous item of the array the
 * parent is an item of, and `0-1#` the index of the previous item. The
 * default dialect, `'handrews-01'`, refuses the form at compile time. With a
 * manipulation the location must exist in `dataRoot` and be an item of an
 * array; a root, a member of an object, an index outside the array or a
 * location the document does not hold resolves to `JSONPOINTER_NOTHING`.
 * `#` after a manipulation is always an array index, so `hashIndex` only
 * chooses its type (`'string'` by default, `'number'` as the draft has it).
 *
 * @param {string} pointer - The relative pointer (e.g. `1/sibling`, `0#`)
 * @param {{ hashIndex?: 'string'|'number', dialect?: 'handrews-01'|'bhutton-00' }} [options]
 *   `hashIndex` selects what the `#` form yields for an array position
 *   (default `'string'`); `dialect` selects the grammar (default
 *   `'handrews-01'`)
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the pointer is not valid
 * @throws {TypeError} When `hashIndex` is neither `'string'` nor `'number'`,
 *   or `dialect` is neither `'handrews-01'` nor `'bhutton-00'`
 * @example
 * const resolve = compileRelativeJSONPointer('1/limits');
 * resolve({ limits: { min: 2 } , value: 5 }, '/value'); // { min: 2 }
 * @example
 * const spec = compileRelativeJSONPointer('0#', { hashIndex: 'number' });
 * spec({ a: ['x', 'y'] }, '/a/1'); // 1  (the number, per the draft)
 * @example
 * const next = compileRelativeJSONPointer('0+1', { dialect: 'bhutton-00' });
 * next({ a: ['x', 'y'] }, '/a/0'); // 'y'
 * next({ a: ['x', 'y'] }, '/a/1'); // JSONPOINTER_NOTHING (no item after the last)
 */
export function compileRelativeJSONPointer(pointer, options = undefined) {
  const { levels, hash, segments, shift } = parseRelativeJSONPointer(pointer, options);
  const numericHash = readHashIndexOption(options) === 'number';
  if (shift !== undefined)
    return compileShiftedResolver(levels, hash, segments, shift, numericHash);
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
 * @param {{ hashIndex?: 'string'|'number', dialect?: 'handrews-01'|'bhutton-00' }} [options]
 *   forwarded to {@link compileRelativeJSONPointer}; only the relative forms
 *   act on it
 * @returns {RelativeJsonPointerResolver} resolver returning
 *   the addressed value, or `JSONPOINTER_NOTHING`
 * @throws {JSONPointerSyntaxError} When the reference is none of the
 *   accepted forms
 * @throws {TypeError} When `hashIndex` is neither `'string'` nor `'number'`,
 *   or `dialect` is neither `'handrews-01'` nor `'bhutton-00'`
 */
export function compileDataRef(ref, options = undefined) {
  if (typeof ref !== 'string')
    throw new JSONPointerSyntaxError('a data reference must be a string', String(ref), 0);
  // Validate the option even on the forms that ignore it, so a typo is a
  // compile-time error wherever it appears rather than only on `N#` refs.
  readHashIndexOption(options);
  readIndexShiftDialect(options);
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
