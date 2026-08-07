//@ts-check
/**
 * The Play boundary — the site's glue for `@jarenjs/play`. The engine
 * playground: pick an engine + an example, edit the source or the data, and
 * it runs live — the registered operator packs threaded in so `$mean`/`$npv`
 * work in the query/jslt engines. Ephemeral (no document, unlike the studio).
 */
import { createSplitterWidget } from '@jarenjs/app';
import { createPlayComponent } from '@jarenjs/play/component';
import { operatorRegistry } from './engines.js';
import { md } from './markdown.js';
import { mermaid } from './mermaid.js';
import { chartRenderer } from './charts.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const playComponent = createPlayComponent({ operators: operatorRegistry });

/**
 * Host-injected vnode renderers for the playground's VISUAL engines (the
 * hybrid seam): @jarenjs/play owns the markdown/mermaid/charts descriptors
 * + examples, but stays free of those component deps — the rendering happens
 * here, reusing the site's own memoized md/mermaid components and the charts
 * static path. `md.view` / `mermaid.view` are memoized per source string.
 */
const renderers = {
  markdown: (source) => md.view(source),
  mermaid: (source) => mermaid.view(source),
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
  // the IDE half (PLAY_04): a play SESSION is a saveable document
  name: '',        // the name the session saves under (the header input)
  names: [],       // the saved session names (seeded from the play doc-store)
  shared: null,    // the last Share status line (or null)
  ratio: 0.5,      // the editors|result split (the shared splitter widget)
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

/** Run the active engine over the current source + data (operators, option config, visual renderers). */
export function runPlay(slice) {
  return playComponent.runExample(slice.engine, slice.source, slice.data,
    { operators: operatorRegistry, config: slice.config, renderers });
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
