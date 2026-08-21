//@ts-check
/**
 * @file `@jarenjs/play` — a JSON-engine playground. Pick an engine, feed
 * it a source input and one or more datasets, and watch it run — a way to
 * understand an engine standalone before composing it in the studio.
 *
 * The model (PLAY-FORMAT.md): each engine is a DESCRIPTOR — the panes it
 * consumes (`sourcePanes` = the input; `dataPanes` = the JSON it runs
 * against, possibly none) plus a pure `run`. Each EXAMPLE presets those
 * source panes plus a LIST of datasets: 0 = the engine takes no data
 * (markdown/mermaid), 1 = one dataset, N = a dataset switcher (the same
 * source over several shapes). The engine registry and the example library
 * fill in over the next orders; this is the headless core the component
 * renders.
 */

import { ENGINE_LIST } from './engines.js';
import { EXAMPLE_LIST } from './examples.js';

/**
 * @typedef {Object} EnginePane
 * @property {string} key - the pane's id (e.g. 'selector', 'data')
 * @property {string} label
 * @property {'code' | 'text'} [control]
 */

/**
 * @typedef {Object} OptionPane
 * A live select above the editors — a mode an engine runs in (JOSL vs TOML,
 * CSV strict vs repair). Its value lives in the host's `config` slice.
 * @property {string} key
 * @property {string} label
 * @property {Array<{ value: string, label: string }>} choices
 * @property {string} default - the value used until the user picks another
 */

/**
 * @typedef {Object} Panel
 * A single result SCREEN. Every ok run yields at least one; a multi-screen
 * engine (CSV: a summary note, the parsed table, the CSV round-trip) yields
 * several, which the component shows behind a tab strip.
 * @property {string} id - unique within the result (the tab key)
 * @property {string} [label] - the tab label (defaults to `id`)
 * @property {'code' | 'view' | 'table' | 'note' | 'cards'} kind
 * @property {'simple' | 'deep'} [depth] - `deep` panels are the engine's rich
 *   explainers, hidden until the student drills in via the depth toggle;
 *   defaults to `simple` (the calm default view)
 * @property {string} [text] - `code` / `note`: the text body
 * @property {any} [vnode] - `view`: a host-rendered vnode, spliced verbatim
 * @property {string[]} [columns] - `table`: the header labels
 * @property {Array<Array<any>>} [rows] - `table`: cells, row-major
 * @property {'ok' | 'warn' | 'info'} [tone] - `note`: the callout tone
 * @property {Array<{ title: string, value: string, note?: string }>} [items]
 *   `cards`: a row of stat cards (matches, compile/run timings, …)
 */

/**
 * The error half of a Result: what the compiler said, plus WHERE — in the
 * format's own fields, so the view can point at the pane and the location
 * rather than only quoting the message. Every location field is present
 * exactly when the compiler stated it (a field is never fabricated), and
 * `pane` names the editor the location points into; a location into a
 * document the learner never typed (XQuery's generated query document) has
 * no pane. See PLAY-FORMAT §2.
 * @typedef {Object} PlayError
 * @property {string} message - the compiler's message, verbatim (a coded
 *   error composes `code: reason at path` itself)
 * @property {string} [code] - the stable diagnosis code, when there is one
 * @property {string} [pane] - the pane KEY (source or data) the error is
 *   about: the source pane for a compile or run failure, the data pane
 *   whose JSON did not parse
 * @property {string} [path] - JSON Pointer into that pane's DOCUMENT (a
 *   coded error's `docPath`: the failing patch operation, the query
 *   construct, the stylesheet rule)
 * @property {string} [dataPath] - JSON Pointer into the DATA the document
 *   was applied to, when a runtime error blames both (a patch operation
 *   AND the target location it failed at)
 * @property {number} [position] - 0-based offset into that pane's TEXT
 *   (the syntax family: a JSONPath selector, a JSON Pointer, an XQuery)
 * @property {number} [line] - 1-based line (the JOSL / CSV family)
 * @property {number} [column] - 1-based column (with `line`)
 */

/**
 * @typedef {Object} PlayResult
 * @property {boolean} ok
 * @property {{ compileMs: number, runMs: number } | null} timing
 * @property {PlayError | null} error - null on an ok run
 * @property {Panel[]} panels - the result screens (`[]` on error); a single
 *   `code` panel for most engines, several for the richer ones
 */

