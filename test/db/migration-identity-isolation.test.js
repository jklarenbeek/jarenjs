//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { postgresDriver } from '@jarenjs/db/postgres';
import { migrate, migrationHistory, adoptMigrationHistory, createModelShape } from '../../packages/db/src/migrate.js';
import { chain } from '../../packages/db/src/driver.js';
import { EMPTY, hosts, document, legacy, fixture, all, seedLegacy, rejected } from './migration-identity-helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const first = document('first', [{ kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' }]);
const other = document('other', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('other')" }]);
const mine = document('mine', [{ kind: 'host', run: 'notice', version: '1' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('mine')" }]);

function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Wait for the actual server admission state, never an assumed delay. */
async function advisoryWaiter(pool, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT granted FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1246907982", [pid]);
    if (result.rows.some((row) => row.granted === false)) return;
    await yieldTurn();
  }
  assert.fail('the caller never became a blocked migration-lock waiter');
}

if (hosts.includes('postgres')) {
  for (const atomic of [false, true]) for (const isolation of ['read committed', 'repeatable read', 'serializable'])
    it(`postgres: borrowed ${isolation}, ${atomic ? 'atomic' : 'link'} migration refuses a competing branch before callbacks`, async () => {
      await fixture('postgres', async (connection, context) => {
        await migrate({ connection }, [first], { baseline: EMPTY, shadow: false });
        const contender = await context.driver.open();
        let called = 0, registered = 0;
        try {
          await assert.rejects(() => connection.transaction(async (scope) => {
            assert.deepEqual((await all(scope, 'SELECT id FROM _jaren_migrations ORDER BY rid')).map((row) => row.id), ['first']);
            await migrate({ connection: contender }, [first, other], { baseline: EMPTY, shadow: false });
            return migrate({ connection: scope }, [first, mine], {
              baseline: EMPTY, shadow: false, atomic,
              registerFunctions() { registered++; },
              hosts: { notice: { version: '1', run() { called++; } } },
            });
          }, undefined, 'deferred', { isolation }), { code: isolation === 'read committed' ? 'JD0022' : 'JD0021' });
          assert.equal(called, 0);
          assert.equal(registered, isolation === 'read committed' ? 1 : 0);
          assert.deepEqual((await migrationHistory({ connection })).history.rows.map((row) => row.id), ['first', 'other']);
          assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['other']);
          assert.equal((await all(connection, "SELECT current_setting('transaction_isolation') AS isolation"))[0].isolation, 'read committed');
        }
        finally { await contender.close(); }
      });
    });

  for (const atomic of [false, true]) for (const isolation of ['repeatable read', 'serializable'])
    it(`postgres: owned ${isolation} default refuses ${atomic ? 'atomic' : 'link'} work without lowering isolation`, async () => {
      await fixture('postgres', async (connection, context) => {
        await migrate({ connection }, [first], { baseline: EMPTY, shadow: false });
        let called = 0, registered = 0, releasedIsolation;
        const source = { async connect() {
          const client = await context.pool.connect();
          await client.query(`SET default_transaction_isolation='${isolation}'`);
          const release = client.release.bind(client);
          return { query: client.query.bind(client),
            async release(discard) {
              releasedIsolation = (await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0].isolation;
              release(discard);
            } };
        } };
        const driver = postgresDriver(source, { schema: context.schema, lockTimeoutMs: 5000 });
        await rejected(() => migrate({ driver }, [first, mine], {
          baseline: EMPTY, shadow: false, atomic,
          registerFunctions() { registered++; }, hosts: { notice: { version: '1', run() { called++; } } },
        }), 'JD0021');
        assert.equal(called, 0);
        assert.equal(registered, 0);
        assert.equal(releasedIsolation, isolation);
        assert.deepEqual((await migrationHistory({ connection })).history.rows.map((row) => row.id), ['first']);
      });
    });

  for (const isolation of ['repeatable read', 'serializable'])
    it(`postgres: read-only observation retains a borrowed ${isolation} view but adoption refuses it`, async () => {
      await fixture('postgres', async (connection) => {
        await createModelShape(connection, MODEL);
        const old = legacy('legacy', [], MODEL);
        await seedLegacy(connection, [old]);
        const observed = await migrationHistory({ connection });
        let registered = 0;
        await assert.rejects(() => connection.transaction(async (scope) => {
          assert.deepEqual(await migrationHistory({ connection: scope }), observed);
          await rejected(() => adoptMigrationHistory({ connection: scope }, [old], {
            observed, model: MODEL, registerFunctions() { registered++; },
          }), 'JD0021');
          assert.equal((await all(scope, "SELECT current_setting('transaction_isolation') AS isolation"))[0].isolation, isolation);
          throw new Error('caller controls its transaction');
        }, undefined, 'deferred', { isolation }), /caller controls/);
        assert.equal(registered, 0);
        assert.deepEqual(await migrationHistory({ connection }), observed);
      });
    });

  for (const atomic of [false, true])
    it(`postgres: a blocked READ COMMITTED ${atomic ? 'atomic' : 'link'} writer reobserves the committed branch`, async () => {
      await fixture('postgres', async (connection, context) => {
        await migrate({ connection }, [first], { baseline: EMPTY, shadow: false });
        const contender = await context.driver.open();
        const entered = latch(), release = latch();
        const blocking = document('other', [{ kind: 'host', run: 'hold', version: '1' }, ...other.steps]);
        let called = 0, holding, waiting;
        try {
          holding = migrate({ connection: contender }, [first, blocking], {
            baseline: EMPTY, shadow: false,
            hosts: { hold: { version: '1', run() { entered.resolve(); return release.promise; } } },
          });
          await entered.promise;
          const pid = (await all(connection, 'SELECT pg_backend_pid() AS pid'))[0].pid;
          waiting = migrate({ connection }, [first, mine], {
            baseline: EMPTY, shadow: false, atomic,
            hosts: { notice: { version: '1', run() { called++; } } },
          });
          const refused = rejected(() => waiting, 'JD0022');
          await advisoryWaiter(context.pool, pid);
          release.resolve();
          await holding;
          await refused;
          assert.equal(called, 0);
          assert.deepEqual((await migrationHistory({ connection })).history.rows.map((row) => row.id), ['first', 'other']);
          assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['other']);
        }
        finally {
          release.resolve();
          await Promise.allSettled([holding, waiting]);
          await contender.close();
        }
      });
    });

  for (const changed of [false, true]) it(`postgres: ${changed ? 'different' : 'identical'} blocked attestations preserve original history`, async () => {
    await fixture('postgres', async (connection, context) => {
      await createModelShape(connection, MODEL);
      const old = legacy('legacy', [], MODEL);
      await seedLegacy(connection, [old]);
      const observed = await migrationHistory({ connection });
      const contender = await context.driver.open();
      const inserted = latch(), release = latch();
      let held = false, adopting, competing;
      const wrap = (scope) => ({ ...scope,
        prepare(sql, metadata) {
          return chain(scope.prepare(sql, metadata), (statement) => sql.startsWith('INSERT INTO "_jaren_migration_identity"')
            ? { ...statement, run: (params) => chain(statement.run(params), (result) => {
              if (held) return result;
              held = true;
              inserted.resolve();
              return release.promise.then(() => result);
            }) } : statement);
        },
        transaction: (fn, ...args) => scope.transaction((child) => fn(wrap(child)), ...args),
      });
      const wrapped = { ...wrap(connection), exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args) };
      try {
        adopting = adoptMigrationHistory({ connection: wrapped }, [old], { observed, model: MODEL });
        await inserted.promise;
        const pid = (await all(contender, 'SELECT pg_backend_pid() AS pid'))[0].pid;
        competing = adoptMigrationHistory({ connection: contender }, [old], { observed,
          model: changed ? { collections: MODEL.collections, $model: '0.1' } : MODEL });
        const competingResult = changed ? rejected(() => competing, 'JD0022') : competing;
        await advisoryWaiter(context.pool, pid);
        release.resolve();
        assert.deepEqual(await adopting, { adopted: 1, unchanged: 0 });
        if (changed) await competingResult;
        else assert.deepEqual(await competingResult, { adopted: 0, unchanged: 1 });
        assert.deepEqual((await migrationHistory({ connection })).history, observed.history);
      }
      finally {
        release.resolve();
        await Promise.allSettled([adopting, competing]);
        await contender.close();
      }
    });
  });
}

