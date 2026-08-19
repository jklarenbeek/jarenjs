//#region Canonical JSON (RFC 8785 / JCS)
// JSON Canonicalization Scheme
// https://www.rfc-editor.org/rfc/rfc8785.html
//
// Deterministic serialization for hashing and signing: two structurally
// equal JSON values always produce byte-identical output, so a hash or
// signature over the text is a hash or signature over the value.
//
// The package already had two stable serializers before this one, and
// neither is JCS. Both stay as they are, because both are load-bearing
// where they live:
//
//   - `stableKeyString` (query/runtime.js) is a grouping/ordering KEY.
//     It emits `NaN` and `Infinity` by name so that NaN groups with NaN
//     per the XQuery grouping rule - which JCS forbids outright, since
//     neither is a JSON number.
//   - `stableStringify` (@jarenjs/core/object) is a cache/memo
//     fingerprint. It follows `JSON.stringify` conventions: `NaN`
//     becomes `null`, `undefined` members are dropped.
//
// Silently dropping or coercing a value is exactly right for a memo key
// and exactly wrong for a signature, so this module rejects instead:
// every input that is not JSON data is an error, never a guess.

import { encodeJSONPointerSegment } from './pointer.js';

const hasOwn = Object.hasOwn;

// In a Unicode-mode pattern a well-formed surrogate pair is one code
// point, so this matches only UNPAIRED surrogates.
const RE_LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Error thrown when a value cannot be canonicalized because it is not
 * JSON data (RFC 8785 section 3.2.1). `dataPath` is an RFC 6901 JSON
 * Pointer to the offending value, so a rejected document says which
 * member was at fault rather than only that one was.
 *
 * Extends `TypeError`: passing a non-JSON value to a canonicalizer is a
 * programming error, the same class `JSON.stringify` raises for a
 * BigInt or a cycle.
 */
export class JsonCanonicalizeError extends TypeError {
  constructor(message, dataPath) {
    super(`${message} at ${dataPath === '' ? 'the document root' : dataPath}`);
    this.name = 'JsonCanonicalizeError';
    this.dataPath = dataPath;
  }
}

function fail(message, dataPath) {
  throw new JsonCanonicalizeError(message, dataPath);
}

// RFC 6901 escaping for the diagnostic pointer only.
function appendPath(path, token) {
  return path + '/' + encodeJSONPointerSegment(token);
}

function serializeString(value, path) {
  if (RE_LONE_SURROGATE.test(value))
    fail('a string with an unpaired surrogate is not valid Unicode', path);
  // Section 3.2.2.2 is the JSON string escape discipline with the
  // shortest possible escapes and no escaping of non-ASCII - which is
  // precisely what ECMAScript's JSON.stringify emits for a string.
  return JSON.stringify(value);
}

function serializeNumber(value, path) {
  if (!Number.isFinite(value))
    fail(`${value === value ? String(value) : 'NaN'} is not a JSON number`, path);
  // Section 3.2.2.3 mandates ECMAScript's Number::toString, which is
  // what String() is - including `-0` serializing as `0`.
  return String(value);
}

function serializeValue(value, path, stack) {
  if (value === null)
    return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return serializeString(value, path);
    case 'object':
      break;
    case 'undefined':
      return fail('undefined is not a JSON value', path);
    case 'bigint':
      return fail('a BigInt is not a JSON number', path);
    default: // 'function', 'symbol'
      return fail(`a ${typeof value} is not a JSON value`, path);
  }

  if (stack.has(value))
    fail('a circular reference cannot be canonicalized', path);
  stack.add(value);

  let out;
  if (Array.isArray(value)) {
    out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0)
        out += ',';
      // an array hole reads as undefined, which is not a JSON value
      out += serializeValue(value[i], path + '/' + i, stack);
    }
    out += ']';
  }
  else {
    // A signing primitive must not guess. A class instance would walk
    // as its own enumerable fields (a Date as `{}`, a Map as `{}`),
    // which is a silently wrong signature rather than a loud error, so
    // only plain objects are JSON objects here. `toJSON` is
    // deliberately not consulted for the same reason: the value that
    // gets signed is the value that was passed in.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype)
      fail(`a ${value.constructor?.name ?? 'non-plain'} instance is not a JSON object`, path);
    // Section 3.2.3: members sorted by the UTF-16 code units of their
    // names, which is what the default string sort compares.
    const keys = Object.keys(value).sort();
    out = '{';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      /* c8 ignore next 2 -- Object.keys only yields own keys */
      if (!hasOwn(value, key))
        continue;
      if (i > 0)
        out += ',';
      out += serializeString(key, path) + ':'
        + serializeValue(value[key], appendPath(path, key), stack);
    }
    out += '}';
  }

  stack.delete(value);
  return out;
}

/**
 * Serialize a JSON value to its canonical form (RFC 8785 / JCS): object
 * members sorted by the UTF-16 code units of their names, numbers in
 * the ECMAScript `Number::toString` form, strings with the shortest
 * JSON escapes and no escaping of non-ASCII, and no insignificant
 * whitespace. Two structurally equal values always produce identical
 * text, which is what makes the result safe to hash or sign.
 *
 * Unlike `JSON.stringify`, nothing is dropped or coerced: `undefined`,
 * a function, a symbol, a BigInt, `NaN`, `Infinity`, an unpaired
 * surrogate, a circular reference and a class instance are all errors,
 * because a canonicalizer that quietly rewrote its input would produce
 * a signature over a document nobody sent.
 *
 * @param {any} value - The JSON value to canonicalize
 * @returns {string} The canonical JSON text
 * @throws {JsonCanonicalizeError} When the value is not JSON data
 * @example
 * canonicalizeJson({ b: 1, a: [2, 3] }); // '{"a":[2,3],"b":1}'
 * canonicalizeJson({ 'ä': 1, 'a': 2 }); // '{"a":2,"ä":1}'
 * canonicalizeJson(1e21); // '1e+21'
 */
export function canonicalizeJson(value) {
  return serializeValue(value, '', new Set());
}

const HEX = '0123456789abcdef';

/**
 * The lowercase hex SHA-256 over the RFC 8785 canonical UTF-8 bytes of a
 * JSON value — the content identity two independent processes agree on
 * (a document revision, an idempotency request hash), which is why it is
 * SHA-256 over the canonical text and never a 32-bit fingerprint that
 * collides. Asynchronous because it rides the platform's
 * `globalThis.crypto.subtle` (Node ≥ 20, Bun, browsers, workers); the
 * canonicalization itself is synchronous and its refusals
 * (`JsonCanonicalizeError`) surface as the rejection.
 *
 * @param {any} value - The JSON value to identify
 * @returns {Promise<string>} 64 lowercase hex characters
 * @example
 * await canonicalSha256({ b: 1, a: 2 }) === await canonicalSha256({ a: 2, b: 1 }); // true
 */
export async function canonicalSha256(value) {
  const text = canonicalizeJson(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[b >> 4] + HEX[b & 15];
  }
  return out;
}

//#endregion
