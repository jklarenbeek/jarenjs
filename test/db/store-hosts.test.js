//@ts-check
/** The same differential oracle, including errors, on each host seam. */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver } from '../../packages/db/src/drivers/node-worker.js';
import { nodeWorkerPoolDriver } from '../../packages/db/src/drivers/node-pool.js';
import { loadGroups, storeForGroup, runCase, loadRelationGroups, storeForEntityGroup, runEntityCase } from './oracle/harness.js';

let sqlite3;
let folder;
let sequence = 0;
before(async () => {
  sqlite3 = await init({ print: () => {}, printErr: () => {} });
  folder = await mkdtemp(join(tmpdir(), 'jaren-host-oracle-'));
});
after(async () => { await rm(folder, { recursive: true }); });
const factories = {
  node: () => nodeDriver(),
  worker: () => nodeWorkerDriver(),
  pool: () => {
    const driver = nodeWorkerPoolDriver({ readers: 2 });
    return { ...driver, open: (_path, options) => driver.open(join(folder, `${++sequence}.sqlite`), options) };
  },
  'wasm-session': () => wasmDriver(sqlite3Handle(sqlite3)),
  'wasm-journal': () => wasmDriver(sqlite3Handle({ ...sqlite3,
    capi: { ...sqlite3.capi, sqlite3session_create: undefined } })),
};
const lifecycleModel = { $model: '0.1', collections: {
  notes: { key: '/id', schema: { type: 'object' } },
}, entities: {
  Parent: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    children: { 'x-entity': { relation: { to: 'Child', many: true, via: 'parentId', onDelete: 'cascade' } } },
  } } },
  Child: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, parentId: { type: 'string' }, body: { type: 'string' },
    parent: { 'x-entity': { relation: { to: 'Parent', via: 'parentId', onDelete: 'cascade' } } },
  } } },
} };
for (const [host, factory] of Object.entries(factories)) describe(`Store host oracle: ${host}`, () => {
  it('matches every collection value and coded error with and without pushdown', async () => {
    const driver = factory();
    for (const group of loadGroups()) {
      const { store, collection } = await storeForGroup(group, driver);
      try {
        for (const kase of group.cases) for (const mode of ['native', 'residual'])
          assert.equal(await runCase(collection, group.documents, kase, mode), null, `${group.group}/${kase.name}/${mode}`);
      }
      finally { await store.close(); }
    }
  });
  it('matches every entity, relation and join-root value and coded error', async () => {
    const driver = factory();
    for (const group of loadRelationGroups()) {
      const { store } = await storeForEntityGroup(group, driver);
      try {
        for (const kase of group.cases) for (const mode of ['native', 'residual'])
          assert.equal(await runEntityCase(store, { ...group.documents, ...group.memberships }, kase, mode), null, `${group.group}/${kase.name}/${mode}`);
      }
      finally { await store.close(); }
    }
  });
  it('preserves cursor/include bounds, capture, cancellation and nested transaction ownership', async () => {
    const store = await openStore(lifecycleModel, { driver: factory(), capture: { mode: 'auto', log: true } });
    try {
      await store.entity('Parent').create({ id: 'p' });
      for (const id of [1, 2]) await store.entity('Child').create({ id, parentId: 'p', body: 'é😀\\\n' });
      const parents = store.entity('Parent');
      const loaded = await parents.load({ include: { children: { orderBy: '$it.id' } } });
      assert.deepEqual(loaded[0].children.map((child) => child.id), [1, 2]);
      await assert.rejects(parents.load({ include: { children: { maxRows: 1 } } }), { code: 'JD2073' });
      await assert.rejects(parents.load({ include: { children: { maxBytes: 1 } } }), { code: 'JD2073' });
      const page = await parents.page({ include: { children: true } }, { limit: 1 });
      assert.equal(page.items.length, 1);
      assert.equal(page.hasMore, false);
      if (store.sync) assert.deepEqual(store.sync.entity('Parent').page({ include: { children: true } }, { limit: 1 }), page);
      for await (const row of parents.loadCursor()) { assert.equal(row.id, 'p'); break; }
      const controller = new AbortController();
      const cursor = store.entity('Child').loadCursor({}, { signal: controller.signal });
      await cursor.next();
      controller.abort();
      await assert.rejects(cursor.next(), { code: 'JD2072' });
      await cursor.return();
      await store.collection('notes').insert({ id: 'a', body: 'before' });
      let escaped;
      await store.transaction(async (tx) => {
        escaped = tx.collection('notes');
        await escaped.put({ id: 'a', body: 'after' });
        await assert.rejects(tx.transaction(async (nested) => {
          await nested.collection('notes').delete('a');
          throw new Error('rollback');
        }), /rollback/);
        assert.equal((await escaped.get('a')).body, 'after');
      });
      await assert.rejects(async () => escaped.get('a'), { code: 'JD2070' });
      assert.equal((await store.collection('notes').get('a')).body, 'after');
      assert.ok((await store.changesSince(0)).length > 0);
      assert.equal(store.capabilities.capture, host.startsWith('wasm-session') || host === 'node' ? 'session' : 'journal');
    }
    finally { await store.close(); }
    await assert.rejects(async () => store.entity('Parent').load(), { code: 'JD2063' });
  });
});
