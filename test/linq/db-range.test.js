//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { open, createDbRangeProvider } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { rangeProviderContract, rangeRequest, assertRangeResponse } from '../adoption/range-provider-contract.js';
import { statementCountingDriver, tempDbPath } from '../db/helpers.js';

const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, rank: { type: 'integer' }, revision: { type: 'integer' },
} } } } };

async function source(options = {}) {
  const client = await open(model, { driver: nodeDriver(), capture: true });
  for (let i = 0; i < 10; i++) await client.entities.Row.create({ id: `row-${i}`, rank: Math.floor(i / 2), revision: 0 });
  const provider = await client.entities.Row.range({ orderBy: '$it.id' }, { keys: ['id'], resident: true,
    source: 'source', query: 'filter-sort-schema-v1', ...options });
  return { client, provider };
}

rangeProviderContract('SQLite bounded resident source', async (options) => {
  const { client, provider } = await source(options);
  return { provider: { ...provider, dispose: async () => { await provider.dispose(); await client.close(); } },
    invalidate: () => client.store.sync.entity('Row').update('row-0', { revision: 1 }),
    resources: () => { const s = provider.stats(); return s.pending + s.pages + s.rows + s.subscriptions; } };
});

it('sequential pages obey row work credits, preserve tied keys and refuse hidden index scans', async () => {
  const { client, provider: seeded } = await source();
  await seeded.dispose();
  const provider = await createDbRangeProvider(client.store, 'Row', { orderBy: '$it.rank' },
    { keys: ['id'], source: 'source', query: 'filter-sort-schema-v1', maxPages: 2 });
  try {
    assert.equal(provider.capabilities.seekIndex, false);
    const before = provider.stats().sourceReads;
    assert.equal((await provider.request(rangeRequest({ range: { start: 8, end: 9 } }))).reason, 'unsupported-seek');
    assert.equal(provider.stats().sourceReads, before);
    const seen = [];
    let request = rangeRequest();
    for (;;) {
      const result = await provider.request(request);
      assertRangeResponse(request, result);
      assert.equal(result.state, 'ready', JSON.stringify(result));
      seen.push(...result.keys);
      assert.ok(provider.stats().pages <= 2);
      if (!result.continuation) break;
      request = rangeRequest({ range: undefined, continuation: result.continuation, requestId: `next-${seen.length}` });
    }
    assert.deepEqual(seen, Array.from({ length: 10 }, (_, i) => `row-${i}`));
    assert.equal(provider.stats().sourceRows, 10, 'no eleventh lookahead row is admitted');
  }
  finally { await provider.dispose(); await client.close(); }
});

it('superseded requests cannot publish and disposal drains queued database work', async () => {
  const { client, provider } = await source();
  let release;
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const held = client.transaction(async () => { admitted(); await new Promise((resolve) => { release = resolve; }); });
  await started;
  try {
    const old = provider.request(rangeRequest());
    const newer = provider.request(rangeRequest({ generation: 2, requestId: 'newer' }));
    release(); await held;
    assert.equal((await old).reason, 'superseded');
    assert.equal((await newer).state, 'ready');
  }
  finally { release(); await held; await provider.dispose(); await client.close(); }
});

