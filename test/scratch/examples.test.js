//@ts-check
/**
 * @file The curated example library: every example targets a registered
 * engine and runs GREEN over each of its datasets (operators injected, as
 * the host does), and the multi-dataset examples carry a switchable list.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { EXAMPLES, ENGINES, runExample } from '@jarenjs/scratch';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

const ops = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

describe('@jarenjs/scratch — the example library', () => {
  it('is numerous, and every example targets a registered engine with a source + datasets', () => {
    assert.ok(EXAMPLES.length >= 15, `only ${EXAMPLES.length} examples`);
    for (const ex of EXAMPLES) {
      assert.ok(ENGINES[ex.engine], `${ex.id}: unknown engine ${ex.engine}`);
      assert.ok(ex.source && typeof ex.source === 'object', `${ex.id}: source`);
      // datasets is a LIST: [] for a source-only engine (josl/csv), ≥1 otherwise
      assert.ok(Array.isArray(ex.datasets), `${ex.id}: datasets is a list`);
      const engine = ENGINES[ex.engine];
      if (engine.dataPanes.length > 0) assert.ok(ex.datasets.length >= 1, `${ex.id}: a data engine needs a dataset`);
      else assert.strictEqual(ex.datasets.length, 0, `${ex.id}: a source-only engine carries no datasets`);
    }
    assert.strictEqual(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length, 'ids are unique');
  });

  it('every example runs GREEN over each of its datasets (operators + its option config)', () => {
    for (const ex of EXAMPLES) {
      // a source-only example runs once against no data
      const runs = ex.datasets.length > 0 ? ex.datasets : [{ label: '—', data: {} }];
      for (const ds of runs) {
        const r = runExample(ex.engine, ex.source, ds.data, { operators: ops, config: ex.config });
        assert.strictEqual(r.ok, true, `${ex.id} / ${ds.label}: ${r.error?.message}`);
        assert.ok(r.output.length > 0);
      }
    }
  });

  it('carries multi-dataset examples (the switcher earns its place)', () => {
    const multi = EXAMPLES.filter((e) => e.datasets.length >= 2);
    assert.ok(multi.length >= 2, 'at least two multi-dataset examples');
  });
});
