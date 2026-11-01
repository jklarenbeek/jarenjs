//@ts-check
/**
 * @file The row a store rule's `$exists-row` finds, held for the probing
 * write's transaction where writers do not serialize. On PostgreSQL the
 * store's probe locks it `FOR KEY SHARE` when it compares key columns only —
 * the key, the columns of a unique index over plain column terms without a
 * condition — and `FOR SHARE` when it compares any other, whatever keys it.
 * Which lock each probe takes; the probe SQL as each engine runs it
 * (SQLite's writer lock serializes writes, so its probe takes none); and, on
 * a live server (`JAREN_PG_URL`; skipped without it, three connections at
 * most), a delete or a change of the found row raced against the probing
 * write in either order: the two never both commit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeEntities, openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { column } from './invariant-oracle.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
/** @param {string} name */
const col = (name) => ({ $sql: 'column', name });
const LINE = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** A store rule on insert that requires a row of `entity` matching `match`. @param {string} entity @param {any} match */
const requires = (entity, match) => [{ name: 'r', on: ['insert'], enforcement: 'store', assert: { '$exists-row': { entity, match } } }];
/** Whether the probe of `entity`'s one rule locks `FOR KEY SHARE`. @param {any} model @param {string} entity */
const keyShare = (model, entity) => /** @type {any} */ (normalizeEntities(model)).get(entity).invariants[0].probes[0].keyShare;

/**
 * Documents on a layout the store owns — a unique code, an indexed group, a
 * status, members `a` and `b` under one unique entity index, a member unique
 * only among open documents, and the column `c` of a foreign key many
 * documents share — and lines whose store rule probes them by `match`.
 * @param {any} match
 */
const ownedModel = (match) => ({ $model: '0.1', entities: {
  Customer: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    docs: { 'x-entity': { relation: { to: 'Doc', many: true, via: 'c', onDelete: 'restrict' } } } } } },
  Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    code: { type: 'integer', 'x-entity': { unique: true } }, grp: { type: 'integer', 'x-entity': { index: true } }, status: { type: 'string' },
    a: { type: 'integer' }, b: { type: 'integer' }, part: { type: 'integer' }, c: { type: 'integer' } } },
  indexes: [{ name: 'doc_ab', path: ['$.a', '$.b'], unique: true }, { name: 'doc_part', path: '$.part', unique: true, where: { $eq: ['$.status', 'open'] } }] },
  Line: { schema: LINE, invariants: requires('Doc', match) },
} });

/** Documents declared over an existing table with a unique code and a group index, probed by `match`. @param {any} match */
const physicalModel = (match) => ({ $model: '0.1', entities: {
  Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, code: { type: 'integer' }, grp: { type: 'integer' },
    status: { type: 'string' } } },
  physical: { table: 'docs', columns: { id: column('id'), code: column('code'), grp: column('grp'), status: column('status', 'text') },
    indexes: [{ name: 'docs_code', unique: true, terms: [{ by: col('code') }] }, { name: 'docs_grp', terms: [{ by: col('grp') }] }] } },
  Line: { schema: LINE, physical: { table: 'lines', columns: { id: column('id'), ref: column('ref') } }, invariants: requires('Doc', match) },
} });

describe("the lock a store rule's probe takes", () => {
  it('is FOR KEY SHARE when every member it compares is a key column, else FOR SHARE, whatever keys the probe', () => {
    const cases = /** @type {[any, boolean][]} */ ([
      [{ id: '$.new.ref' }, true], // the key
      [{ code: '$.new.ref' }, true], // a unique member
      [{ a: '$.new.ref', b: '$.new.ref' }, true], // a unique entity index's columns
      [{ id: '$.new.ref', code: 7 }, true], // the key and a unique member
      [{ id: '$.new.ref', a: 7 }, true], // the key and a column of a unique index over two
      [{ grp: '$.new.ref' }, false], // an indexed member
      [{ c: '$.new.ref' }, false], // the column of a foreign key many documents share
      [{ id: '$.new.ref', status: 'open' }, false], // the key and a member no unique index covers
      [{ id: '$.new.ref', part: 7 }, false], // the key and a member unique only under a condition
    ]);
    assert.deepEqual(cases.map(([match]) => keyShare(ownedModel(match), 'Line')), cases.map(([, locks]) => locks));
  });

  it('reads a physical layout by its declared indexes the same way', () => {
    assert.deepEqual([{ code: '$.new.ref' }, { grp: '$.new.ref' }, { id: '$.new.ref', status: 'x' }, { id: '$.new.ref', code: 7 }]
      .map((match) => keyShare(physicalModel(match), 'Line')), [true, false, false, true]);
  });
});

