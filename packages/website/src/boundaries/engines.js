//@ts-check
/**
 * The shared transform-engine boundary: the site's registered-operator
 * registry, plus the two render-node transform runners (`runQuery` /
 * `runJslt`) the Project IDE runs its `query`/`jslt` files through.
 * The single-engine exploration surface itself is `@jarenjs/play`
 * (`#/play`) — this module only keeps what other live surfaces share.
 * The runners speak the reader's compiled catalog, in the words of the
 * studio that hosts them.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json';
import {
  compileJsltStylesheet,
  createJsltRegistry, mathPack, financePack, statsPack,
} from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { studioText } from '@jarenjs/studio';

import { cards, code, error, callout } from '../lib/nodes.js';
import { timed, formatJson, formatMsUnscaled } from '../lib/format.js';

const compileTypeTest = createTypeTestCompiler();

// The site mounts the built-in operator packs (math / finance / stats)
// so REGISTERED operators — $sqrt, $npv, $mean, $stddev, $percentile, …
// — run live in the play and project transform engines. They are a host
// opt-in, not part of the closed spec vocabulary: a document compiled
// WITHOUT this registry still rejects them with JQ0002. One frozen
// instance is built once, so the engines' compile caches stay keyed by
// a stable options identity. `.toOptions()` is `{ extensions,
// functions }`; `.names()` feeds the assistant's engine catalogue.
export const operatorRegistry = createJsltRegistry()
  .use(mathPack).use(financePack).use(statsPack);
const registryOptions = operatorRegistry.toOptions();

/**
 * The text function of a run's words over the reader's compiled catalog,
 * falling back to the studio's English per id.
 * @param {{ messages?: Readonly<Record<string, unknown>> | null }} options
 */
function wordsOf(options) {
  return studioText(options.messages ?? null);
}

/**
 * Parse a JSON input; returns `{ value }` or `{ node }` (an error node).
 * @param {string} text @param {string} label @param {ReturnType<typeof wordsOf>} t
 */
function parseJson(text, label, t) {
  try {
    return { value: JSON.parse(text) };
  }
  catch (err) {
    return { node: error({ message: `${label}: ${/** @type {Error} */ (err).message}` }, t('studio/run/invalid-json')) };
  }
}

/**
 * Run a query document over a data document → render nodes; never throws.
 * @param {{ query: string, data: string, externals: string }} inputs - JSON texts
 * @param {{ messages?: Readonly<Record<string, unknown>> | null }} [options] -
 *   `messages`: the reader's compiled catalog; English when absent
 */
export function runQuery(inputs, options = {}) {
  const t = wordsOf(options);
  try {
    const query = parseJson(inputs.query, 'query', t);
    if (query.node) return [query.node];
    const data = parseJson(inputs.data, 'data', t);
    if (data.node) return [data.node];
    let externals = {};
    if (inputs.externals !== '') {
      const parsed = parseJson(inputs.externals, 'externals', t);
      if (parsed.node) return [parsed.node];
      // externals are named values: anything but an object has no names to bind
      if (!isJsonObject(parsed.value)) {
        return [callout('Externals must be an object',
          'The externals input is a JSON object of name → value, one member per external the query uses.')];
      }
      externals = parsed.value;
    }
    const compiled = timed(() => compileJsonQuery(query.value, { compileTypeTest, ...registryOptions }));
    const fn = compiled.value;
    const unbound = fn.externals.filter((name) => !Object.hasOwn(externals, name));
    if (unbound.length > 0) {
      return [callout('Unbound externals',
        `This query needs externals not provided: ${unbound.join(', ')}. Add them to the externals input as JSON.`)];
    }
    const run = timed(() => fn(data.value, externals));
    const value = run.value;
    const count = value === undefined ? 0 : Array.isArray(value) ? value.length : 1;
    return [
      cards([
        { title: t('studio/run/items'), value: String(count) },
        { title: t('studio/run/compile'), value: formatMsUnscaled(compiled.ms) },
        { title: t('studio/run/run'), value: formatMsUnscaled(run.ms) },
      ]),
      code(t('studio/run/result'), value === undefined ? t('studio/run/empty-sequence') : formatJson(value)),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Query error')];
  }
}

/**
 * Run a JSLT stylesheet over a data document → render nodes; never throws.
 * @param {{ stylesheet: string, data: string }} inputs - JSON texts
 * @param {{ messages?: Readonly<Record<string, unknown>> | null }} [options] -
 *   `messages`: the reader's compiled catalog; English when absent
 */
export function runJslt(inputs, options = {}) {
  const t = wordsOf(options);
  try {
    const stylesheet = parseJson(inputs.stylesheet, 'stylesheet', t);
    if (stylesheet.node) return [stylesheet.node];
    const data = parseJson(inputs.data, 'data', t);
    if (data.node) return [data.node];
    const compiled = timed(() => compileJsltStylesheet(stylesheet.value, { compileTypeTest, ...registryOptions }));
    const run = timed(() => compiled.value(data.value));
    return [
      cards([
        { title: t('studio/run/compile'), value: formatMsUnscaled(compiled.ms) },
        { title: t('studio/run/transform'), value: formatMsUnscaled(run.ms), note: run.value === data.value ? '=== input (shared)' : null },
      ]),
      code(t('studio/run/output'), formatJson(run.value), run.value === data.value ? 'proof of no change' : null),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'JSLT error')];
  }
}
