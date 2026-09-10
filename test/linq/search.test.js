//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLexical } from '@jarenjs/core/search';
import { createLexicalProvider, compileJsonQuery, QUERY_CODES } from '@jarenjs/json/query';
import { from } from '@jarenjs/linq';
import { createLexicalRangeProvider } from '@jarenjs/linq/db';
import { rangeProviderContract } from '../adoption/range-provider-contract.js';

const rows = [{ id: 'a', title: 'tea tea', allowed: false, category: 'red' },
  { id: 'b', title: 'tea', allowed: true, category: 'blue' }, { id: 'c', title: 'tea', allowed: true, category: 'blue' }];
function source() {
  const index = compileLexical({ version: 1, fields: ['title'] }).create();
  index.rebuild(rows, { sourceRevision: 'r1' });
  return { index, provider: createLexicalProvider(index, { row: (id) => rows.find((row) => row.id === id) }) };
}
describe('explicit lexical query and LINQ authoring', () => {
  it('filters and facets the full membership before top-k; compiles a provider exactly once', () => {
    const { provider } = source(); let compiles = 0;
    const query = compileJsonQuery({ $lexical: ['catalog', '$.text', { where: '$.allowed', facets: ['category'], limit: 1 }] },
      { lexicalProviders: { catalog: { compile(spec) { compiles++; return provider.compile(spec); } } } });
    for (let i = 0; i < 3; i++) {
      const result = query({ text: 'tea' });
      assert.deepEqual(result.hits.map((hit) => hit.id), ['b']); assert.equal(result.total, 2);
      assert.deepEqual(result.facets, { category: [{ value: 'blue', count: 2 }] });
    }
    assert.equal(compiles, 1);
  });
  it('tie-aware continuation is lossless and refuses a changed source/query', () => {
    const { index, provider } = source(); const ids = []; let after;
    for (;;) {
      const result = provider.compile({ limit: 1, after })('tea'); ids.push(...result.hits.map((h) => h.id));
      if (!result.continuation) break; after = result.continuation;
    }
    assert.deepEqual(ids, ['a', 'b', 'c']);
    assert.equal(provider.compile({ limit: 1, after, order: { field: 'id', direction: 'desc' } })('tea').state, 'invalidated');
    const old = provider.compile({}); index.update({ put: [{ id: 'd', title: 'tea' }] }, { sourceRevision: 'r2' });
    assert.equal(old('tea').state, 'invalidated');
    assert.equal(provider.compile({ after })('tea').state, 'invalidated');
  });
  it('LINQ emits the same explicit request document without a second evaluator', () => {
    const { provider } = source();
    const query = from([{ text: 'tea' }]).select((row) => row.text.lexical('catalog', { limit: 2 }));
    assert.ok(JSON.stringify(query.toDocument()).includes('$lexical'));
    const result = compileJsonQuery(query.toDocument(), { lexicalProviders: { catalog: provider } })([{ text: 'tea' }]);
    assert.equal(result.total, 3); assert.equal(result.hits.length, 2);
    assert.throws(() => from([]).select((row) => row.text.lexical('', {})), { code: 'JL0005' });
  });
  it('freezes provider diagnostics and refuses non-JSON, partial and duplicate replies', () => {
    assert.equal(QUERY_CODES.JQ0012, 'lexical provider missing or request declaration rejected');
    assert.equal(QUERY_CODES.JQ2012, 'lexical provider threw or returned an invalid result');
    const doc = { $lexical: ['catalog', 'tea', {}] };
    assert.throws(() => compileJsonQuery(doc), { code: 'JQ0012' });
    assert.throws(() => compileJsonQuery({ $lexical: [] }), { code: 'JQ0003' });
    for (const compile of [() => { throw new Error('bad spec'); }, () => 1])
      assert.throws(() => compileJsonQuery(doc, { lexicalProviders: { catalog: { compile } } }), { code: 'JQ0012' });
    assert.throws(() => compileJsonQuery({ $lexical: ['catalog', 'tea', 1] }), { code: 'JQ0003' });
    for (const result of [{ state: 'complete', hits: [null], total: 1 }, Promise.resolve({}), { state: 'complete', hits: [], total: null },
      { state: 'budget-exhausted', hits: [], total: 0 },
      { state: 'complete', hits: [{ id: 'a', score: 1 }, { id: 'a', score: 1 }], total: 2 }]) {
      const query = compileJsonQuery(doc, { lexicalProviders: { catalog: { compile: () => () => result } } });
      assert.throws(() => query(null), { code: 'JQ2012' });
    }
    const broken = compileJsonQuery(doc, { lexicalProviders: { catalog: { compile: () => () => { throw null; } } } });
    assert.throws(() => broken(null), { code: 'JQ2012' });
    const { provider } = source();
    assert.throws(() => compileJsonQuery({ $lexical: ['catalog', 1, {}] }, { lexicalProviders: { catalog: provider } })(null), { code: 'JQ2001' });
    for (const spec of [{ unknown: 1 }, { facets: ['category', 'category'] }, { order: { field: 1 } }])
      assert.throws(() => provider.compile(spec));
  });
});

rangeProviderContract('lexical complete bounded membership', async (options) => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `row-${i}`, title: 'tea' }));
  const index = compileLexical({ version: 1, fields: ['title'] }).create(); index.rebuild(rows, { sourceRevision: 'source-v1' });
  let revision = 'source-v1'; const observers = new Set();
  const source = { get sourceRevision() { return revision; },
    search: async (text, spec) => createLexicalProvider(index).compile(spec)(text),
    row: (id) => rows.find((row) => row.id === id), refresh: async () => ({ state: 'complete' }),
    subscribe(fn) { observers.add(fn); return () => observers.delete(fn); } };
  const provider = await createLexicalRangeProvider(source, 'tea', {}, { ...options, query: 'filter-sort-schema-v1' });
  return { provider: { ...provider, async request(request, signal) {
    if (request.snapshot === revision && request.snapshot !== provider.snapshot) await provider.refresh();
    return provider.request(request, signal);
  }, async dispose() { await provider.dispose(); index.dispose(); } },
  invalidate(next) { revision = next; index.rebuild(rows, { sourceRevision: revision }); for (const fn of observers) fn({ type: 'reset' }); },
  resources: () => provider.stats().pending + provider.stats().rows + observers.size };
});
