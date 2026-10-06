//@ts-check
/**
 * Real remote statement limits: completed semantic plans and explanations
 * release capacity, while a cursor keeps the resource its next pull needs.
 * The minimal worker has ten fixed Store statements and one query slot.
 * The populated matrix leaves room for two entity layouts, graph children,
 * writes and simultaneous cursor statements; its 100 plans exceed the
 * entire 64-statement host capacity, not only the one-plan cache bound.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { compileJsonQuery } from '@jarenjs/json/query';
import { tempDbPath } from './helpers.js';

const MINIMAL = { $model: '0.1', collections: { items: {
  key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } }, indexes: [],
} } };
const COLLECTION = { $model: '0.1', collections: { items: {
  key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } },
  indexes: [{ name: 'by_n', path: '$.n' }],
} } };
const ENTITIES = { $model: '0.1', entities: {
  Item: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' },
    children: { 'x-entity': { relation: { to: 'Child', many: true, via: 'ownerId', onDelete: 'cascade' } } },
  } } },
  Child: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, ownerId: { type: 'string' }, n: { type: 'integer' },
  } } },
} };
const ROWS = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }];
const CHILDREN = [{ id: 'x', ownerId: 'a', n: 1 }, { id: 'y', ownerId: 'a', n: 2 }, { id: 'z', ownerId: 'b', n: 3 }];

/** @param {number} id */
const minimalQuery = (id) => ({ $for: { it: '$[*]' }, $where: { $eq: ['$it.id', String(id)] }, $return: '$it' });
/** @param {string} from @param {number} min */
const query = (from, min) => ({ $for: { it: from }, $where: { $ge: ['$it.n', min] }, $orderby: '$it.id', $return: '$it' });

/** Every test owns a fresh database and closes its host before removing it.
 * @param {any} driver @param {any} model @param {(store: any) => Promise<void>} run
 * @param {boolean} [file]
 */
async function withStore(driver, model, run, file = false) {
  const { dbPath, cleanup } = tempDbPath();
  let store;
  try {
    store = await openStore(model, { driver, path: file ? dbPath : ':memory:', statementCacheBound: 1 });
    await run(store);
  }
  finally {
    try { await store?.close(); }
    finally { cleanup(); }
  }
}

it('worker capacity 11 executes 100 distinct simple plans with a one-plan cache', async () => {
  await withStore(nodeWorkerDriver({ maxStatements: 11 }), MINIMAL, async (store) => {
    for (let n = 0; n < 100; n++) {
      assert.equal(await store.collection('items').execute(minimalQuery(n)), undefined, `plan ${n}`);
    }
    assert.equal(store.stats().statementCache.evictions, 99);
  });
});

it('worker capacity 11 explains one identical plan 100 times without retaining temporary statements', async () => {
  await withStore(nodeWorkerDriver({ maxStatements: 11 }), MINIMAL, async (store) => {
    for (let n = 0; n < 100; n++) {
      const explained = await store.collection('items').explain(minimalQuery(0));
      assert.equal(explained.mode, 'native', `explanation ${n}`);
      assert.match(explained.sql, /^SELECT\b/);
    }
    assert.equal(store.stats().statementCache.evictions, 0);
  });
});

it('worker capacity 11 preserves JD0011 for 100 repeated scan refusals', async () => {
  await withStore(nodeWorkerDriver({ maxStatements: 11 }), MINIMAL, async (store) => {
    for (let n = 0; n < 100; n++) {
      await assert.rejects(() => store.collection('items').execute('$[*]', { profile: { refuseFullScan: true } }),
        { code: 'JD0011' }, `refused scan ${n}`);
    }
  });
});

it('worker capacity 11 keeps 100 independent streaming cursor plans bounded', async () => {
  await withStore(nodeWorkerDriver({ maxStatements: 11 }), MINIMAL, async (store) => {
    for (let n = 0; n < 100; n++) {
      const cursor = store.collection('items').query(minimalQuery(n));
      assert.equal(cursor.streaming, 'row');
      assert.deepEqual(await cursor.next(), { done: true, value: undefined });
      await cursor.return();
    }
  });
});

