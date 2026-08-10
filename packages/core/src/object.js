//@ts-check

import {
  isFn,
  isScalarType,
  isBooleanType,
  isTypedArray,
} from './index.js';
import { compareCodePoints, hashContent } from './string.js';

const hasOwn = Object.hasOwn;

/**
 * Deep equality comparison for arbitrary values.
 *
 * Generic JavaScript equality: understands Maps, Sets, RegExps,
 * functions, typed arrays and class instances (constructors must
 * match). Not the same as `equalsJson`, which compares JSON values
 * only and is the hot-path variant — keep both.
 * @param {any} target
 * @param {any} source
 * @returns {boolean}
 */
export function equalsDeep(target, source) {
  if (target === source) return true;
  if (target == null) return false;
  if (source == null) return false;
  if (isBooleanType(target)) return false;
  if (isBooleanType(source)) return false;

  if (isFn(target))
    return target.toString() === source.toString();

  if (isScalarType(target))
    return false;

  if (target.constructor !== source.constructor)
    return false;

  if (target.constructor === Object) {
    const tks = Object.keys(target);
    const sks = Object.keys(source);
    if (tks.length !== sks.length)
      return false;
    for (let i = 0; i < tks.length; ++i) {
      const key = tks[i];
      if (!equalsDeep(target[key], source[key]))
        return false;
    }
    return true;
  }

  if (target.constructor === Map) {
    if (target.size !== source.size)
      return false;
    for (const [key, value] of target) {
      if (source.has(key) === false)
        return false;
      if (!equalsDeep(value, source.get(key)))
        return false;
    }
    return true;
  }

  if (target.constructor === Array) {
    if (target.length !== source.length)
      return false;
    for (let i = 0; i < target.length; ++i) {
      if (!equalsDeep(target[i], source[i]))
        return false;
    }
    return true;
  }

  if (target.constructor === Set) {
    if (target.size !== source.size)
      return false;
    for (const value of target) {
      if (source.has(value) === false)
        return false;
    }
    return true;
  }

  if (target.constructor === RegExp) {
    return target.toString() === source.toString();
  }

  if (isTypedArray(target)) {
    if (target.length !== source.length)
      return false;
    for (let i = 0; i < target.length; ++i) {
      if (target[i] !== source[i])
        return false;
    }
    return true;
  }

  // we could test for instance of Array, Map and Set in order
  // to differentiate between types of equality.. but we dont.
  const tkeys = Object.keys(target);
  const skeys = Object.keys(source);
  if (tkeys.length !== skeys.length) return false;
  if (tkeys.length === 0) return true;
  for (let i = 0; i < tkeys.length; ++i) {
    const key = tkeys[i];
    if (!equalsDeep(target[key], source[key]))
      return false;
  }
  return true;
}

/**
 * Structural equality of two JSON values per RFC 9535 section 2.3.5.2.2.
 *
 * JSON-only equality: objects compare by own enumerable keys, arrays by
 * index, primitives by `===` (so `1 === 1.0`, and `NaN` is never equal).
 * Anything a JSON value cannot be — Map, Set, RegExp, function, class
 * instance — compares by identity only. Deliberately not the same as
 * `equalsDeep`, the generic JavaScript variant: this is the hot-path
 * comparator of the JSONPath engine — do not merge the two.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function equalsJson(a, b) {
  if (a === b)
    return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return false;
  if (aIsArray) {
    const alen = a.length;
    if (alen !== b.length)
      return false;
    for (let i = 0; i < alen; i++) {
      if (!equalsJson(a[i], b[i]))
        return false;
    }
    return true;
  }
  let count = 0;
  for (const key in a) {
    if (!hasOwn(a, key))
      continue;
    if (!hasOwn(b, key) || !equalsJson(a[key], b[key]))
      return false;
    count++;
  }
  for (const key in b) {
    if (hasOwn(b, key))
      count--;
  }
  return count === 0;
}

/**
 * Ordering of two JSON values per RFC 9535 section 2.3.5.2.2 — the
 * ordering half of the comparison family whose equality half is
 * `equalsJson`.
 *
 * Only two numbers or two strings order at all: numbers by value,
 * strings by Unicode scalar values (`compareCodePoints`, not the native
 * `<`). Every other pair — mismatched types, objects, arrays, booleans,
 * null — is simply `false` in both directions, never an error.
 *
 * @param {any} a
 * @param {any} b
 * @param {boolean} [orEqual] when true test `<=` instead of `<`
 * @returns {boolean}
 */
