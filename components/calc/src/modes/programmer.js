//@ts-check
/**
 * @file The programmer mode kernel (design decision D6). Binds the
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
 * The live four-base view of an integer value at the given word size.
 * @param {number} value @param {number} [wordBits] @param {boolean} [signed]
 * @returns {{ hex: string, dec: string, oct: string, bin: string }}
 */
export function wordViews(value, wordBits = 32, signed = false) {
  if (!Number.isFinite(value)) return { hex: '—', dec: '—', oct: '—', bin: '—' };
  const w = toWord(BigInt(Math.trunc(value)), wordBits, signed);
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
 * Format the primary display in the currently-selected base.
 * @param {number} value @param {any} [state]
 * @returns {string}
 */
export function format(value, state) {
  const bits = state?.wordBits ?? 32;
  const signed = state?.signed ?? false;
  const base = state?.base ?? 'DEC';
  const v = wordViews(value, bits, signed);
  return base === 'HEX' ? '0x' + v.hex : base === 'OCT' ? '0o' + v.oct : base === 'BIN' ? '0b' + v.bin : v.dec;
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