if (hosts.includes('postgres')) {
  it('postgres: effective isolation is checked again after registration and inside the writer transaction', async () => {
    await fixture('postgres', async (connection) => {
      await migrate({ connection }, [first], { baseline: EMPTY, shadow: false });
      let called = 0;
      try {
        await rejected(() => migrate({ connection }, [first, mine], {
          baseline: EMPTY, shadow: false,
          registerFunctions: () => connection.exec("SET default_transaction_isolation='repeatable read'"),
          hosts: { notice: { version: '1', run() { called++; } } },
        }), 'JD0021');
        assert.equal(called, 0);
        assert.equal((await all(connection, "SELECT current_setting('transaction_isolation') AS isolation"))[0].isolation, 'repeatable read');
        assert.deepEqual((await migrationHistory({ connection })).history.rows.map((row) => row.id), ['first']);
      }
      finally { await connection.exec("SET default_transaction_isolation='read committed'"); }
    });
  });

  for (const atomic of [false, true]) for (const control of ['signal', 'deadline'])
    it(`postgres: ${control} while waiting for ${atomic ? 'atomic' : 'link'} migration admission runs no host or SQL`, async () => {
    await fixture('postgres', async (connection, context) => {
      await migrate({ connection }, [first], { baseline: EMPTY, shadow: false });
      const contender = await context.driver.open();
      const entered = latch(), release = latch();
      const blocking = document('other', [{ kind: 'host', run: 'hold', version: '1' }, ...other.steps]);
      const controller = new AbortController();
      let called = 0, holding, waiting, now = 0;
      try {
        holding = migrate({ connection: contender }, [first, blocking], {
          baseline: EMPTY, shadow: false,
          hosts: { hold: { version: '1', run() { entered.resolve(); return release.promise; } } },
        });
        await entered.promise;
        const pid = (await all(connection, 'SELECT pg_backend_pid() AS pid'))[0].pid;
        waiting = migrate({ connection }, [first, mine], {
          baseline: EMPTY, shadow: false, atomic, signal: controller.signal,
          ...(control === 'deadline' ? { deadline: 1000, runtime: { now: () => now } } : {}),
          hosts: { notice: { version: '1', run() { called++; } } },
        });
        const refused = rejected(() => waiting, control === 'signal' ? 'JD2080' : 'JD2075');
        await advisoryWaiter(context.pool, pid);
        if (control === 'signal') controller.abort();
        else now = 2000;
        release.resolve();
        await holding;
        await refused;
        assert.equal(called, 0);
        assert.deepEqual((await migrationHistory({ connection })).history.rows.map((row) => row.id), ['first', 'other']);
        assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['other']);
      }
      finally {
        release.resolve();
        await Promise.allSettled([holding, waiting]);
        await contender.close();
      }
    });
  });
}
