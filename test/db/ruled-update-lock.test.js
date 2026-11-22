//@ts-check
/**
 * @file The lock a ruled update reads its row with. The store reads the row a
 * store rule judges as `$.old` inside the write's transaction and locks it
 * there where the engine locks rows (MODEL-FORMAT §13.3): on PostgreSQL an
 * `update()` that assigns no key column reads it `FOR NO KEY UPDATE` — the
 * lock the `UPDATE` itself takes — which a probe's `FOR KEY SHARE` admits, so
 * two transactions that each probe the row and then update it both commit;
 * an update that assigns a key column, and a delete, read it `FOR UPDATE`.
 * SQLite takes no row lock, and its read is unchanged. The PostgreSQL half
 * needs a live server (`JAREN_PG_URL`; skipped without it, three connections
 * at most).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirectory } from './helpers.js';
import { column } from './invariant-oracle.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const LINE = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** A parent whose update and delete a store rule judges, with a unique code, and lines whose store rule probes it by its key. */
const model = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    code: { type: 'integer', 'x-entity': { unique: true } }, status: { type: 'string' } } },
  invariants: [{ name: 'thawed', on: ['update', 'delete'], enforcement: 'store', assert: { $ne: ['$.old.status', 'frozen'] } }] },
  Line: { schema: LINE, invariants: [{ name: 'by_key', on: ['insert'], enforcement: 'store',
    assert: { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } } }] },
} };

/** The row lock each read of the Parent row by its key ends with. @param {string[]} recorded */
const parentReads = (recorded) => recorded.filter((sql) => /FROM \S*"Parent" WHERE "id" = \S+( FOR [A-Z ]+)?$/.test(sql))
  .map((sql) => / FOR ([A-Z ]+)$/.exec(sql)?.[1] ?? 'none');

describe('the read of a row a store rule judges, before its update or delete', () => {
  it('on SQLite takes no lock, as before', async () => {
    const recorded = /** @type {string[]} */ ([]);
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (/** @type {string} */ sql, /** @type {any[]} */ ...rest) {
      recorded.push(String(sql));
      return prepare.call(this, sql, ...rest);
    };
    try {
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        await store.entity('Parent').create({ id: 1, code: 1, status: 'open' });
        await store.entity('Parent').update(1, { status: 'shut' });
        await store.entity('Parent').update(1, { code: 2 });
        assert.equal(await store.entity('Parent').delete(1), true);
      }
      finally { await store.close(); }
    }
    finally { DatabaseSync.prototype.prepare = prepare; }
    // the reads by key, the locked one included, end with no lock
    assert.deepEqual([...new Set(parentReads(recorded))], ['none']);
  });

  it('on PostgreSQL is FOR NO KEY UPDATE for an update that assigns no key column, else FOR UPDATE', { skip }, () =>
    withPostgres(async ({ schema }) => {
      const { default: pg } = await import('pg');
      const recorded = /** @type {string[]} */ ([]);
      const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
      pool.on('connect', (/** @type {any} */ client) => {
        const query = client.query.bind(client);
        client.query = (/** @type {any} */ q, /** @type {any[]} */ ...rest) => { recorded.push(typeof q === 'string' ? q : q?.text ?? ''); return query(q, ...rest); };
      });
      try {
        const store = await openStore(model, { driver: postgresDriver(pool, { schema, cursorMode: 'buffered' }) });
        try {
          await store.entity('Parent').create({ id: 1, code: 1, status: 'open' });
          await store.entity('Parent').update(1, { status: 'shut' });
          // the key, assigned the value it holds, and the unique code, assigned another
          await store.entity('Parent').update(1, { id: 1, status: 'open' });
          await store.entity('Parent').update(1, { code: 2 });
          assert.equal(await store.entity('Parent').delete(1), true);
        }
        finally { await store.close(); }
      }
      finally { await pool.end(); }
      // the locked reads, in order (a plain read by key takes none)
      assert.deepEqual(parentReads(recorded).filter((lock) => lock !== 'none'), ['NO KEY UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']);
    }));

  it('on PostgreSQL lets two transactions that each probe the row then update it both commit', { skip }, () =>
    withPostgres(async ({ pool, schema }) => {
      const { default: pg } = await import('pg');
      // one session per transaction; a lock wait would end in a deadlock after 200 ms
      const pools = [0, 1].map(() => new pg.Pool({ connectionString: PG_URL, max: 1, options: '-c lock_timeout=5000 -c deadlock_timeout=200' }));
      const stores = /** @type {any[]} */ ([]);
      try {
        for (const each of pools) stores.push(await openStore(model, { driver: postgresDriver(each, { schema }) }));
        await stores[0].entity('Parent').create({ id: 1, code: 1, status: 'open' });
        let arrived = 0;
        /** @type {() => void} */
        let go = () => {};
        const gate = new Promise((resolve) => { go = () => resolve(undefined); });
        const outcomes = await Promise.all(stores.map((store, i) => store.transaction(async (/** @type {any} */ tx) => {
          // each probe holds FOR KEY SHARE on parent 1 until its transaction ends
          await tx.entity('Line').create({ id: 10 + i, ref: 1 });
          if (++arrived === 2) go();
          await gate;
          await tx.entity('Parent').update(1, { status: `s${i}` });
        }).then(() => 'committed', (/** @type {any} */ error) => error.code)));
        assert.deepEqual(outcomes, ['committed', 'committed']);
        const { rows } = await pool.query(`SELECT (SELECT count(*) FROM "${schema}"."Line")::int AS lines, (SELECT status FROM "${schema}"."Parent") AS status`);
        assert.equal(rows[0].lines, 2);
        assert.ok(['s0', 's1'].includes(rows[0].status), rows[0].status);
      }
      finally {
        for (const store of stores) await store.close();
        for (const each of pools) await each.end();
      }
    }));
});

