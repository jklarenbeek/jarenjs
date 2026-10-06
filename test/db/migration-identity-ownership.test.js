//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, createModelShape } from '../../packages/db/src/migrate.js';
import { document, legacy, seedLegacy, all } from './migration-identity-helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const drivers = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 4 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: 4 } })],
];
if (!process.versions.bun) drivers.push(['process', () => nodeProcessDriver({ maxStatements: 4 })]);

for (const [host, makeDriver] of drivers) {
  it(`${host}: 100 ordinary model-validating migrations release every borrowed temporary`, async () => {
    const connection = await makeDriver().open(':memory:');
    try {
      await createModelShape(connection, MODEL);
      const migration = document('ordinary', [], MODEL);
      let recorded;
      for (let at = 0; at < 100; at++) {
        const result = await migrate({ connection }, [migration], {
          baseline: MODEL,
          model: MODEL,
          shadow: false,
        });
        assert.deepEqual(result.applied, at === 0 ? ['ordinary'] : []);
        const observed = await migrationHistory({ connection });
        if (at === 0) recorded = observed;
        else assert.deepEqual(observed, recorded);
      }
      assert.deepEqual((await all(connection, 'SELECT 1 AS value')).map((row) => row.value), [1]);
    }
    finally {
      await connection.close();
    }
  });

  it(`${host}: 100 repeated observation/status/adoption calls retain four slots and borrowed ownership`, async () => {
    const connection = await makeDriver().open(':memory:');
    try {
      await createModelShape(connection, MODEL);
      const old = legacy('legacy', [], MODEL);
      await seedLegacy(connection, [old]);
      const observed = await migrationHistory({ connection });
      assert.deepEqual(await adoptMigrationHistory({ connection }, [old], { observed, model: MODEL }), { adopted: 1, unchanged: 0 });
      const after = await migrationHistory({ connection });
      for (let at = 0; at < 100; at++) {
        assert.deepEqual(await migrationHistory({ connection }), after);
        assert.equal((await migrationStatus({ connection }, [old])).upToDate, true);
        assert.deepEqual(await adoptMigrationHistory({ connection }, [old], { observed, model: MODEL }), { adopted: 0, unchanged: 1 });
        assert.equal((await migrate({ connection }, [old], { baseline: MODEL, shadow: false })).upToDate, true);
      }
      assert.deepEqual((await all(connection, 'SELECT 1 AS value')).map((row) => row.value), [1]);
      assert.deepEqual((await migrationHistory({ connection })).history, observed.history);
    }
    finally { await connection.close(); }
  });

  it(`${host}: 100 stale adoption refusals release every borrowed temporary`, async () => {
    const connection = await makeDriver().open(':memory:');
    try {
      await createModelShape(connection, MODEL);
      const old = legacy('legacy', [], MODEL);
      await seedLegacy(connection, [old]);
      const observed = await migrationHistory({ connection });
      await connection.exec('UPDATE _jaren_migrations SET applied_at=321');
      for (let at = 0; at < 100; at++) {
        await assert.rejects(() => adoptMigrationHistory({ connection }, [old], { observed, model: MODEL }), { code: 'JD0022' });
      }
      assert.equal((await migrationHistory({ connection })).identity.present, false);
      assert.deepEqual((await all(connection, 'SELECT 1 AS value')).map((row) => row.value), [1]);
    }
    finally { await connection.close(); }
  });
}