it('committed source changes issue explicit resets and invalidate old continuations', async () => {
  const { client, provider } = await source();
  try {
    const events = [];
    provider.subscribe((event) => events.push(event));
    const first = await provider.request(rangeRequest());
    await client.entities.Row.update('row-9', { rank: -1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reset');
    assert.equal(events[0].revision, 2);
    assert.equal((await provider.request(rangeRequest({ range: undefined, continuation: first.continuation }))).state, 'invalidated');
    const current = rangeRequest({ snapshot: provider.snapshot, generation: 2 });
    assertRangeResponse(current, await provider.request(current));
  }
  finally { await provider.dispose(); await client.close(); }
});

it('dispose cancels and drains an admitted request while another transaction remains open', async () => {
  const { client, provider } = await source();
  let release;
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const held = client.transaction(async () => { admitted(); await new Promise((resolve) => { release = resolve; }); });
  await started;
  try {
    const request = provider.request(rangeRequest());
    await new Promise((resolve) => setImmediate(resolve));
    await provider.dispose();
    assert.equal((await request).reason, 'disposed');
    assert.equal(provider.stats().pending, 0);
  }
  finally { release(); await held; await provider.dispose(); await client.close(); }
});

it('resident and sequential ranges share the primary-key tie order', async () => {
  const client = await open(model, { driver: nodeDriver(), capture: true });
  const providers = [];
  try {
    for (const id of ['row-2', 'row-0', 'row-1']) await client.entities.Row.create({ id, rank: 0, revision: 0 });
    for (const resident of [true, false]) {
      const provider = await client.entities.Row.range({ orderBy: '$it.rank' }, {
        keys: ['id'], resident, source: 'source', query: 'filter-sort-schema-v1',
      });
      providers.push(provider);
      assert.deepEqual((await provider.request(rangeRequest())).keys, ['row-0', 'row-1', 'row-2']);
    }
  }
  finally { await Promise.all(providers.map((provider) => provider.dispose())); await client.close(); }
});

it('throwing reset observers cannot block sibling observers', async () => {
  const { client, provider } = await source();
  try {
    const events = [];
    provider.subscribe(() => { throw new Error('observer failure'); });
    provider.subscribe((event) => events.push(event));
    await client.entities.Row.update('row-0', { revision: 1 });
    assert.deepEqual(events.map((event) => event.snapshot), ['source-v2']);
  }
  finally { await provider.dispose(); await client.close(); }
});

it('resident refresh refuses insufficient work before scanning and charges its bounded refill', async () => {
  const { client, provider } = await source({ maxRows: 10 });
  try {
    await client.entities.Row.update('row-0', { revision: 1 });
    const before = provider.stats();
    const request = rangeRequest({ snapshot: provider.snapshot, range: { start: 0, end: 1 },
      credits: { pages: 1, rows: 1, bytes: 4096, work: 1 } });
    const refused = await provider.request(request);
    assert.equal(refused.state, 'budget-exhausted');
    assert.equal(refused.used.work, 0);
    assert.equal(provider.stats().sourceReads, before.sourceReads);
    request.credits.work = 12;
    const result = await provider.request(request);
    assertRangeResponse(request, result);
    assert.equal(result.state, 'ready');
    assert.equal(result.rows[0].revision, 1);
    assert.equal(result.used.work, 11);
    assert.equal(provider.stats().sourceRows - before.sourceRows, 10);
  }
  finally { await provider.dispose(); await client.close(); }
});

it('byte boundaries charge every consumed source row, including an oversized first row', async () => {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const client = await open(model, { driver: statementCountingDriver(counters), capture: true });
  let provider;
  try {
    for (let i = 0; i < 3; i++) await client.entities.Row.create({ id: `row-${i}`, rank: 0, revision: 0 });
    provider = await client.entities.Row.range({ orderBy: '$it.id' }, {
      keys: ['id'], source: 'source', query: 'filter-sort-schema-v1',
    });
    Object.assign(counters, { iterate: 0, next: 0, return: 0, all: 0 });
    const row = { id: 'row-0', rank: 0, revision: 0 };
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    const request = rangeRequest({ credits: { pages: 1, rows: 3, bytes: rowBytes + 5, work: 3 } });
    const result = await provider.request(request);
    assertRangeResponse(request, result);
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.keys, ['row-0']);
    assert.equal(counters.next, 2);
    assert.equal(result.used.work, 2);
    assert.equal(provider.stats().sourceRows, 2);
    assert.equal(provider.stats().sourceBytes, rowBytes * 2);
    const before = provider.stats();
    const oversized = await provider.request(rangeRequest({
      credits: { pages: 1, rows: 3, bytes: 5, work: 3 },
    }));
    assert.equal(oversized.state, 'budget-exhausted');
    assert.equal(oversized.used.work, 1);
    assert.equal(provider.stats().sourceRows - before.sourceRows, 1);
    assert.equal(provider.stats().sourceBytes - before.sourceBytes, rowBytes);
  }
  finally { await provider?.dispose(); await client.close(); }
});

it('a queued root entity page cancels while the unrelated transaction remains open', async () => {
  const { client, provider } = await source();
  let release;
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const held = client.transaction(async () => { admitted(); await new Promise((resolve) => { release = resolve; }); });
  await started;
  try {
    const controller = new AbortController();
    const pending = client.store.entity('Row').page({}, { limit: 1, signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'JD2064' });
    controller.abort();
    await rejected;
  }
  finally { release(); await held; await provider.dispose(); await client.close(); }
});

it('foreign commits require an explicit source reset before resident results refresh', async () => {
  const { dbPath, cleanup } = tempDbPath();
  let client;
  let other;
  let provider;
  try {
    client = await open(model, { driver: nodeDriver(), path: dbPath, capture: true });
    await client.entities.Row.create({ id: 'row-0', rank: 0, revision: 0 });
    provider = await client.entities.Row.range({}, { keys: ['id'], resident: true, maxRows: 3,
      source: 'source', query: 'filter-sort-schema-v1' });
    other = await open(model, { driver: nodeDriver(), path: dbPath });
    await other.entities.Row.create({ id: 'row-1', rank: 0, revision: 0 });
    const events = [];
    provider.subscribe((event) => events.push(event));
    const result = await provider.request(rangeRequest());
    assert.equal(result.state, 'invalidated');
    assert.equal(events[0].reason, 'external-source-changed');
    const current = rangeRequest({ snapshot: provider.snapshot,
      credits: { pages: 1, rows: 3, bytes: 4096, work: 7 } });
    const refreshed = await provider.request(current);
    assertRangeResponse(current, refreshed);
    assert.deepEqual(refreshed.keys, ['row-0', 'row-1']);
    assert.deepEqual(refreshed.total, { kind: 'known', value: 2 });
  }
  finally { await provider?.dispose(); await other?.close(); await client?.close(); cleanup(); }
});

it('a caller cannot change the profile behind an established query identity', async () => {
  const profile = { maxRows: 1 };
  const { client, provider } = await source({ resident: false, profile, query: undefined });
  try {
    const query = provider.query;
    profile.maxRows = 3;
    const result = await provider.request(rangeRequest({ query }));
    assert.equal(result.state, 'budget-exhausted');
    assert.equal(result.reason, 'JD2007');
    assert.equal(provider.query, query);
    assert.match(query, /"maxRows":1/);
  }
  finally { await provider.dispose(); await client.close(); }
});
