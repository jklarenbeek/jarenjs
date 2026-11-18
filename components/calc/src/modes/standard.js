//@ts-check
/**
 * @file The standard mode kernel: a data-driven
 * keypad descriptor, the function-binding environment the compiler uses,
 * and a display formatter. A key is `{ label, k, tone?, span?, aria? }`;
 * `k` is the token the key presses (the component's entry editor decides
 * what it writes), or a command (`equals`, `clear`, `back`). Switching mode is just a patch of `$.calc.mode`.
 */

import { formatSignificant } from '../format.js';
import { defaultEnv } from '../env.js';

/**
 * A keypad key: what it shows, the token it presses, its tone and column
 * span, and the message id of its accessible name where the label is a
 * symbol a screen reader would not read as its meaning.
 * @typedef {{ label: string, k: string, tone?: string, span?: number, aria?: string }} KeyDescriptor
 */

/** @type {Array<Array<KeyDescriptor>>} */
export const KEYPAD = [
  [{ label: 'AC', k: 'clear', tone: 'clear', aria: 'calc/key/clear' }, { label: '⌫', k: 'back', tone: 'clear', aria: 'calc/key/back' }, { label: '(', k: '(', aria: 'calc/key/open' }, { label: ')', k: ')', aria: 'calc/key/close' }],
  [{ label: '7', k: '7' }, { label: '8', k: '8' }, { label: '9', k: '9' }, { label: '÷', k: '/', tone: 'op', aria: 'calc/key/divide' }],
  [{ label: '4', k: '4' }, { label: '5', k: '5' }, { label: '6', k: '6' }, { label: '×', k: '*', tone: 'op', aria: 'calc/key/multiply' }],
  [{ label: '1', k: '1' }, { label: '2', k: '2' }, { label: '3', k: '3' }, { label: '−', k: '-', tone: 'op', aria: 'calc/key/minus' }],
  [{ label: '0', k: '0' }, { label: '.', k: '.', aria: 'calc/key/point' }, { label: '%', k: '%', aria: 'calc/key/percent' }, { label: '+', k: '+', tone: 'op', aria: 'calc/key/plus' }],
  [{ label: 'ans', k: 'ans', aria: 'calc/key/ans' }, { label: '^', k: '^', tone: 'op', aria: 'calc/key/power' }, { label: '=', k: 'equals', tone: 'equals', span: 2, aria: 'calc/key/equals' }],
];

/**
 * Format a numeric result for the display: twelve significant digits, a
 * safe integer in full, thousands grouped when `state.group` is `true`
 * (see `formatSignificant`).
 * @param {number} value @param {any} [state]
 * @returns {string}
 */
export function format(value, state) {
  return formatSignificant(value, { digits: 12, group: state?.group === true });
}

export const standardMode = {
  id: 'standard',
  label: 'Standard',
  env: defaultEnv(),
  keypad: KEYPAD,
  format,
};
