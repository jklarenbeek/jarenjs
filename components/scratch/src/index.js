//@ts-check
/**
 * @file `@jarenjs/scratch` — a JSON-engine scratchpad. Pick an engine, feed
 * it a source input and one or more datasets, and watch it run — a way to
 * understand an engine standalone before composing it in the studio.
 *
 * The model (SCRATCH-FORMAT.md): each engine is a DESCRIPTOR — the panes it
 * consumes (`sourcePanes` = the input; `dataPanes` = the JSON it runs
 * against, possibly none) plus a pure `run`. Each EXAMPLE presets those
 * source panes plus a LIST of datasets: 0 = the engine takes no data
 * (markdown/mermaid), 1 = one dataset, N = a dataset switcher (the same
 * source over several shapes). The engine registry and the example library
 * fill in over the next orders; this is the headless core the component
 * renders.
 */

import { ENGINE_LIST } from './engines.js';

/**
 * @typedef {Object} EnginePane
 * @property {string} key - the pane's id (e.g. 'selector', 'data')
 * @property {string} label
 * @property {'code' | 'text'} [control]
 */

/**
 * @typedef {Object} ScratchResult
 * @property {boolean} ok
 * @property {string} output - the formatted result (empty on error)
 * @property {{ compileMs: number, runMs: number } | null} timing
 * @property {{ message: string, code?: string, path?: string } | null} error
 */

/**
 * @typedef {Object} EngineDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string} [lead] - one line describing the engine
 * @property {EnginePane[]} sourcePanes - the engine INPUT pane(s)
 * @property {EnginePane[]} dataPanes - the JSON it runs against (may be [])
 * @property {(source: Record<string, string>, data: Record<string, string>, options?: { operators?: any }) => ScratchResult} run
 */

/**
 * @typedef {Object} ScratchExample
 * @property {string} id
 * @property {string} label
 * @property {string} engine - an engine id
 * @property {Record<string, string>} source - presets the source pane(s)
 * @property {Array<{ label: string, data: Record<string, string> }>} datasets
 */

/** The registered engines, by id. */
export const ENGINES = Object.freeze(/** @type {Record<string, EngineDescriptor>} */ (
  Object.fromEntries(ENGINE_LIST.map((e) => [e.id, e]))));

/** The ids of the registered engines, in registration order. */
export function engineIds() {
  return ENGINE_LIST.map((e) => e.id);
}

/** The curated example library. Filled by `src/examples/*` (next order). */
export const EXAMPLES = Object.freeze(/** @type {ScratchExample[]} */ ([]));

/**
 * Run one engine over a source + data. An unknown engine (or a throwing
 * runner) yields an error Result — this never throws.
 * @param {string} engineId
 * @param {Record<string, string>} source
 * @param {Record<string, string>} data
 * @param {{ operators?: any }} [options] - a host operator registry for query/jslt
 * @returns {ScratchResult}
 */
export function runExample(engineId, source, data, options = {}) {
  const engine = ENGINES[engineId];
  if (engine === undefined) {
    return { ok: false, output: '', timing: null, error: { message: `unknown engine: ${engineId}` } };
  }
  try {
    return engine.run(source ?? {}, data ?? {}, options);
  }
  catch (err) {
    return { ok: false, output: '', timing: null, error: { message: String(/** @type {any} */ (err)?.message ?? err) } };
  }
}