/** @type {[string, () => any][]} */
const HOSTS = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 64, windowRows: 1 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 1, worker: { maxStatements: 64, windowRows: 1 } })],
];
// The process binding's public runtime contract is Node 24+; Bun runs
// the worker and pool cases over the same package exports instead.
if (!process.versions.bun) HOSTS.push(['process', () => nodeProcessDriver({ maxStatements: 64, windowRows: 1 })]);

/** @param {any} store */
async function seedEntities(store) {
  for (const row of ROWS) await store.entity('Item').create(row);
  for (const child of CHILDREN) await store.entity('Child').create(child);
}

for (const [host, driver] of HOSTS) {
  it(`${host}: 100 collection plans agree with the JSON query oracle after eviction`, async () => {
    await withStore(driver(), COLLECTION, async (store) => {
      const items = store.collection('items');
      for (const row of ROWS) await items.insert(row);
      for (let n = 0; n < 100; n++) {
        const document = query('$[*]', n - 47);
        assert.deepEqual(await items.execute(document), compileJsonQuery(document)(ROWS), `plan ${n}`);
      }
    }, true);
  });

  it(`${host}: 100 entity plans agree with the JSON query oracle after eviction`, async () => {
    await withStore(driver(), ENTITIES, async (store) => {
      await seedEntities(store);
      for (let n = 0; n < 100; n++) {
        const document = query('$.Item[*]', n - 47);
        // The root and entity-handle entry points share one semantic owner.
        const source = n % 2 ? store.entity('Item') : store;
        assert.deepEqual(await source.execute(document), compileJsonQuery(document)({ Item: ROWS }), `plan ${n}`);
      }
    }, true);
  });

  it(`${host}: 100 graph-load plans preserve root and included rows after eviction`, async () => {
    await withStore(driver(), ENTITIES, async (store) => {
      await seedEntities(store);
      for (let n = 0; n < 100; n++) {
        const min = n - 47;
        const spec = { where: { $ge: ['$it.n', min] }, orderBy: '$it.id',
          include: { children: { orderBy: '$it.id' } } };
        const expected = ROWS.filter((row) => row.n >= min)
          .map((row) => ({ ...row, children: CHILDREN.filter((child) => child.ownerId === row.id) }));
        assert.deepEqual(await store.entity('Item').load(spec), expected, `load ${n}`);
      }
    }, true);
  });

  it(`${host}: lazy materializing and active streaming cursors survive plan eviction`, async () => {
    await withStore(driver(), COLLECTION, async (store) => {
      const items = store.collection('items');
      for (const row of ROWS) await items.insert(row);
      const document = { $for: { it: '$[*]' }, $let: { n: '$it.n' }, $orderby: '$it.id', $return: '$n' };
      assert.deepEqual(await items.execute(document), [1, 2, 3]);
      const delayed = items.query(document);
      assert.equal(delayed.streaming, 'buffered');
      await items.execute(query('$[*]', 0));
      const materialized = [];
      for await (const row of delayed) materialized.push(row);
      assert.deepEqual(materialized, [1, 2, 3]);

      const streaming = items.query(query('$[*]', 1));
      assert.equal(streaming.streaming, 'row');
      assert.deepEqual(await streaming.next(), { done: false, value: ROWS[0] });
      await items.execute(query('$[*]', 2));
      const remaining = [];
      for await (const row of streaming) remaining.push(row);
      assert.deepEqual(remaining, ROWS.slice(1));

      for (let n = 0; n < 100; n++) {
        const early = items.query(query('$[*]', -n));
        assert.deepEqual(await early.next(), { done: false, value: ROWS[0] });
        await early.return();
      }
    }, true);
  });

  it(`${host}: a lazy entity count uses its retired plan safely`, async () => {
    await withStore(driver(), ENTITIES, async (store) => {
      await seedEntities(store);
      const document = { $count: '$.Item[*]' };
      assert.equal(await store.execute(document), 3);
      const cursor = store.entity('Item').cursor(document);
      await store.execute(query('$.Item[*]', 0));
      assert.deepEqual(await cursor.next(), { done: false, value: 3 });
      assert.deepEqual(await cursor.next(), { done: true, value: undefined });
    }, true);
  });
}
