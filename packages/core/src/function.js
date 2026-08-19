//@ts-check
import {
  isFn,
} from './index.js';

// export * from './function-tools-xtra';

/**
 * True when a value is a thenable — the shape `await` and the sync-capable
 * async helpers below key on. A `then` that is not a function is data.
 * @param {any} value
 * @returns {boolean}
 */
export function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

/**
 * Sync-capable-async composition: apply `next` to a result that may be
 * a value or a promise, WITHOUT allocating a promise when it is already
 * a value. This is how a seam whose implementations may answer either
 * way (a database driver, an idempotency ledger) keeps its synchronous
 * fast path exact while the asynchronous one composes naturally.
 * @param {any} value - A value or a promise of one
 * @param {(value: any) => any} next
 * @returns {any} `next`'s result, promise-wrapped only if the input was
 */
export function chain(value, next) {
  return isThenable(value) ? value.then(next) : next(value);
}

/**
 * Lift a value-or-promise into a promise — the ONE allocation a public
 * asynchronous surface pays per call over a sync-capable seam.
 * @param {any} value
 * @returns {Promise<any>}
 */
export function toPromise(value) {
  return isThenable(value) ? value : Promise.resolve(value);
}

/**
 * trueThat
 * acts as a dummy validator that always returns true
 * @param {any} whatever any json data input
 * @param {string | undefined} _path the current json path to the data
 * @param {any | undefined} _root  the root of the json data
 * @param {string | string[] | undefined} _key a key or an array of keys
 * @returns {boolean} returns always true
 */
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
