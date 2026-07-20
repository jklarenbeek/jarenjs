//@ts-check
/**
 * @file Evaluation environments — the operator/function binding sets the
 * compiler resolves against (design decision D5). The AST is neutral; an
 * environment gives it meaning. `defaultEnv` covers standard/scientific
 * (float, `^` = power, angle-aware trig); `programmerEnv` overrides the
 * bitwise operators with `@jarenjs/core/math/word.js` word math and adds
 * the programmer functions. Every binding closes over `scope` so angle
 * mode and word size are read at evaluation time.
 *
 * Binding shapes (all monomorphic): `func(args[], scope)`,
 * `binop(a, b, scope)`, `unop(a, scope)`, `postop(a, scope)`.
 */

import {
  Float64,
  mathf64_sin, mathf64_cos, mathf64_tan, mathf64_asin, mathf64_acos, mathf64_atan,
  mathf64_sinh, mathf64_cosh, mathf64_tanh, mathf64_atan2,
  mathf64_log, mathf64_log2, mathf64_log10, mathf64_exp, mathf64_expm1,
  mathf64_sqrt, mathf64_cbrt, mathf64_abs, mathf64_floor, mathf64_ceil,
  mathf64_round, mathf64_min, mathf64_max, mathf64_pow,
  toWord, wAnd, wOr, wXor, wNot, wShl, wShr, wRol, wRor, wMod,
} from '@jarenjs/core/math';
import { CONSTANTS } from './ast.js';

/** Convert a user angle to radians per the scope's angle mode. */
function toRad(x, scope) {
  const m = scope && scope.angleMode;
  if (m === 'deg') return (x * Math.PI) / 180;
  if (m === 'grad') return (x * Math.PI) / 200;
  return x;
}
/** Convert a radian result back to the scope's angle mode. */
function fromRad(x, scope) {
  const m = scope && scope.angleMode;
  if (m === 'deg') return (x * 180) / Math.PI;
  if (m === 'grad') return (x * 200) / Math.PI;
  return x;
}

/** Coerce to a BigInt word using the scope's word size/sign. */
function big(v, scope) {
  return toWord(BigInt(Math.trunc(+v)), scope?.wordBits ?? 32, scope?.signed ?? false);
}

/** @type {Record<string, (args: number[], scope: any) => number>} */
const FLOAT_FUNCS = {
  sin: (a, s) => mathf64_sin(toRad(a[0], s)),
  cos: (a, s) => mathf64_cos(toRad(a[0], s)),
  tan: (a, s) => mathf64_tan(toRad(a[0], s)),
  asin: (a, s) => fromRad(mathf64_asin(a[0]), s),
  acos: (a, s) => fromRad(mathf64_acos(a[0]), s),
  atan: (a, s) => fromRad(mathf64_atan(a[0]), s),
  atan2: (a, s) => fromRad(mathf64_atan2(a[0], a[1]), s),
  sinh: (a) => mathf64_sinh(a[0]),
  cosh: (a) => mathf64_cosh(a[0]),
  tanh: (a) => mathf64_tanh(a[0]),
  ln: (a) => mathf64_log(a[0]),
  log: (a) => (a.length > 1 ? Float64.logBase(a[0], a[1]) : mathf64_log10(a[0])),
  log2: (a) => mathf64_log2(a[0]),
  log10: (a) => mathf64_log10(a[0]),
  exp: (a) => mathf64_exp(a[0]),
  expm1: (a) => mathf64_expm1(a[0]),
  sqrt: (a) => mathf64_sqrt(a[0]),
  cbrt: (a) => mathf64_cbrt(a[0]),
  root: (a) => Float64.nthroot(a[0], a[1]),
  abs: (a) => mathf64_abs(a[0]),
  sign: (a) => Float64.sign(a[0]),
  floor: (a) => mathf64_floor(a[0]),
  ceil: (a) => mathf64_ceil(a[0]),
  round: (a) => (a.length > 1 ? Float64.roundTo(a[0], a[1]) : mathf64_round(a[0])),
  trunc: (a) => Math.trunc(a[0]),
  min: (a) => mathf64_min(...a),
  max: (a) => mathf64_max(...a),
  hypot: (a) => Float64.hypot(...a),
  fact: (a) => Float64.factorial(a[0]),
  gamma: (a) => Float64.gamma(a[0]),
  pow: (a) => mathf64_pow(a[0], a[1]),
  mod: (a) => a[0] % a[1],
};

