//@ts-check
/**
 * @file The programmer mode kernel. Binds the
 * word-math environment (`@jarenjs/core/math/word.js`) so `& | << >> ~`
 * and the `and/or/xor/not/shl/shr/rol/ror/mod` functions operate at the
 * chosen word size (8/16/32/64) and signedness. Literals are written with
 * `0x`/`0o`/`0b` prefixes; the display shows all four bases live.
 *
 * No formulas live here — the reusable word math is in core; this module
 * is the keypad + the four-base view derivation.
 */

import { toWord, toBase } from '@jarenjs/core/math';
import { programmerEnv } from '../env.js';
import { fit, isFiniteValue, truncated } from '../exact.js';

/** @typedef {import('../exact.js').ExactValue} ExactValue */

export const BASES = ['HEX', 'DEC', 'OCT', 'BIN'];
export const WORD_SIZES = [8, 16, 32, 64];

/** @type {Array<Array<{label:string,k:string,tone?:string,span?:number}>>} */
export const KEYPAD = [
  [{ label: 'C', k: 'clear', tone: 'clear' }, { label: '⌫', k: 'back', tone: 'clear' }, { label: '(', k: '(' }, { label: ')', k: ')' }, { label: '~', k: '~', tone: 'op' }],
  [{ label: 'A', k: 'A' }, { label: 'B', k: 'B' }, { label: '&', k: '&', tone: 'op' }, { label: '|', k: '|', tone: 'op' }, { label: 'xor', k: 'xor(', tone: 'fn' }],
  [{ label: 'C', k: 'C' }, { label: 'D', k: 'D' }, { label: '«', k: '<<', tone: 'op' }, { label: '»', k: '>>', tone: 'op' }, { label: 'mod', k: 'mod(', tone: 'fn' }],
  [{ label: 'E', k: 'E' }, { label: 'F', k: 'F' }, { label: '0x', k: '0x' }, { label: '0b', k: '0b' }, { label: '0o', k: '0o' }],
  [{ label: '7', k: '7' }, { label: '8', k: '8' }, { label: '9', k: '9' }, { label: '×', k: '*', tone: 'op' }, { label: '÷', k: '/', tone: 'op' }],
  [{ label: '4', k: '4' }, { label: '5', k: '5' }, { label: '6', k: '6' }, { label: '+', k: '+', tone: 'op' }, { label: '−', k: '-', tone: 'op' }],
  [{ label: '1', k: '1' }, { label: '2', k: '2' }, { label: '3', k: '3' }, { label: '0', k: '0' }, { label: '=', k: 'equals', tone: 'equals' }],
];

/**
 * The word a finite value stands for: truncated toward zero, then wrapped
 * to `wordBits` (two's complement when `signed`). An exact `bigint` is
 * wrapped as it is and a `Ratio` by its exact whole part; a `Number` past
 * 2^53 has already rounded.
 * @param {ExactValue} value @param {number} wordBits @param {boolean} signed
 * @returns {bigint}
 */
function wordOf(value, wordBits, signed) {
  return toWord(truncated(value), wordBits, signed);
}

/**
 * The word the display shows for `value`: a `Number` while it is safe, an
 * exact `bigint` once it is beyond 2^53, so what a programmer-mode result
 * commits as `ans` is the value the user saw rather than the unwrapped
 * float. A non-finite value has no word and is returned as it is.
 * @param {ExactValue} value @param {number} [wordBits] @param {boolean} [signed]
 * @returns {number | bigint}
 */
export function wordExact(value, wordBits = 32, signed = false) {
  return isFiniteValue(value) ? fit(wordOf(value, wordBits, signed)) : /** @type {number} */ (value);
}

/**
 * The four-base view of a value, a `Number`, an exact `bigint` or a `Ratio`.
 * @param {ExactValue} value @param {number} wordBits @param {boolean} signed
 * @returns {{ hex: string, dec: string, oct: string, bin: string }}
 */
export function viewsOf(value, wordBits, signed) {
  if (!isFiniteValue(value)) return { hex: '—', dec: '—', oct: '—', bin: '—' };
  const w = wordOf(value, wordBits, signed);
  // unsigned view for hex/oct/bin so the two's-complement bit pattern shows
  const u = toWord(w, wordBits, false);
  return {
    hex: toBase(u, 16, { upper: true, group: 4 }),
    dec: toBase(w, 10),
    oct: toBase(u, 8, { group: 3 }),
    bin: toBase(u, 2, { group: 4, pad: wordBits }),
  };
}

/**
 * The live four-base view of an integer value at the given word size.
 * @param {number} value @param {number} [wordBits] @param {boolean} [signed]
 * @returns {{ hex: string, dec: string, oct: string, bin: string }}
 */
export function wordViews(value, wordBits = 32, signed = false) {
  return viewsOf(value, wordBits, signed);
}

/**
 * The primary display of a value, a `Number`, an exact `bigint` or a
 * `Ratio`, in the currently-selected base.
 * @param {ExactValue} value @param {any} [state]
 * @returns {string}
 */
export function formatWord(value, state) {
  const bits = state?.wordBits ?? 32;
  const signed = state?.signed ?? false;
  const base = state?.base ?? 'DEC';
  const v = viewsOf(value, bits, signed);
  return base === 'HEX' ? '0x' + v.hex : base === 'OCT' ? '0o' + v.oct : base === 'BIN' ? '0b' + v.bin : v.dec;
}

/**
 * Format the primary display in the currently-selected base.
 * @param {number} value @param {any} [state]
 * @returns {string}
 */
export function format(value, state) {
  return formatWord(value, state);
}

export const programmerMode = {
  id: 'programmer',
  label: 'Programmer',
  env: programmerEnv(),
  keypad: KEYPAD,
  format,
  bases: BASES,
  wordSizes: WORD_SIZES,
};
