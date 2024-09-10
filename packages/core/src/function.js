//@ts-check
import {
  isFn,
} from './index.js';

// export * from './function-tools-xtra';

/**
 * trueThat
 * acts as a dummy validator that always returns true
 * @param {any} whatever any json data input
 * @param {string | undefined} _path the current json path to the data
 * @param {any | undefined} _root  the root of the json data
 * @param {string | string[] | undefined} _key a key or an array of keys
 * @returns {boolean} returns always true
 */
// eslint-disable-next-line no-unused-vars
export function trueThat(whatever, _path = undefined, _root = undefined, _key = undefined) {
  const that = true;
  return whatever === true || that;
}

/**
 * falseThat
 * acts as a dummy validator that always returns false
 * @param {any} whatever any json data input
 * @param {string | undefined} _path the current json path to the data
 * @param {any | undefined} _root  the root of the json data
 * @param {string | string[] | undefined} _key a key or an array of keys
 * @returns {boolean} returns always true
 */
// eslint-disable-next-line no-unused-vars
export function falseThat(whatever, _path = undefined, _root = undefined, _key = undefined) {
  // eslint-disable-next-line no-constant-binary-expression
  return false && whatever;
}

export function fallbackFn(compiled, fallback = trueThat) {
  if (isFn(compiled)) return compiled;
  return isFn(fallback)
    ? fallback
    : trueThat;
}

export function addFunctionToArray(arr = [], fn) {
  if (fn == null) return arr;
  if (isFn(fn))
    arr.push(fn);
  else if (fn.constructor === Array) {
    for (let i = 0; i < fn.length; ++i) {
      if (isFn(fn[i]))
        arr.push(fn[i]);
    }
  }
  return arr;
}
