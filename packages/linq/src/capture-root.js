//@ts-check
/**
 * @file One capture over a value rooted at `$` with named externals —
 * the shared piece under every pen's query-valued member: a schema
 * `check()` rule (`root`, `path`), a model `compute()` default (no
 * externals), a JSLT rule body (`root`, `path` and the parameters the
 * body declares). The value proxy is rooted at `$`, the instance the
 * query is evaluated at; the externals proxy answers exactly the named
 * expressions and refuses any other name at build time (`JL0104`),
 * earlier than the engine's own error and with the same meaning. One
 * implementation: a pen adds an externals list, never a capture entry
 * point.
 */

import { captureExpression } from './expression.js';
import { LinqBuildError } from './errors.js';

/** No parameters are declared for a rule: `p.x` cannot appear. */
const NO_PARAMS = new Set();

/**
 * The externals proxy: exactly the named expressions the capture handed
 * us; anything else has nothing to bind to.
 * @param {string} what - the method, for the message
 * @param {readonly string[]} names - the externals bound
 * @param {readonly any[]} proxies - one expression proxy per name
 * @param {((name: string) => string) | undefined} advice - the fix, when one exists
 */
function externalsProxy(what, names, proxies, advice) {
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
        + 'anything else has nothing to bind to'
        + (advice === undefined ? '' : advice(prop)));
    },
  });
}

/**
 * Capture one rule into a query document over a value rooted at `$`,
 * with the named externals as the second argument.
 * @param {string} what - the method, for the message
 * @param {readonly string[]} externals - the externals the evaluator binds
 * @param {(value: any, externals: any) => any} rule
 * @param {{ advice?: (name: string) => string, fold?: boolean }} [options] -
 *   `advice`: appended to the `JL0104` message, how an unbound name could
 *   be declared where it can; `fold`: whether a pure data tree folds into
 *   one `$const` (the default) or is spelled as a constructor tree
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureQuery(what, externals, rule, options = {}) {
  return captureExpression(
    (value, ...bound) => rule(value, externalsProxy(what, externals, bound, options.advice)),
    [{ doc: '$', pathable: true }, ...externals],
    NO_PARAMS,
    options.fold !== false);
}
