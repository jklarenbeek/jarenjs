//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planTable, planTableMigration, applyTableMigration, withForeignKeysSuspended, sql } from '@jarenjs/db';
const b = sql.binary, c = sql.column;
async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  try { await run(db); } finally { db.close(); }
}
const before = { name: 'history', primaryKey: ['id'], columns: [
  { name: 'id', type: 'INTEGER', identity: 'autoincrement', nullable: false },
  { name: 'bytes', type: 'BLOB', nullable: false }, { name: 'raw', type: 'TEXT' },
] };
const after = () => ({ ...before, columns: [...before.columns, { name: 'revision', type: 'INTEGER', nullable: false, default: 1 }],
  indexes: [{ name: 'history_revision', terms: [{ by: c('revision') }] }],
  triggers: [{ name: 'history_immutable', timing: 'before', event: 'update', steps: [{ raise: { action: 'abort', message: 'immutable history' } }] }] });
const seed = (db) => {
  for (const text of planTable(before).createSql) db.exec(text);
  db.exec("INSERT INTO history VALUES(1,X'0001FF',' { \"key\" : 1 } '); INSERT INTO history VALUES(30,X'00','unused'); DELETE FROM history WHERE id=30; CREATE TABLE child(id INTEGER PRIMARY KEY,history INTEGER REFERENCES history(id) ON DELETE CASCADE);INSERT INTO child VALUES(1,1);CREATE VIEW history_view AS SELECT id,bytes FROM history; CREATE INDEX retained_raw ON history(raw)");
};

it('populated rebuilds preserve bytes, histories, references, indexes and allocated identities on repeat', async () => fixture((db) => {
  seed(db);
  const plan = planTableMigration(db, after(), { id: 'history-v2', allowRebuild: true });
  assert.ok(plan.statements.length);
  assert.ok(applyTableMigration(db, plan).changed > 0);
  assert.deepEqual(applyTableMigration(db, plan), { changed: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get([]).n, 1);
  assert.deepEqual([...db.prepare('SELECT bytes FROM history_view').get([]).bytes], [0, 1, 255]);
  assert.equal(db.prepare('SELECT raw FROM history').get([]).raw, ' { "key" : 1 } ');
  assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='retained_raw'").get([]));
  assert.throws(() => db.prepare('UPDATE history SET raw=raw').run([]), /immutable history/);
  assert.equal(Number(db.prepare("INSERT INTO history(bytes) VALUES(X'00')").run([]).lastInsertRowid), 31);
}));

it('failed guarded rebuilds roll back everything and restore pragmas; nested migration scopes settle synchronously', async () => fixture((db) => {
  seed(db);
  const impossible = after(); impossible.columns[2] = { ...impossible.columns[2], check: b('=', c('raw'), 'impossible') };
  const rejected = planTableMigration(db, impossible, { id: 'bad', allowRebuild: true });
  assert.throws(() => applyTableMigration(db, rejected), /CHECK/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '_jaren_rebuild_%'").get([]).n, 0);
  const good = planTableMigration(db, after(), { id: 'good', allowRebuild: true });
  assert.throws(() => db.transaction(() => applyTableMigration(db, good)), /outer migration scope/);
  assert.throws(() => withForeignKeysSuspended(db, () => {
    db.transaction(() => applyTableMigration(db, good)); throw new Error('outer failure');
  }), /outer failure/);
  assert.equal(db.prepare('PRAGMA table_info(history)').all([]).length, 3);
  withForeignKeysSuspended(db, () => db.transaction(() => applyTableMigration(db, good)));
  assert.equal(db.prepare('PRAGMA table_info(history)').all([]).length, 4);
  assert.throws(() => withForeignKeysSuspended(db, () => Promise.resolve()), /synchronously/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, 1);
}));

it('migration plans refuse schema drift, undeclared drops and mutations of a reviewed plan', async () => fixture((db) => {
  seed(db);
  assert.throws(() => planTableMigration(db, after(), { id: 'x' }), /allowRebuild/);
  const dropped = { ...before, columns: before.columns.slice(0, 2) };
  assert.throws(() => planTableMigration(db, dropped, { id: 'x', allowRebuild: true }), /dropColumns/);
  const plan = planTableMigration(db, after(), { id: 'x', allowRebuild: true });
  assert.throws(() => applyTableMigration(db, { ...plan, statements: [] }), /checksum/);
  db.exec('CREATE TABLE concurrent(id INTEGER)');
  assert.throws(() => applyTableMigration(db, plan), /source schema/);
  assert.equal(db.prepare('PRAGMA table_info(history)').all([]).length, 3);
}));

it('ordered composite keys, foreign-key actions and fresh-table plans preserve rowids', async () => fixture((db) => {
  db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(1)');
  const table = { name: 'items', columns: [{ name: 'environment', type: 'TEXT', nullable: false }, { name: 'id', type: 'INTEGER', nullable: false }, { name: 'parent', type: 'INTEGER' }],
    primaryKey: ['id', 'environment'], constraints: [{ kind: 'foreignKey', columns: ['parent'], table: 'parent', references: ['id'], onDelete: 'set null', onUpdate: 'cascade' }] };
  const fresh = planTableMigration(db, table, { id: 'fresh' });
  applyTableMigration(db, fresh); assert.deepEqual(applyTableMigration(db, fresh), { changed: 0 });
  db.exec("INSERT INTO items(rowid,environment,id,parent) VALUES(17,'test',1,1)");
  const next = { ...table, columns: [...table.columns, { name: 'new', type: 'TEXT' }] };
  applyTableMigration(db, planTableMigration(db, next, { id: 'next', allowRebuild: true }));
  assert.equal(db.prepare('SELECT rowid FROM items').get([]).rowid, 17);
  db.exec('UPDATE parent SET id=2 WHERE id=1'); assert.equal(db.prepare('SELECT parent FROM items').get([]).parent, 2);
  db.exec('DELETE FROM parent'); assert.equal(db.prepare('SELECT parent FROM items').get([]).parent, null);
}));

it('a process killed after DROP recovers its populated WAL database and repeats the reviewed upgrade', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-migration-crash-'));
  const path = join(directory, 'legacy.db'), planPath = join(directory, 'plan.json');
  const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
  const driver = process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver();
  let db = await driver.open(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); seed(db);
    const original = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all([]).map((r) => ({ ...r }));
    const plan = planTableMigration(db, after(), { id: 'crash', allowRebuild: true });
    writeFileSync(planPath, JSON.stringify(plan)); db.close(); db = null;
    const child = spawnSync(process.execPath, [new URL('./fixtures/table-migration-crash.mjs', import.meta.url).pathname, path, planPath], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    for (let opening = 0; opening < 2; opening++) {
      db = await driver.open(path); db.exec('PRAGMA foreign_keys=ON');
      if (opening === 0) assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all([]).map((r) => ({ ...r })), original);
      assert.equal(db.prepare('PRAGMA integrity_check').get([]).integrity_check, 'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all([]).length, 0);
      applyTableMigration(db, plan); assert.deepEqual(applyTableMigration(db, plan), { changed: 0 });
      assert.deepEqual([...db.prepare('SELECT bytes FROM history').get([]).bytes], [0, 1, 255]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM child').get([]).n, 1);
      db.close(); db = null;
    }
  }
  finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
