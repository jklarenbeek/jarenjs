//@ts-check
/**
 * The Play boundary — the site's glue for `@jarenjs/play`. The engine
 * playground: pick an engine + an example, edit the source or the data, and
 * it runs live — the registered operator packs threaded in so `$mean`/`$npv`
 * work in the query/jslt engines. Ephemeral (no document, unlike the studio).
 */
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
});

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
