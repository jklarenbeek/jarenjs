//@ts-check
/**
 * The charts playground boundary: a chart-definition document (JSON,
 * JSONX or JOSL) in, kind-tagged render nodes out — plus the replay
 * controller behind the engine's `stream: replay` mode.
 *
 * Dogfooding is the point of this engine: even the static path parses
 * the source through the incremental readers
 * (`createJsonxStreamReader` / `createStreamReader`), the definition is
 * validated by `@jarenjs/validate` against the package's JSON Schema,
 * and a `stream` member routes the document's own records through
 * `createStreamAdapter` — the same event path a live feed uses.
 *
 * Replay slices the source into ~48 chunks and feeds one per 80 ms
 * tick, dispatching a fresh snapshot through the normal action → state
 * → re-render loop. One controller exists at a time; `chartsSync`
 * stops it whenever the inputs change, the stream select leaves
 * 'replay', or the route leaves the charts playground.
 */

import { createStreamReader, createJsonxStreamReader } from '@jarenjs/josl';
import { JarenValidator } from '@jarenjs/validate';
import { compileChart } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import chartSchema from '@jarenjs/charts/schemas/chart-definition.schema.json' with { type: 'json' };

import { cards, code, error, callout, details, chart } from '../lib/nodes.js';
import { now, formatJson, formatMsUnscaled } from '../lib/format.js';
import { binanceInvitation } from './binance.js';

const validateDefinition = new JarenValidator({ skipErrors: false, collectErrors: true })
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

/** The static run: parse → validate → compile → nodes. */
export function runCharts(inputs) {
  if (inputs.stream === 'live') {
    // the live mode ignores the source document; nothing connects until
    // the user presses the button (the opt-in ground rule)
    return binanceInvitation();
  }
  const format = normalFormat(inputs.format);
  const events = [];
  let config;
  const t0 = now();
  try {
    config = parseWithEvents(format, String(inputs.source ?? ''), events);
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Parse error')];
  }
  const parseMs = now() - t0;
  const outcome = validateDefinition(config);
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (!valid) {
    const errs = (typeof outcome === 'object' && outcome !== null ? outcome.errors : null) ?? [];
    return [
      error({ message: 'The document is not a valid chart definition (schemas/chart-definition.schema.json).' }, 'Schema validation failed'),
      ...errs.slice(0, 5).map((e) => error({
        message: e.message ?? 'invalid',
        dataPath: e.instancePath ?? '',
        code: e.keyword,
      }, 'Validation error')),
    ];
  }
  try {
    const data = dataFor(config, events);
    const t1 = now();
    const compiled = compileChart(config, data, { theme: 'host' });
    const vnode = compiled.toVnode();
    const compileMs = now() - t1;
    const replaying = inputs.stream === 'replay';
    return [
      cards([
        { title: 'Chart', value: String(config.type), note: `${format} source, schema-valid` },
        { title: 'Parse (streaming reader)', value: formatMsUnscaled(parseMs), note: `${events.length} document-order events` },
        { title: 'Compile + render', value: formatMsUnscaled(compileMs), note: 'geometry-free AST → pure-vnode SVG' },
      ]),
      chart(null, vnode, replaying
        ? 'Replay is running: the chart rebuilds as chunks arrive below.'
        : null),
      details('Geometry-free AST (JSON)', [code(null, formatJson(compiled.ast))]),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Chart error')];
  }
}

//#region replay controller

/** @type {{timer: any}|null} the single live replay session */
let active = null;

function stopReplay() {
  if (active !== null) {
    clearInterval(active.timer);
    active = null;
  }
}

/**
 * Engine lifecycle hook (wireBoundaries): restart or stop the replay to
 * match the current inputs and route. `isActive` is true only when the
 * playground currently shows the charts engine.
 * @param {any} inputs
 * @param {(action: string, payload: any) => void} dispatch
 * @param {boolean} isActive
 */
export function chartsSync(inputs, dispatch, isActive) {
  stopReplay();
  if (!isActive || inputs.stream !== 'replay') return;
  startReplay(inputs, dispatch);
}

function startReplay(inputs, dispatch) {
  const format = normalFormat(inputs.format);
  const source = String(inputs.source ?? '');
  let config;
  try {
    config = parseWithEvents(format, source, []);
  }
  catch {
    return; // the static run already shows the parse error
  }
  if (config === null || typeof config !== 'object' || config.stream === undefined
    || (config.type !== 'line' && config.type !== 'bar')) {
    dispatch('eng/result', {
      engine: 'charts',
      result: [callout('Replay needs a streaming definition',
        "Give the document a \"stream\" member (recordPath/xField/yField…) and a 'line' or 'bar' type — see the replay examples.")],
    });
    return;
  }
  const adapter = createStreamAdapter(config.type, config.stream);
  const reader = format === 'josl'
    ? createStreamReader({ onEvent: adapter.onEvent })
    : createJsonxStreamReader({ mode: format, onEvent: adapter.onEvent });
  const chunkSize = Math.max(8, Math.ceil(source.length / 48));
  const readerName = format === 'josl' ? 'createStreamReader' : 'createJsonxStreamReader';
  let pos = 0;
  const frame = (done) => {
    const compiled = compileChart(config, adapter.getData(), { theme: 'host' });
    const pct = Math.min(100, Math.round((pos / source.length) * 100));
    dispatch('eng/result', {
      engine: 'charts',
      result: [
        cards([{
          title: 'Replay',
          value: done ? 'complete' : `${pct}%`,
          note: `${Math.min(pos, source.length)} / ${source.length} chars through ${readerName}`,
        }]),
        chart(null, compiled.toVnode(), done
          ? 'Replay complete. Records completed the moment their fields arrived — no buffering, no reparse.'
          : 'The source is fed chunk by chunk through the incremental reader; each record joins the chart when its fields complete.'),
      ],
    });
  };
  const session = { timer: null };
  session.timer = setInterval(() => {
    try {
      reader.feed(source.slice(pos, pos + chunkSize));
      pos += chunkSize;
      if (pos >= source.length) {
        reader.end();
        adapter.endDocument();
        stopReplay();
        frame(true);
        return;
      }
      frame(false);
    }
    catch (err) {
      stopReplay();
      dispatch('eng/result', { engine: 'charts', result: [error(/** @type {any} */ (err), 'Replay error')] });
    }
  }, 80);
  active = session;
}

/** Whether a replay timer is live (test hook). */
export function chartsReplayActive() {
  return active !== null;
}

//#endregion
