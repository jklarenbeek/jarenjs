//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { planTableMigration } from '@jarenjs/db/relational';
import { target, upgradeIdentity } from './fixtures/schema-upgrade.mjs';
const host = async () => process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
const snapshot = (db) => db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all([]).map((row) => ({ ...row }));
const data = (db) => db.prepare('SELECT * FROM preferences ORDER BY entity_id,value').all([]).map((row) => ({ ...row }));
const history = (db) => [...db.prepare('SELECT payload FROM history').get([]).payload];
const seed = (db) => db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
  CREATE TABLE owners(id INTEGER PRIMARY KEY,scope TEXT,product INTEGER);
  INSERT INTO owners VALUES(1,'first',10),(2,'second',10),(3,'first',90);
  CREATE TABLE candidates(id INTEGER PRIMARY KEY,scope TEXT,product INTEGER,area INTEGER,slot INTEGER);
  INSERT INTO candidates VALUES(8,'first',10,7,1),(4,'first',10,7,1),(1,'second',10,7,1),(2,'first',99,7,1);
  CREATE TABLE preferences(entity_id INTEGER,area INTEGER,slot INTEGER,value TEXT,PRIMARY KEY(entity_id,area,slot));
  INSERT INTO preferences VALUES(1,7,1,'keep-a'),(2,7,1,'keep-b'),(3,7,1,'unmatched-product'),(1,9,1,'unmatched-area');
  CREATE TABLE history(id INTEGER PRIMARY KEY,owner INTEGER REFERENCES owners(id),payload BLOB);
  INSERT INTO history VALUES(1,1,X'0001FF');
  CREATE TRIGGER history_immutable BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'immutable history');END;`);

it('an explicit identity policy selects scoped minimum IDs, accounts for excluded rows and repeats without changes', async () => {
  const db = await (await host()).open(':memory:');
  try {
    seed(db);
    assert.throws(() => planTableMigration(db, target, { id: 'not-authorized', allowRebuild: true }), { code: 'JD0021' });
    const before = snapshot(db), old = data(db);
    assert.throws(() => db.transaction(() => { upgradeIdentity(db); throw new Error('rollback'); }), /outer migration scope/);
    const { withForeignKeysSuspended } = await import('@jarenjs/db/relational');
    assert.throws(() => withForeignKeysSuspended(db, () => { upgradeIdentity(db); throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(data(db), old);
    assert.deepEqual(upgradeIdentity(db), { changed: 1, retained: 2, excluded: 2 });
    assert.deepEqual(data(db), [{ entity_id: 1, source_id: 4, value: 'keep-a' }, { entity_id: 2, source_id: 1, value: 'keep-b' }]);
    const complete = snapshot(db);
    assert.deepEqual(upgradeIdentity(db), { changed: 0, retained: 0, excluded: 0 });
    assert.deepEqual(snapshot(db), complete);
    assert.deepEqual(history(db), [0, 1, 255]);
    assert.deepEqual(complete.filter((o) => !['preferences', 'sqlite_autoindex_preferences_1'].includes(o.name)), before.filter((o) => !['preferences', 'sqlite_autoindex_preferences_1'].includes(o.name)));
    assert.throws(() => db.exec('UPDATE history SET payload=payload'), /immutable history/);
    assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all([]).length, 0);
  }
  finally { db.close(); }
});

it('a killed key-changing upgrade recovers its original schema and reruns once across reopened databases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-identity-crash-'));
  const path = join(directory, 'data.db');
  const driver = await host();
  let db = await driver.open(path);
  try {
    seed(db); const before = snapshot(db), old = data(db);
    db.close(); db = null;
    const child = spawnSync(process.execPath, [new URL('./fixtures/schema-upgrade.mjs', import.meta.url).pathname, path], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    for (let opening = 0; opening < 3; opening++) {
      db = await driver.open(path); db.exec('PRAGMA foreign_keys=ON');
      if (opening === 0) { assert.deepEqual(snapshot(db), before); assert.deepEqual(data(db), old); }
      assert.equal(db.prepare('PRAGMA integrity_check').get([]).integrity_check, 'ok');
      assert.equal(upgradeIdentity(db).changed, opening === 0 ? 1 : 0);
      assert.deepEqual(upgradeIdentity(db), { changed: 0, retained: 0, excluded: 0 });
      assert.deepEqual(data(db), [{ entity_id: 1, source_id: 4, value: 'keep-a' }, { entity_id: 2, source_id: 1, value: 'keep-b' }]);
      assert.deepEqual(history(db), [0, 1, 255]);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all([]).length, 0);
      db.close(); db = null;
    }
  }
  finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
