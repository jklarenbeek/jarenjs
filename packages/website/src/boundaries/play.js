//@ts-check
/**
 * The Play boundary — the site's glue for `@jarenjs/play`. The engine
 * playground: pick an engine + an example, edit the source or the data, and
 * it runs live — the registered operator packs threaded in so `$mean`/`$npv`
 * work in the query/jslt engines. Ephemeral (no document, unlike the studio).
 */
import { createSplitterWidget } from '@jarenjs/app';
import { createPlayComponent } from '@jarenjs/play/component';
import { toMarkdown } from '@jarenjs/md';
import { createMdx } from '@jarenjs/md/mdx';
import { compileJsonQuery } from '@jarenjs/json';
import { operatorRegistry } from './engines.js';
import { md, mdArticle, UNTRUSTED } from './markdown.js';
import { mermaid } from './mermaid.js';
import { chartRenderer } from './charts.js';
import { runValidation, localizeErrors } from './validator.js';
import { formatJson } from '../lib/format.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const playComponent = createPlayComponent({ operators: operatorRegistry });

/** The mdx pass (markdown × data), with the suite's own query compiler
 * injected — the expression language IS jaren-query, no new mini-language. */
const mdx = createMdx({ compileQuery: compileJsonQuery });

/**
 * Host-injected vnode renderers for the playground's VISUAL engines (the
 * hybrid seam): @jarenjs/play owns the markdown/mermaid/charts descriptors
 * + examples, but stays free of those component deps — the rendering happens
 * here, reusing the site's own memoized md/mermaid components and the charts
 * static path. `md.view` / `mermaid.view` are memoized per source string.
 *
 * Markdown and Mermaid also hand back `deep` panels — the drill-down
 * explainers only the host can derive (the JSON AST, the canonical
 * round-trip): teacher-voiced, revealed behind the depth toggle.
 *
 * Each renderer also reports its own `compileMs` / `runMs`. Play cannot
 * split a host render from the outside — it would only have one wall-clock
 * number for both phases — and these renderers genuinely have two: the
 * source compiles to a document, then the document builds a vnode. Report
 * them and the stage prints two real numbers; omit them and it honestly
 * prints one.
 */
const timed = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

const renderers = {
  markdown: (source) => {
    const compiled = timed(() => md.compile(source).doc);
    const doc = compiled.value;
    const rendered = timed(() => mdArticle(md.view(source, UNTRUSTED)));
    return {
      compileMs: compiled.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'ast', label: 'The document, as JSON', kind: 'code', text: formatJson(doc.ast) },
        { id: 'roundtrip', label: 'Canonical Markdown', kind: 'code', text: toMarkdown(doc) },
        ...(doc.frontmatter !== null
          ? [{ id: 'frontmatter', label: 'The frontmatter', kind: 'code', text: formatJson(doc.frontmatter) }]
          : []),
      ],
    };
  },
  // mdx receives the PARSED data document as its second argument: the pass
  // resolves the template against it, then renders through the same
  // memoized md pipeline (the doc-keyed memo carries the transformed doc)
  mdx: (source, dataValue) => {
    const compiled = timed(() => mdx.transform(md.compile(source).doc, dataValue));
    const doc = compiled.value;
    const rendered = timed(() => mdArticle(md.view(doc, UNTRUSTED)));
    return {
      compileMs: compiled.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'rendered', label: 'The resolved Markdown', kind: 'code', text: toMarkdown(doc) },
        { id: 'ast', label: 'The document, as JSON', kind: 'code', text: formatJson(doc.ast) },
      ],
    };
  },
  mermaid: (source) => {
    const step = timed(() => mermaid.compile(source));
    const compiled = step.value;
    const doc = compiled.doc;
    const rendered = timed(() => mermaid.view(source));
    return {
      compileMs: step.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'ast', label: 'The geometry-free AST', kind: 'code',
          text: doc ? formatJson(doc.ast) : String(compiled.parseError?.message ?? 'parse error') },
        { id: 'roundtrip', label: 'Canonical Mermaid', kind: 'code', text: compiled.toText() },
      ],
    };
  },
  charts: (source, config) => chartRenderer(source, config),
};

