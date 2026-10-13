//@ts-check
/**
 * @file Evaluation environments — the operator/function binding sets the
 * compiler resolves against. The AST is neutral; an
 * environment gives it meaning. `defaultEnv` covers standard/scientific
 * (float, `^` = power, angle-aware trig); `programmerEnv` overrides the
 * bitwise operators with `@jarenjs/core/math/word.js` word math and adds
 * the programmer functions. Every binding closes over `scope` so angle
 * mode and word size are read at evaluation time.
 *
 * Binding shapes (all monomorphic): `func(args[], scope)`,
 * `binop(a, b, scope)`, `unop(a, scope)`, `postop(a, scope)`. Each
 * environment also carries an `arity` table, `[min, max]` per function,
 * which the compiler checks every call against. An environment whose
 * values may be exact integers past 2^53 (`programmerEnv`) sets `exact`:
 * the compiler then reads an integer literal as the integer written, and
 * its operators answer a `bigint` where a `Number` could not hold the
 * result (see `exact.js`).
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
import {
  fit, toNumber, add, subtract, multiply, divide, power, negate, magnitude, extreme,
} from './exact.js';

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

/**
 * A word operand as a BigInt integer. A non-finite one has no integer to
 * become, and is refused in the calculator's terms rather than in the
 * engine's ("cannot be converted to a BigInt").
 * @param {number | bigint} v
 * @returns {bigint}
 */
function integer(v) {
  if (typeof v === 'bigint') return v;
  const n = +v;
  if (!Number.isFinite(n)) throw new RangeError(`a word operand must be a finite number, got ${n}`);
  return BigInt(Math.trunc(n));
}

/**
 * Coerce to a BigInt word using the scope's word size/sign.
 * @param {number | bigint} v
 * @param {any} scope
 * @returns {bigint}
 */
function big(v, scope) {
  return toWord(integer(v), scope?.wordBits ?? 32, scope?.signed ?? false);
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

/** @type {readonly [number, number]} */
const ONE = Object.freeze([1, 1]);
/** @type {readonly [number, number]} */
const TWO = Object.freeze([2, 2]);
/** @type {readonly [number, number]} */
const ONE_OR_TWO = Object.freeze([1, 2]);
/** @type {readonly [number, number]} */
const ONE_OR_MORE = Object.freeze([1, Infinity]);

/**
 * How many arguments each function takes, as `[min, max]`; the compiler
 * refuses a call outside it, so a surplus argument is never dropped and a
 * missing one never read as `NaN`. `log` and `round` take an optional
 * second argument; `min`, `max` and `hypot` take one or more.
 * @type {Readonly<Record<string, readonly [number, number]>>}
 */
const FLOAT_ARITY = Object.freeze({
  sin: ONE, cos: ONE, tan: ONE, asin: ONE, acos: ONE, atan: ONE, atan2: TWO,
  sinh: ONE, cosh: ONE, tanh: ONE,
  ln: ONE, log: ONE_OR_TWO, log2: ONE, log10: ONE, exp: ONE, expm1: ONE,
  sqrt: ONE, cbrt: ONE, root: TWO, abs: ONE, sign: ONE, floor: ONE, ceil: ONE,
  round: ONE_OR_TWO, trunc: ONE, min: ONE_OR_MORE, max: ONE_OR_MORE, hypot: ONE_OR_MORE,
  fact: ONE, gamma: ONE, pow: TWO, mod: TWO,
});

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
    arity: FLOAT_ARITY,
    binops: FLOAT_BINOPS,
    unops: FLOAT_UNOPS,
    postops: FLOAT_POSTOPS,
  };
}

/**
 * A binary word operation: both operands read as words of the scope's size
 * and sign, the result in the programmer environment's canonical form (a
 * `Number` while it is safe, the exact `bigint` past that).
 * @param {(a: bigint, b: bigint, bits: number, signed: boolean) => bigint} op
 * @returns {(a: number | bigint, b: number | bigint, scope: any) => number | bigint}
 */
function wordBinop(op) {
  return (a, b, s) => fit(op(big(a, s), big(b, s), s?.wordBits ?? 32, s?.signed ?? false));
}

/**
 * A binary word operation whose second operand is a count (`<<`, `>>`,
 * `shl`, `shr`, `rol`, `ror`) rather than a word.
 * @param {(a: bigint, n: bigint, bits: number, signed: boolean) => bigint} op
 * @returns {(a: number | bigint, n: number | bigint, scope: any) => number | bigint}
 */
function countBinop(op) {
  return (a, n, s) => fit(op(big(a, s), integer(n), s?.wordBits ?? 32, s?.signed ?? false));
}

