//@ts-check
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createDbSearch, createDbSearchStorage } from '@jarenjs/db/search';
import { compileLexical } from '@jarenjs/core/search';
import { createLexicalRangeProvider } from '@jarenjs/linq/db';
import { rangeRequest } from '../adoption/range-provider-contract.js';

const definition = { version: 1, fields: ['title'] };
const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, title: { type: 'string' }, category: { type: 'string' }, allowed: { type: 'boolean' },
} } } }, collections: { snapshots: { schema: { type: 'object' }, key: '/id', indexes: [] } } };
const documents = [{ id: 'a', title: 'tea tea', category: 'red', allowed: false },
  { id: 'b', title: 'tea', category: 'blue', allowed: true }, { id: 'c', title: 'tea', category: 'blue', allowed: true }];
async function host() {
  const store = await openStore(model, { driver: nodeDriver(), capture: true });
  for (const row of documents) await store.entity('Item').create(row);
  const storage = createDbSearchStorage(store, 'snapshots');
  return { store, storage, options: { source: 'catalog', storage } };
}
describe('persisted lexical execution', () => {
  it('agrees with resident ranking, filters before limits, restores and never rewrites equal snapshots', async () => {
    const { store, storage, options } = await host(); let source;
    try {
      source = await createDbSearch(store, 'Item', definition, options);
      const resident = compileLexical(definition).create(); resident.rebuild(documents);
      assert.deepEqual((await source.search('tea')).hits, resident.search('tea').hits);
      const result = await source.search('tea', { where: '$.allowed', facets: ['category'], limit: 1 });
      assert.deepEqual(result.hits.map((h) => h.id), ['b']); assert.equal(result.total, 2);
      assert.deepEqual(result.facets.category, [{ value: 'blue', count: 2 }]);
      assert.equal(source.stats().writes, 1); assert.equal((await source.refresh()).changes, 0); assert.equal(source.stats().writes, 1);
      const saved = await storage.load('catalog:Item'); assert.equal((await storage.save('catalog:Item', saved)).changes, 0);
      await source.dispose(); source = await createDbSearch(store, 'Item', definition, options);
      assert.equal(source.stats().restores, 1); assert.equal(source.stats().writes, 0);
      assert.deepEqual((await source.search('tea')).hits, resident.search('tea').hits);
      const events = []; source.subscribe((event) => events.push(event));
      const oldRevision = source.sourceRevision;
      await store.entity('Item').update('b', { title: 'coffee' });
      assert.equal(events.length, 1); assert.equal(source.stats().dirty, true);
      assert.throws(() => source.row('b', oldRevision));
      assert.deepEqual((await source.search('tea')).hits.map((hit) => hit.id), ['a', 'c']);
      assert.equal((await source.search('tea', { sourceRevision: oldRevision })).state, 'invalidated');
      assert.equal(source.explain().nativeFTS, false); resident.dispose();
    }
    finally { await source?.dispose(); await store.close(); }
  });
  it('corrupt caches recover from the source and failed persistence does not report success', async () => {
    const { store, storage, options } = await host(); let source;
    try {
      await storage.save('catalog:Item', '{broken');
      source = await createDbSearch(store, 'Item', definition, options);
      assert.equal(source.stats().recovery, 'corrupt-snapshot'); assert.equal((await source.search('tea')).total, 3);
      await source.dispose();
      await assert.rejects(createDbSearch(store, 'Item', definition, { ...options,
        storage: { load: async () => null, save: async () => { throw new Error('disk full'); } } }), /disk full/);
      await assert.rejects(createDbSearch(store, 'Item', definition, { ...options, maxRows: 1 }), /row credits/);
      await assert.rejects(createDbSearch(store, 'Item', definition, { ...options, maxBytes: 3 }));
      await assert.rejects(createDbSearchStorage(store, 'snapshots', { maxBytes: 1 }).save('a', 'too large'));
      await assert.rejects(createDbSearchStorage(store, 'snapshots', { maxBytes: 1 }).load('catalog:Item'));
      assert.equal(await storage.load('missing'), null);
    }
    finally { await source?.dispose(); await store.close(); }
  });
  it('feeds credited ranges, resets stale pages, rejects incomplete top-k and drains resources', async () => {
    const { store, options } = await host(); let source, provider;
    try {
      source = await createDbSearch(store, 'Item', definition, options);
      await assert.rejects(createLexicalRangeProvider(source, 'tea', {}, { maxMatches: 1 }), /complete membership/);
      provider = await createLexicalRangeProvider(source, 'tea', {}, { maxMatches: 10, maxRows: 2 });
      const request = rangeRequest({ query: provider.query, snapshot: provider.snapshot, range: { start: 0, end: 2 } });
      const first = await provider.request(request); assert.deepEqual(first.keys, ['a', 'b']);
      const events = [];
      provider.subscribe(() => { throw new Error('observer fault'); });
      const stop = provider.subscribe(event => events.push(event));
      await store.entity('Item').update('b', { title: 'coffee' });
      assert.equal((await provider.request(request)).state, 'invalidated');
      assert.equal(events.length, 1); assert.equal(events[0].type, 'reset'); stop();
      await provider.refresh();
      const current = { ...request, snapshot: provider.snapshot, generation: 2 };
      assert.deepEqual((await provider.request(current)).keys, ['a', 'c']);
      const pages = []; for await (const page of provider.export({ query: provider.query, snapshot: provider.snapshot, pageRows: 1 })) pages.push(page);
      assert.equal(pages.at(-1).state, 'complete'); assert.equal(pages.at(-1).total, 2);
      assert.equal(provider.indexOf('c'), 1);
      await provider.dispose(); await source.dispose();
      assert.equal((await provider.request(request)).reason, 'disposed'); assert.equal(source.stats().sourceRows, 0);
      assert.equal(source.stats().pending, 0); assert.equal(provider.stats().rows, 0);
    }
    finally { await provider?.dispose(); await source?.dispose(); await store.close(); }
  });
});

