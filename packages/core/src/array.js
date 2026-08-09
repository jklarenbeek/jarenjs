//@ts-check

import {
  TypedArray,
} from './index.js';

/**
 * @brief test if object is instanceof Array, Set or TypedArray!
 * @param {*} data the data to test
 * @returns boolean
 */
export function isArrayish(data) {
  return data != null
    && (data instanceof Array
      || data instanceof Set
      || data instanceof TypedArray);
}

/**
 * Returns a new array containing only the unique elements from the input array.
 * If the input is an array, it filters out duplicate elements.
 * If the input is a Set, it converts it to an array.
 * @param {Array|Set} arr - The input array or Set.
 * @param {Array|undefined} [def=undefined] - The default value to return if the input is neither an array nor a Set.
 * @returns {Array|undefined} A new array with unique elements, or the default value if the input is not an array or Set.
 */
export function getUniqueArray(arr, def = undefined) {
  if (arr == null)
    return def;

  return arr.constructor === Array
    ? arr.filter((el, index, a) => index === a.indexOf(el))
    : arr.constructor === Set
      ? Array.from(arr)
      : def;
}

/**
 * Checks if all elements in the input array are unique.
 * @param {Array} arr - The input array to check for uniqueness.
 * @returns {boolean} True if all elements are unique, false otherwise.
 */
export function isUniqueArray(arr) {
  const unique = getUniqueArray(arr);
  return unique != null
    && unique.length == arr.length;
}

/**
 * Checks if all elements in the 'values' array are included in the 'arr' array.
 * @param {Array} arr - The array to check against.
 * @param {Array} values - The array of values to check for inclusion.
 * @returns {boolean} True if all 'values' are included in 'arr', false otherwise.
 */
export function includesAll(arr, values) {
  return values.every(v => arr.includes(v));
}

/**
 * The value when it is one of `allowed`, otherwise `fallback`. The point
 * is untrusted input: a value restored from storage, a share link or a
 * stale state slice can be anything, and a UI that switches on it directly
 * renders nothing at all for a name it does not know. Narrowing to a known
 * set turns that blank into the fallback.
 * @template T
 * @param {unknown} value - The candidate, from anywhere.
 * @param {readonly T[]} allowed - The values that may pass through.
 * @param {T} fallback - Used when `value` is not one of `allowed`.
 * @returns {T}
 */
export function pickAllowed(value, allowed, fallback) {
  return allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;
}