/**
 * @typedef {Object} EngineDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string} [lead] - one line describing the engine
 * @property {EnginePane[]} sourcePanes - the engine INPUT pane(s)
 * @property {EnginePane[]} dataPanes - the JSON it runs against (may be [])
 * @property {OptionPane[]} [optionPanes] - live mode selects (may be absent)
 * @property {(source: Record<string, string>, data: Record<string, string>, options?: RunOptions) => PlayResult | Promise<PlayResult>} run
 *   most engines answer synchronously; an engine whose run resolves real
 *   promises (the contract engine's dispatch panel) answers a thenable
 *   Result, which `runExample` passes through with the same never-throw
 *   contract (a rejection settles into an error Result)
 */

/**
 * @typedef {Object} RunOptions
 * @property {any} [operators] - a host operator registry ({ toOptions() }) for query/jslt/jtlt
 * @property {Record<string, string>} [config] - the current option-pane values
 * @property {Record<string, (source: string, config?: any) => any>} [renderers]
 *   host-injected vnode renderers keyed by engine id — the visual engines
 *   (markdown/mermaid/charts) delegate their rendering here (the hybrid seam),
 *   so the package owns the descriptors + examples but stays dependency-light.
 *   A renderer receives the source text plus its second argument — the
 *   option-pane config for the visual engines, the PARSED data document for
 *   `mdx` — and returns the preview vnode, or `{ vnode, deep }` where `deep`
 *   is extra `Panel`s (AST, canonical round-trip) the host derives — shown
 *   only behind the depth toggle
 * @property {(schemaText: string, data: any, locale: string) => { schemaError: string|null, draft: string, compileMs: number|null, validateMs: number|null, valid: boolean|null, errors: any[] }} [validate]
 *   host-injected JSON Schema validator (the same seam) — the `validate`
 *   engine delegates here so @jarenjs/validate + the locale packs stay in the host
 */

/**
 * @typedef {Object} PlayExample
 * @property {string} id
 * @property {string} label
 * @property {string} engine - an engine id
 * @property {Record<string, string>} source - presets the source pane(s)
 * @property {Array<{ label: string, data: Record<string, string> }>} datasets
 *   the JSON to run against — `[]` for a source-only engine (josl/csv/md),
 *   one for a single run, several for a switcher
 * @property {Record<string, string>} [config] - presets option-pane values
 */

/** The registered engines, by id. */
export const ENGINES = Object.freeze(/** @type {Record<string, EngineDescriptor>} */ (
  Object.fromEntries(ENGINE_LIST.map((e) => [e.id, e]))));

/** The ids of the registered engines, in registration order. */
export function engineIds() {
  return ENGINE_LIST.map((e) => e.id);
}

/** The curated example library (the canonical home for the suite's engine
 * examples). */
export const EXAMPLES = Object.freeze(/** @type {PlayExample[]} */ (EXAMPLE_LIST));

/**
 * Fill an engine's option-pane defaults so its runner always sees a
 * complete `config` (the host `config` slice may hold only user overrides).
 * @param {EngineDescriptor} engine
 * @param {{ operators?: any, config?: Record<string, string> }} options
 */
function withConfig(engine, options) {
  const panes = engine.optionPanes ?? [];
  if (panes.length === 0) return options;
  const given = options.config ?? {};
  /** @type {Record<string, string>} */
  const config = {};
  for (const p of panes) config[p.key] = given[p.key] ?? p.default;
  return { ...options, config };
}

/**
 * Run one engine over a source + data. An unknown engine (or a throwing
 * runner) yields an error Result — this never throws. A synchronous
 * engine answers a Result; an async engine (the contract dispatch)
 * answers a Promise of one that never rejects — a host that must know
 * which awaits `Promise.resolve(runExample(…))`.
 * @param {string} engineId
 * @param {Record<string, string>} source
 * @param {Record<string, string>} data
 * @param {RunOptions} [options] - operators (query/jslt), the option-pane
 *   config, and host renderers (markdown/mermaid/charts)
 * @returns {PlayResult | Promise<PlayResult>}
 */
export function runExample(engineId, source, data, options = {}) {
  const engine = ENGINES[engineId];
  if (engine === undefined) {
    return { ok: false, timing: null, error: { message: `unknown engine: ${engineId}` }, panels: [] };
  }
  const failed = (/** @type {unknown} */ err) =>
    /** @type {PlayResult} */ ({ ok: false, timing: null, error: { message: String(/** @type {any} */ (err)?.message ?? err) }, panels: [] });
  try {
    const result = engine.run(source ?? {}, data ?? {}, withConfig(engine, options));
    return result !== null && typeof result === 'object' && typeof (/** @type {any} */ (result).then) === 'function'
      ? /** @type {Promise<PlayResult>} */ (result).then((r) => r, failed)
      : result;
  }
  catch (err) {
    return failed(err);
  }
}
