//@ts-check
/**
 * @file An entity index over a declared expression on PostgreSQL (MODEL-FORMAT
 * §7A): the server computes the host's IMMUTABLE function on every
 * connection, so the index holds for the store and for a raw SQL writer
 * alike; each member is read as a collection's expression reads it (its text
 * under the database's default collation); every open reads the key back out
 * of the catalog; the migration planner creates, drops and recreates it; and
 * introspection reads it back by the host's declarations. SQLite keeps the
 * refusal, in `entity-indexes.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openStore, planColumnUpgrade, planMigration } from '@jarenjs/db';
import { postgresDialect, postgresDriver } from '@jarenjs/db/postgres';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { openRefusal } from './invariant-oracle.js';

const EXPRESSIONS = {
  lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'lower' },
  prefix: { arity: 2, deterministic: true, apply: (/** @type {any} */ value, /** @type {any} */ n) => String(value).slice(0, n), sql: 'left' },
};
const LOWER_EMAIL = { call: 'lower', args: [{ member: '$.email' }] };
const BY_LOWER_EMAIL = { name: 'by_lower_email', expression: LOWER_EMAIL, unique: true };
const SCHEMA = { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, email: { type: 'string' }, status: { type: 'string' } } };
/** A model whose `User` declares the given indexes. @param {any[]} [indexes] */
const userModel = (indexes = [BY_LOWER_EMAIL]) => ({ $model: '0.1', entities: { User: { schema: SCHEMA, ...(indexes.length ? { indexes } : {}) } } });
const INDEX_SQL = 'CREATE UNIQUE INDEX "User_by_lower_email" ON "User" (lower(("email" COLLATE "default")))';

/** The definitions of a schema's indexes, by name. @param {any} pool @param {string} schema */
async function indexDefinitions(pool, schema) {
  const { rows } = await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [schema]);
  return rows.map((/** @type {any} */ row) => `${row.indexname}: ${row.indexdef.replaceAll(`${schema}.`, '')}`);
}

/** Run a plan's statements in a schema. @param {any} pool @param {string} schema @param {any[]} steps */
async function runSteps(pool, schema, steps) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const step of steps) await client.query(step.sql);
  }
  finally {
    await client.query('RESET search_path');
    client.release();
  }
}

/** What a create answers: `ok`, or the error's code. @param {any} entity @param {any} row */
const created = (entity, row) => entity.create(row).then(() => 'ok', (/** @type {any} */ error) => error.code);

