//@ts-check
/**
 * @file Regressions for the runtime-service quirks a reading of the
 * store found: change delivery keeps commit order for every observer
 * (a writing observer no longer inverts it for its siblings); a
 * rejected write on an asynchronous driver is a rejected write; live
 * views refuse the connection that cannot maintain them; the event-time
 * strategies hand the kernel its own spelling; journal capture records
 * a keyed upsert as the change it is; two stores over one file share
 * the change log; a closed store says so; the sync twin never queues; a
 * queue option reaches every driver; and the queue validates what it
 * stores.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { asyncWasmHandle, declaringWasmHandle, tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' }, n: { type: 'integer' }, at: { type: 'integer' } } },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};
const ALL = [{ $for: { it: '$[*]' }, $return: '$it' }];

describe('delivery keeps commit order', () => {
  for (const mode of ['session', 'journal']) {
    it(`a writing observer does not hand its record to its siblings before the older one (${mode})`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
      const notes = store.collection('notes');
      const live1 = await notes.live(ALL);
      const live2 = await notes.live(ALL);
      const live3 = await notes.live([{ $sum: { $for: { it: '$[*]' }, $return: '$it.n' } }]);
      live1.subscribe(({ patch }) => {
        if (patch.some((op) => op.op === 'add' && op.path === '/rows/0'))
          store.sync.collection('notes').patch('x', [{ op: 'replace', path: '/n', value: 2 }]);
      });
      const seen = [];
      live2.subscribe((event) => seen.push(event.seq));
      const observed = [];
      store.observe((record) => observed.push(record.seq));
      await notes.insert({ id: 'x', n: 1 });
      assert.deepStrictEqual(await notes.get('x'), { id: 'x', n: 2 });
      assert.deepStrictEqual(live1.result.rows, [{ id: 'x', n: 2 }]);
      assert.deepStrictEqual(live2.result.rows, [{ id: 'x', n: 2 }], 'the sibling holds the committed row');
      assert.deepStrictEqual(seen, [1, 2], 'in commit order');
      assert.deepStrictEqual(observed, [1, 2]);
      assert.deepStrictEqual(live3.result.rows, [2]);
      await store.close();
    });
  }
});

describe('an asynchronous driver', () => {
  it('rejects a write the database refused, with the coded error, and nothing leaks as an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = await openStore(MODEL, { driver: wasmDriver(asyncWasmHandle()) });
      const notes = store.collection('notes');
      await notes.insert({ id: 'a', n: 1 });
      await assert.rejects(notes.patch('a', [{ op: 'replace', path: '/n', value: 'not-an-int' }]), (e) => e.code === 'JD2005');
      await assert.rejects(notes.patch('a', [{ op: 'test', path: '/id', value: 'a' }, { op: 'replace', path: '/n', value: 'nope' }]), (e) => e.code === 'JD2005');
      assert.deepStrictEqual(await notes.get('a'), { id: 'a', n: 1 });
      await assert.rejects(notes.insert({ id: 'a', n: 2 }), (e) => e.code === 'JD2001');
      await store.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepStrictEqual(unhandled, []);
    }
    finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('is not maintained by a live view: the capability says so and registration refuses by name', async () => {
    const store = await openStore(MODEL, { driver: wasmDriver(asyncWasmHandle()), capture: true });
    assert.strictEqual(store.capabilities.live, false);
    await assert.rejects(store.collection('notes').live(ALL), (e) => e.code === 'JD0051');
    await store.close();
  });

  it('honours queueTimeout through the wasm driver as the node driver does', async () => {
    const store = await openStore(MODEL, { driver: wasmDriver(declaringWasmHandle({ userFunctions: true })), queueTimeout: 50 });
    const started = Date.now();
    await store.transaction(async () => {
      await null;
      await assert.rejects(store.transaction(async () => {}), (e) => e.code === 'JD0012' && /50ms/.test(e.message));
    });
    assert.ok(Date.now() - started < 2000, 'the bound was 50 ms, not the 5 s default');
    await store.close();
  });
});

describe('event-time views take the document’s selectors', () => {
  it('a $resample with an explicit value selector and a $rolling with at/value selectors maintain', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const notes = store.collection('notes');
    const eventTime = { path: '$.at', watermark: 0, retention: 100000 };
    const bucket = await notes.live([{ $resample: ['$[*]', { every: 1000, aggregate: 'sum', value: '$.n' }] }], { eventTime });
    await notes.insert({ id: 'a', at: 100, n: 3 });
    await notes.insert({ id: 'b', at: 200, n: 4 });
    assert.strictEqual(bucket.state, 'live');
    assert.deepStrictEqual(bucket.result.rows, [{ at: 0, count: 2, value: 7 }]);
    const rolling = await notes.live([{ $rolling: ['$[*]', { width: 1000, aggregate: 'sum', at: '$.at', value: '$.n' }] }], { eventTime });
    assert.strictEqual(rolling.mode.strategy, 'rolling');
    assert.deepStrictEqual(rolling.result.rows.map((row) => row.value), [3, 7]);
    await store.close();
  });

  it('an invalid eventTime declaration carries the collection in its docPath', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    await assert.rejects(store.collection('notes').live(ALL, { eventTime: { path: '$.at', watermark: 'x', retention: 1 } }),
      (e) => e.code === 'JD0053' && e.docPath === '/collections/notes');
    await store.close();
  });
});

describe('journal capture and the change log', () => {
  it('a keyed upsert of an existing document is the replace it is, and a no-op put is no record (both modes agree)', async () => {
    const patches = {};
    for (const mode of ['session', 'journal']) {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
      const seen = [];
      store.observe((record) => seen.push(record.patch));
      const notes = store.collection('notes');
      await notes.insert({ id: 'n1', body: 'a', n: 1 });
      await notes.put({ id: 'n1', body: 'b', n: 1 });
      await notes.put({ id: 'n1', body: 'b', n: 1 });
      await notes.put({ id: 'n1', body: 'c', n: 2 }, 'n1');
      patches[mode] = seen;
      await store.close();
    }
    assert.deepStrictEqual(patches.journal, patches.session);
    assert.strictEqual(patches.journal.length, 3);
    assert.deepStrictEqual(patches.journal[1], [{ op: 'replace', path: '/notes/n1/body', value: 'b' }]);
  });

  it('two stores over one file share the change log: the sequence is allocated by the statement', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const a = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, capture: { log: true } });
    const b = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, capture: { log: true } });
    await a.collection('notes').insert({ id: 'a1' });
    await b.collection('notes').insert({ id: 'b1' });
    await a.collection('notes').insert({ id: 'a2' });
    assert.deepStrictEqual((await a.changesSince(0)).map((record) => record.seq), [1, 2, 3]);
    assert.deepStrictEqual(await b.collection('notes').get('a2'), { id: 'a2' });
    await a.close();
    await b.close();
    cleanup();
  });

  it('changesSince() records carry their collections and refuse a cursor that is not a number', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: { log: true } });
    await store.collection('notes').insert({ id: 'n1' });
    const [record] = await store.changesSince(0);
    assert.deepStrictEqual(Object.keys(record).sort(), ['at', 'collections', 'patch', 'seq', 'source']);
    assert.deepStrictEqual(record.collections, ['notes']);
    await assert.rejects(store.changesSince(/** @type {any} */ (undefined)), TypeError);
    await store.close();
  });

  it('a log retention below one is refused at open', async () => {
    await assert.rejects(openStore(MODEL, { driver: nodeDriver(), capture: { log: { retention: 0 } } }), TypeError);
  });
});

