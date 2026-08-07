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
import { operatorRegistry } from './engines.js';
import { md } from './markdown.js';
import { mermaid } from './mermaid.js';
import { chartRenderer } from './charts.js';
import { runValidation, localizeErrors } from './validator.js';
import { formatJson } from '../lib/format.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const playComponent = createPlayComponent({ operators: operatorRegistry });

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
 */
const renderers = {
  markdown: (source) => {
    const doc = md.compile(source).doc;
    return {
      vnode: md.view(source),
      deep: [
        { id: 'ast', label: 'The document, as JSON', kind: 'code', text: formatJson(doc.ast) },
        { id: 'roundtrip', label: 'Canonical Markdown', kind: 'code', text: toMarkdown(doc) },
        ...(doc.frontmatter !== null
          ? [{ id: 'frontmatter', label: 'The frontmatter', kind: 'code', text: formatJson(doc.frontmatter) }]
          : []),
      ],
    };
  },
  mermaid: (source) => {
    const compiled = mermaid.compile(source);
    const doc = compiled.doc;
    return {
      vnode: mermaid.view(source),
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
  // the IDE half: a play SESSION is a saveable document
  name: '',        // the name the session saves under (the header input)
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

/** A blank session of the given engine (New): empty panes, default config. */
export function blankSession(engineId) {
  const engine = playComponent.engineIds().includes(engineId) ? engineId : PLAY_START.engine;
  return { engine, exampleId: null, source: {}, data: {}, config: {} };
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

/** The data of one dataset (by index) of an example, or null. */
export function loadDataset(exampleId, index) {
  const ex = playComponent.examples.find((e) => e.id === exampleId);
  const ds = ex?.datasets?.[index];
  return ds ? { ...ds.data } : null;
}
