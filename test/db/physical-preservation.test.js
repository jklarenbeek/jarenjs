//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDriver } from '@jarenjs/db/node';
import { migrate, planPhysicalMigration, schemaShapeOf } from '@jarenjs/db';
const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, value: { type: 'string' },
} }, physical: { table: 'rows', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'reject' },
} } } } };

for (const failure of ['source', 'literal', 'object', 'assertion', 'receipt', 'commit']) {
  it(`physical ${failure} failure changes neither schema nor committed facts`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-preservation-'));
    const path = join(dir, 'fixture.sqlite');
    try {
      let db = await nodeDriver().open(path);
      db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO rows VALUES(1,'original'); CREATE TRIGGER unchanged AFTER DELETE ON rows BEGIN SELECT 'a  b'; END");
      const source = await schemaShapeOf(db);
      const steps = failure === 'object' ? [{ kind: 'ddl', sql: 'DROP TRIGGER unchanged' }]
        : [{ kind: 'sql', sql: "UPDATE rows SET value='changed'" }];
      const plan = await planPhysicalMigration(db, model, model, { id: 'change', steps,
        dispositions: Object.fromEntries(source.map((o) => [`${o.type}:${o.name}`, 'preserve'])),
        ...(failure === 'assertion' ? { assertions: [{ sql: 'SELECT value FROM rows', expected: [{ value: 'original' }] }] } : {}),
      });
      if (failure === 'literal') db.exec("DROP TRIGGER unchanged; CREATE TRIGGER unchanged AFTER DELETE ON rows BEGIN SELECT 'a b'; END");
      if (failure === 'source') db.exec('CREATE VIEW added AS SELECT id FROM rows');
      const before = JSON.stringify({ schema: await schemaShapeOf(db), rows: db.prepare('SELECT * FROM rows').all([]) });
      db.close();
      const driver = { ...nodeDriver(), open: async (...args) => {
        const c = await nodeDriver().open(...args);
        return { ...c, exec: (sql) => { if (failure === 'commit' && sql === 'COMMIT') throw new Error('commit failed'); return c.exec(sql); },
          prepare: (sql, options) => { const s = c.prepare(sql, options); return failure === 'receipt' && /^INSERT INTO "_jaren_migrations"/.test(sql)
            ? { ...s, run: () => { throw new Error('receipt failed'); } } : s; },
        };
      } };
      await assert.rejects(migrate({ driver, path }, [plan], { baseline: model, model, shadow: false }));
      db = await nodeDriver().open(path);
      assert.equal(JSON.stringify({ schema: await schemaShapeOf(db), rows: db.prepare('SELECT * FROM rows').all([]) }), before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
      db.close();
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

it('saved preservation plans validate dispositions again before any migration write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-saved-plan-'));
  const path = join(directory, 'fixture.sqlite');
  try {
    const db = await nodeDriver().open(path);
    db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT)');
    const plan = await planPhysicalMigration(db, model, model, { id: 'saved', steps: [], dispositions: { 'table:rows': 'preserve' } });
    db.close();
    delete plan.physical.dispositions['table:rows'];
    await assert.rejects(migrate({ driver: nodeDriver(), path }, [plan], { baseline: model, model, shadow: false }), { code: 'JD0021' });
    const check = await nodeDriver().open(path);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
    check.close();
  }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
