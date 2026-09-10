//@ts-check
/** Installed public-API probe; inputs are copied beside this file by the pack gate. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { readSchema, openStore } from '@jarenjs/db';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { compileJsonQuery } from '@jarenjs/json/query';

const fixture = JSON.parse(readFileSync(new URL('./adoption-relational.json', import.meta.url), 'utf8'));
const consumers = JSON.parse(readFileSync(new URL('./adoption-consumers.json', import.meta.url), 'utf8'));
const driver = process.versions.bun ? bunDriver() : nodeDriver();
const directory = mkdtempSync(join(tmpdir(), 'jaren-installed-relational-'));
const path = join(directory, 'adoption.sqlite');
const db = await driver.open(path);
try {
  for (const sql of [...fixture.ddl, ...fixture.seed]) db.exec(sql);
  for (const read of fixture.reads)
    assert.deepEqual(JSON.parse(JSON.stringify(db.prepare(read.sql).all([]))), read.expected);
  assert.ok((await readSchema(db)).tables.length >= 5);
  for (const { definition, rows, expected } of consumers) {
    assert.equal(rows.length, definition.rows);
    const query = compileJsonQuery({ $count: { $for: { row: '$[*]' },
      $where: { $eq: ['$row.provenance', 'manual'] }, $return: '$row.id' } });
    assert.equal(query(rows), expected.protectedRows);
    assert.equal(rows[0].sku, '00000000');
  }
}
finally { db.close(); }

const column = (name, codec = 'text', extra = {}) => ({ name, codec, null: 'reject', ...extra });
const model = m.defineModel({ entities: {
  Setting: m.object({ id: m.string().key(), value: m.string(), updated: m.string().optional() }).physical({
    table: 'app_settings', columns: { id: column('key'), value: column('value'),
      updated: column('updated_at', 'datetime', { default: 'database' }) },
  }),
  Receipt: m.object({ id: m.integer().identity('auto'), body: m.string(), revision: m.integer().optional() }).physical({
    table: 'receipt', columns: { id: column('id', 'integer'), body: column('body', 'blob-hex'),
      revision: column('revision', 'integer', { default: 'database' }) },
  }),
} });
try {
  let inventory;
  for (let run = 0; run < 2; run++) {
    const probe = await driver.open(path);
    const before = JSON.stringify(await readSchema(probe));
    probe.close();
    const client = await open(model, { driver, path, adopt: true });
    try {
      assert.equal((await client.entities.Setting.get('locale')).value, run ? 'en-GB' : 'nl-NL');
      assert.deepEqual(await client.entities.Receipt.get(1), { id: 1, body: '0001ff', revision: 1 });
      await client.transaction(async (tx) => {
        if (!run) {
          for (const read of fixture.reads)
            assert.deepEqual(JSON.parse(JSON.stringify(await tx.sql.prepare(read.sql, { access: 'read' }).all([]))), read.expected);
        }
        for (const mutation of fixture.mutations) {
          const statement = tx.sql.prepare(mutation.sql, { access: 'write' });
          assert.deepEqual(JSON.parse(JSON.stringify(await statement.all([]))), run ? [] : mutation.first);
          assert.deepEqual(await statement.all([]), []);
          assert.equal((await tx.sql.prepare('SELECT changes() AS n', { access: 'read' }).get([])).n, 0);
        }
      });
    }
    finally { await client.close(); }
    const after = await driver.open(path);
    inventory = JSON.stringify(await readSchema(after));
    after.close();
    assert.equal(inventory, before, 'opening and mixed DML never rewrite schema or trigger ownership');
  }
  // Infrastructure provisioning is explicit; subsequent mixed work still has one owner.
  const store = await openStore(model, { driver, path, jobs: true });
  try {
    for (const failure of [true, false]) {
      const work = store.transaction(async (tx) => {
        tx.sql.prepare('UPDATE app_settings SET value=? WHERE key=?', { access: 'write' }).run(['fr-FR', 'locale']);
        const receipt = await tx.entity('Receipt').create({ body: '00ff80' });
        assert.equal(receipt.id, 2);
        await tx.jobs.enqueue('publish', { id: receipt.id }, { id: 'receipt-outbox' });
        if (failure) throw new Error('consumer rollback');
      });
      if (failure) {
        await assert.rejects(work, /consumer rollback/);
        assert.equal(await store.entity('Receipt').get(2), undefined);
        assert.equal(await store.jobs.get('receipt-outbox'), undefined);
      }
      else await work;
    }
    await store.transaction((tx) => {
      assert.deepEqual(JSON.parse(JSON.stringify(tx.sql.prepare('SELECT receipt_id,hex(body) AS body,revision FROM history WHERE receipt_id=2',
        { access: 'read' }).get([]))), { receipt_id: 2, body: '00FF80', revision: 1 });
    });
  }
  finally { await store.close(); }
}
finally { rmSync(directory, { recursive: true, force: true }); }
