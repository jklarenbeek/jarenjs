//@ts-check
/**
 * @file `check()` — a cross-field rule captured into the validator's
 * `$query` keyword through the chain's own recording proxy. This is the
 * only module of the pen that imports the capture machine: the value
 * proxy is rooted at `$` (the instance the keyword is evaluated at),
 * and the externals proxy answers exactly the two names
 * `compileQuerySchema` binds — `root` and `path` — refusing any other
 * at build time (`JL0104`), earlier than the validator's own compile
 * error and with the same meaning.
 */

import { captureExpression } from '../expression.js';
import { LinqBuildError } from '../errors.js';

/** The names the validator binds on every `$query` evaluation. */
const EXTERNALS = ['root', 'path'];

/** No parameters are declared for a rule: `p.x` cannot appear. */
const NO_PARAMS = new Set();

/**
 * The externals proxy: `x.root` and `x.path` are the two expressions the
 * capture handed us; anything else has nothing to bind to.
 * @param {any} root - the `$root` expression proxy
 * @param {any} path - the `$path` expression proxy
 */
function externalsProxy(root, path) {
  return new Proxy(Object.freeze({}), {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'root') return root;
      if (prop === 'path') return path;
      throw new LinqBuildError('JL0104',
        `a check() rule cannot bind '${prop}' — a $query evaluates with exactly two `
        + `externals, ${EXTERNALS.map((n) => `'${n}'`).join(' and ')} (the instance root `
        + 'and the current location); anything else has nothing to bind to');
    },
  });
}

/**
 * Capture one rule into a `$query` document.
 * @param {(value: any, externals: any) => any} rule - receives the value
 *   proxy (rooted at `$`) and the externals proxy `{ root, path }`
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureCheck(rule) {
  return captureExpression(
    (value, root, path) => rule(value, externalsProxy(root, path)),
    [{ doc: '$', pathable: true }, ...EXTERNALS],
    NO_PARAMS);
}
