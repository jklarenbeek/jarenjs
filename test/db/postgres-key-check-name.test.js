//@ts-check
/**
 * @file The key CHECK a PostgreSQL store gives each `numeric` column holding
 * a key, by its name and by its meaning. A fresh table names it
 * `<table>_<column>_jaren_key` (clipped beside a hash where the engine would
 * truncate it); the open reads it by its expression under any name, an
 * earlier release's included. A key that gains the database's allocation
 * drops it with the type, and one that loses it gets it back, with the CHECK
 * that refuses a NaN where the column had none, so no route leaves a
 * `numeric` key without it. The server's rewrite of the CHECK across a
 * change of the column's type is the store's own, but guards nothing over a
 * `numeric`: `introspect()` names it and `planColumnUpgrade` replaces it.
 * Past 2^53 the CHECK leaves a writer's digits its own, so an external list
 * compares by its double's interval. PostgreSQL where JAREN_PG_URL names a
 * server; the CHECK reader always.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planModelMigration, planColumnUpgrade, migrate } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { postgresChecks } from '../../packages/db/src/dialects/check-read.js';
import { skipFor, withPostgres } from './store-core-engines.js';

const W = '6.00000000000000000001';
/** @param {boolean} auto - whether the database allocates the post's key */
const model = (auto) => ({ $model: '0.1', entities: {
  Post: { schema: { type: 'object', required: ['pid'], properties: {
    pid: { type: 'integer', 'x-entity': { key: true, ...(auto ? { default: 'auto' } : {}) } }, name: { type: 'string' },
    comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
  Comment: { schema: { type: 'object', properties: { cid: { type: 'string', 'x-entity': { key: true } }, postId: { type: 'integer' } } } },
  Tag: { schema: { type: 'object', properties: { tid: { type: 'string', 'x-entity': { key: true } } } } },
} });
/** The columns holding the post's key. */
const HOLDERS = [['Comment', 'postId'], ['Post', 'pid'], ['Post_Tag', 'Post_key']];
const KEY = (/** @type {string} */ k) => ('CASE WHEN ((abs(k) >= (\'9007199254740992\'::bigint)::numeric) OR (k = trunc(k))) THEN true '
  + 'WHEN (abs(k) < ((5)::numeric * power((10)::numeric, (\'-324\'::integer)::numeric))) THEN false '
  + 'ELSE (k = (((k)::double precision)::text)::numeric) END').replaceAll('k', k);

/**
 * Every CHECK of a schema's tables, `<table>.<name>: <what it is>` — `KEY`
 * the key CHECK, `KEY-REWRITTEN` the server's rewrite of it, else its text.
 * @param {any} pool @param {string} schema @returns {Promise<string[]>}
 */
const checks = async (pool, schema) => (await pool.query('SELECT t.relname AS t, c.conname AS c, pg_catalog.pg_get_expr(c.conbin, c.conrelid) AS e '
  + 'FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace '
  + 'WHERE n.nspname = $1 AND c.contype = \'c\' ORDER BY 1, 2', [schema])).rows
  .map((/** @type {any} */ row) => `${row.t}.${row.c}: ${/trunc/.test(row.e) ? (/double precision = trunc/.test(row.e) ? 'KEY-REWRITTEN' : 'KEY') : row.e}`);

/** What a fresh store creates for each model's columns holding the post's key. */
const FRESH = {
  caller: ['Comment.Comment_postId_check: ("postId" <> \'NaN\'::numeric)', 'Comment.Comment_postId_jaren_key: KEY',
    'Post.Post_pid_check: (pid <> \'NaN\'::numeric)', 'Post.Post_pid_jaren_key: KEY',
    'Post_Tag.Post_Tag_Post_key_check: ("Post_key" <> \'NaN\'::numeric)', 'Post_Tag.Post_Tag_Post_key_jaren_key: KEY'],
  allocated: [],
};

/**
 * Apply `planModelMigration` link by link along `chain` (each entry whether the key is allocated).
 * @param {{ driver: () => any }} pg @param {string} schema @param {boolean[]} chain
 * @returns {Promise<any[]>} the applied links
 */
async function migrateAlong(pg, schema, chain) {
  const applied = [];
  for (let step = 1; step < chain.length; step++) {
    const { migration } = planModelMigration(model(chain[step - 1]), model(chain[step]), { dialect: postgresDialect({ schema }), id: `m${step}` });
    applied.push(migration);
    await migrate({ driver: pg.driver() }, [...applied], { baseline: model(chain[0]), model: model(chain[step]), shadow: false });
  }
  return applied;
}

describe('the key CHECK, read by its meaning', () => {
  it('reads the store\'s own CHECK under any name, and the server\'s rewrites of it as the store\'s own that guard nothing', () => {
    const read = (/** @type {string} */ expression) => {
      const [check] = postgresChecks([{ name: 'any', expression, validated: 1 }]);
      return { guard: check.guard, keyCheck: check.keyCheck, notNaN: check.notNaN, column: check.column };
    };
    assert.deepEqual(read(KEY('"postId"')), { guard: 'shortest-digits', keyCheck: true, notNaN: undefined, column: 'postId' });
    // over a column that became a bigint, and over the numeric it became again
    const bigint = 'CASE WHEN (((abs(k))::numeric >= (\'9007199254740992\'::bigint)::numeric) OR ((k)::double precision = trunc((k)::double precision))) THEN true '
      + 'WHEN ((abs(k))::numeric < ((5)::numeric * power((10)::numeric, (\'-324\'::integer)::numeric))) THEN false '
      + 'ELSE ((k)::numeric = (((k)::double precision)::text)::numeric) END';
    const released = 'CASE WHEN ((abs(k) >= (\'9007199254740992\'::bigint)::numeric) OR ((k)::double precision = trunc((k)::double precision))) THEN true '
      + 'WHEN (abs(k) < ((5)::numeric * power((10)::numeric, (\'-324\'::integer)::numeric))) THEN false '
      + 'ELSE (k = (((k)::double precision)::text)::numeric) END';
    for (const text of [bigint, released])
      assert.deepEqual(read(text.replaceAll('k', 'pid')), { guard: undefined, keyCheck: 'rewritten', notNaN: undefined, column: 'pid' });
    // two columns among it, or another bound, is no CHECK of the store's
    assert.deepEqual(read(KEY('pid').replace('trunc(pid)', 'trunc(qid)')), { guard: undefined, keyCheck: undefined, notNaN: undefined, column: undefined });
    assert.deepEqual(read(released.replaceAll('k', 'pid').replace('9007199254740992', '9007199254740993')),
      { guard: undefined, keyCheck: undefined, notNaN: undefined, column: undefined });
    // the NaN CHECK as the server rewrites it over a bigint is the same refusal; another cast is not
    assert.deepEqual(read('(("postId")::numeric <> \'NaN\'::numeric)'), { guard: 'not-nan', keyCheck: undefined, notNaN: true, column: 'postId' });
    assert.deepEqual(read('(("postId")::integer <> \'NaN\'::numeric)'), { guard: undefined, keyCheck: undefined, notNaN: undefined, column: undefined });
  });
});

describe('the key CHECK, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('names the CHECK of every column holding a key, and clips a name the engine would truncate', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(model(false), { driver: driver() })).close();
      assert.deepEqual(await checks(pool, schema), FRESH.caller);
      const long = 'P'.repeat(40);
      const longModel = { $model: '0.1', entities: { [long]: { schema: { type: 'object', required: ['identifier_of_a_row'], properties: {
        identifier_of_a_row: { type: 'integer', 'x-entity': { key: true } } } } } } };
      const store = await openStore(longModel, { driver: driver() });
      try {
        const names = (await checks(pool, schema)).filter((row) => row.startsWith(`${long}.`) && row.endsWith(': KEY'));
        assert.equal(names.length, 1);
        const name = names[0].slice(long.length + 1, -': KEY'.length);
        assert.ok(name.length <= 63 && name.endsWith('_jaren_key') && name.startsWith('PPPP'), name);
        // and the open reads it as the key's CHECK: the key compares exactly
        assert.match((await store.explain({ $for: { r: `$.${long}[*]` }, $where: { $eq: ['$r.identifier_of_a_row', 6] }, $return: '$r' })).sql,
          /"t0"\."identifier_of_a_row" = \$1/);
      }
      finally { await store.close(); }
    });
  });

  for (const chain of [[false, true], [true, false], [false, true, false], [true, false, true, false]]) {
    it(`leaves every column holding the key with the CHECKs a fresh store gives it, along ${chain.join(' -> ')}`, async () => {
      await withPostgres(async (pg) => {
        const { pool, schema, driver } = pg;
        await (await openStore(model(chain[0]), { driver: driver() })).close();
        await migrateAlong(pg, schema, chain);
        const last = /** @type {boolean} */ (chain.at(-1));
        // gaining, the CHECK the server rewrote over the bigint goes with the key's name; the NaN CHECK it keeps refuses nothing
        assert.deepEqual(await checks(pool, schema), last ? (chain[0] ? FRESH.allocated : FRESH.caller.filter((row) => !row.endsWith('KEY'))
          .map((row) => row.replace(/\((pid|"\w+") <> /, '(($1)::numeric <> '))) : FRESH.caller);
        const store = await openStore(model(last), { driver: driver() });
        try {
          const { report } = await store.introspect();
          assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint' || row.code === 'unguarded-number'), []);
          assert.match((await store.explain({ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', 6] }, $return: '$p.name' })).sql, /"t0"\."pid" = \$1/);
          if (!last) {
            await store.entity('Post').create({ pid: 7, name: 'p7' });
            await store.saveChanges();
            await store.entity('Comment').create({ cid: 'c7', postId: 7 });
            await store.saveChanges();
            for (const [table, column] of HOLDERS) {
              await pool.query(`INSERT INTO "${schema}"."Tag" (tid, doc) VALUES ('t', '{}') ON CONFLICT DO NOTHING; `
                + `INSERT INTO "${schema}"."Post_Tag" ("Post_key", "Tag_key") VALUES (7, 't') ON CONFLICT DO NOTHING`);
              await assert.rejects(pool.query(`UPDATE "${schema}"."${table}" SET "${column}" = ${W} WHERE "${column}" = 7`), { code: '23514' }, `${table}.${column}`);
              await assert.rejects(pool.query(`UPDATE "${schema}"."${table}" SET "${column}" = 'NaN' WHERE "${column}" = 7`), { code: '23514' }, `${table}.${column}`);
            }
          }
        }
        finally { await store.close(); }
        const connection = await driver().open();
        try { assert.deepEqual((await planColumnUpgrade(connection, model(last))).migration.steps, []); }
        finally { await connection.close(); }
      });
    });
  }

  it('names a rebuilt table\'s key CHECK after the table, not the copy it is built as', async () => {
    await withPostgres(async (pg) => {
      const { pool, schema, driver } = pg;
      await (await openStore(model(false), { driver: driver() })).close();
      const enumerated = /** @type {any} */ (model(false));
      // a column with an enum's CHECK added to the table referencing the key, which rebuilds it
      enumerated.entities.Comment.schema.properties.note = { type: 'string', enum: ['a', 'b'] };
      const { migration } = planModelMigration(model(false), enumerated, { dialect: postgresDialect({ schema }), id: 'enum' });
      migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
      assert.ok(migration.steps.some((/** @type {any} */ step) => step.kind === 'rebuild'));
      await migrate({ driver: driver() }, [migration], { baseline: model(false), model: enumerated, shadow: false });
      assert.ok((await checks(pool, schema)).includes('Comment.Comment_postId_jaren_key: KEY'), JSON.stringify(await checks(pool, schema)));
    });
  });

  it('reports the CHECK an earlier release named as the engine did once the server rewrote it, and the upgrade replaces it', async () => {
    await withPostgres(async (pg) => {
      const { pool, schema, driver } = pg;
      await (await openStore(model(false), { driver: driver() })).close();
      // an earlier release's CHECKs carry the engine's names
      for (const [table, column] of HOLDERS)
        await pool.query(`ALTER TABLE "${schema}"."${table}" RENAME CONSTRAINT "${table}_${column}_jaren_key" TO "${table}_${column}_check1"`);
      const connection = await driver().open();
      try { assert.deepEqual((await planColumnUpgrade(connection, model(false))).migration.steps, []); }
      finally { await connection.close(); }
      const applied = await migrateAlong(pg, schema, [false, true, false]);
      // the rewritten one stays beside the CHECK the release gave back
      assert.deepEqual((await checks(pool, schema)).filter((row) => /KEY/.test(row)),
        HOLDERS.flatMap(([table, column]) => [`${table}.${table}_${column}_check1: KEY-REWRITTEN`, `${table}.${table}_${column}_jaren_key: KEY`]));
      const store = await openStore(model(false), { driver: driver() });
      try {
        const { report } = await store.introspect();
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint').map((/** @type {any} */ row) => row.object).sort(),
          HOLDERS.map(([table, column]) => `${table}.${table}_${column}_check1`));
        assert.ok(report.every((/** @type {any} */ row) => row.code !== 'unmapped-constraint' || /rewrote/.test(row.detail)));
      }
      finally { await store.close(); }
      const again = await driver().open();
      try {
        const { migration } = await planColumnUpgrade(again, model(false));
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql),
          ['ALTER TABLE "Post" DROP CONSTRAINT "Post_pid_check1"', 'ALTER TABLE "Comment" DROP CONSTRAINT "Comment_postId_check1"',
            'ALTER TABLE "Post_Tag" DROP CONSTRAINT "Post_Tag_Post_key_check1"']);
        await migrate({ driver: driver() }, [...applied, migration], { baseline: model(false), model: model(false), shadow: false });
        assert.deepEqual((await planColumnUpgrade(again, model(false))).migration.steps, []);
      }
      finally { await again.close(); }
      assert.deepEqual(await checks(pool, schema), FRESH.caller);
    });
  });

  it('replaces a rewritten CHECK the key holds alone, and reads the key by the interval until it does', async () => {
    await withPostgres(async (pg) => {
      const { pool, schema, driver } = pg;
      await (await openStore(model(false), { driver: driver() })).close();
      await pool.query(`ALTER TABLE "${schema}"."Post" DROP CONSTRAINT "Post_pid_jaren_key"; `
        + `ALTER TABLE "${schema}"."Post" ADD CONSTRAINT "Post_pid_check1" CHECK (${KEY('pid').replace('(pid = trunc(pid))', '((pid)::double precision = trunc((pid)::double precision))')})`);
      const store = await openStore(model(false), { driver: driver() });
      try { assert.match((await store.explain({ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', 6] }, $return: '$p.name' })).sql, /"t0"\."pid" >= \$1 AND "t0"\."pid" <= \$2/); }
      finally { await store.close(); }
      const connection = await driver().open();
      try {
        const { migration } = await planColumnUpgrade(connection, model(false));
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), ['ALTER TABLE "Post" DROP CONSTRAINT "Post_pid_check1"',
          `ALTER TABLE "Post" ADD CONSTRAINT "Post_pid_jaren_key" CHECK (${postgresDialect().keyCheck('"pid"')})`]);
      }
      finally { await connection.close(); }
    });
  });

  it('compares a key past 2^53 in an external list by its double\'s interval, under the CHECK', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model(false), { driver: driver() });
      try {
        await store.entity('Post').create({ pid: 1, name: 'p1' });
        await store.saveChanges();
        // another writer spells 2^60 by its exact digits, which JavaScript writes 1152921504606847000
        await pool.query(`INSERT INTO "${schema}"."Post" (pid, name, doc) VALUES (1152921504606846976, 'big', '{}')`);
        const query = { $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', '$ids[*]'] }, $orderby: ['$p.name'], $return: '$p.name' };
        for (const ids of [[2 ** 60], [1, 2 ** 60]]) {
          assert.equal((await store.explain(query, { externals: { ids } })).mode, 'native');
          assert.deepEqual(await store.execute(query, { externals: { ids } }), await store.execute(query, { externals: { ids }, pushdown: false }));
        }
        assert.deepEqual(await store.execute(query, { externals: { ids: [1, 2 ** 60] } }), ['big', 'p1']);
      }
      finally { await store.close(); }
    });
  });
});