export function compareJsonScalarLt(a, b, orEqual = false) {
  if (typeof a === 'number')
    return typeof b === 'number' && (orEqual ? a <= b : a < b);
  if (typeof a === 'string')
    return typeof b === 'string' && (orEqual
      ? compareCodePoints(a, b) <= 0
      : compareCodePoints(a, b) < 0);
  return false;
}

/**
 * Check if all items in an array are unique using deep equality
 * @param {any[]} arr - The array to check
 * @returns {boolean} True if all items are unique
 */
export function isUniqueDeepArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return true;

  // Small all-scalar arrays: pairwise === beats allocating a Set.
  if (arr.length <= 8) {
    let allScalar = true;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
        allScalar = false;
        break;
      }
    }
    if (allScalar) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (arr[i] === arr[j]) return false;
        }
      }
      return true;
    }
  }

  // Primitives are compared with === by equalsDeep and can never deep-equal
  // an object, so they dedupe in O(n) through a Set (SameValueZero); only
  // objects, arrays and functions need the pairwise deep comparison.
  let seen = null;
  let complex = null;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
      if (complex === null) complex = [item];
      else complex.push(item);
    }
    else {
      // NaN !== NaN under equalsDeep; keep NaN values always unique
      if (typeof item === 'number' && item !== item) continue;
      if (seen === null) seen = new Set();
      else if (seen.has(item)) return false;
      seen.add(item);
    }
  }

  if (complex !== null && complex.length > 1) {
    for (let i = 0; i < complex.length; i++) {
      for (let j = i + 1; j < complex.length; j++) {
        if (equalsDeep(complex[i], complex[j])) return false;
      }
    }
  }
  return true;
}

/**
 * Deterministic JSON text for plain data: like `JSON.stringify`, but
 * object keys are emitted in sorted order at every depth, so two
 * structurally equal values always produce the same string (a stable
 * cache/memo/fingerprint key regardless of key insertion order).
 * Non-JSON values follow `JSON.stringify` semantics (undefined members
 * are dropped, undefined roots return undefined).
 *
 * That leniency is what makes it a memo key and not an interchange
 * format: dropping a member changes the document. For output that is
 * hashed or signed, use `canonicalizeJson` (`@jarenjs/json/canonical`,
 * RFC 8785), which rejects every non-JSON input instead of coercing it.
 * @param {*} value - The value to serialize
 * @returns {string|undefined} Deterministic JSON text
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; ++i)
      out += (i === 0 ? '' : ',') + (stableStringify(value[i]) ?? 'null');
    return out + ']';
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  let first = true;
  for (const key of keys) {
    const sv = stableStringify(value[key]);
    if (sv === undefined)
      continue;
    out += (first ? '' : ',') + JSON.stringify(key) + ':' + sv;
    first = false;
  }
  return out + '}';
}

/**
 * The suite's one MEMO-GRADE content key: `hashContent(stableStringify
 * (value) ?? '')`. Two structurally equal plain-JSON values produce the
 * same key regardless of property insertion order — which is exactly
 * what a reconciliation key wants and exactly what `JSON.stringify`-based
 * keys get wrong.
 *
 * **This is a 32-bit FINGERPRINT, never an identity.** Distinct values
 * DO share a key — the birthday bound puts the first collision around
 * 65k documents, and one turns up after ~113k trivially different query
 * documents in practice. So it is sound for a vnode `key`, a DOM id, a
 * bucket index or a diagnostic label, and WRONG as the sole identity of
 * anything whose reuse changes a result: a compiled query, a query plan,
 * a registered SQL function body, a memoized render. For those use
 * {@link semanticKey}, which compares the whole serialization.
 *
 * Two further properties a caller must know, inherited from
 * `stableStringify`: **`undefined` members are dropped** (two values
 * differing only in an `undefined` member share a key) and there is
 * **no cycle guard** (a cyclic value overflows the stack). Both are fine
 * for a fingerprint and wrong for a checksum — for anything hashed,
 * signed or recorded, use `canonicalizeJson`
 * (`@jarenjs/json/canonical`, RFC 8785) instead. Do not conflate the
 * three.
 * @param {*} value - The value to derive a fingerprint for
 * @returns {string} base-36 content hash of the stable serialization
 */
