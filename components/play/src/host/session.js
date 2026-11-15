//@ts-check
/**
 * @file The play slice a host keeps, and the rules that move it: loading an
 * example, switching an option, saving and opening a session. The reader's
 * language is the reader's alone: only the reader sets it (the locale
 * option's choice), an example made to show one language shows it for its
 * own run, and a session or share never carries or changes it.
 */

import { isJsonObject } from '@jarenjs/core/object';

import { ENGINES, EXAMPLES, engineIds, switchOption } from '../index.js';

/** The first example, loaded and ready to run. */
const first = EXAMPLES[0];

/**
 * The initial play slice: the first example loaded, nothing run yet, the
 * presentation and session state at rest (ARCHITECTURE "State and actions
 * supplied by the host").
 */
export const PLAY_START = Object.freeze({
  engine: first.engine,
  exampleId: first.id,
  source: { ...first.source },
  datasetIndex: 0,
  // source-only engines (josl/csv) carry no datasets — guard the seed
  data: { ...(first.datasets[0]?.data ?? {}) },
  config: { ...(first.config ?? {}) },
  result: null,
  panel: null, // the active result panel (tab) id; null → the first panel
  // the drill-deeper depth toggle: deep panels stay hidden until asked for;
  // a fresh example/session load resets both (calm by default)
  deep: false,     // the depth toggle — true reveals the deep panels
  deepPick: null,  // the active DEEP panel id; null → the first deep panel
  // the phone layout: which single pane shows (examples | editor | result)
  mobilePane: 'editor',
  // the IDE half: a play SESSION is a saveable document
  name: '',        // the session TITLE (the header input, freely edited)
  // the store record this session is bound to, or null when it has never
  // been saved. Save overwrites THIS; Save As writes the title as a new
  // record and rebinds — which is the whole difference between them.
  savedName: null,
  names: [],       // the saved session names
  shared: null,    // the last Share status line (or null)
  ratio: 0.5,      // the editors|result split
  // the generated-form half: the validate engine's data pane can
  // toggle between the JSON textarea and a schema-generated form; `dataValue`
  // is the structured buffer the form edits, mirrored back to the data text
  dataView: 'json', // 'json' | 'form'
  dataValue: null,  // the parsed data the form binds to (validate + form only)
  // the language an example made to show one runs in, while it is loaded
  // (never the reader's language: only the reader sets that)
  exampleLocale: null,
});

/**
 * The play slice as the engines and the panes read it: every engine that
 * offers a locale speaks the reader's language (`lang`, English until
 * chosen), whatever an opened session or share carried — except while an
 * example made to show one language is loaded (`slice.exampleLocale`),
 * which shows its own for its own run.
 * @param {any} slice - the play slice
 * @param {string | null} [lang] - the reader's language, null until chosen
 * @returns {any} the slice, its config carrying the locale it runs in
 */
export function withPlayLocale(slice, lang = null) {
  const locale = slice.exampleLocale ?? lang ?? 'en';
  if (slice.config?.locale === locale) return slice;
  const engine = Object.hasOwn(ENGINES, slice.engine) ? ENGINES[slice.engine] : undefined;
  if (!(engine?.optionPanes ?? []).some((/** @type {any} */ pane) => pane.key === 'locale')) return slice;
  return { ...slice, config: { ...(slice.config ?? {}), locale } };
}

/**
 * Run the slice's engine in the reader's language: the slice through
 * {@link withPlayLocale}, play's own words through `lang`'s catalog (English
 * while it has not loaded, never ids). Every other run option (`operators`,
 * `renderers`, `validate`) passes through to `component.runExample`.
 * @param {{ runExample: (engineId: string, source: any, data: any, options?: any) => any }} component -
 *   a `createPlayComponent()` result
 * @param {any} slice - the play slice
 * @param {{ lang?: string | null, catalogs?: { catalogFor: (code: string | null | undefined) => any },
 *   [option: string]: any }} [options]
 * @returns {any} the run's `PlayResult`, or a promise of it
 */
export function runPlay(component, slice, options = {}) {
  const { lang = null, catalogs, ...run } = options;
  const located = withPlayLocale(slice, lang);
  return component.runExample(located.engine, located.source, located.data, {
    ...run, config: located.config, messages: catalogs?.catalogFor(lang),
  });
}

/**
 * Load an example's source, first dataset and option config as a
 * slice-ready payload, or null for an id the library does not hold.
 * @param {string} exampleId
 * @returns {{ engine: string, exampleId: string, source: Record<string, string>, datasetIndex: number,
 *   data: Record<string, string>, config: Record<string, string>, exampleLocale: string | null } | null}
 */
export function loadExample(exampleId) {
  const ex = EXAMPLES.find((e) => e.id === exampleId);
  if (ex === undefined) return null;
  return {
    engine: ex.engine, exampleId: ex.id,
    source: { ...ex.source }, datasetIndex: 0,
    data: { ...(ex.datasets[0]?.data ?? {}) },
    config: { ...(ex.config ?? {}) },
    // an example made to show one language shows it for its own run
    exampleLocale: typeof ex.config?.locale === 'string' ? ex.config.locale : null,
  };
}

/**
 * The data of one dataset (by index) of an example, or null.
 * @param {string} exampleId @param {number} index
 * @returns {Record<string, string> | null}
 */
export function loadDataset(exampleId, index) {
  const ex = EXAMPLES.find((e) => e.id === exampleId);
  const ds = ex?.datasets?.[index];
  return ds ? { ...ds.data } : null;
}

