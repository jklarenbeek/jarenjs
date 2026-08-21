//@ts-check
/**
 * The charts boundary: the static renderer behind the play `charts`
 * engine (the hybrid seam in @jarenjs/play).
 *
 * Dogfooding is the point: even this static path parses the source
 * through the incremental readers (`createJsonxStreamReader` /
 * `createStreamReader`), the definition is validated by
 * `@jarenjs/validate` against the package's JSON Schema, and a `stream`
 * member routes the document's own records through
 * `createStreamAdapter` — the same event path a live feed uses. The
 * LIVE feed itself is the #/charts page (boundaries/binance.js).
 */

import { createStreamReader, createJsonxStreamReader } from '@jarenjs/josl';
import { JarenValidator } from '@jarenjs/validate';
import { OUR_SCHEMA_OPTIONS } from '../lib/schema-options.js';
import { compileChart } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import chartSchema from '@jarenjs/charts/schemas/chart-definition.schema.json' with { type: 'json' };

const validateDefinition = new JarenValidator(OUR_SCHEMA_OPTIONS)
  .compile(chartSchema);

/** Parse a definition through the streaming readers, buffering events. */
function parseWithEvents(format, text, events) {
  const sink = (e) => events.push(e);
  const reader = format === 'josl'
    ? createStreamReader({ onEvent: sink })
    : createJsonxStreamReader({ mode: format, onEvent: sink });
  reader.feed(text);
  return reader.end();
}

/** The chart data for a definition: inline fields, or — when a
 * `stream` member maps records — the buffered events replayed through
 * the stream adapter (the exact path a live feed takes). */
function dataFor(config, events) {
  if (config === null || typeof config !== 'object' || config.stream === undefined
    || (config.type !== 'line' && config.type !== 'bar')) {
    return config;
  }
  const adapter = createStreamAdapter(config.type, config.stream);
  for (const event of events) adapter.onEvent(event);
  adapter.endDocument();
  return adapter.getData();
}

function normalFormat(value) {
  return value === 'josl' || value === 'jsonx' ? value : 'json';
}

/**
 * The STATIC chart renderer for play's `charts` engine: a definition
 * string + `{ format }` in, the pure-vnode SVG out — parse →
 * schema-validate → compile → toVnode. Throws on a parse or schema
 * failure so play lands an honest error Result.
 * @param {string} source
 * @param {{ format?: string }} [config]
 * @returns {any} the chart's SVG vnode
 */
export function chartRenderer(source, config) {
  const format = normalFormat(config?.format);
  // parse + schema-check + compile is the COMPILE phase; turning the
  // geometry-free AST into SVG vnodes is the RUN. Play reports whichever
  // halves a renderer measures, so measure both rather than hand it one
  // wall-clock number it would have to attribute by guessing.
  const t0 = performance.now();
  const events = [];
  const definition = parseWithEvents(format, String(source ?? ''), events);
  const outcome = validateDefinition(definition);
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (!valid) throw new Error('not a valid chart definition (schemas/chart-definition.schema.json)');
  const compiled = compileChart(definition, dataFor(definition, events), { theme: 'host' });
  const t1 = performance.now();
  const vnode = compiled.toVnode();
  return { vnode, compileMs: t1 - t0, runMs: performance.now() - t1 };
}