export function contentKey(value) {
  return hashContent(stableStringify(value) ?? '');
}

/**
 * The raw tokens {@link semanticKey} uses for the values JSON text cannot
 * tell apart. Each is emitted UNQUOTED, which alone is enough that no
 * string can forge one — `JSON.stringify` always puts quotes around a
 * string. The leading NUL is belt and braces: `JSON.stringify` escapes it
 * to `\u0000` inside a string, so a token cannot occur in serialized text
 * at all.
 *
 * Written as `\u0000` escapes on purpose. The same character as a literal
 * byte is invisible in every editor and diff and makes tooling treat the
 * file as binary, so a test pins that it stays an escape.
 */
const SEMANTIC_TOKENS = {
  undefined: '\u0000undef',
  nan: '\u0000nan',
  posInfinity: '\u0000+inf',
  negInfinity: '\u0000-inf',
  // -0 needs no sentinel: JSON text for the NUMBER -0 is `0`, so this
  // two-character form is already unreachable as a number's key
  negZero: '-0',
};

/**
 * Serialize one node of a semantic key, or throw when the value cannot
 * be keyed injectively.
 * @param {*} value
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @param {Set<object>} open - Ancestors on the current path (cycle guard)
 * @returns {string}
 */
function semanticToken(value, path, open) {
  const refuse = (what) => {
    throw new TypeError(
      `semanticKey: ${what} at ${path === '' ? 'the root' : path} cannot be a cache identity`);
  };
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return JSON.stringify(value);
    case 'number':
      if (Number.isNaN(value)) return SEMANTIC_TOKENS.nan;
      if (value === Infinity) return SEMANTIC_TOKENS.posInfinity;
      if (value === -Infinity) return SEMANTIC_TOKENS.negInfinity;
      // -0 and 0 are one token in JSON text and two values to every
      // arithmetic the engine performs (1/-0 is -Infinity)
      return Object.is(value, -0) ? SEMANTIC_TOKENS.negZero : String(value);
    case 'undefined': return SEMANTIC_TOKENS.undefined;
    case 'bigint': return `\u0000big${value}`;
    case 'function': return refuse('a function');
    case 'symbol': return refuse('a symbol');
    default: break;
  }
  const object = /** @type {object} */ (value);
  if (open.has(object)) refuse('a cycle');
  const proto = Object.getPrototypeOf(object);
  // a symbol-keyed member is data the serialization cannot show, so two
  // values differing only there would share an identity
  if (Object.getOwnPropertySymbols(object).length > 0)
    refuse('a symbol-keyed member');
  open.add(object);
  let out;
  if (Array.isArray(object)) {
    // a subclass carries behavior the key cannot see
    if (proto !== Array.prototype) refuse('an Array subclass instance');
    const items = /** @type {any[]} */ (object);
    // an own property beyond the elements would vanish positionally
    for (const key of Object.keys(items)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= items.length)
        refuse(`the extra array property ${JSON.stringify(key)}`);
    }
    out = '[';
    for (let i = 0; i < items.length; i++)
      out += (i === 0 ? '' : ',') + semanticToken(items[i], `${path}/${i}`, open);
    out += ']';
  }
  else {
    // Date, Map, Set, RegExp and every class instance stringify to `{}`
    // through `Object.keys` — a whole family collapsing onto one key
    if (proto !== Object.prototype && proto !== null)
      refuse(`a ${object.constructor?.name ?? 'non-plain'} instance`);
    const keys = Object.keys(object).sort(compareCodePoints);
    out = '{';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      out += (i === 0 ? '' : ',') + JSON.stringify(key) + ':'
        + semanticToken(/** @type {any} */ (object)[key], `${path}/${key}`, open);
    }
    out += '}';
  }
  open.delete(object);
  return out;
}

