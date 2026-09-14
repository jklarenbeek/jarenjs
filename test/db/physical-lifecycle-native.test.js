//@ts-check
/** Native receipts, guarded rebuilds and application initialization share one owner. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCrash } from './fixtures/abrupt-exit.js';
import { planTable, planTableMigration, applyTableMigration, planPhysicalMigration, migrate, readSchema,
  withForeignKeysSuspended } from '@jarenjs/db';

const driver = async () => process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
const beforeTable = { name: 'items', primaryKey: ['id'], columns: [
  { name: 'id', type: 'INTEGER', identity: 'autoincrement', nullable: false },
  { name: 'payload', type: 'BLOB', nullable: false }, { name: 'raw', type: 'TEXT', nullable: false },
] };
const afterTable = { ...beforeTable, columns: [...beforeTable.columns,
  { name: 'revision', type: 'INTEGER', nullable: false, default: 7 },
] };
const baseline = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, payload: { type: 'string' }, raw: { type: 'string' },
} }, physical: { table: 'items', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, payload: { name: 'payload', codec: 'blob-hex', null: 'reject' },
  raw: { name: 'raw', codec: 'text', null: 'reject' },
} } } } };
const model = structuredClone(baseline);
model.entities.Item.schema.properties.revision = { type: 'integer' };
model.entities.Item.physical.columns.revision = { name: 'revision', codec: 'integer', null: 'reject' };
const rows = (db, sql) => db.prepare(sql).all([]).map((row) => ({ ...row }));
const receipts = (db) => rows(db, 'SELECT * FROM _jaren_migrations ORDER BY rowid');
const snapshot = (db) => ({
  objects: rows(db, 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'),
  items: rows(db, 'SELECT id,hex(payload) AS payload,raw FROM items ORDER BY id'),
  audit: rows(db, 'SELECT item,hex(payload) AS payload FROM audit ORDER BY item'),
  initialized: rows(db, 'SELECT * FROM app_state ORDER BY id'),
  allocation: rows(db, 'SELECT * FROM sqlite_sequence ORDER BY name'), receipts: receipts(db),
});

function seed(db) {
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of planTable(beforeTable).createSql) db.exec(sql);
  db.exec(`CREATE TABLE audit(item INTEGER REFERENCES items(id) ON DELETE CASCADE,payload BLOB NOT NULL);
    CREATE TRIGGER item_added AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(NEW.id,NEW.payload); END;
    CREATE INDEX items_raw ON items(raw);
    CREATE VIEW item_view AS SELECT id,payload,raw FROM items;
    CREATE TABLE app_state(id INTEGER PRIMARY KEY,phase TEXT);
    INSERT INTO app_state VALUES(1,'original');
    INSERT INTO items VALUES(1,X'0001FF',' { "kept" : true } ');
    INSERT INTO items VALUES(99,X'FF','retired'); DELETE FROM items WHERE id=99;`);
}

/** Review the upgrade before the existing receipt is created. */
async function review(db, host) {
  const source = readSchema(db).objects;
  const preserved = Object.fromEntries(source.map((object) => [`${object.type}:${object.name}`, 'preserve']));
  const bootstrap = planPhysicalMigration(db, baseline, baseline, { id: 'baseline', steps: [], dispositions: preserved });
  const table = planTableMigration(db, afterTable, { id: 'upgrade', allowRebuild: true });
  const fixture = await host.open(':memory:');
  let physicalTarget;
  try {
    seed(fixture);
    applyTableMigration(fixture, planTableMigration(fixture, afterTable, { id: 'upgrade', allowRebuild: true }));
    physicalTarget = { objects: readSchema(fixture).objects };
  }
  finally { fixture.close(); }
  const upgrade = planPhysicalMigration(db, baseline, model, { id: 'upgrade', steps: [{ kind: 'table', plan: table }],
    dispositions: { ...preserved, 'table:items': 'replace' }, physicalTarget });
  const initialized = migrate({ connection: db }, [bootstrap],
    { baseline, model: baseline, shadow: false, physicalTarget: { objects: source } });
  assert.equal(typeof initialized?.then, 'undefined', 'borrowed native migration settles synchronously');
  assert.deepEqual(initialized.applied, ['baseline']);
  return { migrations: [bootstrap, upgrade], options: { baseline, model, shadow: false, physicalTarget } };
}

