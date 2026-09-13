//@ts-check
/** Complete physical acceptance and explicit migration connection ownership. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus, planPhysicalMigration, readSchema, shapeHash,
  planTableMigration, applyTableMigration, withForeignKeysSuspended, compareShapeToModel,
  createModelShape } from '@jarenjs/db';

const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, value: { type: 'string' },
} }, physical: { table: 'rows', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'reject' },
} } } } };
const sql = "CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT DEFAULT 'a  b' CHECK(length(value)>0)); CREATE INDEX by_value ON rows(value COLLATE BINARY) WHERE value!='x  y'; CREATE TRIGGER retained AFTER DELETE ON rows BEGIN SELECT 'a  b'; END";
const seed = (db) => db.exec(`${sql}; INSERT INTO rows(id,value) VALUES(1,'original')`);
const targetOf = (db, tables = undefined) => ({ objects: readSchema(db, { tables }).objects, ...(tables === undefined ? {} : { tables }) });
const document = (id, steps = []) => ({ $migration: '0.1', id, from: shapeHash(model), to: shapeHash(model), steps });
async function fixture(run) {
  const db = await driver.open(':memory:');
  try { return await run(db); }
  finally { db.close(); }
}

it('a reviewed target checks repeated startup and status while unrelated tables remain outside ownership', async () => fixture((db) => {
  seed(db);
  const target = targetOf(db);
  const plan = planPhysicalMigration(db, model, model, { id: 'adopt', steps: [],
    dispositions: { 'table:rows': 'preserve', 'index:by_value': 'preserve', 'trigger:retained': 'preserve' }, physicalTarget: target });
  assert.deepEqual(migrate({ connection: db }, [plan], { baseline: model, model, shadow: false }).applied, ['adopt']);
  db.exec('CREATE TABLE unrelated(note TEXT)');
  assert.equal(migrationStatus({ connection: db }, [plan], { model }).upToDate, true);
  assert.deepEqual(migrate({ connection: db }, [plan], { baseline: model, model, shadow: false }),
    { applied: [], skipped: ['adopt'], upToDate: true });
  db.exec('ALTER TABLE rows ADD COLUMN undeclared INTEGER');
  assert.equal(migrationStatus({ connection: db }, [plan], { model }).drift, 'different table:rows');
  assert.throws(() => migrate({ connection: db }, [plan], { baseline: model, model, shadow: false }), { code: 'JD0023' });
  assert.equal(db.prepare('SELECT count(*) n FROM _jaren_migrations').get([]).n, 1);
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'original');
}));

for (const kind of ['literal', 'check', 'foreignKey', 'index', 'trigger', 'extraObject', 'missingObject', 'columnOrder']) {
  it(`complete target detects ${kind} drift through both public entry points`, async () => fixture(async (db) => {
    seed(db);
    const target = targetOf(db);
    if (kind === 'literal' || kind === 'check' || kind === 'foreignKey' || kind === 'columnOrder') {
      db.exec('DROP TABLE rows');
      const body = kind === 'columnOrder' ? "value TEXT DEFAULT 'a  b' CHECK(length(value)>0),id INTEGER PRIMARY KEY"
        : `id INTEGER PRIMARY KEY,value TEXT DEFAULT '${kind === 'literal' ? 'a b' : 'a  b'}' CHECK(length(value)>${kind === 'check' ? '1' : '0'})${kind === 'foreignKey' ? ',FOREIGN KEY(id) REFERENCES parent(id)' : ''}`;
      db.exec(`CREATE TABLE rows(${body}); CREATE INDEX by_value ON rows(value COLLATE BINARY) WHERE value!='x  y'; CREATE TRIGGER retained AFTER DELETE ON rows BEGIN SELECT 'a  b'; END`);
    }
    else if (kind === 'index') db.exec("DROP INDEX by_value; CREATE INDEX by_value ON rows(value COLLATE NOCASE) WHERE value!='x  y'");
    else if (kind === 'trigger') db.exec("DROP TRIGGER retained; CREATE TRIGGER retained AFTER DELETE ON rows BEGIN SELECT 'a b'; END");
    else if (kind === 'extraObject') db.exec('CREATE INDEX unexpected ON rows(id,value)');
    else db.exec('DROP TRIGGER retained');
    const report = migrationStatus({ connection: db }, [], { physicalTarget: target });
    assert.equal(report.upToDate, false);
    assert.match(report.drift, /different|unexpected|missing/);
    assert.throws(() => migrate({ connection: db }, [], { baseline: model, shadow: false, physicalTarget: target }), { code: 'JD0023' });
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  }));
}

it('formatting-only physical targets agree and explicitly owned drops remain absent', async () => fixture((db) => {
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT)');
  const target = { objects: [{ type: 'table', name: 'rows', owner: 'rows', sql: 'CREATE /* reviewed */ TABLE IF NOT EXISTS rows ( id INTEGER PRIMARY KEY, value TEXT )' }], tables: ['rows', 'retired'] };
  assert.equal(migrationStatus({ connection: db }, [], { physicalTarget: target }).upToDate, true);
  db.exec('CREATE TABLE retired(id INTEGER)');
  assert.equal(migrationStatus({ connection: db }, [], { physicalTarget: target }).drift, 'unexpected table:retired');
}));