/** A child whose store rule requires a parent matching `match`. @param {string} name @param {any} match */
const child = (name, match) => ({ schema: LINE,
  invariants: [{ name, on: ['insert'], enforcement: 'store', assert: { '$exists-row': { entity: 'Parent', match } } }] });

/**
 * Parents with a unique code, a group the store indexes and a status, on a
 * layout the store owns, and four children: one probes its parent by the
 * key, one by the unique code, one by the group's index, one by the key and
 * the parent's status.
 */
const raceModel = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    code: { type: 'integer', 'x-entity': { unique: true } }, grp: { type: 'integer', 'x-entity': { index: true } }, status: { type: 'string' } } } },
  ByKey: child('by_key', { id: '$.new.ref' }),
  ByCode: child('by_code', { code: '$.new.ref' }),
  ByGroup: child('by_group', { grp: '$.new.ref' }),
  ByKeyStatus: child('by_key_status', { id: '$.new.ref', status: 'open' }),
} };
const CHILDREN = ['ByKey', 'ByCode', 'ByGroup', 'ByKeyStatus'];

/** What the probes by the key, the unique code and the group compare, `p` the engine's first parameter.
 * @param {string} p */
const keyedBy = (p) => ['id', 'code', 'grp'].map((member) => `"_jaren_row"."${member}" = ${p}`);

