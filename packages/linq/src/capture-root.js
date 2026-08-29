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

/** The indefinite article for a method name (`edge() select` → `an`). */
const article = (/** @type {string} */ what) =>
  ('aeiou'.includes(what.charAt(0).toLowerCase()) ? 'an' : 'a');

/**
 * The externals proxy: exactly the named expressions the capture handed
 * us; anything else has nothing to bind to.
 *
 * The message states only what this file KNOWS — how many externals the
 * evaluator binds and which — because that is all it can know: WHERE the
 * query is evaluated differs per pen (a schema rule over the instance, a
 * model default over the document being written, a flow guard over the
 * step scope at step time), and naming one pen's answer here made the
 * message contradict its own advice for every other pen. A caller that
 * has a scope to name passes it as `advice`.
 * @param {string} what - the method, for the message
 * @param {readonly string[]} names - the externals bound
 * @param {readonly any[]} proxies - one expression proxy per name
 * @param {((name: string) => string) | undefined} advice - the fix, when one exists
 * @param {string} noun - what this pen calls the callback
 */
function externalsProxy(what, names, proxies, advice, noun) {
  return new Proxy(Object.freeze({}), {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const index = names.indexOf(/** @type {string} */ (prop));
      if (index !== -1) return proxies[index];
      const bound = names.length === 0
        ? 'no externals at all'
        : `exactly ${names.length === 1 ? 'one external' : `${names.length} externals`}, `
          + `${names.map((n) => `'${n}'`).join(' and ')}`;
      throw new LinqBuildError('JL0104',
        `${article(what)} ${what} ${noun} cannot bind '${prop}' — its query evaluates with `
        + `${bound}; anything else has nothing to bind to`
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
 * @param {{ advice?: (name: string) => string, fold?: boolean, noun?: string }} [options] -
 *   `advice`: appended to the `JL0104` message — how an unbound name could
 *   be declared where it can, or what the callback's own argument already
 *   is; `fold`: whether a pure data tree folds into one `$const` (the
 *   default) or is spelled as a constructor tree; `noun`: what this pen
 *   calls the callback (`'rule'` by default; a pen with no rules passes
 *   its own word)
 * @returns {any} the captured query expression (plain JSON)
 */
export function captureQuery(what, externals, rule, options = {}) {
  const noun = options.noun ?? 'rule';
  return captureExpression(
    (value, ...bound) => rule(value, externalsProxy(what, externals, bound, options.advice, noun)),
    [{ doc: '$', pathable: true }, ...externals],
    NO_PARAMS,
    options.fold !== false);
}