/** @type {Record<string, (a: number, b: number, scope: any) => number>} */
const FLOAT_BINOPS = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': (a, b) => mathf64_pow(a, b),
  '&': (a, b) => (a | 0) & (b | 0),
  '|': (a, b) => (a | 0) | (b | 0),
  '<<': (a, b) => (a | 0) << (b | 0),
  '>>': (a, b) => (a | 0) >> (b | 0),
};

/** @type {Record<string, (a: number, scope: any) => number>} */
const FLOAT_UNOPS = {
  '-': (a) => -a,
  '+': (a) => a,
  '~': (a) => ~(a | 0),
};

/** @type {Record<string, (a: number, scope: any) => number>} */
const FLOAT_POSTOPS = {
  '!': (a) => Float64.factorial(a),
  '%': (a) => a / 100,
};

/**
 * The default (standard/scientific) environment.
 * @returns {any}
 */
export function defaultEnv() {
  return {
    constants: { ...CONSTANTS },
    funcs: FLOAT_FUNCS,
    binops: FLOAT_BINOPS,
    unops: FLOAT_UNOPS,
    postops: FLOAT_POSTOPS,
  };
}

/** Word-aware programmer functions (return `Number`; see the >2^53 caveat in docs). */
const WORD_FUNCS = {
  ...FLOAT_FUNCS,
  and: (a, s) => Number(wAnd(big(a[0], s), big(a[1], s), s?.wordBits ?? 32, s?.signed ?? false)),
  or: (a, s) => Number(wOr(big(a[0], s), big(a[1], s), s?.wordBits ?? 32, s?.signed ?? false)),
  xor: (a, s) => Number(wXor(big(a[0], s), big(a[1], s), s?.wordBits ?? 32, s?.signed ?? false)),
  not: (a, s) => Number(wNot(big(a[0], s), s?.wordBits ?? 32, s?.signed ?? false)),
  shl: (a, s) => Number(wShl(big(a[0], s), BigInt(Math.trunc(a[1])), s?.wordBits ?? 32, s?.signed ?? false)),
  shr: (a, s) => Number(wShr(big(a[0], s), BigInt(Math.trunc(a[1])), s?.wordBits ?? 32, s?.signed ?? false)),
  rol: (a, s) => Number(wRol(big(a[0], s), BigInt(Math.trunc(a[1])), s?.wordBits ?? 32, s?.signed ?? false)),
  ror: (a, s) => Number(wRor(big(a[0], s), BigInt(Math.trunc(a[1])), s?.wordBits ?? 32, s?.signed ?? false)),
  mod: (a, s) => Number(wMod(big(a[0], s), big(a[1], s), s?.wordBits ?? 32, s?.signed ?? false)),
};

const WORD_BINOPS = {
  ...FLOAT_BINOPS,
  '&': (a, b, s) => Number(wAnd(big(a, s), big(b, s), s?.wordBits ?? 32, s?.signed ?? false)),
  '|': (a, b, s) => Number(wOr(big(a, s), big(b, s), s?.wordBits ?? 32, s?.signed ?? false)),
  '<<': (a, b, s) => Number(wShl(big(a, s), BigInt(Math.trunc(b)), s?.wordBits ?? 32, s?.signed ?? false)),
  '>>': (a, b, s) => Number(wShr(big(a, s), BigInt(Math.trunc(b)), s?.wordBits ?? 32, s?.signed ?? false)),
};

const WORD_UNOPS = {
  ...FLOAT_UNOPS,
  '~': (a, s) => Number(wNot(big(a, s), s?.wordBits ?? 32, s?.signed ?? false)),
};

/**
 * The programmer environment: word-masked bitwise operators plus the
 * `and/or/xor/not/shl/shr/rol/ror/mod` functions, read against the
 * scope's `wordBits`/`signed`.
 * @returns {any}
 */
export function programmerEnv() {
  return {
    constants: { ...CONSTANTS },
    funcs: WORD_FUNCS,
    binops: WORD_BINOPS,
    unops: WORD_UNOPS,
    postops: FLOAT_POSTOPS,
  };
}