describe('the probe SQL each engine runs', () => {
  it('on SQLite is unchanged: the writer lock serializes writes, so the probe takes no lock', async () => {
    const recorded = /** @type {string[]} */ ([]);
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (/** @type {string} */ sql, /** @type {any[]} */ ...rest) {
      recorded.push(String(sql));
      return prepare.call(this, sql, ...rest);
    };
    try {
      const store = await openStore(raceModel, { driver: nodeDriver() });
      try {
        await store.entity('Parent').create({ id: 1, code: 1, grp: 1, status: 'open' });
        for (const name of CHILDREN) await store.entity(name).create({ id: 1, ref: 1 });
      }
      finally { await store.close(); }
    }
    finally { DatabaseSync.prototype.prepare = prepare; }
    const [byKey, byCode, byGroup] = keyedBy('?');
    assert.deepEqual([...new Set(recorded.filter((sql) => sql.includes('"_jaren_row"')))], [
      `SELECT EXISTS (SELECT 1 FROM "Parent" AS "_jaren_row" WHERE ${byKey}) AS "hit"`,
      `SELECT EXISTS (SELECT 1 FROM "Parent" AS "_jaren_row" WHERE ${byCode}) AS "hit"`,
      `SELECT EXISTS (SELECT 1 FROM "Parent" AS "_jaren_row" WHERE ${byGroup}) AS "hit"`,
      'SELECT EXISTS (SELECT 1 FROM "Parent" AS "_jaren_row" WHERE "_jaren_row"."id" = ? AND NOT ("_jaren_row"."status" IS NOT ? COLLATE BINARY)) AS "hit"',
    ]);
  });

  it('on PostgreSQL locks the row it finds, FOR KEY SHARE by key columns only and FOR SHARE otherwise, in either cursor mode', { skip }, () =>
    withPostgres(async ({ schema }) => {
      const { default: pg } = await import('pg');
      for (const cursorMode of ['native', 'buffered']) {
        const recorded = /** @type {string[]} */ ([]);
        const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
        pool.on('connect', (/** @type {any} */ client) => {
          const query = client.query.bind(client);
          client.query = (/** @type {any} */ q, /** @type {any[]} */ ...rest) => { recorded.push(typeof q === 'string' ? q : q?.text ?? ''); return query(q, ...rest); };
        });
        try {
          const store = await openStore(raceModel, { driver: postgresDriver(pool, { schema, cursorMode }) });
          try {
            await store.entity('Parent').create({ id: 1, code: 1, grp: 1, status: 'open' });
            for (const name of CHILDREN) await store.entity(name).create({ id: 1, ref: 1 });
            for (const name of [...CHILDREN, 'Parent']) await store.entity(name).delete(1);
          }
          finally { await store.close(); }
        }
        finally { await pool.end(); }
        const probes = recorded.filter((sql) => sql.includes('"_jaren_row"'));
        // the default reads through a cursor
        assert.equal(probes.every((sql) => sql.startsWith('DECLARE ')), cursorMode === 'native', cursorMode);
        const table = `"${schema}"."Parent"`;
        const [byKey, byCode, byGroup] = keyedBy('$1');
        assert.deepEqual(probes.map((sql) => sql.replace(/^DECLARE "\w+" NO SCROLL CURSOR FOR /, '')), [
          `SELECT EXISTS (SELECT 1 FROM ${table} AS "_jaren_row" WHERE ${byKey} FOR KEY SHARE) AS "hit"`,
          `SELECT EXISTS (SELECT 1 FROM ${table} AS "_jaren_row" WHERE ${byCode} FOR KEY SHARE) AS "hit"`,
          `SELECT EXISTS (SELECT 1 FROM ${table} AS "_jaren_row" WHERE ${byGroup} FOR SHARE) AS "hit"`,
          `SELECT EXISTS (SELECT 1 FROM ${table} AS "_jaren_row" WHERE "_jaren_row"."id" = $1 AND NOT ((("_jaren_row"."status")::text COLLATE "C") IS DISTINCT FROM (($2)::text COLLATE "C")) FOR SHARE) AS "hit"`,
        ], cursorMode);
      }
    }));
});

// one row of the race: the outcome of each step, then what the two left
const HELD = { writeFirst: ['ok', '55P03', 'ok', 'ok', { orphans: 0, children: 1 }], otherFirst: ['ok', 'blocked', 'ok', 'refused', { orphans: 0, children: 0 }] };
const PASSES = { writeFirst: ['ok', 'ok', 'ok', 'ok', { orphans: 0, children: 1 }], otherFirst: ['ok', 'settled', 'ok', 'ok', { orphans: 0, children: 1 }] };
const WAITS = { writeFirst: ['ok', '55P03', 'ok', 'ok', { orphans: 0, children: 1 }], otherFirst: ['ok', 'blocked', 'ok', 'ok', { orphans: 0, children: 1 }] };

/**
 * Per child: the statement that changes the matched row — the key, the
 * unique code, the group, the status — and the parents its rule requires.
 * @type {Record<string, { change: string, requires: string }>}
 */
const SHAPES = {
  ByKey: { change: 'UPDATE "Parent" SET id = 2 WHERE id = 1', requires: 'p.id = c.ref' },
  ByCode: { change: 'UPDATE "Parent" SET code = 2 WHERE id = 1', requires: 'p.code = c.ref' },
  ByGroup: { change: 'UPDATE "Parent" SET grp = 2 WHERE id = 1', requires: 'p.grp = c.ref' },
  ByKeyStatus: { change: `UPDATE "Parent" SET status = 'closed' WHERE id = 1`, requires: `p.id = c.ref AND p.status = 'open'` },
};

