//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeDriver } from '@jarenjs/db/node';
import { openStore, planPhysicalMigration, migrate, schemaShapeOf } from '@jarenjs/db';
const child = fileURLToPath(new URL('./relational-recovery-child.js', import.meta.url));
const baseline = { $model: '0.1', entities: { Receipt: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, body: { type: 'string' },
} }, physical: { table: 'receipt', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, body: { name: 'body', codec: 'blob-hex', null: 'reject' },
} } } } };
const target = structuredClone(baseline);
target.entities.Receipt.schema.properties.note = { type: ['string', 'null'] };
target.entities.Receipt.physical.columns.note = { name: 'note', codec: 'text', null: 'null' };
const trigger = 'CREATE TRIGGER receipt_history AFTER INSERT ON receipt BEGIN INSERT INTO history VALUES(NEW.id,NEW.body); END';
const seed = ['CREATE TABLE receipt(id INTEGER PRIMARY KEY, body BLOB NOT NULL)',
  'CREATE TABLE history(receipt_id INTEGER, body BLOB)', trigger, "INSERT INTO receipt(body) VALUES(X'0001ff')"];
const steps = [{ kind: 'rebuild', table: 'receipt', create: ['CREATE TABLE "receipt__rebuild"(id INTEGER PRIMARY KEY, body BLOB NOT NULL, note TEXT)'],
  copy: 'INSERT INTO "receipt__rebuild"(id,body) SELECT id,body FROM receipt', indexes: [trigger] }];
const run = (host, file, spec, point) => {
  const input = `${file}.json`; writeFileSync(input, JSON.stringify(spec));
  return spawnSync(host, [child, file, input, point], { encoding: 'utf8', timeout: 15000 });
};

for (const host of [process.execPath, 'bun']) {
  it(`${host === 'bun' ? 'Bun' : 'Node'} preserves committed WAL across rebuild/drop/commit and backup publication kills`, async () => {
    for (const point of ['rebuild', 'drop', 'commit', 'copy', 'publish-before', 'publish-after']) {
      const dir = mkdtempSync(join(tmpdir(), 'jaren-preserve-'));
      const file = join(dir, 'source.sqlite');
      try {
        const seeded = run(host, file, { seed }, 'seed');
        assert.equal(seeded.status, 0, seeded.stderr);
        assert.ok(existsSync(`${file}-wal`));
        const db = await nodeDriver().open(file);
        const source = await schemaShapeOf(db);
        const migration = await planPhysicalMigration(db, baseline, target, { id: 'upgrade', steps,
          dispositions: Object.fromEntries(source.map((o) => [`${o.type}:${o.name}`, o.name === 'receipt' ? 'replace' : 'preserve'])),
          assertions: [{ sql: 'SELECT id,hex(body) AS body FROM receipt ORDER BY id', expected: [{ id: 1, body: '0001FF' }] },
            { sql: 'SELECT receipt_id,hex(body) AS body FROM history', expected: [{ receipt_id: 1, body: '0001FF' }] }],
        });
        db.close();
        const backup = ['copy', 'publish-before', 'publish-after'].includes(point);
        const killed = run(host, file, { baseline, model: backup ? baseline : target, migrations: [migration] }, point);
        assert.equal(killed.signal, 'SIGKILL', killed.stderr);
        if (!backup) {
          const repaired = run(host, file, { baseline, model: target, migrations: [migration] }, 'repair');
          assert.equal(repaired.status, 0, repaired.stderr);
        }
        if (!backup) {
          const fresh = await nodeDriver().open(':memory:');
          fresh.exec('CREATE TABLE "receipt"(id INTEGER PRIMARY KEY, body BLOB NOT NULL, note TEXT)');
          for (const sql of seed.slice(1)) fresh.exec(sql);
          const upgraded = await nodeDriver().open(file);
          assert.deepEqual(await schemaShapeOf(upgraded), await schemaShapeOf(fresh));
          assert.deepEqual(upgraded.prepare('SELECT id,hex(body) AS body,note FROM receipt').all([]),
            fresh.prepare('SELECT id,hex(body) AS body,note FROM receipt').all([]));
          fresh.close(); upgraded.close();
        }
        const store = await openStore(backup ? baseline : target, { driver: nodeDriver(), path: file, adopt: true });
        assert.equal((await store.entity('Receipt').get(1)).body, '0001ff');
        await store.entity('Receipt').create({ body: 'ff', ...(backup ? {} : { note: 'later' }) });
        await store.close();
        if (!backup) {
          const trace = [];
          const driver = { ...nodeDriver(), open: async (...args) => { const c = await nodeDriver().open(...args); return { ...c, exec: (sql) => { trace.push(sql); return c.exec(sql); } }; } };
          const repeated = await migrate({ driver, path: file }, [migration], { baseline, model: target, shadow: false });
          assert.equal(repeated.upToDate, true);
          assert.deepEqual(trace, [], 'second migration issues no DDL or DML');
          const newest = await openStore(target, { driver: nodeDriver(), path: file, adopt: true });
          assert.equal((await newest.entity('Receipt').get(2)).note, 'later');
          await newest.close();
          const current = await nodeDriver().open(file);
          const shape = await schemaShapeOf(current);
          const repair = await planPhysicalMigration(current, target, baseline, { id: 'forward-repair',
            steps: [{ kind: 'rebuild', table: 'receipt', create: ['CREATE TABLE "receipt__rebuild"(id INTEGER PRIMARY KEY, body BLOB NOT NULL, note TEXT)'],
              copy: 'INSERT INTO "receipt__rebuild"(id,body,note) SELECT id,body,note FROM receipt', indexes: [trigger] }],
            dispositions: Object.fromEntries(shape.map((o) => [`${o.type}:${o.name}`, o.name === 'receipt' ? 'replace' : 'preserve'])),
            assertions: [{ sql: 'SELECT id,hex(body) AS body,note FROM receipt ORDER BY id', expected: [{ id: 1, body: '0001FF', note: null }, { id: 2, body: 'FF', note: 'later' }] },
              { sql: 'SELECT receipt_id,hex(body) AS body FROM history ORDER BY receipt_id', expected: [{ receipt_id: 1, body: '0001FF' }, { receipt_id: 2, body: 'FF' }] }],
          });
          current.close();
          const forwarded = run(host, file, { baseline, model: baseline, migrations: [migration, repair] }, 'forward');
          assert.equal(forwarded.status, 0, forwarded.stderr);
          const restored = await openStore(baseline, { driver: nodeDriver(), path: file, adopt: true });
          assert.equal((await restored.entity('Receipt').get(2)).body, 'ff');
          await restored.transaction((tx) => assert.equal(tx.sql.prepare('SELECT note FROM receipt WHERE id=2', { access: 'read' }).get([]).note, 'later'));
          assert.equal((await migrate({ driver: nodeDriver(), path: file }, [migration, repair], { baseline, model: baseline, shadow: false })).upToDate, true);
          await restored.close();
        }
        if (point === 'publish-after') {
          const copy = await openStore(baseline, { driver: nodeDriver(), path: `${file}.backup`, adopt: true });
          assert.equal((await copy.entity('Receipt').get(1)).body, '0001ff'); await copy.close();
        }
        else if (backup) assert.equal(existsSync(`${file}.backup`), false);
      }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}
