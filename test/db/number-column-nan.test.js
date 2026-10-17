//@ts-check
/**
 * @file A number column of an entity or a join table holds no NaN, on either
 * engine, so every comparison and order of it answers as the engine.
 * PostgreSQL's `numeric` holds `'NaN'`, which orders above every number and
 * equals itself where the engine refuses the row (`JD2003`): the store gives
 * each such column `CHECK (col <> 'NaN')` (an enum's CHECK admits none
 * already), `introspect()` reads it as the store's own, and a table an
 * earlier release created without it opens as before and gets it through
 * `planColumnUpgrade`, refused `JD0023` while a row holds one. A collection's
 * generated column reads its document, whose JSON holds no NaN; SQLite's
 * `REAL` stores none at all. A store run is SQLite always, PostgreSQL where
 * JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, planColumnUpgrade, planModelMigration, migrate } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { postgresChecks } from '../../packages/db/src/dialects/check-read.js';
import { PG_URL, withPostgres, withStore } from './store-core-engines.js';

const MODEL = { $model: '0.1', entities: {
  E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
    a: { type: 'number' }, c: { type: 'number' }, i: { type: 'integer' }, e: { type: 'number', enum: [1, 5] }, t: { type: 'string' },
    at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } } }, indexes: [{ name: 'by_a', path: '$.a' }] },
  N: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'number', 'x-entity': { key: true } }, y: { type: 'number' },
    items: { 'x-entity': { relation: { to: 'E', many: true, via: 'nid', onDelete: 'setNull' } } },
    tags: { 'x-entity': { relation: { to: 'T', many: true } } } } } },
  T: { schema: { type: 'object', required: ['k'], properties: { k: { type: 'integer', 'x-entity': { key: true } } } } } } };
/** Every CHECK a fresh store creates, as the server deparses it. */
const CHECKS = ['E.E_a_check: CHECK ((a <> \'NaN\'::numeric))', 'E.E_at_check: CHECK ((at <> \'NaN\'::numeric))',
  'E.E_c_check: CHECK ((c <> \'NaN\'::numeric))', 'E.E_e_check: CHECK ((e = ANY (ARRAY[(1)::numeric, (5)::numeric])))',
  'E.E_i_check: CHECK ((i <> \'NaN\'::numeric))', 'E.E_nid_check: CHECK ((nid <> \'NaN\'::numeric))',
  'N.N_id_check: CHECK ((id <> \'NaN\'::numeric))', 'N.N_y_check: CHECK ((y <> \'NaN\'::numeric))',
  'N_T.N_T_N_key_check: CHECK (("N_key" <> \'NaN\'::numeric))', 'N_T.N_T_T_key_check: CHECK (("T_key" <> \'NaN\'::numeric))',
  'T.T_k_check: CHECK ((k <> \'NaN\'::numeric))'];
/** Each number column a writer beside the store could set, by table. */
const COLUMNS = [['E', 'a'], ['E', 'c'], ['E', 'i'], ['E', 'e'], ['E', 'at'], ['E', 'nid'], ['N', 'id'], ['N', 'y'], ['N_T', 'N_key'], ['N_T', 'T_key'], ['T', 'k']];

