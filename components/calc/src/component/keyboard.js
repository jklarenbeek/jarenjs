//@ts-check
/**
 * @file Typing on the calculator: a physical key mapped to the keypad key it
 * stands for, and the host listener that presses it while the keypad has
 * focus. The listener is host code because only it can tell the keys the
 * calculator takes (their browser default is suppressed: Enter on a focused
 * keypad button evaluates instead of pressing that button again, `/` opens
 * no quick find) from those it must leave alone (Tab, Space on a focused
 * button, Enter on a button that is no keypad key, any shortcut with Ctrl,
 * Meta or Alt).
 */

import { MODE_BY_ID } from '../modes/index.js';

/** The commands every keypad mode takes from the keyboard. */
const COMMAND_KEYS = Object.freeze({ Enter: 'equals', '=': 'equals', Backspace: 'back', Escape: 'clear', Delete: 'clear' });

/** A physical key that names another keypad token. */
const ALIASES = Object.freeze({ ',': '.', '<': '<<', '>': '>>' });

/** The tokens each mode's keypad presses, by mode id. @type {Map<string, Set<string>>} */
const KEYS_BY_MODE = new Map();

/**
 * The tokens a mode's keypad presses.
 * @param {string} mode
 * @returns {Set<string> | null} `null` for a mode without a keypad
 */
function keysOf(mode) {
  let keys = KEYS_BY_MODE.get(mode);
  if (keys === undefined) {
    const desc = MODE_BY_ID[mode];
    if (!desc || !desc.keypad) return null;
    keys = new Set(desc.keypad.flat().map((/** @type {any} */ key) => key.k));
    KEYS_BY_MODE.set(mode, keys);
  }
  return keys;
}

/**
 * The keypad token a physical key stands for in `mode`, or `null` when the
 * mode's keypad has no such key (a mode without a keypad takes none). `,`
 * and `.` are both the point. In the programmer mode a letter `a`-`f` is its
 * hex digit and `%` is `mod`; in the scientific mode `;` separates a
 * function's arguments.
 * @param {string} key a `KeyboardEvent.key`
 * @param {string} mode
 * @returns {string | null}
 * @example
 * calcKeyOf('Enter', 'standard'); // 'equals'
 * calcKeyOf('c', 'programmer');   // 'C'
 */
export function calcKeyOf(key, mode) {
  const keys = keysOf(mode);
  if (keys === null || typeof key !== 'string') return null;
  if (Object.hasOwn(COMMAND_KEYS, key)) return COMMAND_KEYS[/** @type {keyof typeof COMMAND_KEYS} */ (key)];
  let token = Object.hasOwn(ALIASES, key) ? ALIASES[/** @type {keyof typeof ALIASES} */ (key)] : key;
  if (mode === 'programmer') {
    if (/^[a-f]$/i.test(token)) token = token.toUpperCase();
    else if (token === '%') token = 'mod';
  }
  // the scientific functions take two arguments (`log(8; 2)`): `;` separates
  // them, since `,` is the point for a reader whose decimal sign it is
  if (mode === 'scientific' && token === ';') return ',';
  return keys.has(token) ? token : null;
}

/**
 * Press keypad keys from the keyboard: a `keydown` listener on `root` (the
 * document, or an element holding the calculator) that acts on a key only
 * while focus is inside the keypad region (`.calc-pad`, which takes focus
 * itself), so a form field of the financial, converter or plot panel never
 * types into the calculator. A press in the region also moves focus there
 * when nothing in it holds focus (a browser that does not focus a clicked
 * button), so typing continues after a click.
 * @param {any} root an `EventTarget`: `document` or an element
 * @param {{ getState: () => any, dispatch: (name: string, payload?: any) => void }} app
 * @returns {() => void} removes the listeners
 * @example
 * const unbind = bindCalcKeyboard(document, app);
 */
export function bindCalcKeyboard(root, app) {
  /** @param {any} event */
  const onKey = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target;
    if (target == null || typeof target.closest !== 'function' || target.closest('.calc-pad') === null) return;
    const k = calcKeyOf(event.key, app.getState()?.calc?.mode);
    if (k === null) return;
    // Enter on a button of the region that is no keypad key (an angle, a
    // word size, M+) presses that button, as Enter does
    if (event.key === 'Enter' && target.tagName === 'BUTTON' && target.closest('.calc-keypad') === null) return;
    event.preventDefault();
    app.dispatch('calc/key', { k });
  };
  /** @param {any} event */
  const onPress = (event) => {
    const target = event.target;
    const pad = target != null && typeof target.closest === 'function' ? target.closest('.calc-pad') : null;
    const active = pad?.ownerDocument?.activeElement;
    if (pad !== null && typeof pad.focus === 'function' && !(active != null && pad.contains(active))) pad.focus({ preventScroll: true });
  };
  root.addEventListener('keydown', onKey);
  root.addEventListener('pointerdown', onPress);
  return () => {
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onPress);
  };
}
