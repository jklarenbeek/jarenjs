//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLexical } from '@jarenjs/core/search';

const definition = { version: 1, fields: ['title', 'sku'] };
describe('atomic bounded lexical updates', () => {
  it('incremental edits equal a rebuild after every operation, including statistics', () => {
    const compiled = compileLexical(definition), index = compiled.create(), rows = new Map();
    for (let n = 0; n < 70; n++) {
      const id = String(n % 11);
      const row = { id, title: n % 2 ? 'green green tea' : 'black coffee', sku: `00${n}` };
      if (n % 5 === 0) { rows.delete(id); index.update({ remove: [id] }); }
      else { rows.set(id, row); assert.equal(index.update({ put: [row] }).state, 'complete'); }
      const fresh = compiled.create(); fresh.rebuild(rows.values());
      for (const query of ['green', 'black', 'gren tea', '00', ''])
        assert.deepEqual(index.search(query).hits, fresh.search(query).hits);
      for (const key of ['documents', 'vocabulary', 'postings', 'tokens', 'sourceBytes', 'indexBytes', 'fieldLengths'])
        assert.deepEqual(index.stats()[key], fresh.stats()[key], key);
      assert.equal(index.stats().tombstones, 0); fresh.dispose();
    }
    index.clear(); assert.equal(index.stats().documents, 0); assert.equal(index.stats().postings, 0);
    index.dispose(); index.dispose(); assert.equal(index.search('tea').reason, 'disposed');
    assert.equal(index.update({}).reason, 'disposed'); assert.equal(index.stats().indexBytes, 0);
  });
  it('equal rebuilds and versions publish zero changes and no revision increments', () => {
    const index = compileLexical(definition).create(), rows = [{ id: 'a', title: 'Tea', sku: '001' }];
    index.rebuild(rows, { generation: 2, sourceRevision: 'source-2' }); const before = index.stats();
    assert.equal(index.rebuild(rows, { generation: 3, sourceRevision: 'source-2' }).changes, 0);
    assert.equal(index.update({ put: rows }, { generation: 2 }).changes, 0);
    assert.deepEqual(index.stats(), before);
    assert.equal(index.rebuild([], { generation: 1 }).reason, 'stale-generation');
    assert.equal(index.rebuild([], { generation: 2 }).reason, 'conflicting-generation');
    assert.deepEqual(index.stats(), before);
    assert.equal(index.rebuild(rows, { generation: 3, sourceRevision: 'source-3' }).state, 'complete');
  });
  it('failed batches preserve postings and reject malformed source before publishing', () => {
    const index = compileLexical({ ...definition, limits: { maxDocuments: 2, maxFieldBytes: 64 } }).create();
    const row = { id: 'a', title: 'green tea', sku: '001' }; index.rebuild([row]); const before = index.stats();
    for (const rows of [[row, row], [{ id: 1 }], [{ id: 'a', title: 20 }], [{ id: 'a', title: 'x'.repeat(65) }],
      [row, { ...row, id: 'b' }, { ...row, id: 'c' }]]) {
      assert.notEqual(index.rebuild(rows).state, 'complete'); assert.deepEqual(index.stats(), before);
    }
    assert.equal(index.update({ remove: [1] }).state, 'error');
    assert.equal(index.rebuild([row], { generation: -1 }).state, 'error');
    assert.equal(index.search('tea', { sourceRevision: 'stale' }).state, 'invalidated');
  });
  it('each independent resource credit refuses explicitly', () => {
    for (const [key, value] of Object.entries({ maxSourceBytes: 1, maxTokens: 1, maxPostings: 1,
      maxVocabulary: 1, maxIndexBytes: 1, maxTemporaryBytes: 1, maxTokenLength: 1, maxWork: 1, maxBatchWork: 1 })) {
      const index = compileLexical({ ...definition, limits: { [key]: value } }).create();
      assert.equal(index.rebuild([{ id: 'a', title: 'green tea', sku: '001' }]).state, 'budget-exhausted', key);
      assert.equal(index.stats().documents, 0);
    }
    const index = compileLexical({ ...definition, limits: { maxQueryBytes: 8, maxCandidates: 1 } }).create();
    index.rebuild([{ id: 'a', title: 'green' }, { id: 'b', title: 'green' }]);
    assert.equal(index.search('green').reason, 'candidates');
    assert.equal(index.search('green tea tea').reason, 'query-bytes');
    assert.equal(index.search('green', { credits: { expansions: 0 } }).reason, 'expansions');
    assert.equal(index.search('tea', { credits: { work: -1 } }).reason, 'invalid-credits');
    assert.equal(index.search('tea', { limit: -1 }).reason, 'invalid-query');
  });
  it('cooperative work cancels and fences a superseded generation', async () => {
    const compiled = compileLexical({ ...definition, limits: { maxBatchWork: 100 } });
    const index = compiled.create(), row = { id: 'old', title: 'old tea' }; index.rebuild([row]);
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 'new green tea' }));
    let progress = 0, yields = 0;
    const abort = new AbortController();
    const cancelled = await index.rebuildAsync(rows, { signal: abort.signal, yield: async () => { yields++; abort.abort(); },
      onProgress: () => progress++ });
    assert.equal(cancelled.reason, 'cancelled'); assert.equal(yields, 1); assert.equal(progress, 1);
    assert.equal(index.stats().documents, 1);
    const stale = await index.rebuildAsync(rows, { yield: async () => { index.rebuild([row]); } });
    assert.equal(stale.reason, 'superseded');
    const good = await index.rebuildAsync(rows, { yield: async () => { yields++; } });
    assert.equal(good.state, 'complete'); assert.ok(yields > 1); assert.equal(index.stats().documents, 20);
    const disposed = await index.rebuildAsync(rows, { yield: async () => { index.dispose(); } });
    assert.equal(disposed.reason, 'disposed');
    await assert.rejects(index.rebuildAsync([], /** @type {any} */ ({})), /yield/);
  });
  it('supports explicit stable-key ties, boosts and OR without changing default compatibility', () => {
    const index = compileLexical({ ...definition, profile: 'lexical-key/1', combineWith: 'OR', boost: { sku: 3 } }).create();
    index.rebuild([{ id: 'b', title: 'tea' }, { id: 'a', title: 'tea' }, { id: 'c', title: 'coffee' }]);
    assert.deepEqual(index.search('tea').hits.map((h) => h.id), ['a', 'b']);
    assert.equal(index.search('tea coffee').total, 3);
    assert.equal(index.search('tea', { filter: () => { throw new Error('bad filter'); } }).state, 'error');
  });
});

