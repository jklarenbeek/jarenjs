//@ts-check
/**
 * The shared transform-engine boundary: the site's registered-operator
 * registry, plus the two render-node transform runners (`runQuery` /
 * `runJslt`) the Project IDE runs its `query`/`jslt` files through.
 * The single-engine exploration surface itself is `@jarenjs/play`
 * (`#/play`) — this module only keeps what other live surfaces share.
 */

import { compileJsonQuery } from '@jarenjs/json';
import {
  compileJsltStylesheet,
  createJsltRegistry, mathPack, financePack, statsPack,
} from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { cards, code, error, callout } from '../lib/nodes.js';
import { now, formatJson, formatMsUnscaled } from '../lib/format.js';

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

/** Parse a JSON input; returns `{ value }` or `{ node }` (an error node). */
function parseJson(text, label) {
  try {
    return { value: JSON.parse(text) };
  }
  catch (err) {
    return { node: error({ message: `${label}: ${/** @type {Error} */ (err).message}` }, 'Invalid JSON') };
  }
}

function timed(fn) {
  const start = now();
  const value = fn();
  return { value, ms: now() - start };
}

/**
 * Run a query document over a data document → render nodes; never throws.
 * @param {{ query: string, data: string, externals: string }} inputs - JSON texts
 */
export function runQuery(inputs) {
  try {
    const query = parseJson(inputs.query, 'query');
    if (query.node) return [query.node];
    const data = parseJson(inputs.data, 'data');
    if (data.node) return [data.node];
    let externals = {};
    if (inputs.externals !== '') {
      const parsed = parseJson(inputs.externals, 'externals');
      if (parsed.node) return [parsed.node];
      externals = parsed.value;
    }
    const compiled = timed(() => compileJsonQuery(query.value, { compileTypeTest, ...registryOptions }));
    const fn = compiled.value;
    const unbound = fn.externals.filter((name) => !(name in externals));
    if (unbound.length > 0) {
      return [callout('Unbound externals',
        `This query needs externals not provided: ${unbound.join(', ')}. Add them to the externals input as JSON.`)];
    }
    const run = timed(() => fn(data.value, externals));
    const value = run.value;
    const count = value === undefined ? 0 : Array.isArray(value) ? value.length : 1;
    return [
      cards([
        { title: 'Items', value: String(count) },
        { title: 'Compile', value: formatMsUnscaled(compiled.ms) },
        { title: 'Run', value: formatMsUnscaled(run.ms) },
      ]),
      code('Result', value === undefined ? '(empty sequence)' : formatJson(value)),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Query error')];
  }
}

/**
 * Run a JSLT stylesheet over a data document → render nodes; never throws.
 * @param {{ stylesheet: string, data: string }} inputs - JSON texts
 */
export function runJslt(inputs) {
  try {
    const stylesheet = parseJson(inputs.stylesheet, 'stylesheet');
    if (stylesheet.node) return [stylesheet.node];
    const data = parseJson(inputs.data, 'data');
    if (data.node) return [data.node];
    const compiled = timed(() => compileJsltStylesheet(stylesheet.value, { compileTypeTest, ...registryOptions }));
    const run = timed(() => compiled.value(data.value));
    return [
      cards([
        { title: 'Compile', value: formatMsUnscaled(compiled.ms) },
        { title: 'Transform', value: formatMsUnscaled(run.ms), note: run.value === data.value ? '=== input (shared)' : null },
      ]),
      code('Output', formatJson(run.value), run.value === data.value ? 'proof of no change' : null),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'JSLT error')];
  }
}
