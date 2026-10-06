//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDriver } from '@jarenjs/db/postgres';
import { sql, planInvariants, sqliteDialect, readSchema } from '@jarenjs/db';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, createModelShape, planMigration } from '../../packages/db/src/migrate.js';
import { chain } from '../../packages/db/src/driver.js';
import { ruleModel, RULE_TABLES } from './invariant-oracle.js';
import { hosts, native, document, legacy, fixture, all, seedLegacy, rejected } from './migration-identity-helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const first = legacy('first', [{ kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('first')" }], MODEL);
const second = legacy('second', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('second')" },
  { kind: 'host', run: 'inspect', version: '1' }], MODEL);
const tail = document('tail', [{ kind: 'host', run: 'notice', version: '1' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('tail')" }], MODEL);

async function shadowDriverFor(host, context, execute) {
  if (host === 'sqlite') return execute(native());
  const schema = `${context.schema}_shadow`;
  await context.pool.query(`CREATE SCHEMA "${schema}"`);
  try { await execute(postgresDriver(context.pool, { schema, lockTimeoutMs: 5000 })); }
  finally { await context.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
}

for (const host of hosts) for (const atomic of [false, true])
  it(`${host}: adopted steps replay before the exact tail, with ${atomic ? 'atomic' : 'link'} primary ownership`, async () => {
    await fixture(host, async (connection, context) => {
      await createModelShape(connection, MODEL);
      await seedLegacy(connection, [first, second], 1234, { inspect() {} });
      const observed = await migrationHistory({ connection });
      await adoptMigrationHistory({ connection }, [first, second], { observed, model: MODEL });
      const before = await migrationHistory({ connection });
      await shadowDriverFor(host, context, async (driver) => {
        let activeShadow, refused = 0;
        const seen = [];
        const wrap = (scope) => ({ ...scope,
          transaction: (fn, ...args) => scope.transaction((child) => {
            activeShadow = wrap(child);
            return fn(activeShadow);
          }, ...args),
          ...(scope.exclusively ? {
            exclusively: (fn, ...args) => scope.exclusively((child) => fn(wrap(child)), ...args),
          } : {}),
        });
        const shadowDriver = { ...driver, open: (...args) => chain(driver.open(...args), wrap) };
        const callbacks = {
          inspect: { version: '1', run(_scope, ctx) {
            assert.equal(ctx.shadow, true);
            const fail = (error) => {
              assert.equal(error.code, 'JD0022');
              assert.match(error.message, /identity header/);
              refused++;
            };
            try {
              const publicRead = migrationStatus({ connection: activeShadow }, [first, second]);
              if (publicRead?.then) return publicRead.then(() => assert.fail('public admission accepted a partial private prefix'), fail);
              assert.fail('public admission accepted a partial private prefix');
            }
            catch (error) { fail(error); }
          } },
          notice: { version: '1', run(scope, ctx) {
            seen.push(ctx.shadow ? 'shadow' : 'primary');
            return chain(scope.relational.all({ from: 'witness', columns: { value: sql.column('value') } }), (rows) => {
              assert.deepEqual(rows.map((row) => row.value).sort(), ['first', 'second']);
            });
          } },
        };
        const result = await migrate({ connection }, [first, second, tail], {
          baseline: MODEL, model: MODEL, shadowDriver, hosts: callbacks, atomic,
        });
        assert.deepEqual(result.applied, ['tail']);
        assert.equal(refused, 1);
        assert.deepEqual(seen, ['shadow', 'primary']);
        const after = await migrationHistory({ connection });
        assert.deepEqual(after.history.rows.slice(0, 2), before.history.rows);
        assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['first', 'second', 'tail']);
      });
    });
  });

for (const host of hosts) it(`${host}: copied fixture receipts cannot skip the real legacy prefix`, async () => {
  await fixture(host, async (connection, context) => {
    await createModelShape(connection, MODEL);
    await seedLegacy(connection, [first]);
    const observed = await migrationHistory({ connection });
    await adoptMigrationHistory({ connection }, [first], { observed, model: MODEL });
    const before = await migrationHistory({ connection });
    await shadowDriverFor(host, context, async (shadowDriver) => {
      await rejected(() => migrate({ connection }, [first, document('tail', [], MODEL)], {
        baseline: MODEL, model: MODEL, shadowDriver,
        shadowFixture: (shadow) => chain(createModelShape(shadow, MODEL), () => seedLegacy(shadow, [first])),
      }), 'JD0022');
    });
    assert.deepEqual(await migrationHistory({ connection }), before);
  });
});

for (const host of hosts) for (const failing of ['prefix', 'tail'])
  it(`${host}: failed ${failing} replay leaves primary receipts and data untouched`, async () => {
    await fixture(host, async (connection, context) => {
      await createModelShape(connection, MODEL);
      await seedLegacy(connection, [first, second], 1234, { inspect() {} });
      const observed = await migrationHistory({ connection });
      await adoptMigrationHistory({ connection }, [first, second], { observed, model: MODEL });
      const before = await migrationHistory({ connection });
      await shadowDriverFor(host, context, async (shadowDriver) => {
        await rejected(() => migrate({ connection }, [first, second, tail], {
          baseline: MODEL, model: MODEL, shadowDriver,
          hosts: {
            inspect: { version: '1', run() { if (failing === 'prefix') throw new Error('prefix refusal'); } },
            notice: { version: '1', run() { throw new Error('tail refusal'); } },
          },
        }), 'JD0023');
      });
      assert.deepEqual(await migrationHistory({ connection }), before);
      assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['first', 'second']);
    });
  });

it('adopted shadow model preserves entity declaration order for invariant program identities', async () => {
  await fixture('sqlite', async (connection, context) => {
    const model = structuredClone(ruleModel);
    const seed = (target) => {
      target.exec(RULE_TABLES.sqlite);
      for (const statement of planInvariants(model, { dialect: sqliteDialect })) target.exec(statement.sql);
    };
    seed(connection);
    const physicalTarget = { objects: readSchema(connection).objects };
    const old = legacy('legacy', [], model);
    await seedLegacy(connection, [old]);
    const observed = migrationHistory({ connection });
    await adoptMigrationHistory({ connection }, [old], { observed, model, physicalTarget, shadowDriver: context.driver });
    const header = JSON.parse(migrationHistory({ connection }).identity.rows.find((row) => row.key === 'header').value);
    assert.deepEqual(Object.keys(JSON.parse(header.legacyModelSource).entities), ['Entry', 'Audit']);
    assert.deepEqual(Object.keys(JSON.parse(header.legacyModel).entities), ['Audit', 'Entry']);
    const next = planMigration(model, model, { dialect: sqliteDialect, id: 'tail' }).migration;
    assert.deepEqual((await migrate({ connection }, [old, next], {
      baseline: model, model, physicalTarget, shadowDriver: context.driver, shadowFixture: seed,
    })).applied, ['tail']);
    assert.deepEqual(migrationHistory({ connection }).history.rows[0], observed.history.rows[0]);
  });
});
