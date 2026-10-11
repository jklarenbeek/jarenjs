//@ts-check

import { isBigIntType } from './index.js';

/**
 * Whether a value is a bigint. Unlike the number helpers there is no
 * string spelling to accept: `'1'` is text, not a bigint-ish number.
 * @param {*} data
 * @returns {boolean}
 */
export function isBigIntishType(data) {
  return isBigIntType(data);
}

/**
 * The value when it is a bigint, otherwise `def`.
 * @param {*} obj
 * @param {bigint} [def]
 * @returns {bigint | undefined}
 */
export function getBigIntishType(obj, def = undefined) {
  return isBigIntishType(obj)
    ? obj
    : def;
}

/**
 * The smallest of the given bigints.
 * @param {...bigint} args - at least one
 * @returns {bigint}
 */
export function BigInt_min(...args) {
  return args.reduce((m, e) => (e < m ? e : m));
}

/**
 * The largest of the given bigints.
 * @param {...bigint} args - at least one
 * @returns {bigint}
 */
export function BigInt_max(...args) {
  return args.reduce((m, e) => (e > m ? e : m));
}

/**
 * The smallest and the largest of the given bigints, as `[min, max]`.
 * @param {...bigint} args - at least one
 * @returns {[bigint, bigint]}
 */
export function BigInt_MinMax(...args) {
  return args.reduce(([min, max], e) => [
    e < min ? e : min,
    e > max ? e : max,
  ], [args[0], args[0]]);
}