it('borrowed synchronous startup keeps its handle and joins the caller rollback boundary', async () => fixture((db) => {
  seed(db);
  const target = targetOf(db), plan = document('change', [{ kind: 'sql', sql: "UPDATE rows SET value='changed'" }]);
  assert.throws(() => withForeignKeysSuspended(db, () => {
    db.exec('CREATE TABLE initialized(id INTEGER)');
    const result = migrate({ connection: db }, [plan], { baseline: model, model, physicalTarget: target, shadow: false });
    assert.equal(typeof result?.then, 'undefined');
    assert.deepEqual(result.applied, ['change']);
    assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'changed');
    throw new Error('startup acceptance failed');
  }), /startup acceptance failed/);
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'original');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('initialized','_jaren_migrations')").get([]).n, 0);
  const signal = AbortSignal.abort();
  assert.throws(() => migrate({ connection: db }, [plan], { baseline: model, shadow: false, signal }), { code: 'JD2080' });
  assert.throws(() => migrationStatus({ connection: db }, [plan], { signal }), { code: 'JD2080' });
  assert.equal(db.prepare('SELECT 1 AS n').get([]).n, 1);
}));

it('owned acquisition closes exactly once when registration fails, and borrowed registration never closes', async () => {
  for (const asynchronous of [false, true]) {
    const db = await driver.open(':memory:');
    let closes = 0;
    const target = { driver: { ...driver, open: () => ({ ...db, close: () => { closes++; return db.close(); } }) } };
    const failure = new Error('registration failed');
    const run = () => migrate(target, [], { baseline: model, shadow: false,
      registerFunctions: () => { if (asynchronous) return Promise.reject(failure); throw failure; } });
    await assert.rejects(async () => run(), (error) => error === failure);
    assert.equal(closes, 1);
  }
  await fixture((db) => {
    assert.throws(() => migrate({ connection: db }, [], { baseline: model, shadow: false,
      registerFunctions: () => { throw new Error('borrowed registration'); } }), /borrowed registration/);
    assert.equal(db.prepare('SELECT 1 n').get([]).n, 1);
  });
});

it('owned cleanup retains both failures when closing also fails', async () => {
  for (const asynchronous of [false, true]) {
    const db = await driver.open(':memory:');
    const failure = new Error('body failed'), closeFailure = new Error('close failed');
    let closes = 0;
    const target = { driver: { ...driver, open: () => ({ ...db, close: () => {
      closes++; db.close(); if (asynchronous) return Promise.reject(closeFailure); throw closeFailure;
    } }) } };
    await assert.rejects(async () => migrate(target, [], { baseline: model, shadow: false,
      registerFunctions: () => { throw failure; } }), (error) => error instanceof AggregateError
        && error.errors[0] === failure && error.errors[1] === closeFailure);
    assert.equal(closes, 1);
  }
});

