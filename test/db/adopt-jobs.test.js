//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, readSchema } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const model = { $model: '0.1', collections: { items: { key: '/id', schema: { type: 'object' } } } };
it('adopts an existing queue without DDL and co-commits through the same transaction owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-adopt-jobs-')), path = join(dir, 'existing.sqlite');
  try {
    const seed = await openStore(model, { driver: nodeDriver(), path, jobs: true });
    await seed.jobs.enqueue('historic', { original: true }, { id: 'historic' }); await seed.close();
    for (let run = 0; run < 2; run++) {
      const connection = await nodeDriver().open(path), before = await readSchema(connection);
      const exec = connection.exec.bind(connection), ddl = [];
      const traced = { ...connection, exec: (sql) => { if (/\b(CREATE|ALTER|DROP)\b/i.test(sql)) ddl.push(sql); return exec(sql); } };
      const store = await openStore(model, { driver: { ...nodeDriver(), open: () => traced }, path, adopt: true, jobs: true });
      try {
        assert.deepEqual((await store.jobs.get('historic')).payload, { original: true });
        if (!run) {
          await assert.rejects(store.transaction(async (tx) => {
            await tx.collection('items').insert({ id: 'rollback' });
            await tx.jobs.enqueue('effect', {}, { id: 'rollback' });
            throw new Error('rollback');
          }), /rollback/);
          assert.equal(await store.jobs.get('rollback'), undefined);
          assert.equal(await store.collection('items').get('rollback'), undefined);
          await store.transaction(async (tx) => {
            await tx.collection('items').insert({ id: 'later' });
            await tx.jobs.enqueue('effect', {}, { id: 'later' });
          });
        }
        assert.equal((await store.collection('items').get('later')).id, 'later');
        assert.equal((await store.jobs.get('later')).kind, 'effect');
        assert.deepEqual(await readSchema(connection), before); assert.deepEqual(ddl, []);
      }
      finally { await store.close(); }
    }
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const damage of ['DROP TABLE _jaren_jobs', 'ALTER TABLE _jaren_jobs DROP COLUMN lease_token', 'DROP INDEX _jaren_jobs_claim']) {
  it(`refuses damaged adopted job infrastructure without repair: ${damage}`, async () => {
    const connection = await nodeDriver().open(':memory:');
    const driver = { ...nodeDriver(), open: () => ({ ...connection, close() {} }) };
    const seed = await openStore(model, { driver, jobs: true }); await seed.close();
    connection.exec(damage);
    const before = await readSchema(connection);
    try {
      await assert.rejects(openStore(model, { driver, adopt: true, jobs: true }), { code: 'JD0002' });
      assert.deepEqual(await readSchema(connection), before);
    }
    finally { connection.close(); }
  });
}