describe('a closed store, the sync twin, and the queue', () => {
  it('every call after close() is JD2063; a second close is a no-op', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true, capture: { log: true } });
    await store.collection('notes').insert({ id: 'a' });
    await store.close();
    await assert.rejects(store.collection('notes').get('a'), (e) => e.code === 'JD2063');
    await assert.rejects(store.collection('notes').insert({ id: 'b' }), (e) => e.code === 'JD2063');
    await assert.rejects(store.dataVersion(), (e) => e.code === 'JD2063');
    await assert.rejects(store.jobs.enqueue('k', {}), (e) => e.code === 'JD2063');
    assert.throws(() => store.sync.collection('notes').get('a'), (e) => e.code === 'JD2063');
    assert.strictEqual(await store.close(), undefined);
  });

  it('the synchronous transaction refuses to queue behind an open transaction', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const outer = store.transaction(async () => { await gate; return 'outer'; });
    assert.throws(() => store.sync.transaction(() => 'value'), (e) => e.code === 'JD0012');
    release();
    assert.strictEqual(await outer, 'outer');
    assert.strictEqual(store.sync.transaction(() => 'value'), 'value');
    await store.close();
  });

  it('the queue validates runAt, maxAttempts and concurrency, and wraps storage failures', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    await assert.rejects(store.jobs.enqueue('k', null, { runAt: '2026-01-01' }), TypeError);
    await assert.rejects(store.jobs.enqueue('k', null, { runAt: /** @type {any} */ (new Date()) }), TypeError);
    await assert.rejects(store.jobs.enqueue('k', null, { maxAttempts: 0 }), TypeError);
    for (const concurrency of [0, -1, 1.5]) {
      assert.throws(() => store.jobs.createWorker({ handlers: { k: async () => 1 }, concurrency }), TypeError, `concurrency ${concurrency}`);
    }
    await store.close();
  });

  it('a read-only store refuses to create the queue or the log by name, and wraps the writes it cannot make', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const writer = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    await writer.close();
    await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, jobs: true }), (e) => e.code === 'JD0002');
    await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, capture: { log: true } }), (e) => e.code === 'JD0002');
    const prepared = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true, capture: { log: true } });
    await prepared.close();
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, jobs: true, capture: { log: true } });
    await assert.rejects(store.jobs.enqueue('k', {}), (e) => e.code === 'JD2005');
    const worker = store.jobs.createWorker({ handlers: { k: async () => 1 }, pollInterval: 5 }).start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(worker.stats().claimErrors > 0, 'a claim that failed is counted, not swallowed');
    await worker.stop();
    await store.close();
    cleanup();
    fs.rmSync(dbPath, { force: true });
  });
});
