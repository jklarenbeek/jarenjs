//@ts-check

import {
  isFn,
  isScalarType,
  isBooleanType,
  isTypedArray,
} from './index.js';

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
 *
 * @param {Map} map
 * @param  {...Map} iterables
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
