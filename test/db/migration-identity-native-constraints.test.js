//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, createModelShape } from '../../packages/db/src/migrate.js';
import { EMPTY, hosts, document, legacy, fixture, all, seedLegacy, rejected } from './migration-identity-helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const first = document('first', [{ kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' }]);
const tail = document('tail', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('tail')" }]);
const options = { baseline: EMPTY, shadow: false };
const tables = [
  ['_jaren_migrations', 'id', 'checksum'],
  ['_jaren_migration_identity', 'key', 'value'],
];

if (hosts.includes('postgres')) {
  it('postgres: native renderer metadata accepts its primary key and required nullability across catalog versions', async () => {
    await fixture('postgres', async (connection) => {
      assert.deepEqual((await migrate({ connection }, [first], options)).applied, ['first']);
      const before = await migrationHistory({ connection });
      const catalog = (await all(connection, connection.dialect.introspect.catalog()))
        .map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
      const version = Number((await all(connection, "SELECT current_setting('server_version_num') AS version"))[0].version);
      for (const [table, key] of tables) {
        const constraints = catalog.filter((row) => row.owner === table && row.type === 'constraint');
        assert.deepEqual(constraints.filter((row) => row.metadata.kind === 'p').map((row) => row.metadata.columns), [[key]]);
        assert.deepEqual(constraints.filter((row) => row.metadata.kind === 'n').map((row) => row.metadata.columns).sort(),
          version >= 180000 ? [[key], ['rid']].sort() : []);
      }
      assert.equal((await migrationStatus({ connection }, [first])).upToDate, true);
      assert.deepEqual((await migrate({ connection }, [first], options)).applied, []);
      assert.deepEqual(await migrationHistory({ connection }), before);
      assert.deepEqual((await migrate({ connection }, [first, tail], options)).applied, ['tail']);
      assert.deepEqual((await migrationHistory({ connection })).history.rows[0], before.history.rows[0]);
      assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['tail']);
    });
  });

  it('postgres: native legacy adoption accepts unchanged renderer constraints and preserves original rows twice', async () => {
    await fixture('postgres', async (connection) => {
      await createModelShape(connection, MODEL);
      const old = legacy('legacy', [], MODEL);
      await seedLegacy(connection, [old]);
      const observed = await migrationHistory({ connection });
      assert.deepEqual(await adoptMigrationHistory({ connection }, [old], { observed, model: MODEL }), { adopted: 1, unchanged: 0 });
      const adopted = await migrationHistory({ connection });
      assert.deepEqual(adopted.history, observed.history);
      assert.deepEqual(await adoptMigrationHistory({ connection }, [old], { observed, model: MODEL }), { adopted: 0, unchanged: 1 });
      assert.equal((await migrationStatus({ connection }, [old])).upToDate, true);
      assert.deepEqual(await migrationHistory({ connection }), adopted);
    });
  });

  for (const [table, key, nullable] of tables) {
    const changes = {
      extraRequiredColumn: `ALTER TABLE "${table}" ALTER COLUMN "${nullable}" SET NOT NULL`,
      missingRequiredNullability: `ALTER TABLE "${table}" ALTER COLUMN rid DROP NOT NULL`,
      extraCheck: `ALTER TABLE "${table}" ADD CONSTRAINT unwanted_check CHECK (true)`,
      extraUnique: `ALTER TABLE "${table}" ADD CONSTRAINT unwanted_unique UNIQUE (rid)`,
      extraForeignKey: `ALTER TABLE "${table}" ADD CONSTRAINT unwanted_foreign FOREIGN KEY ("${key}") REFERENCES "${table}" ("${key}")`,
      missingPrimaryKey: `ALTER TABLE "${table}" DROP CONSTRAINT "${table}_pkey"`,
    };
    for (const [name, sql] of Object.entries(changes)) {
      it(`postgres: ${table} refuses ${name} without changing history or executing its tail`, async () => {
        await fixture('postgres', async (connection) => {
          await migrate({ connection }, [first], options);
          await connection.exec(sql);
          const before = await migrationHistory({ connection });
          await rejected(() => migrationStatus({ connection }, [first]), 'JD0022');
          await rejected(() => migrate({ connection }, [first, tail], options), 'JD0022');
          assert.deepEqual(await migrationHistory({ connection }), before);
          assert.deepEqual(await all(connection, 'SELECT value FROM witness'), []);
        });
      });
    }
  }
}