/**
 * The example a deep link asks for: an exact `example` id wins, otherwise
 * the first example of `engine`. Returns the example id, or null when
 * neither names anything the library holds — a stale or hand-typed link
 * then leaves the seeded session alone instead of blanking it.
 * @param {{ engine?: string, example?: string }} params
 * @returns {string | null}
 */
export function deepLinkExample(params) {
  if (params.example !== undefined
    && EXAMPLES.some((e) => e.id === params.example)) return params.example;
  if (params.engine === undefined) return null;
  return EXAMPLES.find((e) => e.engine === params.engine)?.id ?? null;
}

/**
 * The slice fields a switch of one option pane leaves: the new config, and
 * the source and data that fit it (`switchOption`). When the switch loads
 * another example, the session follows it there, and the structured form
 * buffer — the old data's — goes, as it does when an example is picked.
 * Choosing on the `locale` pane is the reader choosing a language: `lang`
 * names it (null for any other pane) and the example's own language goes.
 * @param {any} slice @param {string} key @param {string} value
 * @returns {{ config: Record<string, string>, source: Record<string, string>, data: Record<string, string>,
 *   exampleId: string | null, datasetIndex: number, dataView: string, dataValue: any,
 *   lang: string | null, exampleLocale: string | null }}
 */
export function switchPlayOption(slice, key, value) {
  const next = switchOption(slice.engine, key, value, slice);
  const followed = next.example !== undefined;
  return {
    config: next.config, source: next.source, data: next.data,
    exampleId: followed ? /** @type {string} */ (next.example) : slice.exampleId,
    datasetIndex: followed ? 0 : slice.datasetIndex,
    dataView: followed ? 'json' : slice.dataView,
    dataValue: followed ? null : slice.dataValue,
    // choosing a message language makes it the reader's, for every later load
    lang: key === 'locale' ? value : null,
    // the reader's choice replaces the example's own language
    exampleLocale: key === 'locale' ? null : (slice.exampleLocale ?? null),
  };
}

/**
 * A play session as a saveable, shareable document (PLAY-FORMAT §6): the
 * engine, its source and data panes, the option config, and the originating
 * example id. The language is the reader's, never the document's: a session
 * carries none (an opened one renders in its reader's language).
 * @param {any} slice - the play slice
 * @returns {{ engine: string, exampleId: string | null, source: Record<string, string>,
 *   data: Record<string, string>, config: Record<string, string> }}
 */
export function sessionOf(slice) {
  const { locale: _reader, ...config } = slice.config ?? {};
  return {
    engine: slice.engine,
    exampleId: slice.exampleId ?? null,
    source: { ...(slice.source ?? {}) },
    data: { ...(slice.data ?? {}) },
    config,
  };
}

/**
 * A session document as the payload a load seeds a fresh run from. A blank
 * or foreign session is coerced to safe defaults (an engine name that is
 * not a string, panes that are not JSON objects), so a bad share token
 * never crashes the surface. A host that loads it clears the slice's
 * `exampleLocale`: a session renders in its reader's language.
 * @param {any} session
 * @returns {{ engine: string, exampleId: string | null, source: any, data: any, config: any }}
 */
export function sessionToLoaded(session) {
  const s = session && typeof session === 'object' ? session : {};
  return {
    engine: typeof s.engine === 'string' ? s.engine : PLAY_START.engine,
    exampleId: typeof s.exampleId === 'string' ? s.exampleId : null,
    source: isJsonObject(s.source) ? s.source : {},
    data: isJsonObject(s.data) ? s.data : {},
    config: isJsonObject(s.config) ? s.config : {},
  };
}

/** The version of the exported session envelope. */
const PLAY_DOC = '0.1';

/**
 * A session as a FILE: the saveable document plus its title, in the
 * self-describing envelope of PLAY-FORMAT §6.
 * @param {any} slice - the play slice
 * @returns {{ $play: string, name: string, session: ReturnType<typeof sessionOf> }}
 */
export function sessionDocument(slice) {
  return { $play: PLAY_DOC, name: (slice.name ?? '').trim(), session: sessionOf(slice) };
}

/**
 * A file's text as `{ name, session }`, or null when it is not a play
 * document at all. Liberal on purpose: a BARE session (what a share token
 * decodes to) loads too. Every field still goes through
 * {@link sessionToLoaded}, so a foreign or malicious shape lands as safe
 * defaults rather than reaching the engines; a document that names no
 * engine is refused.
 * @param {string} text
 * @returns {{ name: string, session: ReturnType<typeof sessionToLoaded> } | null}
 */
export function sessionFromDocument(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '')); }
  catch { return null; }
  if (!isJsonObject(parsed)) return null;
  const wrapped = parsed.session && typeof parsed.session === 'object';
  const session = wrapped ? parsed.session : parsed;
  // a document that names no engine is not a session — refuse it rather
  // than silently opening the default one under the file's name
  if (typeof session.engine !== 'string') return null;
  const name = wrapped && typeof parsed.name === 'string' ? parsed.name : '';
  return { name, session: sessionToLoaded(session) };
}

/**
 * A filename for an exported session: its title, or a stable fallback.
 * @param {any} slice
 * @returns {string}
 */
export function sessionFilename(slice) {
  const title = (slice.name ?? '').trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
  return `${title === '' ? 'jaren-play-session' : title}.play.json`;
}

/**
 * A blank session of the given engine (New): empty panes, default config;
 * the first example's engine for an id the registry does not hold.
 * @param {string} engineId
 * @returns {{ engine: string, exampleId: null, source: {}, data: {}, config: {} }}
 */
export function blankSession(engineId) {
  const engine = engineIds().includes(engineId) ? engineId : PLAY_START.engine;
  return { engine, exampleId: null, source: {}, data: {}, config: {} };
}
