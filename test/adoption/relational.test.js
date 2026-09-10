//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSchema, introspectModel, DB_CODES } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { readAdoption } from './evidence.js';

const fixture = readAdoption('fixtures/relational.json');
const plain = (value) => JSON.parse(JSON.stringify(value));
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of [...fixture.ddl, ...fixture.seed]) db.exec(sql);
  return db;
}

describe('portable relational reference', () => {
  for (const read of fixture.reads) it(read.id, () => {
    const db = database();
    try {
      assert.deepEqual(plain(db.prepare(read.sql).all()), read.expected);
      assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all().length > 0);
    }
    finally { db.close(); }
  });
  for (const mutation of fixture.mutations) it(`${mutation.id}: identical replay changes nothing`, () => {
    const db = database();
    try {
      assert.deepEqual(plain(db.prepare(mutation.sql).all()), mutation.first);
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const rows = db.prepare(mutation.sql).all();
      assert.deepEqual(plain(rows), mutation.second);
      assert.equal(db.prepare('SELECT changes() AS n').get().n, 0);
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
      assert.equal(rows.length, 0);
    }
    finally { db.close(); }
  });
  it('retains rowid/composite keys, defaults, nullability, BLOB and trigger DDL', () => {
    const db = database();
    try {
      const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
      const keys = (table) => columns(table).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      assert.deepEqual(keys('receipt'), fixture.inventory.receiptPrimaryKey);
      assert.deepEqual(keys('inventory'), fixture.inventory.compositeKey);
      assert.equal(columns('receipt').find((c) => c.name === 'revision').dflt_value, '1');
      assert.equal(columns('inventory').find((c) => c.name === 'quantity').notnull, 0);
      assert.equal(Buffer.from(db.prepare('SELECT body FROM receipt').get().body).toString('hex'), '0001ff');
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='receipt_history'").get().sql, fixture.ddl[3]);
      for (const refusal of fixture.refusals)
        assert.throws(() => db.exec(refusal.sql), (error) => error.message.includes(refusal.message));
    }
    finally { db.close(); }
  });
  it('preserves the public key and trigger inventory without changing schema or data', async () => {
    const db = await nodeDriver().open(':memory:');
    try {
      for (const sql of fixture.ddl.slice(1, 4)) db.exec(sql);
      db.exec("INSERT INTO receipt(body) VALUES (X'0001ff')");
      const snapshot = () => JSON.stringify({ schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all([]),
        rows: db.prepare('SELECT id,hex(body) AS body FROM receipt').all([]),
        history: db.prepare('SELECT receipt_id,hex(body) AS body FROM history').all([]) });
      const before = snapshot();
      const schema = await readSchema(db);
      const receipt = schema.tables.find((table) => table.name === 'receipt');
      assert.deepEqual(receipt.primaryKey, ['id']);
      const report = await introspectModel(db);
      assert.equal(report.report.find((row) => row.object === 'receipt_history').code, 'unmapped-object');
      assert.ok(Object.hasOwn(DB_CODES, 'JD0002'));
      assert.throws(() => introspectModel(db, { strict: true }), { code: 'JD0002' });
      assert.equal(snapshot(), before);
    }
    finally { db.close(); }
  });
  it('recovers committed WAL and preserves history on both subsequent startups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-adoption-wal-'));
    const file = join(dir, 'fixture.sqlite');
    try {
      const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning',
        fileURLToPath(new URL('wal-writer.js', import.meta.url)), file], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(statSync(`${file}-wal`).size > 32);
      let previous;
      for (let startup = 0; startup < 2; startup++) {
        const db = await nodeDriver().open(file);
        try {
          const rows = plain(db.prepare('SELECT id,hex(body) AS body,revision FROM receipt ORDER BY id').all([]));
          assert.equal(rows.length, fixture.recovery.expectedReceipts);
          assert.equal(db.prepare('SELECT count(*) AS n FROM history').get([]).n, fixture.recovery.expectedHistory);
          assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, 0);
          assert.ok(rows.every((row) => row.body === '0001FF'));
          if (previous) assert.deepEqual(rows, previous);
          previous = rows;
        }
        finally { db.close(); }
      }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
