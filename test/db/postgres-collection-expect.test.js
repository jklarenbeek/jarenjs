//@ts-check
/**
 * @file Compare-and-set and `all()` on PostgreSQL (MODEL-FORMAT §5), on a
 * real server: a patch reads its row `FOR UPDATE` inside the write's own
 * transaction, so a leading `test` is a true compare-and-set across
 * sessions — and it locks the ROW, never the store's writer lock: a plain
 * patch neither waits for an immediate transaction nor takes the writer
 * class. A patch that changes nothing writes no row version. `all()` is
 * every document, in both cursor modes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { POSTGRES_LOCK_CLASSES } from '../../packages/db/src/dialects/postgres-locks.js';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  collections: { docs: { schema: { type: 'object' }, key: '/id', indexes: [] } },
};

/** A promise plus its resolver. */
const defer = () => {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('PostgreSQL: a patch reads and writes in one transaction', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_expect_${process.pid}`;
  /** @type {any[]} */
  const pools = [];
  /** @type {any[]} */
  const stores = [];

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
  after(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => {});
    for (const pool of pools.splice(0)) await pool.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  /** @param {Record<string, any>} [driverOptions] */
  const storeOn = async (driverOptions = {}) => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(pool);
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema, ...driverOptions }) });
    stores.push(store);
    return store;
  };
  /** @param {string} id */
  const xminOf = async (id) => (await admin.query(`SELECT xmin::text AS v FROM "${schema}"."docs" WHERE "key" = $1`, [id])).rows[0]?.v;
  // this schema's writer locks only: other files hold their own at the same time
  const writerLocks = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' "
    + 'AND classid = $1::oid AND objid = (pg_catalog.hashtext($2)::bigint & 4294967295)::oid',
  [POSTGRES_LOCK_CLASSES.writer, schema])).rows[0].n;

  it('two stores racing a leading-test patch for 300 rounds lose no update', async () => {
    const a = await storeOn();
    const b = await storeOn();
    await a.collection('docs').put({ id: 'race', revision: 0, log: [] });
    let committed = 0;
    let refused = 0;
    /** @param {any} store @param {string} entry */
    const round = async (store, entry) => {
      const seen = await store.collection('docs').get('race');
      try {
        await store.collection('docs').patch('race', [
          { op: 'test', path: '/revision', value: seen.revision },
          { op: 'replace', path: '/revision', value: seen.revision + 1 },
          { op: 'add', path: '/log/-', value: entry }]);
        committed++;
      }
      catch (error) {
        assert.equal(/** @type {any} */ (error).code, 'JP2004');
        refused++;
      }
    };
    for (let i = 0; i < 300; i++) await Promise.all([round(a, `a${i}`), round(b, `b${i}`)]);
    const end = await a.collection('docs').get('race');
    assert.equal(committed + refused, 600);
    assert.equal(end.revision, committed);
    assert.equal(end.log.length, committed, 'no committed patch was written over');
  });

  it('a patch locks the row it reads, never the store: an immediate transaction does not stop it, and it takes no writer lock', async () => {
    const a = await storeOn();
    const b = await storeOn();
    const c = await storeOn();
    await a.collection('docs').put({ id: 'row-1', n: 0 });
    await a.collection('docs').put({ id: 'row-2', n: 0 });
    // an immediate transaction holds the writer lock...
    const held = defer();
    const release = defer();
    const holder = a.transaction(async () => { held.resolve(); await release.promise; }, { mode: 'immediate' });
    await held.promise;
    assert.equal(await writerLocks(), 1);
    // ...and a plain patch on another store neither waits for it nor takes one
    assert.deepEqual(await b.collection('docs').patch('row-1', [{ op: 'replace', path: '/n', value: 1 }]), { id: 'row-1', n: 1 });
    release.resolve();
    await holder;
    // a patch inside an open transaction holds its ROW: a patch of the same
    // row waits for it, one of another row does not — and no writer lock
    const patched = defer();
    const commit = defer();
    const inside = b.transaction(async (tx) => {
      await tx.collection('docs').patch('row-1', [{ op: 'replace', path: '/n', value: 2 }]);
      patched.resolve();
      await commit.promise;
    });
    await patched.promise;
    assert.equal(await writerLocks(), 0, 'a patch takes no writer lock');
    let sameRowDone = false;
    const sameRow = a.collection('docs').patch('row-1', [{ op: 'replace', path: '/n', value: 3 }]).then(() => { sameRowDone = true; });
    assert.deepEqual(await c.collection('docs').patch('row-2', [{ op: 'replace', path: '/n', value: 1 }]), { id: 'row-2', n: 1 });
    await delay(100);
    assert.equal(sameRowDone, false, 'the same row waits for the transaction holding it');
    commit.resolve();
    await inside;
    await sameRow;
    assert.equal((await a.collection('docs').get('row-1'))?.n, 3, 'and then patches the committed row');
  });

  it('expect refuses JD2040 and writes nothing; a patch that changes nothing writes no row version', async () => {
    const store = await storeOn();
    const docs = store.collection('docs');
    await docs.put({ id: 'e', revision: 4 });
    const before = await xminOf('e');
    await assert.rejects(docs.put({ id: 'e', revision: 9 }, undefined, { expect: { path: '/revision', value: 3 } }),
      (/** @type {any} */ error) => error.code === 'JD2040');
    await assert.rejects(docs.delete('e', { expect: { path: '/revision', value: 3 } }), (/** @type {any} */ error) => error.code === 'JD2040');
    for (const ops of [[], [{ op: 'test', path: '/revision', value: 4 }], [{ op: 'replace', path: '/revision', value: 4 }]])
      assert.deepEqual(await docs.patch('e', ops), { id: 'e', revision: 4 });
    assert.equal(await xminOf('e'), before, 'no statement touched the row');
    await docs.patch('e', [{ op: 'replace', path: '/revision', value: 5 }], { expect: { path: '/revision', value: 4 } });
    assert.notEqual(await xminOf('e'), before);
    assert.equal(await docs.delete('e', { expect: { path: '/revision', value: 5 } }), true);
  });

  for (const cursorMode of /** @type {const} */ (['native', 'buffered'])) {
    it(`all() is every document, always an array (${cursorMode} cursors)`, async () => {
      const table = `all_${cursorMode}`;
      const model = { $model: '0.1', collections: { [table]: { schema: {}, identity: 'integer', indexes: [] } } };
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      pools.push(pool);
      const own = await openStore(model, { driver: postgresDriver(pool, { schema, cursorMode }) });
      stores.push(own);
      const c = own.collection(table);
      assert.deepEqual(await c.all(), []);
      await c.insert([1, 2]);
      assert.deepEqual(await c.all(), [[1, 2]]);
      await c.insert({ a: 1 });
      assert.deepEqual(await c.all(), [[1, 2], { a: 1 }]);
      assert.deepEqual(await own.transaction(async (tx) => tx.collection(table).all()), [[1, 2], { a: 1 }]);
    });
  }
});
