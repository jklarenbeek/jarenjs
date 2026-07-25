//@ts-check
/**
 * @file The scientific mode kernel: the standard keypad plus the
 * A1 transcendentals as function-insert keys, constants, factorial and an
 * angle-mode toggle. It binds the same float environment as standard —
 * the transcendentals were already in it — so no formulas live here.
 */

import { defaultEnv } from '../env.js';
import { format } from './standard.js';

/** @type {Array<Array<{label:string,k:string,tone?:string,span?:number}>>} */
export const KEYPAD = [
  [{ label: 'sin', k: 'sin(', tone: 'fn' }, { label: 'cos', k: 'cos(', tone: 'fn' }, { label: 'tan', k: 'tan(', tone: 'fn' }, { label: 'C', k: 'clear', tone: 'clear' }, { label: '⌫', k: 'back', tone: 'clear' }],
  [{ label: 'asin', k: 'asin(', tone: 'fn' }, { label: 'acos', k: 'acos(', tone: 'fn' }, { label: 'atan', k: 'atan(', tone: 'fn' }, { label: '(', k: '(' }, { label: ')', k: ')' }],
  [{ label: 'ln', k: 'ln(', tone: 'fn' }, { label: 'log', k: 'log(', tone: 'fn' }, { label: '√', k: 'sqrt(', tone: 'fn' }, { label: '7', k: '7' }, { label: '8', k: '8' }],
  [{ label: 'eˣ', k: 'exp(', tone: 'fn' }, { label: 'x!', k: '!', tone: 'op' }, { label: '^', k: '^', tone: 'op' }, { label: '9', k: '9' }, { label: '÷', k: '/', tone: 'op' }],
  [{ label: 'π', k: 'pi', tone: 'const' }, { label: 'e', k: 'e', tone: 'const' }, { label: '4', k: '4' }, { label: '5', k: '5' }, { label: '6', k: '6' }],
  [{ label: '×', k: '*', tone: 'op' }, { label: '1', k: '1' }, { label: '2', k: '2' }, { label: '3', k: '3' }, { label: '−', k: '-', tone: 'op' }],
  [{ label: '0', k: '0' }, { label: '.', k: '.' }, { label: 'ans', k: 'ans' }, { label: '+', k: '+', tone: 'op' }, { label: '=', k: 'equals', tone: 'equals' }],
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
