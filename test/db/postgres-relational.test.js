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
    for (const value of [sql.binary('GLOB', 'a', '*'), sql.call('json_extract', ['{}', '$.a']), sql.call('instr', ['a', 'b']), sql.collate('a', 'NOCASE'), sql.cast('00', 'BLOB')])
      assert.throws(() => planRelational({ columns: { value } }, options), { code: 'JD0038' });
    assert.throws(() => planRelational({ op: 'insert', table: 'items', values: { id: 1 }, ignore: true,
      conflict: { action: 'nothing' } }, options), /cannot be combined/);
    assert.equal(planRelational({ op: 'insert', table: 'items', values: { id: 1 }, ignore: true }, options).sql,
      'INSERT INTO "items" ("id") VALUES ($1) ON CONFLICT DO NOTHING');
    assert.equal(planRelational({ op: 'update', table: 'items', set: { value: 'a' },
      where: true, reporting: 'changed' }, options).sql,
    'UPDATE "items" SET "value" = $1 WHERE $2 AND ("value" IS DISTINCT FROM $3)');
  });
  it('nests AND/OR operands, writes LIKE with an ESCAPE and spells the literal substring test natively', () => {
    const t = sql.column('title');
    assert.deepEqual(planRelational({ columns: { v: sql.binary('OR', 1, 2, 3, 4) } }, options),
      { sql: 'SELECT ((($1 OR $2) OR $3) OR $4) AS "v"', params: [1, 2, 3, 4], access: 'read' });
    assert.deepEqual(planRelational({ columns: { v: sql.like(t, '%100!%%', { escape: '!', negate: true }) } }, options),
      { sql: 'SELECT ("title" NOT LIKE $1 ESCAPE $2) AS "v"', params: ['%100!%%', '!'], access: 'read' });
    // the store's own substring predicate; folded, both sides are lowered under "C", which folds ASCII letters only
    assert.equal(planRelational({ columns: { v: sql.contains(t, 'x') } }, options).sql, 'SELECT (strpos("title", $1::text) > 0) AS "v"');
    assert.equal(planRelational({ columns: { v: sql.contains(t, 'x', { caseInsensitive: true }) } }, options).sql,
      'SELECT (strpos(pg_catalog.lower(("title" COLLATE "C")), pg_catalog.lower(($1 COLLATE "C"))::text) > 0) AS "v"');
    assert.equal(planRelational({ columns: { v: sql.call('strpos', [t, 'x']) } }, options).sql, 'SELECT pg_catalog.strpos("title", $1) AS "v"');
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
  it('matches a literal substring as text and keeps every AND/OR operand, as PostgreSQL itself reads them', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const schema = `jaren_relational_text_${process.pid}`;
    /** @type {any} */
    let connection;
    try {
      // `folded` takes a Unicode-aware collation where the server has one: `lower` alone folds `É` there
      const icu = (await pool.query("SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu'")).rowCount === 1;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      connection = await postgresDriver(pool, { schema }).open();
      await connection.exec(`CREATE TABLE t(n integer PRIMARY KEY, title text, folded text${icu ? ' COLLATE "und-x-icu"' : ''})`);
      const engine = relational(connection);
      const TITLES = ['a 100% b', 'a 1000 b', 'x100_y', 'a_b', 'aXb', 'A_B', 'Éa_b', 'éA_B'];
      for (const [n, title] of [...TITLES, null].entries()) await engine.execute({ op: 'insert', table: 't', values: { n, title, folded: title } });
      const t = sql.column('title');
      const rows = async (/** @type {any} */ where) =>
        (await engine.all({ from: 't', columns: { title: t }, where, orderBy: [{ by: sql.column('n') }] })).map((row) => row.title);
      assert.deepEqual(await rows(sql.contains(t, '100%')), ['a 100% b']);
      assert.deepEqual(await rows(sql.contains(t, 'a_b')), ['a_b', 'Éa_b']);
      assert.deepEqual(await rows(sql.contains(t, 'a_b', { caseInsensitive: true })), ['a_b', 'A_B', 'Éa_b', 'éA_B']);
      for (const column of ['title', 'folded'])
        assert.deepEqual(await rows(sql.contains(sql.column(column), 'éa', { caseInsensitive: true })), ['éA_B'], `only ASCII letters fold (${column})`);
      if (icu) assert.deepEqual(await rows(sql.contains(sql.call('lower', [sql.column('folded')]), 'éa')), ['Éa_b', 'éA_B'], 'the column\'s own lower folds É');
      // the oracle: a substring as JavaScript reads one, ASCII letters folded on request
      const ascii = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
      for (const needle of ['', '%', '_', '100%', '%%', 'a_b', 'A_B', 'X', 'é', 'É', ' 1000 ', 'a 100% b!'])
        for (const caseInsensitive of [false, true])
          assert.deepEqual(await rows(sql.contains(t, needle, { caseInsensitive })),
            TITLES.filter((title) => (caseInsensitive ? ascii(title).includes(ascii(needle)) : title.includes(needle))), `'${needle}' ${caseInsensitive}`);
      // PostgreSQL's LIKE folds no case, and a pattern ending in its escape is the server's error
      assert.deepEqual(await rows(sql.like(t, '%100!%%', { escape: '!' })), ['a 100% b']);
      assert.deepEqual(await rows(sql.like(t, '%a!_b%', { escape: '!' })), ['a_b', 'Éa_b']);
      await assert.rejects(rows(sql.like(t, '%a!', { escape: '!' })),
        (/** @type {any} */ error) => error.code === 'JD2005' && /must not end with escape character/.test(error.message));
      assert.equal((await engine.get({ columns: { at: sql.call('strpos', ['a 100% b', '100%']) } }))?.at, 3);
      // the builder, the node nested by hand and PostgreSQL's own reading of the flat predicate agree
      const key = (/** @type {any} */ value) => sql.binary('=', t, value);
      const native = async (/** @type {string} */ where) =>
        (await (await connection.prepare(`SELECT title FROM t WHERE ${where} ORDER BY n`)).all()).map((/** @type {any} */ row) => row.title);
      for (const [built, nested, text] of /** @type {[any, any, string][]} */ ([
        [sql.binary('AND', key('a_b'), key('a_b'), key('zzz')), sql.binary('AND', sql.binary('AND', key('a_b'), key('a_b')), key('zzz')), "title = 'a_b' AND title = 'a_b' AND title = 'zzz'"],
        [sql.binary('OR', key('zz'), key('a_b'), key('yy'), key('aXb')), sql.binary('OR', sql.binary('OR', sql.binary('OR', key('zz'), key('a_b')), key('yy')), key('aXb')),
          "title = 'zz' OR title = 'a_b' OR title = 'yy' OR title = 'aXb'"],
      ])) {
        assert.deepEqual(await rows(built), await rows(nested), text);
        assert.deepEqual(await rows(built), await native(text), text);
      }
      for (const op of /** @type {const} */ (['AND', 'OR'])) for (const x of [true, false, null]) for (const y of [true, false, null]) for (const z of [true, false, null]) {
        const own = await (await connection.prepare(`SELECT ($1::boolean ${op} $2::boolean ${op} $3::boolean) AS v`)).get([x, y, z]);
        assert.equal((await engine.get({ columns: { v: sql.binary(op, x, y, z) } }))?.v, own.v, `${x} ${op} ${y} ${op} ${z}`);
      }
    }
    finally { await connection?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });
});
