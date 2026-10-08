//@ts-check
/**
 * @file Entity indexes on a live PostgreSQL server: the motivating partial
 * unique index refuses the same rows as on SQLite, for the store and for a raw
 * SQL writer; every open reads the catalog back — an index predicate through
 * the one predicate reader, a generated column's expression through the
 * member-path and expression readers — so a changed or dropped predicate, a
 * predicate added to an index declared without one, and a changed generated
 * column are drift (`JD0002`), as SQLite's declared-text comparison already
 * makes them; a collection index honors its `where`; a boolean condition and
 * a boolean enum compare the stored `smallint`; a reopen changes nothing; and
 * introspection derives the indexes back, a condition read as stored.
 * Two connections at most; each test drops its schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planMigration, introspectModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { ONE_ACTIVE, SHIFT_ROWS, SHIFT_SCHEMA, SHIFT_VERDICTS, createVerdicts, openRefusal, shiftModel, uniquenessAgreement,
  uniquenessModel } from './invariant-oracle.js';

/** The catalog's stored predicate of one index, or null. @param {any} pool @param {string} schema @param {string} index */
async function storedPredicate(pool, schema, index) {
  const { rows } = await pool.query('SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i '
    + 'JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, index]);
  return rows[0]?.predicate ?? null;
}

/** Every index definition of a schema, by name. @param {any} pool @param {string} schema */
async function indexDefinitions(pool, schema) {
  const { rows } = await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [schema]);
  return rows;
}