it('cooperative updates publish atomically and cancelled edits keep the previous snapshot', async () => {
  const index = compileLexical({ ...definition, limits: { maxBatchWork: 100 } }).create();
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 'green tea' }));
  index.rebuild(rows, { sourceRevision: 'old' }); const previous = index.snapshot();
  const edits = { put: rows.map((row) => ({ ...row, title: 'black tea' })), remove: ['0'] };
  const signal = new AbortController();
  assert.equal((await index.updateAsync(edits, { signal: signal.signal, yield: async () => signal.abort() })).reason, 'cancelled');
  assert.equal(index.snapshot(), previous);
  const result = await index.updateAsync(edits, { sourceRevision: 'new', yield: async () => {} });
  assert.equal(result.state, 'complete'); assert.equal(index.search('green').total, 0);
  assert.equal(index.search('black').total, 20); assert.equal(index.stats().sourceRevision, 'new'); index.dispose();
});

it('a reentrant callback cannot label old hits with a newly published source revision', () => {
  for (const operation of ['update', 'dispose']) {
    const index = compileLexical(definition).create(); index.rebuild([{ id: 'old', title: 'tea' }], { sourceRevision: 'old' });
    const result = index.search('tea', { filter() {
      if (operation === 'update') index.rebuild([{ id: 'new', title: 'coffee' }], { sourceRevision: 'new' });
      else index.dispose();
      return true;
    } });
    assert.equal(result.state, operation === 'update' ? 'invalidated' : 'error');
    assert.equal(result.total, null); assert.deepEqual(result.hits, []); index.dispose();
  }
});
