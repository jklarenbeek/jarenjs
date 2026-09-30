//@ts-check
/**
 * @file Relational-engine quirks the phase 1 sweep reproduced, each pinned:
 *
 * 1. The Store's statement cache evicted without finalizing, and a worker
 *    keeps every statement it prepared: past `maxStatements` distinct
 *    texts the whole store refused JD2092 until reopened.
 * 2. A transaction cursor left unfinished could never be released — its
 *    `return()` was refused with the scope — and on a worker each one held
 *    a cursor slot forever.
 * 3. A table's rowid-ness was remembered for the engine's life: after it
 *    was recreated WITHOUT ROWID, an insert reported another table's row.
 * 4. FTS5 and R*Tree inserts reported no `lastInsertRowid` (a virtual
 *    table keeps rowids).
 * 5. An aborted signal was ignored by a transaction's engine and the
 *    synchronous surfaces; the bare synchronous engine answered it with a
 *    rejected promise instead of a throw.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import fs from 'node:fs';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { sql, relational } from '@jarenjs/db/relational';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id', indexes: [] } } };
const coded = (/** @type {string} */ code) => (/** @type {any} */ e) => e?.code === code;
/** The refusal of an aborted call: JD2064, the signal's reason as its cause. */
const gaveUp = (/** @type {any} */ e) => e?.code === 'JD2064' && e.cause?.message === 'caller gave up';

/** A store over `driver` with an application table beside its own. */
async function withStaging(/** @type {any} */ driver, /** @type {any} */ options = {}) {
  /** @type {any} */
  let raw;
  const store = await openStore(MODEL, { driver: { ...driver, open: async (/** @type {any[]} */ ...args) => (raw = await driver.open(...args)) }, ...options });
  await raw.exec('CREATE TABLE staging(id INTEGER PRIMARY KEY, sku TEXT)');
  return { store, raw };
}

describe('relational quirks', () => {
  it('1. the bounded statement cache releases what it evicts: a worker, or a pool of them, never runs out of statements', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      for (const driver of [nodeWorkerDriver({ maxStatements: 24 }),
        nodeWorkerPoolDriver({ readers: 1, worker: { maxStatements: 24 } })]) {
        const { store } = await withStaging(driver, { statementCacheBound: 4, path: dbPath });
        try {
          for (let n = 1; n <= 60; n++) {
            const where = sql.in(sql.column('id'), Array.from({ length: n }, (_, i) => i));
            await store.relational.all({ from: 'staging', where });
          }
          await store.collection('items').put({ id: 'still-writable' });
          assert.equal((await store.collection('items').get('still-writable'))?.id, 'still-writable');
        }
        finally {
          await store.close();
        }
        fs.rmSync(dbPath, { force: true });
      }
    }
    finally { cleanup(); }
  });

  it('2. a transaction closes the cursors it left open, and a retained cursor\'s return() still releases', async () => {
    const { store } = await withStaging(nodeWorkerDriver({ maxCursors: 4 }));
    try {
      for (let i = 0; i < 20; i++) await store.relational.execute({ op: 'insert', table: 'staging', values: { sku: `s${i}` } });
      /** @type {any[]} */
      const retained = [];
      for (let i = 0; i < 10; i++) {
        await store.transaction(async (tx) => {
          const cursor = tx.relational.iterate({ from: 'staging' });
          await cursor.next();
          retained.push(cursor);
        });
      }
      assert.deepEqual(await retained[0].return(), { done: true, value: undefined });
      await assert.rejects(retained[1].next(), coded('JD2070'));
      const rows = [];
      for await (const row of store.relational.iterate({ from: 'staging' })) rows.push(row);
      assert.equal(rows.length, 20, 'every worker cursor slot is free again');
    }
    finally { await store.close(); }
  });

  it('3–4. lastInsertRowid follows the table as it is now, virtual tables included', async () => {
    const db = await nodeDriver().open(':memory:');
    try {
      const r = relational(db);
      db.exec('CREATE TABLE staging(id INTEGER PRIMARY KEY, sku TEXT); CREATE TABLE other(id INTEGER PRIMARY KEY)');
      assert.equal(Number(r.execute({ op: 'insert', table: 'staging', values: { sku: 'a' } }).lastInsertRowid), 1);
      db.exec('DROP TABLE staging; CREATE TABLE staging(sku TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO other VALUES (4242)');
      assert.deepEqual(r.execute({ op: 'insert', table: 'staging', values: { sku: 'b' } }), { affected: 1 });
      db.exec('CREATE VIRTUAL TABLE notes USING fts5(body); CREATE VIRTUAL TABLE boxes USING rtree(id, minX, maxX)');
      assert.equal(Number(r.execute({ op: 'insert', table: 'notes', values: { body: 'hello' } }).lastInsertRowid), 1);
      assert.equal(Number(r.execute({ op: 'insert', table: 'boxes', values: { minX: 0, maxX: 1 } }).lastInsertRowid), 1);
    }
    finally { db.close(); }
  });

  it('5. an aborted signal refuses up front on every surface: rejected where async, thrown where synchronous', async () => {
    const { store } = await withStaging(nodeDriver());
    const signal = AbortSignal.abort(new Error('caller gave up'));
    const insert = { op: 'insert', table: 'staging', values: { sku: 'x' } };
    try {
      await store.transaction(async (tx) => {
        await assert.rejects(tx.relational.all({ from: 'staging' }, { signal }), gaveUp);
        await assert.rejects(tx.relational.execute(/** @type {any} */ (insert), { signal }), gaveUp);
      });
      const sync = /** @type {any} */ (store.sync).relational;
      assert.throws(() => sync.all({ from: 'staging' }, { signal }), gaveUp);
      assert.throws(() => sync.execute(insert, { signal }), gaveUp);
      assert.equal(sync.get({ from: 'staging', columns: { n: sql.call('count', []) } }).n, 0, 'nothing ran');
      const db = await nodeDriver().open(':memory:');
      try {
        db.exec('CREATE TABLE staging(id INTEGER PRIMARY KEY, sku TEXT)');
        const bare = relational(db);
        assert.throws(() => bare.execute(/** @type {any} */ (insert), { signal }), gaveUp, 'a throw, never a promise nothing awaits');
      }
      finally { db.close(); }
    }
    finally { await store.close(); }
  });
});
