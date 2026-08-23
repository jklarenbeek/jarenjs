//@ts-check
/**
 * @file The wasm driver against the REAL official SQLite wasm build
 * (`@sqlite.org/sqlite-wasm`, which also initializes under Node — the
 * same bytes the browser runs): the capability matrix (sessions NOT
 * declared → capture journals; user functions adapted), the FULL
 * pushdown oracle corpus in both native and forced-residual modes,
 * writes and patches, entities with the unit of work, journal capture,
 * live queries, the job queue, and a planned-and-applied migration
 * with its shadow verification — the whole store, one different
 * driver. The browser e2e then proves the ENVIRONMENT (OPFS, workers,
 * tabs); the engine parity is proven here.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore, migrate, planModelMigration, SQLITE_FLOOR } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import {
  loadGroups, storeForGroup, runCase, loadRelationGroups,
} from './oracle/harness.js';

/** @type {any} */
let sqlite3 = null;
/** @type {any} */
let driver = null;
before(async () => {
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  driver = wasmDriver(sqlite3Handle(sqlite3));
});

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, body: { type: 'string' },
        n: { type: 'integer' }, meta: { type: 'object' } } },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
  entities: {
    Item: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          n: { type: 'integer' },
          tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
        },
      },
    },
    Tag: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

describe('the wasm driver (real sqlite-wasm build)', () => {
  it('probes the capability matrix: journal capture, adapted functions', async () => {
    const store = await openStore(MODEL, { driver, capture: true });
    const caps = store.capabilities;
    assert.ok(caps.version >= SQLITE_FLOOR, `wasm build ${caps.version}`);
    assert.strictEqual(caps.capture, 'journal',
      'sessions are compiled into the wasm build but NOT yet adapted — journal, stated');
    assert.strictEqual(caps.live, true);
    assert.ok(store.sync, 'the oo1 API is synchronous — the fast path exists');
    await store.close();
  });

  it('writes, patches, transactions and RETURNING round-trip', async () => {
    const store = await openStore(MODEL, { driver, capture: true });
    const notes = store.collection('notes');
    await notes.insert({ id: 'a', body: 'one', n: 1, meta: { deep: [1, 2] } });
    await notes.patch('a', [{ op: 'replace', path: '/meta/deep/1', value: 9 }]);
    assert.deepStrictEqual(await notes.get('a'),
      { id: 'a', body: 'one', n: 1, meta: { deep: [1, 9] } });
    const seen = [];
    store.observe((record) => seen.push(record));
    await store.transaction(async () => {
      await notes.insert({ id: 'b', body: 'two', n: 2 });
      await notes.put({ id: 'a', body: 'ONE', n: 1, meta: { deep: [1, 9] } }, 'a');
      await notes.delete('b');
    });
    assert.strictEqual(seen.length, 1, 'one coalesced journal record per txn');
    assert.deepStrictEqual(seen[0].patch, [
      { op: 'replace', path: '/notes/a/body', value: 'ONE' },
    ], 'insert+delete vanished; the update diffed minimally');
    await store.close();
  });

  it('runs the ENTIRE pushdown oracle corpus, native and forced-residual', async () => {
    for (const group of loadGroups()) {
      const { store, collection } = await storeForGroup(group, driver);
      for (const kase of group.cases) {
        for (const mode of ['native', 'residual']) {
          await runCase(collection, group.documents, kase, mode);
        }
      }
      await store.close();
    }
  });

  it('entities: create, the unit of work, graph load, relations corpus', async () => {
    const store = await openStore(MODEL, { driver });
    await store.entity('Tag').create({ name: 't1' });
    await store.entity('Tag').create({ name: 't2' });
    await store.entity('Item').create({ id: 'i1', n: 1 });
    const items = store.entity('Item');
    const item = await items.get('i1');
    items.put({ ...item, n: 2, tags: ['t1', 't2'] });
    const report = await store.saveChanges();
    assert.strictEqual(report.joinInserted, 2);
    const loaded = await items.asNoTracking().load({ include: { tags: true } });
    assert.deepStrictEqual(loaded[0].tags.map((tag) => tag.name).sort(), ['t1', 't2']);
    await store.close();

    for (const group of loadRelationGroups().slice(0, 1)) {
      const entityStore = await openStore(group.model, { driver });
      for (const [name, docs] of Object.entries(group.documents)) {
        for (const doc of docs) await entityStore.entity(name).create(doc);
      }
      for (const kase of group.cases.slice(0, 5)) {
        const native = await entityStore.execute(kase.query,
          { externals: kase.externals });
        const residual = await entityStore.execute(kase.query,
          { externals: kase.externals, pushdown: false });
        assert.deepStrictEqual(native, residual, `${group.group}/${kase.name}`);
      }
      await entityStore.close();
    }
  });

  it('the streaming cursor iterates over the wasm connection', async () => {
    const store = await openStore(MODEL, { driver });
    const notes = store.collection('notes');
    for (let i = 0; i < 5; i++) await notes.insert({ id: `c${i}`, body: 'x', n: i });
    const seen = [];
    // a bare FLWOR (no array pack) plans NATIVE, so the cursor streams
    // row by row through the wasm iterate() adapter
    const cursor = notes.query({ $for: { it: '$[*]' },
      $where: { $gt: ['$it.n', 1] }, $return: '$it' });
    for await (const row of cursor) seen.push(row.n);
    assert.deepStrictEqual(seen.sort(), [2, 3, 4], 'the wasm iterate() adapter streams rows');

    // early break: the cursor's return() closes the underlying wasm
    // iterator before exhaustion
    const partial = [];
    for await (const row of notes.query({ $for: { it: '$[*]' }, $return: '$it' })) {
      partial.push(row.id);
      if (partial.length === 2) break;
    }
    assert.strictEqual(partial.length, 2, 'the wasm iterator closes on early break');
    await store.close();
  });

  it('live queries maintain incrementally over the wasm connection', async () => {
    const store = await openStore(MODEL, { driver, capture: true });
    const notes = store.collection('notes');
    await notes.insert({ id: 'a', body: 'x', n: 30 });
    const live = await notes.live([{
      $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 10] }, $return: '$it' }]);
    assert.deepStrictEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
    const events = [];
    live.subscribe((event) => events.push(event));
    await notes.insert({ id: 'b', body: 'y', n: 50 });
    await notes.insert({ id: 'c', body: 'z', n: 5 });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'b']);
    assert.strictEqual(events.length, 1, 'the sub-threshold insert emitted nothing');
    await store.close();
  });

  it('the job queue leases, executes and completes on wasm', async () => {
    const store = await openStore(MODEL, { driver, jobs: true });
    const worker = store.jobs.createWorker({
      handlers: { greet: (payload) => ({ hi: payload.name }) },
      pollInterval: 10,
    });
    worker.start();
    const id = await store.jobs.enqueue('greet', { name: 'wasm' });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const job = await store.jobs.get(id);
      if (job.state === 'done') {
        assert.deepStrictEqual(job.result, { hi: 'wasm' });
        break;
      }
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await worker.stop();
    await store.close();
  });

  it('a migration plans, shadow-verifies and applies through the wasm driver', async () => {
    const before_ = {
      $model: '0.1',
      collections: {
        docs: { schema: { type: 'object', properties: {
          id: { type: 'string' }, v: { type: 'integer' } } },
        key: '/id', indexes: [] },
      },
    };
    const after = {
      $model: '0.1',
      collections: {
        docs: { schema: { type: 'object', properties: {
          id: { type: 'string' }, v: { type: 'integer' } } },
        key: '/id', indexes: [{ name: 'by_v', path: '$.v' }] },
      },
    };
    // a NAMED shared-memory database (memdb, leading slash = shared)
    // is the wasm twin of a temp file — it lives while any connection
    // holds it, so a holder spans the three opens
    const uri = 'file:/mig1?vfs=memdb';
    const holder = new sqlite3.oo1.DB(uri, 'c');
    const first = await openStore(before_, { driver, path: uri });
    await first.collection('docs').insert({ id: 'a', v: 1 });
    await first.close();

    const { migration } = planModelMigration(before_, after,
      { dialect: driver.dialect, id: 'm1' });
    assert.ok(migration.steps.length > 0);
    const report = await migrate({ driver, path: uri },
      [migration], { baseline: before_, model: after, shadow: true });
    assert.strictEqual(report.applied.length, 1);

    const reopened = await openStore(after, { driver, path: uri });
    assert.deepStrictEqual(await reopened.collection('docs').get('a'),
      { id: 'a', v: 1 }, 'the data survived the migration');
    await reopened.close();
    holder.close();
  });

  it('indexes a DERIVED spatial column through the registered functions', async () => {
    // the capability that decides the physical mapping is real here:
    // this build registers deterministic functions and indexes columns
    // generated from them, so the same model document that produces
    // stored columns on Bun produces virtual ones on this driver
    const spatial = {
      $model: '0.1',
      collections: {
        places: {
          schema: { type: 'object', properties: {
            id: { type: 'string' }, at: { type: 'array' }, area: { type: 'object' } } },
          key: '/id',
          indexes: [
            { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 5 },
            { name: 'by_box', path: '$.area', derive: 'bbox' },
          ],
        },
      },
    };
    const uri = 'file:/spatial1?vfs=memdb';
    const holder = new sqlite3.oo1.DB(uri, 'c');
    const store = await openStore(spatial, { driver, path: uri });
    assert.strictEqual(store.capabilities.deterministicIndexableFunctions, true);
    await store.collection('places').insert({
      id: 'ams',
      at: [4.9041, 52.3676],
      area: { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] },
    });
    await store.close();

    const probe = new sqlite3.oo1.DB(uri, 'c');
    // a connection that has NOT registered the functions cannot read
    // the table at all — the hazard the capability gate exists for
    assert.throws(() => probe.exec({ sql: 'SELECT "gx_at_gh5" FROM "places"' }),
      /jaren_geohash/);
    probe.close();

    const reopened = await openStore(spatial, { driver, path: uri });
    assert.deepStrictEqual(await reopened.collection('places').get('ams'), {
      id: 'ams',
      at: [4.9041, 52.3676],
      area: { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] },
    }, 'a second open verifies the shape, registers the functions and reads');
    await reopened.close();
    holder.close();
  });
});