/**
 * The suite's one COLLISION-FREE semantic key: the COMPLETE
 * deterministic serialization of a plain-data value. Two values share a
 * key exactly when they are structurally equal, so a cache keyed by it
 * can never serve one document's compiled semantics for another —
 * which a hash-only key inevitably does (see {@link contentKey}).
 *
 * Use it wherever reuse changes a RESULT: compiled queries, query
 * plans, load specifications, safe profiles, registered SQL function
 * bodies, memoized renders. The key is longer than a fingerprint; for a
 * bounded cache of a few hundred entries that cost is a few kilobytes
 * and the alternative is wrong data.
 *
 * Injective over plain data, and STRICT about the rest: it distinguishes
 * `-0` from `0`, `NaN`/`±Infinity` from `null` and from each other, and
 * a present-but-`undefined` member from an absent one — every case
 * `stableStringify` silently folds together. Values that cannot be
 * keyed injectively are REFUSED with a `TypeError` rather than folded:
 * functions, symbols, cycles, and non-plain objects (a `Date`, `Map`,
 * `RegExp` or class instance, all of which serialize to `{}`), plus the
 * two members a serialization cannot show — a symbol key, and an own
 * array property past the last element. A caller that may hold such a
 * value must treat the refusal as "not cacheable" and compute afresh —
 * never as "reuse whatever shares the key".
 *
 * The identity covers OWN ENUMERABLE string-keyed properties, the same
 * surface JSON reads. Two values differing only in a non-enumerable
 * member are one value to this key, as they are to `JSON.stringify`.
 * @param {*} value - The value to derive an identity for
 * @returns {string} the complete deterministic serialization
 * @throws {TypeError} When the value cannot be keyed injectively
 */
export function semanticKey(value) {
  return semanticToken(value, '', new Set());
}

/**
 * True for a JSON object — a non-null object that is not an array.
 *
 * This is the JSON data-model predicate, deliberately distinct from
 * `isObjectType`: it treats `Map`, `Set`, `Date` and every other class
 * instance as an object too, because at the JSON layer such a value has
 * already been rejected or serialized before it gets here, and the only
 * distinction that matters is object-vs-array.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assign a member so that a key named `__proto__` becomes an own data
 * property instead of reassigning the object's prototype. Every builder
 * that turns untrusted names into members must go through this — a plain
 * `out[name] = value` is a prototype-pollution hole for that one name.
 *
 * @param {Object} out target object
 * @param {string} name member name, possibly attacker-controlled
 * @param {any} value
 */
export function setObjectMember(out, name, value) {
  if (name === '__proto__') {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  else {
    out[name] = value;
  }
}

/**
 * Whether a value can hold JSON members: an object or an array, not null.
 * The complement of a JSON scalar.
 * @param {any} value
 * @returns {boolean}
 */
export function isJsonContainer(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Copy one JSON container one level deep, preserving member order. Object
 * spread copies an own `__proto__` data property as an own property
 * (CreateDataProperty semantics), so this is pollution-safe.
 * @template T
 * @param {T} value - The container to copy
 * @returns {T} A shallow copy; scalars are returned unchanged
 */
export function shallowCloneJson(value) {
  return Array.isArray(value) ? value.slice() : { ...value };
}

/**
 * Deep-copy a JSON value. Scalars are returned as-is; containers are
 * rebuilt so no part of the result is shared with the input.
 * @template T
 * @param {T} value - The JSON value to copy
 * @returns {T} A deep copy sharing no container with the input
 */
export function cloneJson(value) {
  if (!isJsonContainer(value))
    return value;
  if (Array.isArray(value)) {
    const len = value.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++)
      out[i] = cloneJson(value[i]);
    return out;
  }
  const out = {};
  for (const key in value) {
    if (Object.hasOwn(value, key))
      setObjectMember(out, key, cloneJson(value[key]));
  }
  return out;
}

/**
 * Recursively `Object.freeze` a value and everything reachable from it,
 * returning the value. Scalars pass through untouched. Assumes an acyclic
 * structure (a JSON value); a cycle would recurse forever.
 *
 * @template T
 * @param {T} value
 * @returns {T} the same value, deeply frozen
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++)
    deepFreeze(value[keys[i]]);
  return Object.freeze(value);
}

/**
 *
 * @param {Map<any, any>} map
 * @param {...Map<any, any>} iterables
 */
export function mergeMap(map, ...iterables) {
  for (const iterable of iterables) {
    for (const item of iterable) {
      map.set(...item);
    }
  }
}

/**
 *
 * @param {Set<any>} set
 * @param  {...Array<Set<any>>} iterables
 */
export function mergeSet(set, ...iterables) {
  for (const iterable of iterables) {
    for (const item of iterable) {
      set.add(item);
    }
  }
}