/** The initial slice: the first example, loaded and ready to run. */
const first = playComponent.examples[0];
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
  names: [],       // the saved session names (seeded from the play doc-store)
  shared: null,    // the last Share status line (or null)
  ratio: 0.5,      // the editors|result split (the shared splitter widget)
  // the generated-form half: the validate engine's data pane can
  // toggle between the JSON textarea and a schema-generated form; `dataValue`
  // is the structured buffer the form edits, mirrored back to the data text
  dataView: 'json', // 'json' | 'form'
  dataValue: null,  // the parsed data the form binds to (validate + form only)
});

/**
 * A play SESSION as a saveable/shareable document: the engine, its source and
 * data panes, the option config, and the originating example id. This is what
 * `createDocStore` persists and `encodeShare` turns into a `#/play?s=` link.
 * @param {any} slice - the `state.play` slice
 */
export function sessionOf(slice) {
  return {
    engine: slice.engine,
    exampleId: slice.exampleId ?? null,
    source: { ...(slice.source ?? {}) },
    data: { ...(slice.data ?? {}) },
    config: { ...(slice.config ?? {}) },
  };
}

/**
 * A session document → the `play/loaded-session` payload (a fresh run seeds
 * from it). A blank/foreign session is coerced to safe defaults so a bad
 * share token never crashes the surface.
 * @param {any} session
 */
export function sessionToLoaded(session) {
  const s = session && typeof session === 'object' ? session : {};
  return {
    engine: typeof s.engine === 'string' ? s.engine : PLAY_START.engine,
    exampleId: typeof s.exampleId === 'string' ? s.exampleId : null,
    source: s.source && typeof s.source === 'object' ? s.source : {},
    data: s.data && typeof s.data === 'object' ? s.data : {},
    config: s.config && typeof s.config === 'object' ? s.config : {},
  };
}

/** The version of the exported session envelope. */
const PLAY_DOC = '0.1';

/**
 * A session as a FILE: the saveable document plus its title, in a small
 * self-describing envelope. This is the way a session leaves the browser
 * when it is too big for a share link — the case the share refusal points
 * at — so it has to be something the import side can read back.
 * @param {any} slice - the `state.play` slice
 */
export function sessionDocument(slice) {
  return { $play: PLAY_DOC, name: (slice.name ?? '').trim(), session: sessionOf(slice) };
}

/**
 * A file's text → `{ name, session }`, or null when it is not a play
 * document at all. Liberal on purpose: the envelope is what Download
 * writes, but a BARE session (what a share token decodes to, and what a
 * hand-written file is likely to be) loads too. Every field still goes
 * through `sessionToLoaded`, so a foreign or malicious shape lands as
 * safe defaults rather than reaching the engines.
 * @param {string} text
 * @returns {{ name: string, session: any } | null}
 */
export function sessionFromDocument(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '')); }
  catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const wrapped = parsed.session && typeof parsed.session === 'object';
  const session = wrapped ? parsed.session : parsed;
  // a document that names no engine is not a session — refuse it rather
  // than silently opening the default one under the file's name
  if (typeof session.engine !== 'string') return null;
  const name = wrapped && typeof parsed.name === 'string' ? parsed.name : '';
  return { name, session: sessionToLoaded(session) };
}

/** A filename for an exported session: its title, or a stable fallback. */
export function sessionFilename(slice) {
  const title = (slice.name ?? '').trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
  return `${title === '' ? 'jaren-play-session' : title}.play.json`;
}

