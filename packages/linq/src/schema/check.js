//@ts-check
/**
 * @file `check()` — a cross-field rule captured into the validator's
 * `$query` keyword through the chain's own recording proxy. This is the
 * only module of the pen that imports the capture machine: the value
 * proxy is rooted at `$` (the instance the keyword is evaluated at),
 * and the externals proxy answers exactly the two names
 * `compileQuerySchema` binds — `root` and `path` — refusing any other
 * at build time (`JL0104`), earlier than the validator's own compile
 * error and with the same meaning. The same capture, with a different
 * externals list, serves a later pen's query-valued members.
 */

import { captureExpression } from '../expression.js';
import { LinqBuildError } from '../errors.js';

/** The names the validator binds on every `$query` evaluation. */
const EXTERNALS = ['root', 'path'];

/** No parameters are declared for a rule: `p.x` cannot appear. */
const NO_PARAMS = new Set();

/**
 * The externals proxy: exactly the named expressions the capture handed
 * us; anything else has nothing to bind to.
 * @param {string} what - the method, for the message
 * @param {readonly string[]} names - the externals bound
 * @param {readonly any[]} proxies - one expression proxy per name
 */
function externalsProxy(what, names, proxies) {
  return new Proxy(Object.freeze({}), {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const index = names.indexOf(/** @type {string} */ (prop));
      if (index !== -1) return proxies[index];
      const bound = names.length === 0
        ? 'no externals — it sees the document being written and nothing else'
        : `exactly ${names.length === 1 ? 'one external' : `${names.length} externals`}, `
          + `${names.map((n) => `'${n}'`).join(' and ')}`;
      throw new LinqBuildError('JL0104',
        `a ${what} rule cannot bind '${prop}' — its query evaluates with ${bound}; `
        + 'anything else has nothing to bind to');
    },
  });
}

/**
 * Capture one rule into a query document over a value rooted at `$`,
 * with the named externals as the second argument.
 * @param {string} what - the method, for the message
 * @param {readonly string[]} externals - the externals the evaluator binds
 * @param {(value: any, externals: any) => any} rule
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureQuery(what, externals, rule) {
  return captureExpression(
    (value, ...bound) => rule(value, externalsProxy(what, externals, bound)),
    [{ doc: '$', pathable: true }, ...externals],
    NO_PARAMS);
}

/**
 * Capture one `check()` rule into a `$query` document: the value proxy
 * (rooted at `$`) and the externals proxy `{ root, path }`.
 * @param {(value: any, externals: any) => any} rule
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureCheck(rule) {
  return captureQuery('check()', EXTERNALS, rule);
}
