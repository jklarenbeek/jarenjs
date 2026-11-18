//@ts-check
/**
 * @file The scientific mode kernel: the standard keypad plus the
 * A1 transcendentals as function-insert keys, constants, factorial and an
 * angle-mode toggle. It binds the same float environment as standard —
 * the transcendentals were already in it — so no formulas live here.
 */

import { defaultEnv } from '../env.js';
import { format } from './standard.js';

/** @type {Array<Array<import('./standard.js').KeyDescriptor>>} */
export const KEYPAD = [
  [{ label: 'sin', k: 'sin(', tone: 'fn', aria: 'calc/key/sin' }, { label: 'cos', k: 'cos(', tone: 'fn', aria: 'calc/key/cos' }, { label: 'tan', k: 'tan(', tone: 'fn', aria: 'calc/key/tan' }, { label: 'AC', k: 'clear', tone: 'clear', aria: 'calc/key/clear' }, { label: '⌫', k: 'back', tone: 'clear', aria: 'calc/key/back' }],
  [{ label: 'asin', k: 'asin(', tone: 'fn', aria: 'calc/key/asin' }, { label: 'acos', k: 'acos(', tone: 'fn', aria: 'calc/key/acos' }, { label: 'atan', k: 'atan(', tone: 'fn', aria: 'calc/key/atan' }, { label: '(', k: '(', aria: 'calc/key/open' }, { label: ')', k: ')', aria: 'calc/key/close' }],
  [{ label: 'ln', k: 'ln(', tone: 'fn', aria: 'calc/key/ln' }, { label: 'log', k: 'log(', tone: 'fn', aria: 'calc/key/log' }, { label: '√', k: 'sqrt(', tone: 'fn', aria: 'calc/key/sqrt' }, { label: '7', k: '7' }, { label: '8', k: '8' }],
  [{ label: 'eˣ', k: 'exp(', tone: 'fn', aria: 'calc/key/exp' }, { label: 'x!', k: '!', tone: 'op', aria: 'calc/key/factorial' }, { label: '^', k: '^', tone: 'op', aria: 'calc/key/power' }, { label: '9', k: '9' }, { label: '÷', k: '/', tone: 'op', aria: 'calc/key/divide' }],
  [{ label: 'π', k: 'pi', tone: 'const', aria: 'calc/key/pi' }, { label: 'e', k: 'e', tone: 'const', aria: 'calc/key/e' }, { label: '4', k: '4' }, { label: '5', k: '5' }, { label: '6', k: '6' }],
  [{ label: '×', k: '*', tone: 'op', aria: 'calc/key/multiply' }, { label: '1', k: '1' }, { label: '2', k: '2' }, { label: '3', k: '3' }, { label: '−', k: '-', tone: 'op', aria: 'calc/key/minus' }],
  [{ label: '0', k: '0' }, { label: '.', k: '.', aria: 'calc/key/point' }, { label: 'ans', k: 'ans', aria: 'calc/key/ans' }, { label: '+', k: '+', tone: 'op', aria: 'calc/key/plus' }, { label: '=', k: 'equals', tone: 'equals', aria: 'calc/key/equals' }],
];

export const scientificMode = {
  id: 'scientific',
  label: 'Scientific',
  env: defaultEnv(),
  keypad: KEYPAD,
  format,
  /** angle modes offered by the toggle */
  angleModes: ['rad', 'deg', 'grad'],
};
