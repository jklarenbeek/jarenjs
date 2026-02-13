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
 * Deep equality check for uniqueItems validation
 * @param {any} a - First value
 * @param {any} b - Second value
 * @returns {boolean} True if values are deeply equal
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

export function isUniqueDeepArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return true;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (deepEqual(arr[i], arr[j])) return false;
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
