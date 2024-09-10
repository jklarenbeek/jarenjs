//@ts-check

import {
  isArrayClass,
  isSetClass,
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

export function getUniqueArray(arr, def = undefined) {
  return isArrayClass(arr)
    ? arr.filter((el, index, a) => index === a.indexOf(el))
    : isSetClass(arr)
      ? Array.from(arr)
      : def;
}

export function isUniqueArray(arr) {
  const len = arr.length;
  return getUniqueArray(arr).length === len;
}

export function includesAll(arr, values) {
  return values.every(v => arr.includes(v));
}