describe('entity indexes on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('refuses the second active row of an employee-day for the store and for a raw SQL writer, as SQLite does', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(shiftModel(), { driver: driver() });
      try {
        assert.deepEqual(await createVerdicts(store.entity('Shift'), SHIFT_ROWS), SHIFT_VERDICTS);
        await assert.rejects(pool.query(`INSERT INTO "${schema}"."Shift" ("id", "employeeId", "day", "status", "doc") VALUES ('r1', 'e1', 'd1', 'pending', '{}')`),
          (/** @type {any} */ error) => error.code === '23505' && error.constraint === 'Shift_one_active');
        await pool.query(`INSERT INTO "${schema}"."Shift" ("id", "employeeId", "day", "status", "doc") VALUES ('r2', 'e1', 'd1', 'cancelled', '{}')`);
      }
      finally { await store.close(); }
      assert.equal(await storedPredicate(pool, schema, 'Shift_one_active'), "(status = ANY (ARRAY['active'::text, 'pending'::text]))");
    });
  });

  it('refuses exactly the rows the query engine places in the index beside an earlier one, for every condition', async () => {
    await withPostgres(async ({ driver }) => {
      const store = await openStore(uniquenessModel, { driver: driver() });
      try {
        for (const { where, expected, actual, judged, stored } of await uniquenessAgreement(store)) {
          assert.deepEqual(actual, expected, JSON.stringify(where));
          assert.deepEqual(stored, judged, `the engine judged the records as stored: ${JSON.stringify(where)}`);
        }
      }
      finally { await store.close(); }
    });
  });

  it('reads the predicate back on every open: changed, dropped or unconditional is drift', async () => {
    for (const [label, sql] of [
      ['a changed predicate', 'DROP INDEX "S"."Shift_one_active"; CREATE UNIQUE INDEX "Shift_one_active" ON "S"."Shift" ("employeeId", "day") WHERE "status" = \'active\''],
      ['a dropped index', 'DROP INDEX "S"."Shift_one_active"'],
      ['an unconditional index', 'DROP INDEX "S"."Shift_one_active"; CREATE UNIQUE INDEX "Shift_one_active" ON "S"."Shift" ("employeeId", "day")'],
    ]) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await (await openStore(shiftModel(), { driver: driver() })).close();
        await pool.query(sql.replaceAll('"S"', `"${schema}"`));
        const error = await openRefusal(shiftModel(), { driver: driver() });
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message}`);
        assert.match(error.message, /Shift_one_active/, label);
      });
    }
  });

  it('reopens unchanged: a second open creates, alters and reports nothing', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(shiftModel(), { driver: driver() })).close();
      const first = await indexDefinitions(pool, schema);
      await (await openStore(shiftModel(), { driver: driver() })).close();
      assert.deepEqual(await indexDefinitions(pool, schema), first);
      assert.ok(first.some((row) => row.indexname === 'Shift_one_active'));
    });
  });

  it('a predicate added to a collection index declared without one is drift', async () => {
    const model = { $model: '0.1', collections: { c: { schema: { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } } },
      key: '/id', indexes: [{ name: 'by_a', path: '$.a', unique: true }] } } };
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(model, { driver: driver() })).close();
      await pool.query(`DROP INDEX "${schema}"."c_by_a"; CREATE UNIQUE INDEX "c_by_a" ON "${schema}"."c" ("gx_a") WHERE "gx_a" <> 'x'`);
      const error = await openRefusal(model, { driver: driver() });
      assert.equal(error?.code, 'JD0002', error?.message);
      assert.match(error.message, /c_by_a/);
    });
  });

  it('a generated column whose expression changed is drift, a member path and a declared expression alike', async () => {
    const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' } };
    const model = { $model: '0.1', collections: { c: { schema: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' },
      a: { type: 'string' }, b: { type: 'string' } } }, key: '/id', indexes: [{ name: 'by_lower_email', expression: { call: 'lower', args: [{ member: '$.email' }] }, unique: true },
      { name: 'by_a', path: '$.a' }] } } };
    for (const [label, sql] of [
      ['an expression column', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_lower_email_x" SET EXPRESSION AS (upper((doc ->> \'email\')))'],
      ['a member-path column', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS (CASE WHEN jsonb_typeof(doc #> \'{b}\') = \'string\' THEN doc #>> \'{b}\' END)'],
    ]) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await (await openStore(model, { driver: driver(), expressions })).close();
        // the untouched table reopens
        await (await openStore(model, { driver: driver(), expressions })).close();
        await pool.query(sql.replaceAll('"S"', `"${schema}"`));
        const error = await openRefusal(model, { driver: driver(), expressions });
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message}`);
      });
    }
  });

  it('every generated column form and index condition reads back as planned: a reopen is clean', async () => {
    const expressions = {
      lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' },
      // a function whose name is a keyword: the server deparses it quoted
      prefix: { arity: 2, deterministic: true, apply: (/** @type {any} */ v, /** @type {any} */ n) => String(v).slice(0, n), sql: 'left' },
      swap: { arity: 3, deterministic: true, apply: (/** @type {any} */ v, /** @type {any} */ a, /** @type {any} */ b) => String(v).replaceAll(a, b), sql: 'replace' },
    };
    const model = { $model: '0.1', collections: { c: { schema: { type: 'object', properties: {
      id: { type: 'string' }, s: { type: 'string' }, i: { type: 'integer' }, n: { type: 'number' }, b: { type: 'boolean' }, u: {},
      nested: { type: 'object', properties: { deep: { type: 'string' } } }, list: { type: 'array', items: { type: 'integer' } },
      'first name': { type: 'string' }, "o'brien": { type: 'string' }, 'a,b': { type: 'string' }, 'x{y}': { type: 'string' } } }, key: '/id',
      indexes: [
        { name: 'by_s', path: '$.s', unique: true, where: { $and: [{ $exists: '$.i' }, { $ne: ['$.b', true] }, { $gt: ['$.n', -1.5] }, { $eq: ['$.s', { $seq: ['x', "it's"] }] }] } },
        { name: 'by_i', path: '$.i' }, { name: 'by_n', path: '$.n' }, { name: 'by_b', path: '$.b' }, { name: 'by_u', path: '$.u' },
        { name: 'by_deep', path: '$.nested.deep' }, { name: 'by_list', path: '$.list[0]' }, { name: 'by_first', path: '$["first name"]' },
        { name: 'by_quote', path: "$[\"o'brien\"]" }, { name: 'by_comma', path: '$["a,b"]' }, { name: 'by_brace', path: '$["x{y}"]' },
        { name: 'by_lower', expression: { call: 'lower', args: [{ member: '$.s' }] } },
        { name: 'by_prefix', expression: { call: 'prefix', args: [{ member: '$.nested.deep' }, { value: 3 }] } },
        { name: 'by_swap', expression: { call: 'swap', args: [{ member: '$["first name"]' }, { value: "it's" }, { value: 'x' }] } },
      ] } } };
    await withPostgres(async ({ driver }) => {
      await (await openStore(model, { driver: driver(), expressions })).close();
      await (await openStore(model, { driver: driver(), expressions })).close();
    });
  });

  it('a collection index with a where is partial', async () => {
    const model = { $model: '0.1', collections: { c: { schema: { type: 'object', properties: { id: { type: 'string' }, e: { type: 'string' }, s: { type: 'string' } } },
      key: '/id', indexes: [{ name: 'one_active', path: '$.e', unique: true, where: { $eq: ['$.s', { $seq: ['active', 'pending'] }] } }, { name: 'by_s', path: '$.s' }] } } };
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model, { driver: driver() });
      const out = [];
      try {
        for (const doc of [{ id: '1', e: 'x', s: 'active' }, { id: '2', e: 'x', s: 'cancelled' }, { id: '3', e: 'x' }, { id: '4', e: 'x', s: 'pending' }]) {
          try { await store.collection('c').insert(doc); out.push('ok'); }
          catch (error) { out.push(`${/** @type {any} */ (error).code}/${/** @type {any} */ (error).class}`); }
        }
      }
      finally { await store.close(); }
      assert.deepEqual(out, ['ok', 'ok', 'ok', 'JD2005/constraint']);
      assert.equal(await storedPredicate(pool, schema, 'c_one_active'), "(gx_s = ANY (ARRAY['active'::text, 'pending'::text]))");
      await (await openStore(model, { driver: driver() })).close();
    });
  });

  it('a boolean condition and a boolean enum compare the stored smallint', async () => {
    const model = { $model: '0.1', entities: {
      Flagged: { schema: { type: 'object', required: ['id', 'employeeId'], properties: { id: { type: 'string', 'x-entity': { key: true } },
        employeeId: { type: 'string' }, flag: { type: 'boolean' } } },
      indexes: [{ name: 'one_flagged', path: '$.employeeId', unique: true, where: { $eq: ['$.flag', true] } }] },
      E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, flag: { type: 'boolean', enum: [true] } } } } } };
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model, { driver: driver() });
      try {
        assert.deepEqual(await createVerdicts(store.entity('Flagged'), [{ id: 'a', employeeId: 'e', flag: true }, { id: 'b', employeeId: 'e', flag: true },
          { id: 'c', employeeId: 'e', flag: false }, { id: 'd', employeeId: 'e' }]), ['ok', 'JD2005/constraint', 'ok', 'ok']);
        assert.deepEqual(await createVerdicts(store.entity('E'), [{ id: 'a', flag: true }]), ['ok']);
      }
      finally { await store.close(); }
      await pool.query(`INSERT INTO "${schema}"."E" ("id", "flag", "doc") VALUES ('b', 1, '{}')`);
      await assert.rejects(pool.query(`INSERT INTO "${schema}"."E" ("id", "flag", "doc") VALUES ('c', 0, '{}')`), (/** @type {any} */ error) => error.code === '23514');
      assert.equal(await storedPredicate(pool, schema, 'Flagged_one_flagged'), '(flag = 1)');
      await (await openStore(model, { driver: driver() })).close();
    });
  });

  it('the declared index condition keeps its text for every spelling the reader meets', async () => {
    const where = { $and: [{ $and: [{ $eq: ['$.status', { $seq: ['a'] }] }, { $not: { $eq: ['$.day', { $seq: ['x', "it's", 'back\\slash'] }] } }] },
      { $or: [{ $exists: '$.status' }, { $not: { $lt: ['$.employeeId', '$.day'] } }] }] };
    await withPostgres(async ({ driver }) => {
      await (await openStore(shiftModel([{ ...ONE_ACTIVE, where }]), { driver: driver() })).close();
      await (await openStore(shiftModel([{ ...ONE_ACTIVE, where }]), { driver: driver() })).close();
    });
  });

  it('every edit made behind the store is drift, and an identical recreation reopens clean', async () => {
    const lower = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' } };
    const model = { $model: '0.1',
      collections: { c: { schema: { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' },
        n: { type: 'number' }, email: { type: 'string' } } }, key: '/id', indexes: [
        { name: 'by_a', path: '$.a', unique: true, where: { $ne: ['$.n', 0.30000000000000004] } }, { name: 'by_n', path: '$.n' },
        { name: 'by_lower_email', expression: { call: 'lower', args: [{ member: '$.email' }] } }] } },
      entities: { Shift: { schema: SHIFT_SCHEMA, indexes: [{ name: 'one_open', path: ['$.employeeId', '$.day'], unique: true,
        where: { $not: { $eq: ['$.status', { $seq: ['cancelled', 'void'] }] } } }] } } };
    const guarded = (/** @type {string} */ test, /** @type {string} */ then) => `((CASE WHEN jsonb_typeof(doc #> '{a}') = '${test}' THEN ${then} END) COLLATE "C")`;
    const open = 'CREATE UNIQUE INDEX "Shift_one_open" ON "S"."Shift"';
    const CASES = /** @type {[string, string, boolean][]} */ ([
      ['an identical recreation', 'DROP INDEX "S"."Shift_one_open"; CREATE UNIQUE INDEX "Shift_one_open" ON "S"."Shift" ("employeeId", "day") '
        + 'WHERE (NOT (COALESCE("status" IN (\'cancelled\', \'void\'), FALSE)))', false],
      ['a path read in one branch only', `ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS (${guarded('string', "doc #>> '{b}'")})`, true],
      ['a guard testing another type', `ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS (${guarded('number', "doc #>> '{a}'")})`, true],
      ['a guard dropped', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS ((doc #>> \'{a}\') COLLATE "C")', true],
      ['a collation dropped', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS (CASE WHEN jsonb_typeof(doc #> \'{a}\') = \'string\' THEN doc #>> \'{a}\' END)', true],
      ['a member appended to', `ALTER TABLE "S"."c" ALTER COLUMN "gx_a" SET EXPRESSION AS (${guarded('string', "(doc #>> '{a}') || 'x'")})`, true],
      ['a number negated', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_n" SET EXPRESSION AS (CASE WHEN jsonb_typeof(doc #> \'{n}\') = \'number\' THEN -((doc #> \'{n}\')::numeric) END)', true],
      ['a number shifted', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_n" SET EXPRESSION AS (CASE WHEN jsonb_typeof(doc #> \'{n}\') = \'number\' THEN ((doc #> \'{n}\')::numeric) + 1 END)', true],
      ['a declared expression rewritten', 'ALTER TABLE "S"."c" ALTER COLUMN "gx_lower_email_x" SET EXPRESSION AS (lower((doc #>> \'{email}\') || \'x\'))', true],
      ['NOT without the COALESCE the rendering writes', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId", "day") WHERE NOT ("status" IN ('cancelled', 'void'))`, true],
      ['a literal no double spells', 'DROP INDEX "S"."c_by_a"; CREATE UNIQUE INDEX "c_by_a" ON "S"."c" ("gx_a") WHERE "gx_n" <> 0.300000000000000044', true],
      ['NULLS NOT DISTINCT', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId", "day") NULLS NOT DISTINCT `
        + 'WHERE (NOT (COALESCE("status" IN (\'cancelled\', \'void\'), FALSE)))', true],
      ['a descending key', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId", "day" DESC) WHERE (NOT (COALESCE("status" IN ('cancelled', 'void'), FALSE)))`, true],
      ['a key collation of its own', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId" COLLATE "POSIX", "day") `
        + 'WHERE (NOT (COALESCE("status" IN (\'cancelled\', \'void\'), FALSE)))', true],
      ['a key column moved into INCLUDE', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId") INCLUDE ("day") `
        + 'WHERE (NOT (COALESCE("status" IN (\'cancelled\', \'void\'), FALSE)))', true],
      ['an operator class of its own', `DROP INDEX "S"."Shift_one_open"; ${open} ("employeeId" text_pattern_ops, "day") `
        + 'WHERE (NOT (COALESCE("status" IN (\'cancelled\', \'void\'), FALSE)))', true],
    ]);
    for (const [label, sql, drift] of CASES) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await (await openStore(model, { driver: driver(), expressions: lower })).close();
        await pool.query(sql.replaceAll('"S"', `"${schema}"`));
        const error = await openRefusal(model, { driver: driver(), expressions: lower });
        assert.equal(error?.code, drift ? 'JD0002' : undefined, `${label}: ${error?.message}`);
      });
    }
  });

  it('a member named like an array index, and a backslash read in a session without standard strings, reopen clean', async () => {
    const model = { $model: '0.1', collections: { c: { schema: { type: 'object', properties: { id: { type: 'string' }, 123: { type: 'string' },
      0: { type: 'string' }, s: { type: 'string' }, 'a\\b': { type: 'string' }, stats: { type: 'object', properties: { 123: { type: 'string' } } } } }, key: '/id',
    indexes: [{ name: 'by_123', path: '$["123"]', unique: true, where: { $eq: ['$.s', { $seq: ['x\\y', 'z'] }] } }, { name: 'by_0', path: '$["0"]' },
      { name: 'by_s', path: '$.s' }, { name: 'by_slash', path: '$["a\\b"]' }, { name: 'by_deep', path: '$.stats["123"]' }] } },
    entities: { Shift: { schema: SHIFT_SCHEMA, indexes: [{ ...ONE_ACTIVE, where: { $eq: ['$.status', 'back\\slash'] } }] } } };
    await withPostgres(async ({ schema, driver }) => {
      await (await openStore(model, { driver: driver() })).close();
      await (await openStore(model, { driver: driver() })).close();
      const { default: pg } = await import('pg');
      const escaped = new pg.Pool({ connectionString: PG_URL, max: 1, options: '-c standard_conforming_strings=off' });
      try {
        const { postgresDriver } = await import('@jarenjs/db/postgres');
        await (await openStore(model, { driver: postgresDriver(escaped, { schema }) })).close();
      }
      finally { await escaped.end(); }
    });
  });

  it('round-trips the motivating index through introspection, and the derived model reopens the database it was read from', async () => {
    await withPostgres(async ({ schema, driver }) => {
      const model = { $model: '0.1', entities: { Shift: { schema: { ...SHIFT_SCHEMA, properties: { ...SHIFT_SCHEMA.properties,
        employeeId: { type: 'string', 'x-entity': { index: true } } } }, indexes: [ONE_ACTIVE, { name: 'by_day', path: '$.day' }] } } };
      const store = await openStore(model, { driver: driver() });
      const { model: derived, report } = await store.introspect();
      await store.close();
      assert.deepEqual(derived.entities.Shift.indexes, [{ name: 'by_day', path: '$.day' }, ONE_ACTIVE]);
      assert.deepEqual(derived.entities.Shift.schema.properties.employeeId, { type: 'string', 'x-entity': { index: true } });
      assert.deepEqual(report.filter((row) => row.code === 'unmapped-index'), []);
      // the same indexes and columns: back to the authored model is one drafted transform (the
      // derived schema requires only the key) and no DDL
      const back = planMigration(derived, model, { dialect: postgresDialect({ searchPath: schema }) });
      assert.deepEqual(back.migration.steps.map((step) => `${step.kind}${step.draft === true ? ' (draft)' : ''}`), ['jslt (draft)']);
      assert.deepEqual(back.report.schemaChanged, ['Shift']);
      const reopened = await openStore(derived, { driver: driver() });
      try { assert.deepEqual(await createVerdicts(reopened.entity('Shift'), SHIFT_ROWS), SHIFT_VERDICTS); }
      finally { await reopened.close(); }
    });
  });

  it('reads a boolean condition back as the stored smallint, and reports the smallint and numeric columns lossy', async () => {
    await withPostgres(async ({ driver }) => {
      const model = { $model: '0.1', entities: { Shift: { schema: { ...SHIFT_SCHEMA, properties: { ...SHIFT_SCHEMA.properties,
        flag: { type: 'boolean' }, n: { type: 'integer' } } }, indexes: [{ name: 'flagged', path: '$.n', where: { $eq: ['$.flag', true] } }] } } };
      const store = await openStore(model, { driver: driver() });
      try {
        const { model: derived, report } = await store.introspect();
        // the derived types are the columns' own: smallint reads as an integer, numeric as a number
        assert.deepEqual(derived.entities.Shift.indexes, [{ name: 'flagged', path: '$.n', where: { $eq: ['$.flag', 1] } }]);
        assert.deepEqual([derived.entities.Shift.schema.properties.flag, derived.entities.Shift.schema.properties.n],
          [{ type: 'integer' }, { type: 'number' }]);
        assert.deepEqual(report.filter((row) => row.code === 'lossy-type').map((row) => row.object).sort(), ['Shift.flag', 'Shift.n']);
      }
      finally { await store.close(); }
    });
  });

  it('reports an index no model declares, and never derives a name the store would refuse', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const model = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, a: { type: 'string' }, b: { type: 'string', 'x-entity': { index: true } },
        m: { type: 'string' } } } } } };
      await (await openStore(model, { driver: driver() })).close();
      const T = `"${schema}"."T"`;
      // a key over a alone with m only carried; an operator class of its own (twice, once under a
      // property's own index name); the row identity; and a name the store's own index of b takes, case folded
      await pool.query(`CREATE UNIQUE INDEX "T_incl" ON ${T} ("a") INCLUDE ("m"); CREATE INDEX "T_ops" ON ${T} ("a" text_pattern_ops, "m"); `
        + `CREATE INDEX "T_m" ON ${T} ("m" text_pattern_ops); CREATE INDEX "T_rid" ON ${T} ("rid"); CREATE INDEX "T_B" ON ${T} ("b", "m")`);
      const connection = await driver().open();
      try {
        const { model: derived, report } = await introspectModel(connection);
        assert.equal(derived.entities.T.indexes, undefined);
        assert.deepEqual([derived.entities.T.schema.properties.b, derived.entities.T.schema.properties.m],
          [{ type: 'string', 'x-entity': { index: true } }, { type: 'string' }]);
        assert.deepEqual(report.filter((row) => row.code === 'unmapped-index').map((row) => row.object).sort(),
          ['T.T_B', 'T.T_incl', 'T.T_m', 'T.T_ops', 'T.T_rid']);
        // the derived model plans: no two of its objects share a name
        assert.deepEqual(planMigration(derived, derived, { dialect: postgresDialect({ searchPath: schema }) }).migration.steps, []);
      }
      finally { await connection.close(); }
    });
  });
});
