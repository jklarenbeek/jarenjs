//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sql, planRelational, relational } from '@jarenjs/db/relational';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

describe('PostgreSQL structural SQL strategy', () => {
  const options = { dialect: postgresDialect() };
  it('shares parameter ordering and uses native NULL, boolean and offset forms', () => {
    const plan = planRelational({ from: 'items', columns: { id: sql.column('id') },
      where: sql.binary('IS NOT', sql.column('label'), sql.param('absent')), offset: 2 },
    { ...options, externals: { absent: null } });
    assert.equal(plan.sql, 'SELECT "id" AS "id" FROM "items" WHERE ("label" IS DISTINCT FROM $1) OFFSET 2');
    assert.deepEqual(plan.params, [null]);
    const empty = planRelational({ columns: { none: sql.in(sql.value(99), []), all: sql.in(sql.value(99), [], true) } }, options);
    assert.deepEqual(empty.params, []);
    assert.equal(empty.sql, 'SELECT FALSE AS "none", TRUE AS "all"');
    assert.equal(planRelational({ columns: { n: sql.call('count', []) } }, options).sql, 'SELECT pg_catalog.count(*) AS "n"');
    assert.equal(planRelational({ columns: { x: sql.cast(sql.value('9007199254740993'), 'BIGINT') } }, options).sql,
      'SELECT CAST($1 AS BIGINT) AS "x"');
  });
  it('refuses SQLite-only vocabulary and ambiguous ignore/conflict policy', () => {
    for (const value of [sql.binary('GLOB', 'a', '*'), sql.call('json_extract', ['{}', '$.a']), sql.collate('a', 'NOCASE'), sql.cast('00', 'BLOB')])
      assert.throws(() => planRelational({ columns: { value } }, options), { code: 'JD0038' });
    assert.throws(() => planRelational({ op: 'insert', table: 'items', values: { id: 1 }, ignore: true,
      conflict: { action: 'nothing' } }, options), /cannot be combined/);
    assert.equal(planRelational({ op: 'insert', table: 'items', values: { id: 1 }, ignore: true }, options).sql,
      'INSERT INTO "items" ("id") VALUES ($1) ON CONFLICT DO NOTHING');
    assert.equal(planRelational({ op: 'update', table: 'items', set: { value: 'a' },
      where: true, reporting: 'changed' }, options).sql,
    'UPDATE "items" SET "value" = $1 WHERE $2 AND ("value" IS DISTINCT FROM $3)');
  });
});

const url = process.env.JAREN_PG_URL;
describe('PostgreSQL native relational execution', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('executes native statements, holds a cursor lease, rolls back scopes and disposes without closing the host', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const schema = `jaren_relational_${process.pid}`;
    let connection, engine;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      connection = await postgresDriver(pool, { schema, windowRows: 2 }).open();
      await connection.exec('CREATE TABLE items(id integer PRIMARY KEY, enabled boolean, label text, amount numeric)');
      engine = relational(connection);
      const put = (id) => ({ op: 'insert', table: 'items', values: { id, enabled: true, label: `label${id}`, amount: '9007199254740993.00100' } });
      assert.equal((await engine.execute(put(1))).affected, 1);
      assert.equal((await engine.execute({ ...put(1), ignore: true })).affected, 0);
      assert.deepEqual(await engine.get({ from: 'items', columns: { id: sql.column('id'), exact: sql.cast(sql.column('amount'), 'TEXT') } }),
        { id: 1, exact: '9007199254740993.00100' });
      assert.equal((await engine.execute({ op: 'update', table: 'items', set: { label: 'label1' }, where: true, reporting: 'changed' })).affected, 0);
      assert.equal((await engine.execute({ op: 'update', table: 'items', set: { label: 'label1' }, where: true, reporting: 'matched' })).affected, 1);
      await assert.rejects(connection.transaction(async (scope) => {
        await relational(scope).execute(put(2));
        throw new Error('undo');
      }), /undo/);
      assert.equal((await engine.all({ from: 'items', columns: { id: sql.column('id') } })).length, 1);
      const cursor = engine.iterate({ from: 'items', columns: { id: sql.column('id') } });
      assert.deepEqual(await cursor.next(), { done: false, value: { id: 1 } });
      let wrote = false;
      const pending = engine.execute(put(3)).then((value) => { wrote = true; return value; });
      await delay(10);
      assert.equal(wrote, false);
      await cursor.return();
      assert.equal((await pending).affected, 1);
      const controller = new AbortController();
      const aborted = engine.iterate({ from: 'items', columns: { id: sql.column('id') } }, { signal: controller.signal });
      for await (const row of aborted) { assert.equal(row.id, 1); break; }
      const disposed = engine.iterate({ from: 'items', columns: { id: sql.column('id') } });
      await disposed.next();
      await engine.dispose();
      await engine.dispose();
      assert.throws(() => engine.get({ from: 'items' }), /disposed/);
      assert.equal((await (await connection.prepare('SELECT count(*)::int AS n FROM items')).get()).n, 2);
    }
    finally { await engine?.dispose(); await connection?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });
});
