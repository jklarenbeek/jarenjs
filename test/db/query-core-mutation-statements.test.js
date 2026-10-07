//@ts-check
/**
 * @file The entity mutation statement cache on the remote hosts. A
 * worker, pool or process host keeps every prepared statement until it
 * is finalized, so a statement the bounded mutation cache evicts must be
 * released once its admitted use settles: two hundred distinct mutation
 * shapes run on a host with room for one hundred handles, and the store
 * keeps answering ordinary reads afterwards.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { sql } from '@jarenjs/db/relational';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { model } from './fixtures/mutation-model.mjs';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', ...model };

/** @type {[string, () => any][]} */
const HOSTS = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 100 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 1, worker: { maxStatements: 100 } })],
];
// The process binding's public runtime contract is Node 24+.
if (!process.versions.bun) HOSTS.push(['process', () => nodeProcessDriver({ maxStatements: 100 })]);

/** The application-owned table the physical entity maps. @param {string} dbPath */
async function createTable(dbPath) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(dbPath);
  try {
    await db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT');
  }
  finally {
    await db.close();
  }
}

/** One mutation shape per key-list length. @param {number} size */
const shape = (size) => ({ op: 'update', where: sql.in(sql.column('id'), Array.from({ length: size }, (_, i) => i + 1)),
  set: { payload: String(size) }, returning: ['id'] });

for (const [host, driver] of HOSTS) {
  it(`${host}: 200 distinct mutation shapes release evicted statements within 100 handles`, async () => {
    const { dbPath, cleanup } = tempDbPath();
    let store;
    try {
      await createTable(dbPath);
      store = await openStore(MODEL, { driver: driver(), path: dbPath, statementCacheBound: 1 });
      const entries = store.entity('Entry');
      for (let id = 1; id <= 3; id++) await entries.create({ id, payload: `p${id}` });
      for (let size = 1; size <= 200; size++) {
        const out = await entries.mutate(shape(size));
        assert.equal(out.affected, Math.min(size, 3), `mutation shape ${size}`);
      }
      // a shape the cache evicted long ago is prepared again and still answers
      assert.deepEqual((await entries.mutate(shape(1))).rows, [{ id: 1 }]);
      const query = { $for: { it: '$.Entry[*]' }, $where: { $eq: ['$it.payload', '200'] }, $return: '$it.id' };
      assert.deepEqual(await entries.execute(query), [2, 3]);
      assert.equal((await entries.explain(query)).mode, 'native');
      assert.deepEqual(await entries.get(1), { id: 1, payload: '1' });
      assert.deepEqual(await entries.get(3), { id: 3, payload: '200' });
    }
    finally {
      try {
        await store?.close();
      }
      finally {
        cleanup();
      }
    }
  });
}