/** The tables of that layout. */
const TABLES = 'CREATE TABLE parents(id integer PRIMARY KEY, code integer NOT NULL, status text NOT NULL); CREATE TABLE lines(id integer PRIMARY KEY, ref integer NOT NULL)';
/** The parent and its lines over tables of a physical layout, which a unit of work's save reads before its statement. */
const physicalModel = { $model: '0.1', entities: {
  Parent: { schema: model.entities.Parent.schema, invariants: model.entities.Parent.invariants,
    physical: { table: 'parents', columns: { id: column('id'), code: column('code'), status: column('status', 'text') } } },
  Line: { schema: LINE, invariants: model.entities.Line.invariants,
    physical: { table: 'lines', columns: { id: column('id'), ref: column('ref') } } },
} };
/** The row lock each read of a parents row by its key ends with. @param {string[]} recorded */
const savedReads = (recorded) => recorded.filter((sql) => /FROM \S*"parents" WHERE "id" = \S+( FOR [A-Z ]+)?$/.test(sql))
  .map((sql) => / FOR ([A-Z ]+)$/.exec(sql)?.[1] ?? 'none');

describe("a unit of work's save of a row a store rule judges, read before the statement", () => {
  it('on SQLite takes no lock, as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-ruled-save-'));
    const path = join(dir, 'store.db');
    const db = new DatabaseSync(path);
    db.exec(TABLES);
    db.close();
    const recorded = /** @type {string[]} */ ([]);
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (/** @type {string} */ sql, /** @type {any[]} */ ...rest) {
      recorded.push(String(sql));
      return prepare.call(this, sql, ...rest);
    };
    try {
      const store = await openStore(physicalModel, { driver: nodeDriver(), path, adopt: true });
      try {
        await store.entity('Parent').create({ id: 1, code: 1, status: 'open' });
        const parents = store.entity('Parent');
        parents.put({ ...(await parents.get(1)), status: 'shut' });
        await store.saveChanges();
        parents.put({ ...(await parents.get(1)), code: 2 });
        await store.saveChanges();
        parents.remove(1);
        await store.saveChanges();
      }
      finally { await store.close(); }
    }
    finally {
      DatabaseSync.prototype.prepare = prepare;
      removeTempDirectory(dir);
    }
    assert.deepEqual([...new Set(savedReads(recorded))], ['none']);
  });

  it('on PostgreSQL is FOR NO KEY UPDATE for a save that changes no key column, and FOR UPDATE for a delete', { skip }, () =>
    withPostgres(async ({ pool, schema }) => {
      await pool.query(`SET search_path TO "${schema}"; ${TABLES}; RESET search_path`);
      const { default: pg } = await import('pg');
      const recorded = /** @type {string[]} */ ([]);
      const own = new pg.Pool({ connectionString: PG_URL, max: 1 });
      own.on('connect', (/** @type {any} */ client) => {
        const query = client.query.bind(client);
        client.query = (/** @type {any} */ q, /** @type {any[]} */ ...rest) => { recorded.push(typeof q === 'string' ? q : q?.text ?? ''); return query(q, ...rest); };
      });
      try {
        const store = await openStore(physicalModel, { driver: postgresDriver(own, { schema, cursorMode: 'buffered' }), adopt: true });
        try {
          const parents = store.entity('Parent');
          await parents.create({ id: 1, code: 1, status: 'open' });
          parents.put({ ...(await parents.get(1)), status: 'shut' });
          await store.saveChanges();
          parents.put({ ...(await parents.get(1)), code: 2 });
          await store.saveChanges();
          parents.remove(1);
          await store.saveChanges();
        }
        finally { await store.close(); }
      }
      finally { await own.end(); }
      // the two saves change no key column (the table declares no unique index); the delete
      assert.deepEqual(savedReads(recorded).filter((lock) => lock !== 'none'), ['NO KEY UPDATE', 'NO KEY UPDATE', 'UPDATE']);
    }));

  it('on PostgreSQL lets two transactions that each probe the row then save it both commit', { skip }, () =>
    withPostgres(async ({ pool, schema }) => {
      await pool.query(`SET search_path TO "${schema}"; ${TABLES}; RESET search_path`);
      const { default: pg } = await import('pg');
      const pools = [0, 1].map(() => new pg.Pool({ connectionString: PG_URL, max: 1, options: '-c lock_timeout=5000 -c deadlock_timeout=200' }));
      const stores = /** @type {any[]} */ ([]);
      try {
        for (const each of pools) stores.push(await openStore(physicalModel, { driver: postgresDriver(each, { schema }), adopt: true }));
        await stores[0].entity('Parent').create({ id: 1, code: 1, status: 'open' });
        let arrived = 0;
        /** @type {() => void} */
        let go = () => {};
        const gate = new Promise((resolve) => { go = () => resolve(undefined); });
        const outcomes = await Promise.all(stores.map((store, i) => store.transaction(async (/** @type {any} */ tx) => {
          // each probe holds FOR KEY SHARE on parent 1 until its transaction ends
          await tx.entity('Line').create({ id: 10 + i, ref: 1 });
          const parent = await tx.entity('Parent').get(1);
          if (++arrived === 2) go();
          await gate;
          tx.entity('Parent').put({ ...parent, status: `s${i}` });
          await tx.saveChanges();
        }).then(() => 'committed', (/** @type {any} */ error) => error.code)));
        assert.deepEqual(outcomes, ['committed', 'committed']);
        const { rows } = await pool.query(`SELECT (SELECT count(*) FROM "${schema}".lines)::int AS lines, (SELECT status FROM "${schema}".parents) AS status`);
        assert.equal(rows[0].lines, 2);
        assert.ok(['s0', 's1'].includes(rows[0].status), rows[0].status);
      }
      finally {
        for (const store of stores) await store.close();
        for (const each of pools) await each.end();
      }
    }));
});
