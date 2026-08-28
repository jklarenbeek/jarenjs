//@ts-check
/**
 * @file `check()` — a cross-field rule captured into the validator's
 * `$query` keyword through the chain's own recording proxy, over the
 * shared root capture (`src/capture-root.js`): the value proxy is
 * rooted at `$` (the instance the keyword is evaluated at), and the
 * externals proxy answers exactly the two names `compileQuerySchema`
 * binds — `root` and `path` — refusing any other at build time
 * (`JL0104`), earlier than the validator's own compile error and with
 * the same meaning. The same capture, with a different externals list,
 * serves the model pen's `compute()` and the JSLT pen's `body()`.
 */

import { captureQuery } from '../capture-root.js';

/** The names the validator binds on every `$query` evaluation. */
const EXTERNALS = ['root', 'path'];

export { captureQuery };

/**
 * Capture one `check()` rule into a `$query` document: the value proxy
 * (rooted at `$`) and the externals proxy `{ root, path }`.
 * @param {(value: any, externals: any) => any} rule
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureCheck(rule) {
  return captureQuery('check()', EXTERNALS, rule);
}
