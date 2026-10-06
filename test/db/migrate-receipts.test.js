//@ts-check
/** Every receipt field agrees before admission and again under the writer lock. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { migrate, migrationStatus, shapeHash } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { chain, useStatementOnce } from '../../packages/db/src/driver.js';

const native = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver
  : (await import('@jarenjs/db/node')).nodeDriver;
const baseline = { $model: '0.1', collections: {} };
const document = (id, steps = []) => ({ $migration: '0.2', identity: migrationIdentity(baseline), id,
  from: shapeHash(baseline), to: shapeHash(baseline), steps });
const initial = document('applied', [
  { kind: 'sql', sql: 'CREATE TABLE witness(n INTEGER)' },
  { kind: 'sql', sql: 'INSERT INTO witness VALUES(0)' },
]);
const tail = document('tail', [{ kind: 'sql', sql: 'UPDATE witness SET n=n+1' }]);
const options = { baseline, shadow: false };
const all = (connection, sql) => useStatementOnce(connection, sql, (statement) => statement.all([]));
const change = (connection, field, value) => useStatementOnce(connection,
  `UPDATE _jaren_migrations SET ${field}=${connection.dialect.parameterRef(1, 'v')}`,
  (statement) => statement.run([value]));
let fixtureNumber = 0;

async function fixture(host, run, documents = [initial]) {
  let pool, schema, connection;
  try {
    let driver = native();
    if (host === 'postgres') {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 2 });
      schema = `jaren_receipts_${process.pid}_${fixtureNumber++}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      driver = postgresDriver(pool, { schema });
    }
    connection = await driver.open(':memory:');
    await migrate({ connection }, documents, options);
    await run(connection, pool === undefined ? null : () => pool.query(`SELECT * FROM "${schema}"._jaren_migrations ORDER BY rid`));
  }
  finally {
    await connection?.close();
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
}

/** Change only returned history rows, as an injected binding may represent them. */
function reportedSteps(connection, value) {
  const wrap = (scope) => ({ ...scope,
    prepare(sql, metadata) {
      return chain(scope.prepare(sql, metadata), (statement) => /FROM "_jaren_migrations"/.test(sql)
        ? { ...statement, all(params) {
          return chain(statement.all(params), (rows) => rows.map((row) => ({ ...row, steps: value })));
        } } : statement);
    },
    transaction: (fn, ...args) => scope.transaction((child) => fn(wrap(child)), ...args),
  });
  return { ...wrap(connection), ...(connection.exclusively === undefined ? {} : {
    exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args),
  }) };
}

for (const host of ['sqlite', 'postgres']) describe(`${host}: complete migration receipt agreement`,
  { skip: host === 'postgres' && !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
    for (const [field, value] of [['from_hash', 'invented-origin'], ['to_hash', 'invented-endpoint'],
      ['steps', 99], ['steps', null]]) for (const surface of ['status', 'repeat', 'tail'])
      it(`${surface} refuses altered ${field}=${String(value)} before any write`, async () => {
        await fixture(host, async (connection) => {
          await change(connection, field, value);
          const before = await all(connection, 'SELECT * FROM _jaren_migrations');
          const run = () => surface === 'status' ? migrationStatus({ connection }, [initial])
            : migrate({ connection }, surface === 'repeat' ? [initial]
              : [initial, tail], options);
          await assert.rejects(async () => run(), { code: 'JD0022' });
          assert.deepEqual(await all(connection, 'SELECT * FROM _jaren_migrations'), before);
          assert.deepEqual((await all(connection, 'SELECT n FROM witness')).map((row) => row.n), [0]);
        });
      });

    for (const [field, value] of [['from_hash', 'changed-under-lock'], ['to_hash', 'changed-under-lock'], ['steps', 99]])
      it(`writer admission rechecks ${field} before a pending link`, async () => {
        await fixture(host, async (connection) => {
          const before = await all(connection, 'SELECT * FROM _jaren_migrations');
          let injected = false;
          const wrap = (scope) => ({ ...scope, transaction(fn, ...args) {
            return scope.transaction((child) => {
              if (injected) return fn(wrap(child));
              injected = true;
              return chain(change(child, field, value), () => fn(wrap(child)));
            }, ...args);
          } });
          const wrapped = { ...wrap(connection), ...(connection.exclusively === undefined ? {} : {
            exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args),
          }) };
          await assert.rejects(async () => migrate({ connection: wrapped }, [initial, tail], options), { code: 'JD0022' });
          assert.equal(injected, true, 'the initial read saw valid history; disagreement occurs after writer admission');
          assert.deepEqual(await all(connection, 'SELECT * FROM _jaren_migrations'), before, 'the admitted transaction rolls back');
          assert.deepEqual((await all(connection, 'SELECT n FROM witness')).map((row) => row.n), [0]);
        });
      });

    it('valid repeats preserve every raw history field, and missing/reordered ids still refuse', async () => {
      const docs = [initial, document('second')];
      await fixture(host, async (connection, rawRows) => {
        const before = await all(connection, 'SELECT * FROM _jaren_migrations');
        const rawBefore = rawRows === null ? null : (await rawRows()).rows;
        const status = migrationStatus({ connection }, docs);
        const again = migrate({ connection }, docs, options);
        if (host === 'sqlite') {
          assert.equal(status?.then, undefined); assert.equal(again?.then, undefined);
        }
        assert.equal((await status).upToDate, true);
        assert.deepEqual(await again, { applied: [], skipped: ['applied', 'second'], upToDate: true });
        for (const changed of [[], [docs[1], docs[0]], [docs[0]]]) {
          await assert.rejects(async () => migrationStatus({ connection }, changed), { code: 'JD0022' });
          await assert.rejects(async () => migrate({ connection }, changed, options), { code: 'JD0022' });
        }
        assert.deepEqual(await all(connection, 'SELECT * FROM _jaren_migrations'), before);
        if (rawRows !== null) assert.deepEqual((await rawRows()).rows, rawBefore, 'native PG integer strings are not rewritten');
      }, docs);
    });
  });

for (const value of [undefined, null, '', ' ', false, 'not-a-count', -1, 0.5, Infinity, NaN])
  it(`an injected history cannot coerce invalid steps ${String(value)} into zero`, async () => {
    const doc = document('anchor');
    await fixture('sqlite', async (connection) => {
      const wrapped = reportedSteps(connection, value);
      assert.throws(() => migrationStatus({ connection: wrapped }, [doc]), { code: 'JD0022' });
      assert.throws(() => migrate({ connection: wrapped }, [doc], options), { code: 'JD0022' });
    }, [doc]);
  });

for (const value of [2, '2']) it(`lossless history projections require text, received ${typeof value}`, async () => {
  await fixture('sqlite', async (connection) => {
    const before = await all(connection, 'SELECT * FROM _jaren_migrations');
    const wrapped = reportedSteps(connection, value);
    if (typeof value === 'string') {
      assert.equal(migrationStatus({ connection: wrapped }, [initial]).upToDate, true);
      assert.equal(migrate({ connection: wrapped }, [initial], options).upToDate, true);
    }
    else {
      assert.throws(() => migrationStatus({ connection: wrapped }, [initial]), { code: 'JD0022' });
      assert.throws(() => migrate({ connection: wrapped }, [initial], options), { code: 'JD0022' });
    }
    assert.deepEqual(await all(connection, 'SELECT * FROM _jaren_migrations'), before);
  });
});
