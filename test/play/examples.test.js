//@ts-check
/**
 * @file The curated example library: every example targets a registered
 * engine and runs GREEN over each of its datasets (operators injected, as
 * the host does), and the multi-dataset examples carry a switchable list.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { EXAMPLES, ENGINES, runExample } from '@jarenjs/play';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

const ops = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

// the visual engines delegate rendering to host renderers; a stub proves the
// package's delegation without pulling @jarenjs/md, /mermaid or /charts here
const stub = (s) => ['pre', {}, String(s)];
const renderers = { markdown: stub, mermaid: stub, charts: stub };
// the validate engine delegates to a host validator; a stub proves the
// delegation without pulling @jarenjs/validate here (the real runner is
// exercised end-to-end in test/website/play.test.js)
const validate = () => ({ schemaError: null, draft: 'draft-07', compileMs: 0.1, validateMs: 0.1, valid: true, errors: [] });

describe('@jarenjs/play — the example library', () => {
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
        const r = runExample(ex.engine, ex.source, ds.data, { operators: ops, config: ex.config, renderers, validate });
        assert.strictEqual(r.ok, true, `${ex.id} / ${ds.label}: ${r.error?.message}`);
        // a visual engine yields a rendered `view` vnode; every other engine
        // yields at least one non-empty text (or table) panel
        const viewPanel = r.panels.find((p) => p.kind === 'view');
        if (viewPanel) assert.ok(Array.isArray(viewPanel.vnode), `${ex.id}: a rendered vnode`);
        else assert.ok(r.panels.some((p) => (p.text ?? '').length > 0 || (p.rows ?? []).length > 0), `${ex.id}: a non-empty panel`);
      }
    }
  });

  it('carries multi-dataset examples (the switcher earns its place)', () => {
    const multi = EXAMPLES.filter((e) => e.datasets.length >= 2);
    assert.ok(multi.length >= 2, 'at least two multi-dataset examples');
  });
});