/** Each shape, filtering, pairing, joining, ordering and grouping a number column, returning it and not. */
const ids = (/** @type {any} */ where) => ({ $for: { it: '$.E[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
const rows = (/** @type {any} */ where) => ({ $for: { it: '$.E[*]' }, $where: where, $orderby: ['$it.id'], $return: { id: '$it.id', a: '$it.a' } });
const QUERIES = [
  ...['$eq', '$ne', '$lt', '$gt'].flatMap((op) => [ids({ [op]: ['$it.a', 5] }), rows({ [op]: ['$it.a', 5] }), ids({ [op]: ['$it.a', '$it.c'] })]),
  ids({ $eq: ['$it.a', { $seq: [5, 7] }] }), ids({ $eq: ['$it.a', '$xs[*]'] }),
  { $for: { e: '$.E[*]', n: '$.N[*]' }, $where: { $eq: ['$e.a', '$n.y'] }, $orderby: ['$e.id', '$n.id'], $return: { e: '$e.id', n: '$n.id' } },
  { $for: { it: '$.E[*]' }, $orderby: ['$it.a', '$it.id'], $return: '$it.id' },
  { $for: { it: '$.E[*]' }, $orderby: [{ $key: '$it.a', $dir: 'desc' }, '$it.id'], $return: '$it.id' },
  { $for: { it: '$.E[*]' }, $groupby: { a: '$it.a' }, $orderby: ['$a'], $return: { a: '$a', n: { $count: '$it' } } },
  { $for: { it: '$.E[*]' }, $groupby: { a: '$it.a' }, $orderby: ['$a'], $return: { $count: '$it' } },
];

/** The engine's answer or its refusal's code, and the native statement's. @param {any} store - a store or a collection @param {any} query */
async function bothAnswers(store, query) {
  const answer = async (/** @type {any} */ options) => {
    try { return JSON.stringify(await store.execute(query, { externals: { xs: [5, 7] }, ...options })); }
    catch (error) { return `refused ${/** @type {any} */ (error).code}`; }
  };
  return { engine: await answer({ pushdown: false }), native: await answer({}) };
}

/** Seed four rows, `b` and `d` the ones a writer beside the store targets. @param {any} store */
async function seed(store) {
  for (const id of [1, 2]) await store.entity('N').create({ id, y: id === 1 ? 5 : 7 });
  for (const [id, a, nid] of [['a', 1, 1], ['b', 5, 2], ['c', 7, 1], ['d', 3, 2]])
    await store.entity('E').create({ id, a, c: a, i: a, e: 1, t: 'x', at: '2026-10-18T00:00:00Z', nid });
  await store.saveChanges?.();
}

describe('a number column holds no NaN on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** @param {any} pool @param {string} schema */
  const checksOf = async (pool, schema) => (await pool.query('SELECT t.relname, c.conname, pg_catalog.pg_get_constraintdef(c.oid) AS d '
    + 'FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace '
    + "WHERE n.nspname = $1 AND c.contype = 'c' ORDER BY 1, 2", [schema])).rows.map((/** @type {any} */ row) => `${row.relname}.${row.conname}: ${row.d}`);
  /** @param {{ driver: () => any }} context */
  const upgradeOf = async ({ driver }) => {
    const connection = await driver().open();
    try { return await planColumnUpgrade(connection, MODEL); }
    finally { await connection.close(); }
  };

  it('give every number column of an entity and a join table the CHECK, an enum its own, and plan no upgrade', async () => {
    await withPostgres(async (context) => {
      const store = await openStore(MODEL, { driver: context.driver() });
      await store.close();
      assert.deepEqual(await checksOf(context.pool, context.schema), CHECKS);
      const { migration, report } = await upgradeOf(context);
      assert.deepEqual([migration.steps, report.upgraded], [[], []]);
    });
  });

  it('refuse a NaN a writer beside the store sets in any of them, and answer every shape as the engine', async () => {
    await withStore('postgres', MODEL, async (store, pg) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      await seed(store);
      store.entity('N').link(1, 'tags', 1);
      await store.entity('T').create({ k: 1 });
      await store.saveChanges?.();
      for (const [table, column] of COLUMNS) {
        await assert.rejects(pool.query(`UPDATE "${schema}"."${table}" SET "${column}" = 'NaN'`),
          (/** @type {any} */ error) => error.code === '23514', `${table}.${column}`);
      }
      // an infinity is a JSON number the engine reads, and stays writable
      await pool.query(`UPDATE "${schema}"."E" SET "a" = 'Infinity', "c" = '-Infinity' WHERE "id" = 'b'`);
      for (const query of QUERIES) {
        const { engine, native } = await bothAnswers(store, query);
        assert.equal(native, engine, JSON.stringify(query));
      }
    });
  });

  it('open a table an earlier release created without it, refuse its upgrade while a row holds a NaN, and add it once none does', async () => {
    await withPostgres(async (context) => {
      const { pool, schema, driver } = context;
      const store = await openStore(MODEL, { driver: driver() });
      await seed(store);
      const fresh = await store.introspect();
      await store.close();
      await pool.query(`ALTER TABLE "${schema}"."E" DROP CONSTRAINT "E_a_check", DROP CONSTRAINT "E_nid_check"`);
      await pool.query(`ALTER TABLE "${schema}"."N_T" DROP CONSTRAINT "N_T_N_key_check"`);
      await pool.query(`UPDATE "${schema}"."E" SET "a" = 'NaN' WHERE "id" IN ('b', 'd')`);
      // the earlier table opens, introspects and answers as before: its rows' NaN is refused where it is read
      const earlier = await openStore(MODEL, { driver: driver() });
      try {
        assert.deepEqual((await earlier.introspect()).model, fresh.model);
        await assert.rejects(async () => earlier.execute(rows({ $gt: ['$it.a', 5] })), { code: 'JD2003' });
      }
      finally { await earlier.close(); }
      await assert.rejects(upgradeOf(context), (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
        && error.table === 'E' && JSON.stringify(error.columns) === '["a","nid"]' && JSON.stringify(error.rows) === '[["b"],["d"]]'
        && /SET "a" = NULL WHERE "a" = 'NaN'/.test(error.message));
      await pool.query(`UPDATE "${schema}"."E" SET "a" = NULL WHERE "a" = 'NaN'`);
      const { migration, report } = await upgradeOf(context);
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), ['ALTER TABLE "E" ADD CHECK ("a" <> \'NaN\')',
        'ALTER TABLE "E" ADD CHECK ("nid" <> \'NaN\')', 'ALTER TABLE "N_T" ADD CHECK ("N_key" <> \'NaN\')']);
      assert.deepEqual(report.upgraded, ['E.a', 'E.nid', 'N_T.N_key']);
      assert.deepEqual((await migrate({ driver: driver() }, [migration], { baseline: MODEL, model: MODEL, shadow: false })).applied, [migration.id]);
      assert.deepEqual(await checksOf(pool, schema), CHECKS);
      assert.deepEqual((await upgradeOf(context)).migration.steps, []);
    });
  });

  it('read the CHECK back as the store\'s own, and open the model read back over the tables', async () => {
    await withPostgres(async ({ driver }) => {
      const store = await openStore(MODEL, { driver: driver() });
      await seed(store);
      const { model, report } = await store.introspect();
      await store.close();
      assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint'), []);
      assert.deepEqual(model.entities.E.schema.properties.a, { type: 'number' });
      assert.deepEqual(model.entities.E.schema.properties.e, { type: 'number', enum: [1, 5] });
      const derived = await openStore(model, { driver: driver() });
      try { assert.deepEqual(await derived.execute(ids({ $gt: ['$it.a', 2] })), ['b', 'c', 'd']); }
      finally { await derived.close(); }
    });
  });

  it('plan the upgrade without the host functions an entity expression index calls, as before', async () => {
    const indexed = structuredClone(MODEL);
    indexed.entities.E.indexes.push({ name: 'by_lower_t', expression: { call: 'lower', args: [{ member: '$.t' }] } });
    const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'lower' } };
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(indexed, { driver: driver(), expressions })).close();
      await pool.query(`ALTER TABLE "${schema}"."E" DROP CONSTRAINT "E_a_check"`);
      const connection = await driver().open();
      try { assert.deepEqual((await planColumnUpgrade(connection, indexed)).report.upgraded, ['E.a']); }
      finally { await connection.close(); }
    });
  });

  it('give a number column a migration adds the CHECK', async () => {
    const next = structuredClone(MODEL);
    next.entities.E.schema.properties.w = { type: 'number' };
    const { migration } = planModelMigration(MODEL, next, { dialect: postgresDialect(), id: 'add-w' });
    // a member the documents never held: the widening needs no transform
    migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
    assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql).filter((sql) => /ADD COLUMN/.test(sql)),
      ['ALTER TABLE "E" ADD COLUMN "w" numeric CHECK ("w" <> \'NaN\')']);
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(MODEL, { driver: driver() });
      await seed(store);
      await store.close();
      await migrate({ driver: driver() }, [migration], { baseline: MODEL, model: next, shadow: false });
      await assert.rejects(pool.query(`UPDATE "${schema}"."E" SET "w" = 'NaN'`), (/** @type {any} */ error) => error.code === '23514');
    });
  });

  it('hold no NaN in a collection\'s generated number column: its document\'s JSON spells none', async () => {
    const collections = { $model: '0.1', collections: { c: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' },
      a: { type: 'number' } } }, indexes: [{ name: 'by_a', path: '$.a' }] } } };
    await withStore('postgres', collections, async (store, pg) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      for (const [id, a] of [['a', 1], ['b', 5], ['c', 7]]) await store.collection('c').insert({ id, a });
      await assert.rejects(pool.query(`UPDATE "${schema}"."c" SET "doc" = '{"id": "b", "a": NaN}'::jsonb WHERE "key" = 'b'`),
        (/** @type {any} */ error) => error.code === '22P02');
      // a NaN numeric becomes the JSON string "NaN", which the column reads as no number
      await pool.query(`UPDATE "${schema}"."c" SET "doc" = jsonb_set("doc", '{a}', to_jsonb('NaN'::numeric))`
        + ` WHERE "doc" ->> 'id' = 'b'`);
      const of = (/** @type {any} */ where) => ({ $for: { it: '$[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
      for (const query of [of({ $gt: ['$it.a', 5] }), of({ $lt: ['$it.a', 5] }), of({ $eq: ['$it.a', 'NaN'] }), of({ $ne: ['$it.a', 1] })]) {
        const { engine, native } = await bothAnswers(store.collection('c'), query);
        assert.equal(native, engine, JSON.stringify(query));
      }
      assert.equal(await store.collection('c').execute(of({ $eq: ['$it.a', 'NaN'] })), 'b');
    });
  });
});