describe('an entity index over a declared expression on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('keeps one row per lowered email for the store and for a raw SQL writer, which inserts and deletes as before', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(userModel(), { driver: driver(), expressions: EXPRESSIONS });
      try {
        const users = store.entity('User');
        assert.deepEqual([await created(users, { id: 'u1', email: 'Ann@X.org' }), await created(users, { id: 'u2', email: 'ann@x.ORG' }),
          await created(users, { id: 'u3', email: 'bob@x.org' }), await created(users, { id: 'u4' }), await created(users, { id: 'u5' })],
        ['ok', 'JD2005', 'ok', 'ok', 'ok']);
        const table = `"${schema}"."User"`;
        // a writer that registered nothing meets the same index, and writes every other row
        await assert.rejects(pool.query(`INSERT INTO ${table} ("id", "email", "doc") VALUES ('r1', 'BOB@X.ORG', '{}')`),
          (/** @type {any} */ error) => error.code === '23505' && error.constraint === 'User_by_lower_email');
        await pool.query(`INSERT INTO ${table} ("id", "email", "doc") VALUES ('r2', 'carol@x.org', '{}')`);
        await pool.query(`DELETE FROM ${table} WHERE "id" IN ('r2', 'u3')`);
        assert.equal(await created(users, { id: 'u6', email: 'Bob@x.org' }), 'ok');
      }
      finally { await store.close(); }
      assert.deepEqual((await indexDefinitions(pool, schema)).filter((row) => row.startsWith('User_by')),
        ['User_by_lower_email: CREATE UNIQUE INDEX "User_by_lower_email" ON "User" USING btree (lower((email COLLATE "default")))']);
    });
  });

  it('is partial under a condition, nests calls over a literal, and reopens creating, altering and reporting nothing', async () => {
    const indexes = [{ ...BY_LOWER_EMAIL, where: { $eq: ['$.status', 'active'] } },
      { name: 'by_prefix', expression: { call: 'prefix', args: [LOWER_EMAIL, { value: 3 }] } }];
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(userModel(indexes), { driver: driver(), expressions: EXPRESSIONS });
      try {
        const users = store.entity('User');
        assert.deepEqual([await created(users, { id: 'u1', email: 'A@x', status: 'active' }), await created(users, { id: 'u2', email: 'a@X', status: 'gone' }),
          await created(users, { id: 'u3', email: 'a@x', status: 'active' })], ['ok', 'ok', 'JD2005']);
      }
      finally { await store.close(); }
      const first = await indexDefinitions(pool, schema);
      await (await openStore(userModel(indexes), { driver: driver(), expressions: EXPRESSIONS })).close();
      assert.deepEqual(await indexDefinitions(pool, schema), first);
      assert.deepEqual(first.filter((row) => row.startsWith('User_by')), [
        'User_by_lower_email: CREATE UNIQUE INDEX "User_by_lower_email" ON "User" USING btree (lower((email COLLATE "default"))) WHERE (status = \'active\'::text)',
        'User_by_prefix: CREATE INDEX "User_by_prefix" ON "User" USING btree ("left"(lower((email COLLATE "default")), 3))']);
    });
  });

  it('reads the key back on every open: another function, another collation, a nondeterministic one or a lost unique is drift', async () => {
    const recreate = (/** @type {string} */ definition) => `DROP INDEX "S"."User_by_lower_email"; CREATE ${definition}`;
    for (const [label, sql, message] of [
      ['another function', recreate('UNIQUE INDEX "User_by_lower_email" ON "S"."User" (upper(("email" COLLATE "default")))'),
        /keys upper\(\(email COLLATE "default"\)\), and the model declares lower\(\("email" COLLATE "default"\)\)/],
      ['the column read under its own collation', recreate('UNIQUE INDEX "User_by_lower_email" ON "S"."User" (lower("email"))'), /keys lower\(email\)/],
      ['a nondeterministic collation', 'CREATE COLLATION "S".ci (provider = icu, locale = \'und-u-ks-level2\', deterministic = false); '
        + recreate('UNIQUE INDEX "User_by_lower_email" ON "S"."User" ((lower(("email" COLLATE "default"))) COLLATE "S".ci)'), /nondeterministic collation/],
      ['a lost unique', recreate('INDEX "User_by_lower_email" ON "S"."User" (lower(("email" COLLATE "default")))'), /does not match the declared 'User_by_lower_email'/],
      ['a column in place of the expression', recreate('UNIQUE INDEX "User_by_lower_email" ON "S"."User" ("email")'), /covers \(email\)/],
    ]) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await (await openStore(userModel(), { driver: driver(), expressions: EXPRESSIONS })).close();
        await pool.query(String(sql).replaceAll('"S"', `"${schema}"`));
        const error = await openRefusal(userModel(), { driver: driver(), expressions: EXPRESSIONS });
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message}`);
        assert.match(error.message, /User_by_lower_email/, label);
        assert.match(error.message, /** @type {RegExp} */ (message), label);
      });
    }
  });

  it('keys a foreign key\'s column over a string key as it keys a scalar', async () => {
    const model = { $model: '0.1', entities: {
      Team: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
        users: { 'x-entity': { relation: { to: 'User', many: true, via: 'teamId', onDelete: 'cascade' } } } } } },
      User: { schema: SCHEMA, indexes: [{ name: 'one_per_team', expression: { call: 'lower', args: [{ member: '$.teamId' }] }, unique: true }] } } };
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model, { driver: driver(), expressions: EXPRESSIONS });
      try {
        await store.entity('Team').create({ id: 'T1' });
        await store.entity('Team').create({ id: 't1' });
        assert.deepEqual([await created(store.entity('User'), { id: 'u1', teamId: 'T1' }), await created(store.entity('User'), { id: 'u2', teamId: 't1' })],
          ['ok', 'JD2005']);
        await assert.rejects(pool.query(`INSERT INTO "${schema}"."User" ("id", "teamId", "doc") VALUES ('r1', 't1', '{}')`),
          (/** @type {any} */ error) => error.code === '23505' && error.constraint === 'User_one_per_team');
      }
      finally { await store.close(); }
      assert.deepEqual((await indexDefinitions(pool, schema)).filter((row) => row.startsWith('User_one')),
        ['User_one_per_team: CREATE UNIQUE INDEX "User_one_per_team" ON "User" USING btree (lower(("teamId" COLLATE "default")))']);
      await (await openStore(model, { driver: driver(), expressions: EXPRESSIONS })).close();
    });
  });

  it('refuses a model whose function the store was not given, at the call, before any statement', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const error = await openRefusal(userModel(), { driver: driver() });
      assert.equal(error?.code, 'JD0004', error?.message);
      assert.equal(error.docPath, '/entities/User/indexes/0/expression/call');
      assert.match(error.message, /names the function 'lower', which this store was not given[\s\S]*openStore\(\{ expressions \}\)/);
      assert.deepEqual(await indexDefinitions(pool, schema), []);
    });
  });

  it('plans the index into a model, out of it, and again when its condition changes; the planned database opens', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const dialect = postgresDialect({ searchPath: schema });
      const plan = (/** @type {any} */ from, /** @type {any} */ to) => planMigration(from, to, { dialect, expressions: EXPRESSIONS }).migration.steps;
      const partial = userModel([{ ...BY_LOWER_EMAIL, where: { $exists: '$.status' } }]);
      await (await openStore(userModel([]), { driver: driver() })).close();
      const added = plan(userModel([]), userModel());
      assert.deepEqual(added.map((/** @type {any} */ step) => step.sql), [INDEX_SQL]);
      await runSteps(pool, schema, added);
      await (await openStore(userModel(), { driver: driver(), expressions: EXPRESSIONS })).close();
      const changed = plan(userModel(), partial);
      assert.deepEqual(changed.map((/** @type {any} */ step) => step.sql), ['DROP INDEX "User_by_lower_email"', `${INDEX_SQL} WHERE "status" IS NOT NULL`]);
      await runSteps(pool, schema, changed);
      await (await openStore(partial, { driver: driver(), expressions: EXPRESSIONS })).close();
      assert.deepEqual(plan(partial, partial), []);
      assert.deepEqual(plan(partial, userModel([])).map((/** @type {any} */ step) => step.sql), ['DROP INDEX "User_by_lower_email"']);
      // migrate() applies the planned link through its history, and a column upgrade finds nothing to do
      const back = planMigration(partial, userModel(), { dialect, expressions: EXPRESSIONS }).migration;
      const connection = await driver().open();
      try {
        assert.equal((await migrate({ connection }, [back], { baseline: partial, expressions: EXPRESSIONS, shadow: false })).applied.length, 1);
        const upgrade = await planColumnUpgrade(connection, userModel(), { expressions: EXPRESSIONS });
        assert.deepEqual([upgrade.migration.steps, upgrade.report.upgraded], [[], []]);
      }
      finally { await connection.close(); }
      await (await openStore(userModel(), { driver: driver(), expressions: EXPRESSIONS })).close();
      assert.deepEqual((await indexDefinitions(pool, schema)).filter((row) => row.startsWith('User_by')),
        ['User_by_lower_email: CREATE UNIQUE INDEX "User_by_lower_email" ON "User" USING btree (lower((email COLLATE "default")))']);
      // a planner not given the function plans no DDL over it
      assert.throws(() => planMigration(userModel([]), userModel(), { dialect }),
        (/** @type {any} */ error) => error.code === 'JD0004' && error.docPath === '/entities/User/indexes/0/expression/call');
    });
  });

  it('introspects the index back by the declarations, reports it unmapped without them, and the derived model reopens', async () => {
    const indexes = [{ ...BY_LOWER_EMAIL, where: { $eq: ['$.status', 'active'] } },
      { name: 'by_prefix', expression: { call: 'prefix', args: [LOWER_EMAIL, { value: 3 }] } }];
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(userModel(indexes), { driver: driver(), expressions: EXPRESSIONS });
      // an index over the name a store registers a function by, which no plan here renders: never derived as `lower`
      await pool.query(`CREATE FUNCTION "${schema}".jaren_x_lower(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT lower($1)'; `
        + `CREATE INDEX "User_by_registered" ON "${schema}"."User" ("${schema}".jaren_x_lower(("email" COLLATE "default")))`);
      let derived;
      try {
        const read = await store.introspect({ expressions: EXPRESSIONS });
        derived = read.model;
        assert.deepEqual(derived.entities.User.indexes, indexes);
        assert.deepEqual(read.report.filter((/** @type {any} */ row) => row.code === 'unmapped-index').map((/** @type {any} */ row) => row.object),
          ['User.User_by_registered']);
        const bare = await store.introspect();
        assert.equal(bare.model.entities.User.indexes, undefined);
        assert.deepEqual(bare.report.filter((/** @type {any} */ row) => row.code === 'unmapped-index').map((/** @type {any} */ row) => row.object),
          ['User.User_by_lower_email', 'User.User_by_prefix', 'User.User_by_registered']);
        assert.match(bare.report.find((/** @type {any} */ row) => row.object === 'User.User_by_prefix').detail, /introspect\(\{ expressions \}\)/);
      }
      finally { await store.close(); }
      await pool.query(`DROP INDEX "${schema}"."User_by_registered"`);
      // the derived indexes are the ones the database holds: no index DDL back to the model
      const steps = planMigration(derived, userModel(indexes), { dialect: postgresDialect({ searchPath: schema }), expressions: EXPRESSIONS }).migration.steps;
      assert.deepEqual(steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
      await (await openStore(derived, { driver: driver(), expressions: EXPRESSIONS })).close();
    });
  });

  it('verifies and introspects a qualified or upper-case function name as the server deparses it, and still compares a schema off the path', async () => {
    const other = `jaren_expr_other_${process.pid}`;
    const { default: pg } = await import('pg');
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${other}"; `
      + `CREATE OR REPLACE FUNCTION "${other}".fold(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT lower($1)'; `
      + `CREATE OR REPLACE FUNCTION "${other}".lower(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT upper($1)'`);
    /** A declaration of `fold` over the server's function `sql`. @param {string} sql */
    const folding = (sql) => ({ fold: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql } });
    const model = userModel([{ name: 'by_fold', unique: true, expression: { call: 'fold', args: [{ member: '$.email' }] } }]);
    /** Open, reopen, introspect and reopen the derived model. @param {(schema: string) => string} sqlOf @param {any} [pathOwn] */
    const roundTrip = async (sqlOf, pathOwn = false) => withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE FUNCTION "${schema}".fold(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT lower($1)'`);
      const expressions = folding(sqlOf(schema));
      // a store on the connection's own search path names no schema, and finds the function there
      const own = pathOwn ? new pg.Pool({ connectionString: PG_URL, max: 1, options: `-c search_path=${schema}` }) : null;
      const open = (/** @type {any} */ declared) => openStore(declared, { driver: own === null ? driver() : postgresDriver(own), expressions });
      try {
        const first = await open(model);
        await first.entity('User').create({ id: 'u1', email: 'A@x' });
        assert.equal(await created(first.entity('User'), { id: 'u2', email: 'a@X' }), 'JD2005');
        await first.close();
        const store = await open(model);
        let derived;
        try {
          const read = await store.introspect({ expressions });
          derived = read.model;
          assert.deepEqual(read.report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
        }
        finally { await store.close(); }
        assert.deepEqual(derived.entities.User.indexes, model.entities.User.indexes);
        const steps = planMigration(derived, model, { dialect: postgresDialect({ searchPath: schema }), expressions }).migration.steps;
        assert.deepEqual(steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        await (await open(derived)).close();
        return (await indexDefinitions(pool, schema)).filter((row) => row.startsWith('User_by'));
      }
      finally { await own?.end(); }
    });
    try {
      assert.deepEqual(await roundTrip(() => 'pg_catalog.lower'),
        ['User_by_fold: CREATE UNIQUE INDEX "User_by_fold" ON "User" USING btree (lower((email COLLATE "default")))']);
      assert.deepEqual(await roundTrip(() => 'LOWER'),
        ['User_by_fold: CREATE UNIQUE INDEX "User_by_fold" ON "User" USING btree (lower((email COLLATE "default")))']);
      for (const pathOwn of [false, true]) {
        assert.deepEqual(await roundTrip((schema) => `${schema}.fold`, pathOwn),
          ['User_by_fold: CREATE UNIQUE INDEX "User_by_fold" ON "User" USING btree (fold((email COLLATE "default")))']);
      }
      // a schema the store's path does not hold keeps its name in the deparse and is compared by it
      assert.deepEqual(await roundTrip(() => `${other}.fold`),
        [`User_by_fold: CREATE UNIQUE INDEX "User_by_fold" ON "User" USING btree (${other}.fold((email COLLATE "default")))`]);
      await withPostgres(async ({ pool, schema, driver }) => {
        await (await openStore(model, { driver: driver(), expressions: folding('lower') })).close();
        await pool.query(`DROP INDEX "${schema}"."User_by_fold"; CREATE UNIQUE INDEX "User_by_fold" ON "${schema}"."User" (lower(("email" COLLATE "default")))`);
        const error = await openRefusal(model, { driver: driver(), expressions: folding(`${other}.lower`) });
        assert.equal(error?.code, 'JD0002', error?.message);
        assert.match(error.message, new RegExp(`keys lower\\(\\(email COLLATE "default"\\)\\), and the model declares ${other}\\.lower`));
      });
    }
    finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
      await admin.end();
    }
  });

  it('verifies and introspects a collection\'s expression column over a qualified function name and a negative literal', async () => {
    // `lowered` alone names the server's `lower`: of two declarations of one function, introspection reads the one spelled as the server spells it
    const declared = (/** @type {string} */ schema) => ({ prefix: EXPRESSIONS.prefix,
      fold: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: `${schema}.fold` },
      lowered: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'pg_catalog.lower' } });
    for (const expression of [{ call: 'fold', args: [{ member: '$.email' }] }, { call: 'lowered', args: [{ member: '$.email' }] },
      { call: 'prefix', args: [{ call: 'lowered', args: [{ member: '$.email' }] }, { value: -1 }] }]) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await pool.query(`CREATE FUNCTION "${schema}".fold(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT lower($1)'`);
        const expressions = declared(schema);
        const model = { $model: '0.1', collections: { u: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } },
          indexes: [{ name: 'by_x', expression }] } } };
        const first = await openStore(model, { driver: driver(), expressions });
        await first.collection('u').insert({ id: 'a', email: 'A@x' });
        await first.close();
        const store = await openStore(model, { driver: driver(), expressions });
        let derived;
        try { derived = (await store.introspect({ expressions, keys: { u: '/id' } })).model; }
        finally { await store.close(); }
        assert.deepEqual(derived.collections.u.indexes, model.collections.u.indexes, JSON.stringify(expression));
        const steps = planMigration(derived, model, { dialect: postgresDialect({ searchPath: schema }), expressions }).migration.steps;
        assert.deepEqual(steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        await (await openStore(derived, { driver: driver(), expressions })).close();
      });
    }
  });

  it('introspects a number literal the server keeps cast, and refuses one no function takes at the declaration', async () => {
    const expressions = { ...EXPRESSIONS,
      tagged: { arity: 2, deterministic: true, apply: (/** @type {any} */ value, /** @type {any} */ n) => `${value}${n}`, sql: 'tagged' } };
    const literals = [['left', -1], ['tagged', 5], ['tagged', 2147483648], ['tagged', -1.5], ['tagged', 2.5]];
    for (const [fn, value] of literals) {
      await withPostgres(async ({ pool, schema, driver }) => {
        await pool.query(`CREATE FUNCTION "${schema}".tagged(text, numeric) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT $1 || $2::text'`);
        const call = fn === 'left' ? 'prefix' : 'tagged';
        const model = userModel([{ name: 'by_x', expression: { call, args: [LOWER_EMAIL, { value }] } }]);
        await (await openStore(model, { driver: driver(), expressions })).close();
        const store = await openStore(model, { driver: driver(), expressions });
        let derived;
        try { derived = (await store.introspect({ expressions })).model; }
        finally { await store.close(); }
        assert.deepEqual(derived.entities.User.indexes, model.entities.User.indexes, `${fn} ${value}`);
        await (await openStore(derived, { driver: driver(), expressions })).close();
      });
    }
    await withPostgres(async ({ pool, schema, driver }) => {
      const model = userModel([{ name: 'by_x', expression: { call: 'prefix', args: [LOWER_EMAIL, { value: 2147483648 }] } }]);
      const error = await openRefusal(model, { driver: driver(), expressions });
      assert.equal(error?.code, 'JD0004', error?.message);
      assert.equal(error.docPath, '/entities/User/indexes/0/expression');
      assert.match(error.message, /index 'by_x' keys left\(lower\(\("email" COLLATE "default"\)\), 2147483648\), which the server cannot create: function left\(text, bigint\) does not exist/);
      assert.deepEqual(await indexDefinitions(pool, schema), []);
    });
  });

  it('replication orders a value a unique column passes between rows, and keeps the envelope order for an expression key', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
    const outcomes = [];
    try {
      for (const [label, index] of [['a column', { name: 'by_email', path: '$.email', unique: true }],
        ['an expression', { ...BY_LOWER_EMAIL, name: 'by_email' }]]) {
        const schemas = [0, 1].map((at) => `jaren_expr_repl_${process.pid}_${outcomes.length}_${at}`);
        /** @type {any[]} */
        const stores = [];
        try {
          for (const [at, schema] of schemas.entries()) {
            await pool.query(`CREATE SCHEMA "${schema}"`);
            stores.push(await openStore(userModel([index]), { driver: postgresDriver(pool, { schema }), expressions: EXPRESSIONS,
              capture: { mode: 'journal' }, replication: { replica: `r${at}` } }));
          }
          const [origin, replica] = stores;
          await origin.entity('User').create({ id: 'u1', email: 'q' });
          await origin.entity('User').create({ id: 'u2', email: 'a@x' });
          const first = await origin.replication.page({ after: 0 });
          for (const envelope of first.items) await replica.replication.apply(envelope);
          // u2 releases the value u1 takes, and u1 sorts first in the envelope
          await origin.transaction(async (/** @type {any} */ tx) => {
            await tx.entity('User').update('u2', { email: 'z' });
            await tx.entity('User').update('u1', { email: label === 'a column' ? 'a@x' : 'A@X' });
          });
          const [moved] = (await origin.replication.page({ after: first.next })).items;
          outcomes.push(await replica.replication.apply(moved).then((/** @type {any} */ result) => result.status,
            (/** @type {any} */ error) => `${error.code} ${/duplicate key value violates unique constraint "User_by_email"/.test(error.message)}`));
        }
        finally {
          for (const store of stores) await store.close();
          for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      }
    }
    finally { await pool.end(); }
    assert.deepEqual(outcomes, ['applied', 'JD2005 true']);
  });
});
