//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { referenceSearch, referenceGrid, searchOptions } from './oracles.js';
import { readAdoption } from './evidence.js';
import { trustedBodies, SKIP } from './trusted-bodies.js';

describe('retained reference behavior', () => {
  const search = readAdoption('fixtures/search.json');
  for (const query of search.queries) it(`MiniSearch labels and ranking: ${JSON.stringify(query.text)}`, () => {
    const index = referenceSearch(search);
    const hits = index.search(query.text).map(({ id, score }) => ({ id, score }));
    assert.deepEqual(hits, search.expected[query.id]);
    const reloaded = MiniSearch.loadJSON(JSON.stringify(index), searchOptions(search));
    assert.deepEqual(reloaded.search(query.text).map(({ id, score }) => ({ id, score })), search.expectedReload[query.id]);
    assert.deepEqual([...hits].sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.id).sort(), hits.map((x) => x.id).sort());
  });
  it('updates and deletes match a fresh index without retaining old tokens', () => {
    const index = referenceSearch(search);
    const changed = { ...search.documents[0], title: 'White tea' };
    index.replace(changed); index.discard('tea-copy');
    const fresh = referenceSearch(search, [changed, ...search.documents.slice(2)]);
    for (const query of ['white', 'green', '0007'])
      assert.deepEqual(index.search(query).map(({ id, score }) => ({ id, score })), fresh.search(query).map(({ id, score }) => ({ id, score })));
    index.removeAll(); assert.equal(index.documentCount, 0);
  });
  it('does not misrepresent existing regex search or expiring HTTP claims', () => {
    assert.equal(compileJsonQuery({ $search: ['green tea', 'gren'] })(null), false);
    const ledger = createMemoryLedger({ ttlMs: 10 });
    const key = { op: 'post', scope: 'synthetic', key: 'operation-1', hash: 'payload-1' };
    const claim = ledger.claim({ ...key, now: 0 }); ledger.commit(claim.ref, { value: 1 }, 1);
    assert.equal(ledger.claim({ ...key, now: 9 }).state, 'replay');
    assert.equal(ledger.claim({ ...key, now: 10 }).state, 'new');
  });
  const grid = readAdoption('fixtures/grid.json');
  for (const mode of ['fixed', 'measured']) for (const expected of grid.expected[mode])
    it(`virtual-core ${mode} offset ${expected.offset}`, () => {
      const { virtualizer, dispose } = referenceGrid(grid[mode], expected.offset);
      try {
        assert.deepEqual(virtualizer.getVirtualItems().map(({ index, key, start, end, size }) => ({ index, key, start, end, size })), expected.items);
        assert.equal(virtualizer.getTotalSize(), expected.totalSize);
        assert.ok(expected.items.length < grid[mode].count);
      }
      finally { dispose(); dispose(); }
      assert.equal(virtualizer.elementsCache.size, 0);
    });
  it('separates a resident source from a bounded provider and handles empty/hidden grids', () => {
    assert.ok(grid.bounded.residentRowLimit < grid.bounded.logicalCount);
    assert.equal(grid.bounded.residentRowLimit, grid.bounded.pageRows * grid.bounded.cachePages);
    for (const change of [{ count: 0 }, { viewport: 0 }]) {
      const { virtualizer, dispose } = referenceGrid({ ...grid.fixed, ...change }, 0);
      assert.deepEqual(virtualizer.getVirtualItems(), []); dispose();
    }
  });
  const formulas = readAdoption('fixtures/formulas.json');
  for (const formula of formulas.formulas) it(`trusted original ${formula.id}: exact bytes and outcome`, () => {
    let result;
    const before = JSON.stringify(formula);
    if (!formula.enabled) {
      assert.equal(trustedBodies[formula.id], undefined);
      result = { kind: 'disabled' };
    }
    else {
      const body = trustedBodies[formula.id];
      assert.equal(body.toString().split(`// body:${formula.id}\n`)[1].split(`\n// end:${formula.id}`)[0], formula.body);
      try {
        const value = body(structuredClone(formula.input), { SKIP });
        result = value === SKIP ? { kind: 'skip' } : value?.explanation
          ? { kind: 'explanation', text: value.explanation } : { kind: 'value', value };
      }
      catch (error) { result = { kind: 'error', message: error.message }; }
    }
    assert.deepEqual(result, formula.expected);
    assert.equal(JSON.stringify(formula), before);
    assert.deepEqual(JSON.parse(JSON.stringify(formula)), formula);
  });
});