/** A blank session of the given engine (New): empty panes, default config. */
export function blankSession(engineId) {
  const engine = playComponent.engineIds().includes(engineId) ? engineId : PLAY_START.engine;
  return { engine, exampleId: null, source: {}, data: {}, config: {} };
}

/**
 * A LEGACY playground snapshot → a play session, so links and saved
 * experiments from the retired `#/playground` keep working. The legacy
 * shape is `(engine, inputs)` with flat text inputs; `validate` carried
 * `{ schemaText, data }` (the data as a VALUE). Inputs are split into
 * play's source / data / config panes by the engine descriptor; a key
 * with no play home (the old pointer/patch mode sub-fields) is dropped.
 * @param {string} engine
 * @param {any} inputs
 * @returns {any | null} a `play/loaded-session`-shaped session, or null
 */
export function legacyExperimentToSession(engine, inputs) {
  const given = inputs && typeof inputs === 'object' ? inputs : {};
  if (engine === 'validate') {
    return {
      engine: 'validate', exampleId: null,
      source: { schema: typeof given.schemaText === 'string' ? given.schemaText : '' },
      data: { data: JSON.stringify(given.data ?? null, null, 2) },
      config: {},
    };
  }
  const descriptor = playComponent.engines[engine];
  if (descriptor === undefined) return null;
  /** @type {Record<string, string>} */
  const source = {};
  /** @type {Record<string, string>} */
  const data = {};
  /** @type {Record<string, string>} */
  const config = {};
  for (const [key, value] of Object.entries(given)) {
    if (typeof value !== 'string') continue;
    if (descriptor.sourcePanes.some((p) => p.key === key)) source[key] = value;
    else if (descriptor.dataPanes.some((p) => p.key === key)) data[key] = value;
    else if ((descriptor.optionPanes ?? []).some((p) => p.key === key)) config[key] = value;
  }
  return { engine, exampleId: null, source, data, config };
}

/** The Play IDE's editor|result splitter (`play-splitter`): the shared
 * `@jarenjs/app` widget bound to the play grid — drives `--jplay-ratio` live
 * during a drag and commits `play/layout-ratio` on pointer-up. */
export function createPlaySplitterWidget() {
  return createSplitterWidget({
    grid: '.jplay', rail: '.jplay-rail', cssVar: '--jplay-ratio', action: 'play/layout-ratio',
  });
}

/** Host-injected JSON Schema validator for the `validate` engine (the hybrid
 * seam): reuse the site's cached `runValidation`, then localize the errors to
 * the chosen locale — so @jarenjs/validate + the locale packs stay in the host. */
function validateRunner(schemaText, data, locale) {
  const report = runValidation(schemaText, data);
  return { ...report, errors: localizeErrors(report.errors, locale) };
}

/** Run the active engine over the current source + data (operators, option config, visual renderers, the validator). */
export function runPlay(slice) {
  return playComponent.runExample(slice.engine, slice.source, slice.data,
    { operators: operatorRegistry, config: slice.config, renderers, validate: validateRunner });
}

/** Load an example's source + first dataset (+ option config) into a slice-ready payload. */
export function loadExample(exampleId) {
  const ex = playComponent.examples.find((e) => e.id === exampleId);
  if (ex === undefined) return null;
  return {
    engine: ex.engine, exampleId: ex.id,
    source: { ...ex.source }, datasetIndex: 0,
    data: { ...(ex.datasets[0]?.data ?? {}) },
    config: { ...(ex.config ?? {}) },
  };
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
  const examples = playComponent.examples;
  if (params.example !== undefined
    && examples.some((e) => e.id === params.example)) return params.example;
  if (params.engine === undefined) return null;
  return examples.find((e) => e.engine === params.engine)?.id ?? null;
}

/** The data of one dataset (by index) of an example, or null. */
export function loadDataset(exampleId, index) {
  const ex = playComponent.examples.find((e) => e.id === exampleId);
  const ds = ex?.datasets?.[index];
  return ds ? { ...ds.data } : null;
}