it('external SQL invalidates ranges and export; reopened caches validate uncaptured source content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-search-')), path = join(directory, 'search.sqlite');
  let store, source, provider, raw;
  try {
    store = await openStore(model, { driver: nodeDriver(), path, capture: { mode: 'journal' } });
    for (const row of documents) await store.entity('Item').create(row);
    const options = { source: 'external', storage: createDbSearchStorage(store, 'snapshots') };
    source = await createDbSearch(store, 'Item', definition, options);
    provider = await createLexicalRangeProvider(source, 'tea', {}, { maxMatches: 10 });
    raw = new DatabaseSync(path);
    const tables = raw.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name='Item'").all();
    assert.equal(tables.length, 1);
    raw.exec(`UPDATE Item SET title = 'coffee' WHERE id='b'`);
    assert.equal((await provider.request(rangeRequest({ query: provider.query, snapshot: provider.snapshot }))).state, 'invalidated');
    await provider.refresh(); assert.equal((await source.search('tea')).total, 2);
    const output = provider.export({ query: provider.query, snapshot: provider.snapshot, pageRows: 1 });
    assert.equal((await output.next()).value.state, 'ready');
    raw.exec(`UPDATE Item SET title = 'coffee' WHERE id='c'`);
    await assert.rejects(output.next(), /Incomplete lexical snapshot/);
    await provider.dispose(); provider = null; await source.dispose(); source = null; await store.close();
    raw.exec(`UPDATE Item SET title = 'coffee' WHERE id='a'`); raw.close(); raw = null;
    store = await openStore(model, { driver: nodeDriver(), path, capture: { mode: 'journal' } });
    source = await createDbSearch(store, 'Item', definition, { source: 'external', storage: createDbSearchStorage(store, 'snapshots') });
    assert.equal(source.stats().recovery, 'source-stale'); assert.equal((await source.search('tea')).total, 0);
    assert.equal((await source.refresh()).changes, 0); assert.equal(source.stats().writes, 1);
  }
  finally { await provider?.dispose(); await source?.dispose(); await store?.close(); raw?.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('failed snapshot persistence retries the same generation and capture-free hosts refuse freshness', async () => {
  const { store, storage, options } = await host(); let source, fail = false;
  try {
    source = await createDbSearch(store, 'Item', definition, { ...options, storage: { load: storage.load,
      save: async (...args) => { if (fail) throw new Error('disk full'); return storage.save(...args); } } });
    await store.entity('Item').update('a', { title: 'coffee' }); fail = true;
    assert.equal((await source.search('tea')).state, 'error'); assert.equal(source.stats().dirty, true);
    fail = false; assert.equal((await source.search('tea')).total, 2); assert.equal(source.stats().writes, 2);
    assert.equal((await source.refresh()).changes, 0); assert.equal(source.stats().writes, 2);
    await source.dispose(); assert.equal((await source.search('tea')).reason, 'disposed');
    const plain = await openStore(model, { driver: nodeDriver() });
    try { await assert.rejects(createDbSearch(plain, 'Item', definition, { source: 'none' }), /capture/); }
    finally { await plain.close(); }
  }
  finally { await source?.dispose(); await store.close(); }
});

it('validates injected source tokens around reads and bounds asynchronous invalidation observers', async () => {
  const { store, options } = await host();
  let token = 0, calls = 0, churn = false, source;
  const release = Promise.withResolvers();
  try {
    const revision = { name: 'host-external-revision', read(tx) {
      assert.equal(tx.close, undefined, 'the revision provider receives the exact transaction view');
      calls++; return churn ? ++token : token;
    } };
    source = await createDbSearch(store, 'Item', definition, { ...options, revision });
    assert.equal(source.explain().revision, 'host-external-revision');
    const before = source.sourceRevision;
    churn = true;
    assert.equal((await source.refresh()).state, 'invalidated');
    assert.equal(source.sourceRevision, before, 'a mixed token cannot publish a new index');
    churn = false;
    assert.equal((await source.refresh()).state, 'complete');
    const events = [];
    const unsubscribe = source.subscribe((event) => { events.push(event); return release.promise; });
    for (let i = 0; i < 10; i++) await store.entity('Item').update('a', { title: String(i) });
    assert.equal(events.length, 1); assert.equal(source.stats().observerPending, 2);
    unsubscribe(); release.resolve(); await release.promise; await Promise.resolve();
    assert.equal(events.length, 1, 'unsubscription suppresses pending delivery');
    assert.equal(source.stats().subscriptions, 0);
    const seen = []; let stop;
    stop = source.subscribe(() => {
      seen.push('original'); stop();
      stop = source.subscribe(() => { seen.push('replacement'); });
    });
    await store.entity('Item').update('a', { title: 'original' });
    assert.deepEqual(seen, ['original']);
    await store.entity('Item').update('a', { title: 'replacement' });
    assert.deepEqual(seen, ['original', 'replacement']); stop();
    assert.ok(calls >= 6);
    await assert.rejects(createDbSearch(store, 'Item', definition,
      { source: 'bad-token', revision: { name: 'invalid', read: () => ({ token: 1 }) } }), /finite number or a string/);
  }
  finally { release.resolve(); await source?.dispose(); await store.close(); }
});