it('explicit populated fixture replay runs the same guarded history before the borrowed primary', async () => fixture(async (db) => {
  seed(db);
  const plan = planTableMigration(db, { name: 'rows', primaryKey: ['id'], columns: [
    { name: 'id', type: 'INTEGER' }, { name: 'value', type: 'TEXT' }, { name: 'extra', type: 'INTEGER', default: 7 },
  ] }, { id: 'widen', allowRebuild: true });
  const target = await fixture((reference) => { seed(reference); applyTableMigration(reference, plan); return targetOf(reference); });
  const migration = planPhysicalMigration(db, model, model, { id: 'widen', steps: [{ kind: 'table', plan }],
    dispositions: { 'table:rows': 'replace', 'index:by_value': 'preserve', 'trigger:retained': 'preserve' }, physicalTarget: target });
  let fixtures = 0;
  const options = { baseline: model, model, shadowDriver: driver, shadowFixture: (shadow) => { fixtures++; seed(shadow); } };
  assert.deepEqual((await migrate({ connection: db }, [migration], options)).applied, ['widen']);
  assert.equal(fixtures, 1);
  assert.deepEqual((await migrate({ connection: db }, [migration], options)).applied, []);
  assert.equal(fixtures, 1, 'checked repeat does not replay an already applied chain');
  assert.deepEqual({ ...db.prepare('SELECT * FROM rows').get([]) }, { id: 1, value: 'original', extra: 7 });
  assert.equal(migrationStatus({ connection: db }, [migration], { model }).upToDate, true);
  const edited = structuredClone(migration); edited.steps[0].plan.id = 'edited';
  assert.throws(() => migrate({ connection: db }, [edited], { baseline: model, shadow: false }), { code: 'JD0022' });
}));

it('fixture failure closes its owned handle and leaves primary bytes and history unchanged', async () => fixture(async (db) => {
  seed(db);
  let closes = 0;
  const shadowDriver = { ...driver, open: async (...args) => {
    const shadow = await driver.open(...args);
    return { ...shadow, close: () => { closes++; return shadow.close(); } };
  } };
  await assert.rejects(async () => migrate({ connection: db }, [document('change')], { baseline: model,
    shadowDriver, shadowFixture: (shadow) => { seed(shadow); throw new Error('fixture rejected'); } }), /fixture rejected/);
  assert.equal(closes, 1);
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'original');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
}));

it('borrowed model-only status needs an independent reference driver and ownership targets cannot mix', async () => fixture(async (db) => {
  seed(db);
  assert.throws(() => migrationStatus({ connection: db }, [], { model }), /shadowDriver/);
  assert.equal((await migrationStatus({ connection: db }, [], { model, shadowDriver: driver })).upToDate, false);
  for (const target of [{ connection: db, driver }, { connection: db, path: ':memory:' }, { connection: db, busyTimeout: 0 }, { connection: {} }])
    assert.throws(() => migrate(target, [], { baseline: model, shadow: false }), /migration target/);
  assert.throws(() => migrate({ connection: db }, [document('pending')], { baseline: model }), /independent driver/);
}));

it('transaction aliases and trailing statements refuse before any migration write', async () => fixture((db) => {
  seed(db);
  for (const text of ["UPDATE rows SET value='changed'; END;", "UPDATE rows SET value='changed'; END TRANSACTION;",
    'END', 'BEGIN IMMEDIATE', 'PRAGMA foreign_keys=OFF', 'VACUUM', 'SELECT 1',
    'CREATE TRIGGER escape AFTER DELETE ON rows BEGIN SELECT 1; END; END;',
    'CREATE TRIGGER broken AFTER DELETE ON rows BEGIN SELECT 1;',
    'CREATE TRIGGER broken AFTER DELETE ON rows SELECT 1']) {
    assert.throws(() => migrate({ connection: db }, [document('escape', [{ kind: 'sql', sql: text }])],
      { baseline: model, shadow: false }), { code: 'JD0021' });
    assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'original');
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  }
  const allowed = document('trigger', [{ kind: 'ddl', sql: "CREATE TRIGGER safe AFTER UPDATE ON rows BEGIN SELECT CASE WHEN NEW.value='END; COMMIT' THEN 1 ELSE 2 END; END;" }]);
  assert.deepEqual(migrate({ connection: db }, [allowed], { baseline: model, shadow: false }).applied, ['trigger']);
}));

