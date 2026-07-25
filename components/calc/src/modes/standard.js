//@ts-check
/**
 * @file The standard mode kernel: a data-driven
 * keypad descriptor, the function-binding environment the compiler uses,
 * and a display formatter. A key is `{ label, k, tone?, span? }`; `k` is
 * the token appended to the expression entry, or a command (`=`, `C`,
 * `back`). Switching mode is just a patch of `$.calc.mode`.
 */

import { formatNumber } from '@jarenjs/core/math';
import { defaultEnv } from '../env.js';

/** @type {Array<Array<{label:string,k:string,tone?:string,span?:number}>>} */
export const KEYPAD = [
  [{ label: 'C', k: 'clear', tone: 'clear' }, { label: '⌫', k: 'back', tone: 'clear' }, { label: '(', k: '(' }, { label: ')', k: ')' }],
  [{ label: '7', k: '7' }, { label: '8', k: '8' }, { label: '9', k: '9' }, { label: '÷', k: '/', tone: 'op' }],
  [{ label: '4', k: '4' }, { label: '5', k: '5' }, { label: '6', k: '6' }, { label: '×', k: '*', tone: 'op' }],
  [{ label: '1', k: '1' }, { label: '2', k: '2' }, { label: '3', k: '3' }, { label: '−', k: '-', tone: 'op' }],
  [{ label: '0', k: '0' }, { label: '.', k: '.' }, { label: '%', k: '%' }, { label: '+', k: '+', tone: 'op' }],
  [{ label: 'ans', k: 'ans' }, { label: '^', k: '^', tone: 'op' }, { label: '=', k: 'equals', tone: 'equals', span: 2 }],
];

/**
 * Format a numeric result for the display.
 * @param {number} value @param {any} [state]
 * @returns {string}
 */
export function format(value, state) {
  const group = state && state.group === true;
  return formatNumber(value, { notation: 'auto', precision: 12, group });
}

export const standardMode = {
  id: 'standard',
  label: 'Standard',
  env: defaultEnv(),
  keypad: KEYPAD,
  format,
};
