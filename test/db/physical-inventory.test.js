//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readSchema, introspectModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

it('inventories rowid keys and unsupported objects without changing bytes or schema', async () => {
  const db = await nodeDriver().open(':memory:');
  try {
    db.exec(`CREATE TABLE receipt (id INTEGER PRIMARY KEY, body BLOB);
      CREATE TABLE history (receipt_id INTEGER REFERENCES receipt(id)
        ON UPDATE CASCADE ON DELETE SET NULL, body BLOB,
        label TEXT COLLATE NOCASE NOT NULL DEFAULT 'pending');
      CREATE TRIGGER receipt_history AFTER INSERT ON receipt
        BEGIN INSERT INTO history(receipt_id,body) VALUES (NEW.id,NEW.body); END;
      CREATE INDEX history_pending ON history(label COLLATE NOCASE DESC)
        WHERE receipt_id IS NOT NULL;
      CREATE TABLE pair (a TEXT, b INTEGER, PRIMARY KEY(b,a)) WITHOUT ROWID;
      CREATE VIEW receipt_view AS SELECT id FROM receipt;
      INSERT INTO receipt(body) VALUES (X'0001ff');`);
    const snapshot = () => JSON.stringify({
      schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all([]),
      rows: db.prepare('SELECT receipt_id,hex(body) AS body,label FROM history').all([]),
      changes: db.prepare('SELECT total_changes() AS n').get([]),
    });
    const before = snapshot();
    for (let run = 0; run < 2; run++) {
      const schema = await readSchema(db);
      assert.deepEqual(schema.tables.find((t) => t.name === 'receipt').primaryKey, ['id']);
      assert.deepEqual(schema.tables.find((t) => t.name === 'pair').primaryKey, ['b', 'a']);
      const history = schema.tables.find((t) => t.name === 'history');
      assert.equal(history.columns.find((c) => c.name === 'label').default, "'pending'");
      assert.equal(history.columns.find((c) => c.name === 'label').nullable, false);
      assert.equal(history.foreignKeys[0].onUpdate, 'CASCADE');
      assert.equal(history.foreignKeys[0].onDelete, 'SET NULL');
      assert.match(history.indexes[0].sql, /WHERE receipt_id IS NOT NULL/);
      assert.match(history.sql, /COLLATE NOCASE/);
      const result = await introspectModel(db);
      const trigger = result.report.find((r) => r.object === 'receipt_history');
      assert.equal(trigger.code, 'unmapped-object');
      assert.match(trigger.sql, /CREATE TRIGGER/);
      assert.equal(result.inventory.length, schema.objects.length);
      assert.ok(result.inventory.every((o) => ['derived', 'preserve'].includes(o.disposition)));
      await assert.rejects(async () => introspectModel(db, { strict: true }), { code: 'JD0002' });
      assert.equal(snapshot(), before);
    }
  }
  finally { db.close(); }
});