it('fixture cancellation reaches the replay before data steps and closes the owned shadow', async () => fixture(async (db) => {
  seed(db);
  const controller = new AbortController();
  let closes = 0, writes = 0;
  const shadowDriver = { ...driver, open: async (...args) => {
    const shadow = await driver.open(...args);
    return { ...shadow, close: () => { closes++; return shadow.close(); } };
  } };
  await assert.rejects(async () => migrate({ connection: db }, [document('change', [{ kind: 'sql', sql: "UPDATE rows SET value='changed'" }])],
    { baseline: model, dryRun: true, shadowDriver, signal: controller.signal,
      onProgress: () => { writes++; }, shadowFixture: (shadow) => { seed(shadow); controller.abort(); } }), { code: 'JD2080' });
  assert.equal(closes, 1); assert.equal(writes, 0);
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 'original');
}));

it('target mismatch rolls back the step and receipt, and guarded dry runs write nothing', async () => fixture((db) => {
  seed(db);
  const target = targetOf(db);
  const changed = document('column', [{ kind: 'ddl', sql: 'ALTER TABLE rows ADD COLUMN extra INTEGER' }]);
  assert.throws(() => migrate({ connection: db }, [changed], { baseline: model, shadow: false, physicalTarget: target }), { code: 'JD0023' });
  assert.equal(migrationStatus({ connection: db }, [], { physicalTarget: target }).upToDate, true);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  const plan = planTableMigration(db, { name: 'rows', primaryKey: ['id'], columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'TEXT' }, { name: 'extra', type: 'INTEGER' }] }, { id: 'review', allowRebuild: true });
  const dry = migrate({ connection: db }, [document('review', [{ kind: 'table', plan }])], { baseline: model, shadow: false, dryRun: true });
  assert.match(dry.statements[0], /guarded table/);
  assert.ok(dry.statements.some((text) => text.startsWith('DROP TABLE')));
  assert.equal(migrationStatus({ connection: db }, [], { physicalTarget: target }).upToDate, true);
}));

it('invalid complete target inventories refuse before creating history', async () => fixture((db) => {
  seed(db);
  const object = targetOf(db).objects[0];
  for (const target of [null, {}, { objects: [], unknown: true }, { objects: [object, object] },
    { objects: [{ ...object, sql: null }] }, { objects: [{ ...object, name: '_jaren_migrations' }] },
    { objects: [object], tables: [] }, { objects: [], tables: ['rows', 'rows'] },
    { objects: [{ type: 'index', name: 'orphan', owner: 'absent', sql: 'CREATE INDEX orphan ON absent(id)' }] }]) {
    assert.throws(() => migrate({ connection: db }, [], { baseline: model, shadow: false, physicalTarget: target }), { code: 'JD0021' });
  }
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
}));

it('reference registration failures close acquired handles through the same owner', async () => fixture(async (db) => {
  let closes = 0;
  const referenceDriver = { ...driver, open: async (...args) => {
    const reference = await driver.open(...args);
    return { ...reference, close: () => { closes++; return Promise.resolve(reference.close()); } };
  } };
  await assert.rejects(async () => compareShapeToModel(referenceDriver, db, model,
    () => { throw new Error('reference rejected'); }), /reference rejected/);
  assert.equal(closes, 1);
  assert.equal(db.prepare('SELECT 1 n').get([]).n, 1);
}));

it('shadow replay registers each caller function once on every opened connection', async () => fixture(async (db) => {
  const managed = { $model: '0.1', entities: { Row: { schema: model.entities.Row.schema } } };
  createModelShape(db, managed);
  const calls = new Map();
  const migration = { $migration: '0.1', id: 'validate', from: shapeHash(managed), to: shapeHash(managed), steps: [] };
  await migrate({ connection: db }, [migration], { baseline: managed, model: managed, shadowDriver: driver,
    registerFunctions: (connection) => { calls.set(connection, (calls.get(connection) ?? 0) + 1); } });
  assert.equal(calls.size, 4, 'primary, shadow, and their independent reference connections');
  assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
}));
