//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, migrationStatus, introspectModel, schemaShapeOf } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', collections: {
  notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } } },
} };

for (const mode of ['session', 'journal']) {
  it(`${mode}: replication bookkeeping never reports model drift`, async () => {
    const temporary = tempDbPath();
    const driver = nodeDriver();
    try {
      const store = await openStore(MODEL, { driver, path: temporary.dbPath,
        capture: { mode }, replication: { replica: 'origin' } });
      await store.close();
      for (let run = 0; run < 2; run++) {
        assert.deepEqual(await migrationStatus({ driver, path: temporary.dbPath }, [], { model: MODEL }),
          { applied: [], pending: [], drift: null, upToDate: true });
      }
      const connection = await driver.open(temporary.dbPath, {});
      try {
        assert.deepEqual((await schemaShapeOf(connection)).map((row) => row.name), ['notes']);
        await connection.exec('CREATE TABLE outsider (id INTEGER)');
      }
      finally { await connection.close(); }
      assert.equal((await migrationStatus({ driver, path: temporary.dbPath }, [], { model: MODEL })).drift,
        'unexpected table:outsider');
    }
    finally { temporary.cleanup(); }
  });

  it(`${mode}: introspection excludes replication tables and their loss reports`, async () => {
    const temporary = tempDbPath();
    const driver = nodeDriver();
    try {
      const store = await openStore(MODEL, { driver, path: temporary.dbPath,
        capture: { mode }, replication: { replica: 'origin' } });
      await store.close();
      const connection = await driver.open(temporary.dbPath, {});
      try {
        const result = await introspectModel(connection);
        assert.deepEqual(Object.keys(result.model.collections), ['notes']);
        assert.deepEqual(Object.keys(result.model.entities ?? {}), []);
        assert.equal(result.report.some((row) => row.object.startsWith('_jaren_replica')), false);
        assert.deepEqual(await introspectModel(connection), result);
      }
      finally { await connection.close(); }
    }
    finally { temporary.cleanup(); }
  });
}
