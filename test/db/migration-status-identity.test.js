//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createModelShape, migrate, migrationStatus, migrationHistory, adoptMigrationHistory,
  migrationChecksum, planModelMigration, shapeHash, sqliteDialect } from '@jarenjs/db';

const native = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver
  : (await import('@jarenjs/db/node')).nodeDriver;
const model = (value) => ({ $model: '0.1', collections: { items: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { const: value } },
} } } });
const before = model('159koso'), after = model('gnt19f');

for (const changed of [false, true]) {
  it(`status labels an exact zero-step ${changed ? 'changed model as ordinary work' : 'same-model receipt as a baseline'}`, async () => {
    const connection = await native().open(':memory:', {});
    try {
      await createModelShape(connection, before);
      const current = changed ? after : before;
      // This collection is empty: an authored endpoint-only transition needs
      // no data step. Its two exact models still differ in the changed case.
      const document = { ...planModelMigration(before, current, { dialect: sqliteDialect, id: 'first' }).migration, steps: [] };
      assert.deepEqual([shapeHash(before), shapeHash(current)], ['15ta7pe', '15ta7pe']);
      assert.equal(document.identity.from === document.identity.to, !changed);
      assert.deepEqual((await migrate({ connection }, [document], { baseline: before, model: current, shadow: false })).applied, ['first']);
      const recorded = migrationHistory({ connection });
      assert.equal(typeof recorded?.then, 'undefined');
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.deepEqual(migrationStatus({ connection }, [document]), {
          applied: ['first'], pending: [], drift: null, upToDate: true, baseline: changed ? null : 'first',
        });
        assert.deepEqual((await migrate({ connection }, [document], { baseline: before, model: current, shadow: false })).applied, []);
        assert.deepEqual(migrationHistory({ connection }), recorded);
      }
    }
    finally { await connection.close(); }
  });
}

it('status retains the compatible short-fingerprint baseline label for an adopted legacy receipt', async () => {
  const connection = await native().open(':memory:', {});
  try {
    await createModelShape(connection, after);
    const legacy = { $migration: '0.1', id: 'legacy', from: shapeHash(before), to: shapeHash(after), steps: [] };
    await connection.exec(`CREATE TABLE IF NOT EXISTS "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, "to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT`);
    const statement = await connection.prepare('INSERT INTO _jaren_migrations VALUES(?,1234,?,?,?,0)');
    try { await statement.run([legacy.id, legacy.from, legacy.to, migrationChecksum(legacy)]); }
    finally { await statement.finalize?.(); }
    const observed = migrationHistory({ connection });
    assert.deepEqual(adoptMigrationHistory({ connection }, [legacy], { observed, model: after }), { adopted: 1, unchanged: 0 });
    const recorded = migrationHistory({ connection });
    assert.equal(migrationStatus({ connection }, [legacy]).baseline, 'legacy');
    assert.deepEqual(migrationHistory({ connection }), recorded);
    assert.deepEqual(recorded.history, observed.history);
  }
  finally { await connection.close(); }
});