/**
 * The function form of a binary operation.
 * @param {(a: number | bigint, b: number | bigint, scope: any) => number | bigint} op
 * @returns {(args: (number | bigint)[], scope: any) => number | bigint}
 */
function asFunction(op) {
  return (a, s) => op(a[0], a[1], s);
}

/**
 * A float function applied to `Number` arguments, as the programmer
 * environment passes it a value that may be an exact `bigint`.
 * @param {(args: number[], scope: any) => number} fn
 * @returns {(args: (number | bigint)[], scope: any) => number}
 */
function floating(fn) {
  return (a, s) => fn(a.some((v) => typeof v === 'bigint') ? a.map(toNumber) : /** @type {number[]} */ (a), s);
}

/**
 * A function that is the identity on a whole number: a `bigint` given alone
 * is its own answer, anything else is the float function's.
 * @param {(args: number[], scope: any) => number} fn
 * @returns {(args: (number | bigint)[], scope: any) => number | bigint}
 */
function wholeIdentity(fn) {
  const float = floating(fn);
  return (a, s) => (a.length === 1 && typeof a[0] === 'bigint' ? a[0] : float(a, s));
}

const wordAnd = wordBinop(wAnd);
const wordOr = wordBinop(wOr);
const wordShl = countBinop(wShl);
const wordShr = countBinop(wShr);

/**
 * @param {number | bigint} a @param {any} s
 * @returns {number | bigint}
 */
function wordNot(a, s) {
  return fit(wNot(big(a, s), s?.wordBits ?? 32, s?.signed ?? false));
}

/** @type {Record<string, (a: any, scope: any) => number | bigint>} */
const WORD_UNOPS = { '-': negate, '+': (a) => a, '~': wordNot };

/**
 * Word-aware programmer functions: `Number` while the result is safe, an
 * exact `bigint` past 2^53.
 * @type {Record<string, (args: any[], scope: any) => number | bigint>}
 */
const WORD_FUNCS = {
  ...Object.fromEntries(Object.entries(FLOAT_FUNCS).map(([name, fn]) => [name, floating(fn)])),
  abs: (a) => magnitude(a[0], mathf64_abs),
  min: (a) => extreme(a, true, mathf64_min),
  max: (a) => extreme(a, false, mathf64_max),
  trunc: wholeIdentity(FLOAT_FUNCS.trunc),
  floor: wholeIdentity(FLOAT_FUNCS.floor),
  ceil: wholeIdentity(FLOAT_FUNCS.ceil),
  round: wholeIdentity(FLOAT_FUNCS.round),
  pow: asFunction(power),
  and: asFunction(wordAnd),
  or: asFunction(wordOr),
  xor: asFunction(wordBinop(wXor)),
  not: (a, s) => wordNot(a[0], s),
  shl: asFunction(wordShl),
  shr: asFunction(wordShr),
  rol: asFunction(countBinop(wRol)),
  ror: asFunction(countBinop(wRor)),
  mod: asFunction(wordBinop(wMod)),
};

/** The word functions' arity: each takes its fixed operands. */
const WORD_ARITY = Object.freeze({
  ...FLOAT_ARITY,
  and: TWO, or: TWO, xor: TWO, not: ONE, shl: TWO, shr: TWO, rol: TWO, ror: TWO, mod: TWO,
});

/** @type {Record<string, (a: any, b: any, scope: any) => number | bigint>} */
const WORD_BINOPS = {
  '+': add,
  '-': subtract,
  '*': multiply,
  '/': divide,
  '^': power,
  '&': wordAnd,
  '|': wordOr,
  '<<': wordShl,
  '>>': wordShr,
};

/** @type {Record<string, (a: any, scope: any) => number | bigint>} */
const WORD_POSTOPS = {
  '!': (a) => Float64.factorial(toNumber(a)),
  '%': (a) => divide(a, 100),
};

/**
 * The programmer environment: word-masked bitwise operators plus the
 * `and/or/xor/not/shl/shr/rol/ror/mod` functions, read against the
 * scope's `wordBits`/`signed`. Its integers are exact past 2^53 (`exact`):
 * a value is a `number` while it is safe and a `bigint` beyond, so
 * `0xFFFFFFFFFFFFFFFF`, `2^64 - 1` and `not(0)` on a 64-bit word are the
 * words they name. Fractions, roots and every other float operation are
 * the float answers they always were.
 * @returns {any}
 */
export function programmerEnv() {
  return {
    constants: { ...CONSTANTS },
    exact: true,
    funcs: WORD_FUNCS,
    arity: WORD_ARITY,
    binops: WORD_BINOPS,
    unops: WORD_UNOPS,
    postops: WORD_POSTOPS,
  };
}