for (const boundary of ['drop', 'receipt', 'commit']) {
  it(`a process killed at ${boundary} leaves the guarded table and existing receipts unchanged`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-physical-lifecycle-'));
    const path = join(directory, 'data.sqlite'), input = join(directory, 'migration.json');
    const host = await driver();
    let db;
    try {
      db = await host.open(path);
      db.exec('PRAGMA journal_mode=WAL'); seed(db);
      const spec = await review(db, host), original = snapshot(db);
      assert.equal(original.allocation.find((row) => row.name === 'items').seq, 99);
      writeFileSync(input, JSON.stringify(spec));
      db.close(); db = null;
      const child = spawnSync(process.execPath,
        [fileURLToPath(new URL('./fixtures/physical-lifecycle-crash.mjs', import.meta.url)), path, input, boundary],
        { encoding: 'utf8', timeout: 15000 });
      assertCrash(child, boundary);
      assert.equal(readFileSync(`${input}.boundary`, 'utf8'), boundary, 'the requested native operation was reached');
      db = await host.open(path); db.exec('PRAGMA foreign_keys=ON');
      assert.deepEqual(snapshot(db), original, 'schema, rows, allocation and prior receipts roll back together');
      assert.equal(db.prepare('PRAGMA integrity_check').get([]).integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all([]), []);
      assert.deepEqual(migrate({ connection: db }, spec.migrations, spec.options).applied, ['upgrade']);
      assert.deepEqual(receipts(db).map((row) => row.id), ['baseline', 'upgrade']);
      assert.deepEqual(receipts(db)[0], original.receipts[0], 'the existing receipt is untouched');
      assert.deepEqual(rows(db, 'SELECT revision FROM items'), [{ revision: 7 }]);
      const complete = snapshot(db);
      assert.deepEqual(migrate({ connection: db }, spec.migrations, spec.options),
        { applied: [], skipped: ['baseline', 'upgrade'], upToDate: true });
      assert.deepEqual(snapshot(db), complete, 'the repeated accepted startup writes nothing');
      const inserted = db.prepare("INSERT INTO items(payload,raw) VALUES(X'FF','later')").run([]);
      assert.equal(Number(inserted.lastInsertRowid), 100, 'guarded execution preserves the retired allocation high-water mark');
      assert.deepEqual(rows(db, 'SELECT item FROM audit ORDER BY item'), [{ item: 1 }, { item: 100 }]);
      db.close(); db = await host.open(path);
      assert.equal(migrate({ connection: db }, spec.migrations, spec.options).upToDate, true);
      assert.deepEqual(receipts(db).map((row) => row.id), ['baseline', 'upgrade']);
      assert.equal(db.prepare('SELECT count(*) AS n FROM items').get([]).n, 2);
    }
    finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

it('borrowed memory migrations compose synchronously with initialization and acceptance rollback', async () => {
  const host = await driver(), db = await host.open(':memory:');
  let closes = 0;
  const connection = { ...db, get mustQueue() { return db.mustQueue; }, close() { closes++; return db.close(); } };
  try {
    seed(db);
    const spec = await review(connection, host), original = snapshot(db);
    for (const failure of ['initialization', 'acceptance']) {
      const options = structuredClone(spec.options);
      if (failure === 'acceptance') options.physicalTarget.objects.push({ type: 'index', name: 'required_revision', owner: 'items',
        sql: 'CREATE INDEX required_revision ON items(revision)' });
      assert.throws(() => withForeignKeysSuspended(connection, () => {
        connection.exec("UPDATE app_state SET phase='starting'");
        const result = migrate({ connection }, spec.migrations, options);
        assert.equal(typeof result?.then, 'undefined');
        assert.deepEqual(result.applied, ['upgrade']);
        assert.equal(receipts(connection).length, 2, 'the receipt exists only inside the pending owner');
        throw new Error('initialization failed');
      }), failure === 'acceptance' ? { code: 'JD0023' } : /initialization failed/);
      assert.equal(closes, 0);
      assert.deepEqual(snapshot(db), original, 'initialization and migration roll back as one unit');
      assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table, 0);
    }
    const committed = withForeignKeysSuspended(connection, () => {
      const result = migrate({ connection }, spec.migrations, spec.options);
      connection.exec("UPDATE app_state SET phase='ready'");
      return result;
    });
    assert.equal(typeof committed?.then, 'undefined');
    assert.deepEqual(committed.applied, ['upgrade']);
    assert.equal(closes, 0);
    assert.equal(db.prepare('SELECT phase FROM app_state').get([]).phase, 'ready');
    assert.deepEqual(receipts(db).map((row) => row.id), ['baseline', 'upgrade']);
    const beforeRepeat = snapshot(db);
    assert.equal(migrate({ connection }, spec.migrations, spec.options).upToDate, true);
    assert.deepEqual(snapshot(db), beforeRepeat);
    assert.equal(closes, 0);
  }
  finally { db.close(); }
});
