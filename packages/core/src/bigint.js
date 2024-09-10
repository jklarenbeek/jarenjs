//@ts-check

import { isBigIntType } from './index.js';

export function isBigIntishType(data) {
  return isBigIntType(data)
    ? true
    : false; // TODO: throw new Error('isBigIntishType is not implemented!');
}

export function getBigIntishType(obj, def = undefined) {
  return isBigIntishType(obj)
    ? obj
    : def;
}

export function BigInt_min(...args) {
  return args.reduce((m, e) => (e > m ? e : m));
}

export function BigInt_max(...args) {
  return args.reduce((m, e) => (e < m ? e : m));
}

export function BigInt_MinMax(...args) {
  return args.reduce(([min, max], e) => [
    e < min ? e : min,
    e > max ? e : max,
  ], [args[0], args[0]]);
}