describe('a delete or a change of the row a store probe found, raced against the probing write on PostgreSQL', () => {
  for (const cursorMode of ['native', 'buffered']) {
    it(`never commits beside it, in either order (${cursorMode} reads)`, { skip }, () => withPostgres(async ({ pool, schema }) => {
      const { default: pg } = await import('pg');
      // the store on a pool of its own; the other writer and the observer on the shared one
      const storePool = new pg.Pool({ connectionString: PG_URL, max: 1 });
      const store = await openStore(raceModel, { driver: postgresDriver(storePool, { schema, cursorMode }) });
      const other = await pool.connect();
      try {
        // the other writer waits for a row lock 300 ms at most
        await other.query(`SET search_path TO "${schema}"; SET lock_timeout = '300ms'`);
        const otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        /** @param {Promise<unknown>} run */
        const outcome = (run) => run.then(() => 'ok', (/** @type {any} */ error) => (error.code === 'JD2096' ? 'refused' : error.code));
        /** Whether `write` settled, or waits for a lock the other writer holds. @param {Promise<unknown>} write */
        const settledOrBlocked = async (write) => {
          let settled = false;
          write.then(() => { settled = true; });
          for (let i = 0; i < 500; i++) {
            if (settled) return 'settled';
            const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE NOT l.granted AND $1 = ANY (pg_blocking_pids(l.pid))) AS blocked', [otherPid]);
            if (rows[0].blocked) return 'blocked';
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return 'neither';
        };
        const left = async (/** @type {string} */ table) => (await pool.query(`SELECT (SELECT count(*) FROM "${schema}"."${table}" c WHERE NOT EXISTS (
          SELECT 1 FROM "${schema}"."Parent" p WHERE ${SHAPES[table].requires}))::int AS orphans, (SELECT count(*) FROM "${schema}"."${table}")::int AS children`)).rows[0];
        const reset = (/** @type {string} */ table) => pool.query(`TRUNCATE "${schema}"."${table}", "${schema}"."Parent"; `
          + `INSERT INTO "${schema}"."Parent"(id, code, grp, status, doc) VALUES (1, 1, 1, 'open', '{}')`);
        /** @type {Record<string, Record<string, any>>} */
        const runs = {};
        for (const table of CHILDREN) {
          runs[table] = {};
          const writes = [['delete', 'DELETE FROM "Parent" WHERE id = 1'], ['change', SHAPES[table].change]];
          // a change of a member the probe does not compare
          if (table !== 'ByKeyStatus') writes.push(['other', `UPDATE "Parent" SET status = 'x' WHERE id = 1`]);
          for (const [label, sql] of writes) {
            // the probing write first, its transaction open while the other writer runs
            await reset(table);
            /** @type {() => void} */
            let release = () => {};
            const held = new Promise((resolve) => { release = () => resolve(undefined); });
            /** @type {(value: string) => void} */
            let probed = () => {};
            const inserted = new Promise((resolve) => { probed = resolve; });
            const committed = outcome(store.transaction(async (/** @type {any} */ tx) => {
              probed(await outcome(tx.entity(table).create({ id: 1, ref: 1 })));
              await held;
            }));
            const writeFirst = [await inserted];
            await other.query('BEGIN');
            writeFirst.push(await outcome(other.query(sql)), await outcome(other.query('COMMIT')));
            release();
            writeFirst.push(await committed, await left(table));
            // the other writer first, its transaction open while the probing write runs
            await reset(table);
            await other.query('BEGIN');
            const otherFirst = [await outcome(other.query(sql))];
            const write = outcome(store.entity(table).create({ id: 1, ref: 1 }));
            otherFirst.push(await settledOrBlocked(write), await outcome(other.query('COMMIT')), await write, await left(table));
            runs[table][label] = { writeFirst, otherFirst };
          }
        }
        assert.deepEqual(runs, {
          ByKey: { delete: HELD, change: HELD, other: PASSES },
          ByCode: { delete: HELD, change: HELD, other: PASSES },
          ByGroup: { delete: HELD, change: HELD, other: WAITS },
          ByKeyStatus: { delete: HELD, change: HELD },
        });
      }
      finally {
        other.release();
        await store.close();
        await storePool.end();
      }
    }));
  }
});
