//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planTable, planSchemaChange, applySchemaChange, sql } from '@jarenjs/db/relational';

const driver = async () => process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
const change = (db, operation) => applySchemaChange(db, planSchemaChange(db, operation));
const objects = (db) => db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name').all([]).map((row) => ({ ...row }));
const columns = (db) => db.prepare('PRAGMA main.table_xinfo(entries)').all([]).map((row) => ({ ...row }));
const rows = (db) => db.prepare('SELECT rowid,key,payload,raw,typeof(payload) AS storage FROM main.entries ORDER BY rowid').all([]).map((row) => ({ ...row }));
async function fixture(run) {
  const db = await (await driver()).open(':memory:');
  try { await run(db); } finally { db.close(); }
}
const seed = (db) => db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE parents(id INTEGER PRIMARY KEY);INSERT INTO parents VALUES(1);
  CREATE TABLE entries(key TEXT PRIMARY KEY,payload BLOB,raw TEXT DEFAULT 'historical',plugin TEXT CHECK(plugin IS NULL OR length(plugin)>1));
  CREATE INDEX retained_raw ON entries(raw);CREATE INDEX obsolete ON entries(payload);
  CREATE TRIGGER immutable_raw BEFORE UPDATE OF raw ON entries BEGIN SELECT RAISE(ABORT,'immutable raw');END;
  INSERT INTO entries(rowid,key,payload,raw) VALUES(17,'a',X'0001FF',' { "a": 0 } '),(41,'b','007','unaltered');`);
const additions = [
  { name: 'revision', type: 'INTEGER', nullable: false, default: 1, check: sql.binary('>=', sql.column('revision'), 1) },
  { name: 'note', type: 'TEXT' },
  { name: 'parent', type: 'INTEGER', references: { table: 'parents', columns: ['id'], onDelete: 'set null', onUpdate: 'cascade' } },
];
function upgrade(db) {
  return db.transaction(() => {
    let changed = 0;
    const present = new Set(columns(db).map((column) => column.name));
    for (const column of additions) if (!present.has(column.name)) changed += change(db, { op: 'addColumn', table: 'entries', column }).changed;
    changed += change(db, { op: 'dropIndex', name: 'obsolete', ifExists: true }).changed;
    return changed;
  }, { mode: 'immediate' });
}

it('additive plans append only the requested column and preserve unknown schema objects, rowids and storage', async () => fixture((db) => {
  seed(db);
  const before = objects(db), originalRows = rows(db), originalColumns = columns(db);
  const plan = planSchemaChange(db, { op: 'addColumn', table: 'entries', column: additions[0] });
  assert.equal(plan.sql, 'ALTER TABLE "main"."entries" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1 CHECK (("revision" >= 1))');
  assert.deepEqual(objects(db), before, 'planning never changes physical schema');
  assert.deepEqual(rows(db), originalRows);
  assert.deepEqual(applySchemaChange(db, JSON.parse(JSON.stringify(plan))), { changed: 1 });
  assert.deepEqual(columns(db).slice(0, originalColumns.length), originalColumns);
  assert.deepEqual(rows(db), originalRows);
  assert.deepEqual(objects(db).filter((o) => o.name !== 'entries'), before.filter((o) => o.name !== 'entries'));
  assert.equal(objects(db).find((o) => o.name === 'entries').rootpage, before.find((o) => o.name === 'entries').rootpage);
  assert.equal(db.prepare('SELECT sum(revision) AS n FROM entries').get([]).n, 2);
  assert.throws(() => db.exec('UPDATE entries SET revision=0'), /CHECK/);
  assert.throws(() => db.exec("UPDATE entries SET plugin='x'"), /CHECK/);
  assert.throws(() => db.exec('UPDATE entries SET raw=raw'), /immutable raw/);
  assert.throws(() => applySchemaChange(db, plan), { code: 'JD0021' }, 'a completed plan is a stale source, not an implicit receipt');
  assert.equal(upgrade(db), 3);
  assert.equal(upgrade(db), 0);
  assert.deepEqual(columns(db).map((c) => c.name), ['key', 'payload', 'raw', 'plugin', 'revision', 'note', 'parent']);
  assert.equal(db.prepare('SELECT note,parent FROM entries').get([]).note, null);
  assert.throws(() => db.exec('UPDATE entries SET parent=999'), /FOREIGN KEY/);
  db.exec('UPDATE entries SET parent=1;UPDATE parents SET id=2');
  assert.equal(db.prepare('SELECT parent FROM entries').get([]).parent, 2);
  db.exec('DELETE FROM parents');
  assert.equal(db.prepare('SELECT parent FROM entries').get([]).parent, null);
  assert.deepEqual(rows(db), originalRows);
}));

it('additive upgrades roll back and repeated openings leave rows and schema unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-additive-'));
  const path = join(directory, 'data.db');
  const host = await driver();
  let db = await host.open(path);
  try {
    seed(db); const before = objects(db), originalRows = rows(db);
    assert.throws(() => db.transaction(() => { upgrade(db); throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(objects(db), before); assert.deepEqual(rows(db), originalRows);
    assert.equal(upgrade(db), 4);
    const complete = objects(db);
    for (let i = 0; i < 2; i++) {
      db.close(); db = await host.open(path); db.exec('PRAGMA foreign_keys=ON');
      assert.equal(upgrade(db), 0);
      assert.deepEqual(objects(db), complete); assert.deepEqual(rows(db), originalRows);
      assert.equal(db.prepare('PRAGMA integrity_check').get([]).integrity_check, 'ok');
    }
  }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('schema changes refuse stale source/settings, altered SQL and unavailable connection ownership', async () => fixture((db) => {
  seed(db);
  const operation = { op: 'addColumn', table: 'entries', column: additions[0] };
  let plan = planSchemaChange(db, operation);
  operation.column = additions[1];
  assert.equal(plan.operation.column.name, 'revision', 'reviewed operation is detached');
  assert.throws(() => applySchemaChange(db, { ...plan, sql: 'DROP TABLE entries' }), { code: 'JD0021' });
  db.exec('CREATE INDEX concurrent ON entries(plugin)');
  assert.throws(() => applySchemaChange(db, plan), { code: 'JD0021' });
  plan = planSchemaChange(db, operation);
  db.exec('PRAGMA legacy_alter_table=ON');
  assert.throws(() => applySchemaChange(db, plan), { code: 'JD0021' });
  db.exec('PRAGMA legacy_alter_table=OFF;PRAGMA foreign_keys=OFF');
  assert.throws(() => applySchemaChange(db, plan), { code: 'JD0021' });
  db.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(applySchemaChange(db, plan), { changed: 1 });
  for (const unavailable of [{ synchronous: false }, { mustQueue: true }, { dialect: { name: 'postgres' } }]) {
    assert.throws(() => planSchemaChange({ ...db, ...unavailable }, operation), { code: 'JD0021' });
    assert.throws(() => applySchemaChange({ ...db, ...unavailable }, plan), { code: 'JD0021' });
  }
}));

it('native schema operations quote identifiers, target main and expose explicit drop absence', async () => fixture((db) => {
  const name = 'quoted".table';
  for (const text of planTable({ name, columns: [{ name: 'id', type: 'INTEGER' }] }).createSql) db.exec(text);
  db.exec('CREATE TEMP TABLE "quoted"".table"(untouched TEXT)');
  const added = { op: 'addColumn', table: name, column: { name: 'odd"column', type: 'TEXT', default: "a'b" } };
  assert.equal(change(db, added).changed, 1);
  assert.equal(db.prepare('PRAGMA temp.table_info("quoted"".table")').all([]).length, 1);
  assert.equal(change(db, { op: 'renameTable', table: name, to: 'renamed".table' }).changed, 1);
  assert.equal(change(db, { op: 'dropTable', table: 'renamed".table' }).changed, 1);
  assert.throws(() => change(db, { op: 'dropTable', table: 'renamed".table' }), /no such table/);
  assert.equal(change(db, { op: 'dropTable', table: 'renamed".table', ifExists: true }).changed, 0);
  assert.throws(() => change(db, { op: 'dropIndex', name: 'missing' }), /no such index/);
  assert.equal(change(db, { op: 'dropIndex', name: 'missing', ifExists: true }).changed, 0);
  const absent = planSchemaChange(db, { op: 'dropIndex', name: 'missing', ifExists: true });
  assert.deepEqual(applySchemaChange(db, absent), { changed: 0 });
  assert.deepEqual(applySchemaChange(db, absent), { changed: 0 });
  assert.equal(db.prepare('PRAGMA temp.table_info("quoted"".table")').all([]).length, 1);
}));

it('one column renderer validates native additive restrictions and propagates data constraint failures', async () => fixture((db) => {
  seed(db);
  const before = objects(db);
  const invalid = [
    { name: 'x', type: 'INTEGER', identity: 'rowid' },
    { name: 'x', type: 'TEXT', default: sql.call('datetime', ['now']) },
    { name: 'x', type: 'INTEGER', nullable: false },
    { name: 'x', type: 'INTEGER', nullable: false, default: null },
    { name: 'x', type: 'INTEGER', generated: 1, stored: true },
    { name: 'x', type: 'INTEGER', default: 1, references: { table: 'parents', columns: ['id'] } },
    { name: 'x', type: 'INTEGER', references: { table: 'parents', columns: ['id', 'other'] } },
    { name: 'x', type: 'INTEGER', references: { table: 'parents', columns: ['id'], deferred: 'yes' } },
    { name: 'x', type: 'TEXT', raw: 'SQL' },
  ];
  for (const column of invalid) assert.throws(() => planSchemaChange(db, { op: 'addColumn', table: 'entries', column }), { code: 'JD0005' });
  for (const operation of [{ op: 'unknown' }, { op: 'dropTable', table: 'entries', ifExists: 'yes' },
    { op: 'renameTable', table: 'entries', to: 'next', ifExists: true }]) assert.throws(() => planSchemaChange(db, operation), { code: 'JD0005' });
  assert.throws(() => change(db, { op: 'addColumn', table: 'entries', column: { name: 'x', type: 'INTEGER', default: 0, check: sql.binary('>', sql.column('x'), 0) } }), /CHECK/);
  assert.deepEqual(objects(db), before);
  assert.equal(change(db, { op: 'addColumn', table: 'entries', column: { name: 'virtual', type: 'INTEGER', generated: sql.call('length', [sql.column('raw')]) } }).changed, 1);
  assert.equal(change(db, { op: 'addColumn', table: 'entries', column: { name: 'literal', type: 'INTEGER', default: sql.value(7) } }).changed, 1);
  assert.equal(change(db, { op: 'addColumn', table: 'entries', column: { name: 'wide', type: 'INTEGER', default: 9007199254740993n } }).changed, 1);
  assert.equal(db.prepare('SELECT CAST(wide AS TEXT) AS value FROM entries').get([]).value, '9007199254740993');
  const definition = { name: 'inline_ref', columns: [{ name: 'parent', type: 'INTEGER', references: { table: 'parents', columns: ['id'], deferred: true } }] };
  for (const text of planTable(definition).createSql) db.exec(text);
  assert.throws(() => db.exec('INSERT INTO inline_ref VALUES(99)'), /FOREIGN KEY/);
}));
