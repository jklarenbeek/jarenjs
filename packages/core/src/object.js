//@ts-check

import {
  isFn,
  isScalarType,
  isBooleanType,
  isTypedArray,
} from './index.js';
import { compareCodePoints } from './string.js';

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