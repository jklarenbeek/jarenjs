//@ts-check
/**
 * The Scratch boundary — the site's glue for `@jarenjs/scratch`. The engine
 * scratchpad: pick an engine + an example, edit the source or the data, and
 * it runs live — the registered operator packs threaded in so `$mean`/`$npv`
 * work in the query/jslt engines. Ephemeral (no document, unlike the studio).
 */
import { createScratchComponent } from '@jarenjs/scratch/component';
import { operatorRegistry } from './engines.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const scratchComponent = createScratchComponent({ operators: operatorRegistry });

/** The initial slice: the first example, loaded and ready to run. */
const first = scratchComponent.examples[0];
export const SCRATCH_START = Object.freeze({
  engine: first.engine,
  exampleId: first.id,
  source: { ...first.source },
  datasetIndex: 0,
  data: { ...first.datasets[0].data },
  result: null,
});

/** Run the active engine over the current source + data (operators included). */
export function runScratch(slice) {
  return scratchComponent.runExample(slice.engine, slice.source, slice.data, { operators: operatorRegistry });
}

/** Load an example's source + first dataset into a slice-ready payload. */
export function loadExample(exampleId) {
  const ex = scratchComponent.examples.find((e) => e.id === exampleId);
  if (ex === undefined) return null;
  return {
    engine: ex.engine, exampleId: ex.id,
    source: { ...ex.source }, datasetIndex: 0, data: { ...ex.datasets[0].data },
  };
}

/** The data of one dataset (by index) of an example, or null. */
export function loadDataset(exampleId, index) {
  const ex = scratchComponent.examples.find((e) => e.id === exampleId);
  const ds = ex?.datasets?.[index];
  return ds ? { ...ds.data } : null;
}