describe('the CHECK as the PostgreSQL catalog deparses it', () => {
  it('reads the column of exactly that spelling, and nothing else', () => {
    const read = (/** @type {string} */ expression, validated = 1) => {
      const { column, notNaN, values } = postgresChecks([{ name: 'c', expression, validated }])[0];
      return { column, notNaN, values };
    };
    assert.deepEqual(read("(a <> 'NaN'::numeric)"), { column: 'a', notNaN: true, values: undefined });
    assert.deepEqual(read("(\"N_key\" <> 'NaN'::numeric)"), { column: 'N_key', notNaN: true, values: undefined });
    for (const other of ["(a <> 'NaN'::text)", "(a = 'NaN'::numeric)", "(a <> 'Infinity'::numeric)", "((a <> 'NaN'::numeric) AND (b > (1)::numeric))",
      "(a <> 'NaN'::numeric))", "((a <> 'NaN'::numeric)"])
      assert.deepEqual(read(other), { column: undefined, notNaN: undefined, values: undefined }, other);
  });
});

describe('a number column holds no NaN on SQLite', () => {
  it('store no NaN a writer beside the store computes or spells, and answer every shape as the engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-number-nan-'));
    const path = join(dir, 'store.sqlite');
    try {
      await withStore('sqlite', MODEL, async (store) => {
        await seed(store);
        const db = new DatabaseSync(path);
        try {
          // the STRICT table refuses a text, and a NaN the server computes is stored as NULL
          assert.throws(() => db.exec('UPDATE "E" SET "a" = \'NaN\' WHERE "id" = \'b\''), /cannot store TEXT value in REAL column/);
          db.exec('UPDATE "E" SET "a" = 9e999 - 9e999, "c" = 9e999 WHERE "id" = \'b\'');
          assert.deepEqual({ ...db.prepare('SELECT "a", "c" FROM "E" WHERE "id" = \'b\'').get() }, { a: null, c: Infinity });
        }
        finally { db.close(); }
        for (const query of QUERIES) {
          const { engine, native } = await bothAnswers(store, query);
          assert.equal(native, engine, JSON.stringify(query));
        }
      }, { path });
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
