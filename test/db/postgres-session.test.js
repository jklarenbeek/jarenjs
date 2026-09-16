//@ts-check
/** Real pooled-session failures, independent of the managed Store oracle. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDriver } from '@jarenjs/db/postgres';
import { classifyDriverError } from '@jarenjs/db';

const url = process.env.JAREN_PG_URL;
describe('PostgreSQL session ownership', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let admin, pool, pg;
  const schema = `jaren_session_${process.pid}`;
  const role = `jaren_session_role_${process.pid}`;
  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE ROLE "${role}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      finally { await admin.end(); }
    }
  });
  it('restores the exact path before reborrow, also after missing or inaccessible schema open', async () => {
    const original = '"$user", "public", pg_catalog';
    await pool.query("SELECT set_config('search_path', $1, false)", [original]);
    for (let i = 0; i < 2; i++) {
      const connection = await postgresDriver(pool, { schema }).open();
      assert.equal((await (await connection.prepare('SHOW search_path')).get()).search_path, `"${schema}", pg_temp`);
      await connection.close();
      await connection.close();
      assert.equal((await pool.query('SHOW search_path')).rows[0].search_path, original);
      assert.equal(pool.idleCount, 1);
    }
    await assert.rejects(postgresDriver(pool, { schema: `${schema}_missing` }).open(),
      (e) => e.code === 'JD2005' && e.class === 'cantopen' && e.cause.code === '3F000');
    await pool.query(`SET ROLE "${role}"`);
    try {
      await assert.rejects(postgresDriver(pool, { schema }).open(),
        (e) => e.code === 'JD2083' && e.class === 'readonly' && e.cause.code === '42501');
      assert.equal((await pool.query('SHOW search_path')).rows[0].search_path, original);
    }
    finally { await pool.query('RESET ROLE'); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',
      [`${schema}_missing`])).rows[0].n, 0);
  });
  it('preserves named buffered cached-plan refusal in blocks and nested savepoints, then recovers after rollback', async () => {
    const connection = await postgresDriver(pool, { schema, cursorMode: 'buffered' }).open();
    try {
      await connection.exec('CREATE TABLE cached (id integer)');
      const statement = await connection.prepare('SELECT * FROM cached');
      await statement.all();
      await assert.rejects(connection.transaction(async (tx) => {
        await tx.exec('ALTER TABLE cached ADD COLUMN label text');
        await statement.all();
      }), (error) => error.code === '0A000' && error.routine === 'RevalidateCachedQuery'
        && classifyDriverError(error).code === 'JD2005');
      assert.deepEqual(await statement.all(), []);
      await connection.transaction(async (tx) => {
        await assert.rejects(tx.transaction(async (nested) => {
          await nested.exec('ALTER TABLE cached ADD COLUMN label text');
          await statement.all();
        }), (error) => error.code === '0A000');
        await tx.exec('INSERT INTO cached VALUES (1)');
      });
      assert.deepEqual(await statement.all(), [{ id: 1 }]);
      await connection.exec('ALTER TABLE cached ADD COLUMN label text');
      assert.deepEqual(await statement.all(), [{ id: 1, label: null }]);
    }
    finally { await connection.close(); }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name LIKE 'jaren_s%'")).rows[0].n, 0);
  });
  it('does not replay a function-raised feature error after a nontransactional sequence effect', async () => {
    const connection = await postgresDriver(pool, { schema }).open();
    try {
      await connection.exec('CREATE SEQUENCE effect_seq');
      await connection.exec(`CREATE FUNCTION fail_feature() RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('effect_seq');
        RAISE EXCEPTION 'cached plan must not change result type' USING ERRCODE = '0A000'; END $$`);
      await assert.rejects((await connection.prepare('SELECT fail_feature()')).get(), (e) => e.code === '0A000');
      assert.equal((await (await connection.prepare('SELECT last_value::int AS n FROM effect_seq')).get()).n, 1);
    }
    finally { await connection.close(); }
  });
  it('restores after capability probe failure and discards when restoration itself fails', async () => {
    const original = (await pool.query('SHOW search_path')).rows[0].search_path;
    const source = { connect: async () => {
      const client = await pool.connect();
      return { release: (error) => client.release(error), query: (query, values) => {
        if ((typeof query === 'string' ? query : query.text).includes('server_version_num'))
          return Promise.resolve({ rows: [{ num: '150000', version: '15' }] });
        return client.query(query, values);
      } };
    } };
    await assert.rejects(postgresDriver(source, { schema }).open(), (e) => e.code === 'JD0001');
    assert.equal((await pool.query('SHOW search_path')).rows[0].search_path, original);
    const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let restores = 0;
    const broken = { connect: async () => {
      const client = await pool.connect();
      return { release: (error) => client.release(error), query: (query, values) => {
        if ((typeof query === 'string' ? query : query.text).includes("set_config('search_path'") && ++restores === 2)
          throw new Error('restore failed');
        return client.query(query, values);
      } };
    } };
    const connection = await postgresDriver(broken, { schema }).open();
    await assert.rejects(connection.close(), /restore failed/);
    assert.notEqual((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
  });
  it('leaves caller JSON parsers unchanged across acquisition and release', async () => {
    const custom = new pg.Pool({ connectionString: url, max: 1,
      types: { getTypeParser: (oid, format) => oid === 3802 ? (text) => JSON.parse(text) : pg.types.getTypeParser(oid, format) } });
    try {
      const connection = await postgresDriver(custom, { schema }).open();
      assert.equal((await (await connection.prepare(`SELECT '{"n":1}'::jsonb AS doc`)).get()).doc, '{"n":1}');
      await connection.close();
      assert.deepEqual((await custom.query(`SELECT '{"n":1}'::jsonb AS doc`)).rows[0].doc, { n: 1 });
    }
    finally { await custom.end(); }
  });
});
