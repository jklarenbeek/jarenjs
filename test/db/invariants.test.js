//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { migrate, openStore, planInvariants, shapeHash, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { ruleModel as model, truthModel, ruleLifecycle, ruleTruthTable, ruleGrid, sqliteEngine, familyModel, familyLifecycle,
  FAMILY_TABLES, FAMILY_REFUSALS, storeAgreement, column } from './invariant-oracle.js';
import { tempDbPath } from './helpers.js';

it('fresh and upgraded rules agree for every SQL writer, allocated audit keys, nulls and frozen no-ops', async () => {
  assert.equal(await ruleLifecycle(sqliteEngine(), false), await ruleLifecycle(sqliteEngine(), true));
});

it('recursive audit effects and unbounded SQL predicates refuse before execution', () => {
  const recursive = structuredClone(model);
  recursive.entities.Entry.invariants[0].audit.entity = 'Entry';
  assert.throws(() => planInvariants(recursive, { dialect: sqliteDialect }), { code: 'JD0005' });
  // a second entity on the rule's own table is that table: the audit would fire its own trigger
  const aliased = /** @type {any} */ (structuredClone(model));
  aliased.entities.EntryAlias = { schema: aliased.entities.Entry.schema, physical: { ...aliased.entities.Entry.physical, table: 'ENTRY' } };
  aliased.entities.Entry.invariants[0].audit = { entity: 'EntryAlias', values: { start: '$.new.start' } };
  assert.throws(() => planInvariants(aliased, { dialect: sqliteDialect }), { code: 'JD0005', message: /recursive or chained/ });
  const mismatch = structuredClone(model);
  mismatch.entities.Entry.invariants[0].audit.values.entry = '$.new.phase';
  assert.throws(() => planInvariants(mismatch, { dialect: sqliteDialect }), { code: 'JD0005' });
  const unbounded = structuredClone(model);
  unbounded.entities.Entry.invariants[0].assert = { $exists: '$.new' };
  assert.throws(() => planInvariants(unbounded, { dialect: sqliteDialect }), { code: 'JD0005' });
});

it('store-only query rules protect direct and tracked writes and visibly refuse raw SQL bypass', async () => {
  const declared = { $model: '0.1', entities: { A: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, amount: { type: 'integer' },
  } }, invariants: [{ name: 'positive', on: ['insert', 'update'], enforcement: 'store', assert: { $gt: ['$.new.amount', 0] } }] } } };
  const store = await openStore(declared, { driver: nodeDriver() });
  try {
    await assert.rejects(store.entity('A').create({ id: 'x', amount: 0 }), { code: 'JD2096' });
    const row = await store.entity('A').create({ id: 'x', amount: 1 });
    store.entity('A').put({ ...row, amount: -1 });
    await assert.rejects(store.saveChanges(), { code: 'JD2096' });
    store.entity('A').discard('x');
    await assert.rejects(store.transaction((tx) => tx.sql.prepare('DELETE FROM A', { access: 'write' }).run([])), { code: 'JD2095' });
  }
  finally { await store.close(); }
});

it('database predicates agree with Query null truth tables and refuse unavailable or absent paths', async () => {
  await ruleTruthTable(sqliteEngine());
  for (const absent of [false, true]) {
    const spec = structuredClone(truthModel);
    if (absent) spec.entities.Row.physical.columns.a.null = 'absent';
    spec.entities.Row.invariants = [{ name: 'absence', on: ['insert'], enforcement: 'database',
      assert: { $eq: [absent ? '$.new.a' : '$.old.a', null] } }];
    assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' });
  }
});

it('every scalar codec gives the query engine\'s verdict and refuses a stored value its codec cannot read', async () => {
  await ruleGrid(sqliteEngine());
});

it('invariant declarations refuse unspecified writer authority and duplicate names', () => {
  for (const edit of [(m) => { delete m.entities.Entry.invariants[0].enforcement; },
    (m) => { m.entities.Entry.invariants.push(m.entities.Entry.invariants[0]); },
    (m) => { m.entities.Entry.invariants[0].on = ['replace']; }]) {
    const spec = structuredClone(model); edit(spec);
    assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' });
  }
});

it('the trigger families: store and database enforcement refuse the same store writes; SQL writers meet assignment, columns, probes and revisions', async () => {
  /** @type {Record<string, any>} */
  const runs = {};
  for (const enforcement of /** @type {const} */ (['database', 'store'])) for (const upgraded of [false, true])
    runs[`${enforcement}${upgraded ? ' upgraded' : ''}`] = JSON.parse(await familyLifecycle(sqliteEngine(), { enforcement, upgraded }));
  assert.deepEqual(runs['database upgraded'], runs.database);
  assert.deepEqual(runs['store upgraded'], runs.store);
  assert.deepEqual(runs.store.writes, runs.database.writes);
  assert.deepEqual(runs.database.writes, [
    // inserts: a draft, unsealed, present parent only
    'ok', 'refused open_parent', 'refused open_parent', 'refused open_parent', 'ok',
    // updates: a change, a no-op that writes nothing, the pinned column, the lock, a write to a locked line
    'ok', 'ok', 'refused pinned', 'ok', 'refused locked',
    // tracked saves: a change, the pinned column
    'ok', 'refused pinned',
    // a document's probe, created directly and tracked: a parent that exists, one that does not
    'ok', 'refused memo_parent', 'refused memo_parent', 'ok',
    // removals: tracked under a draft parent, direct and tracked under a final one, direct under none
    'ok', 'refused draft_parent', 'refused draft_parent', 'ok']);
  // SQL writers: a change, a same-value assignment, the pinned column assigned to itself, a revision the
  // writer sets, the lock, a same-value assignment to a locked line, a missing parent, a delete
  assert.deepEqual(runs.database.raw, ['ok', 'ok', 'refused pinned', 'ok', 'ok', 'refused locked', 'refused open_parent', 'ok']);
  // a revision moves by one per changing update, whoever writes, and keeps a writer's own value
  assert.deepEqual(runs.database.rows.map((/** @type {any[]} */ rows) => rows.map((row) => row.revision)), [[2, 1], [], [1], [1], [1], [10], [11], [11], [11]]);
  assert.deepEqual(runs.store.rows, runs.database.rows.slice(0, 2));
});

it('the trigger families refuse what they cannot mean before anything is planned', () => {
  for (const [label, edit] of FAMILY_REFUSALS) {
    const spec = familyModel('database'); edit(spec);
    assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' }, label);
  }
  // what a probe reads is resolved for the store's rules too: a member the
  // rule's entity lacks reads nothing, which would match no row, silently
  const column = familyModel('store');
  column.entities.Line.invariants[3].assert = { '$exists-row': { entity: 'Doc', match: { id: '$.old.dco' } } };
  assert.throws(() => planInvariants(column, { dialect: sqliteDialect }), { code: 'JD0005', message: /'Line' has no column 'dco'/ });
  const property = familyModel('store');
  property.entities.Memo.invariants[0].assert = { '$exists-row': { entity: 'Doc', match: { id: '$.new.prent' } } };
  assert.throws(() => planInvariants(property, { dialect: sqliteDialect }), { code: 'JD0005', message: /'Memo' has no stored property 'prent'/ });
});

it('an increment program refuses to open while recursive triggers would run it again', async () => {
  const fixture = await sqliteEngine().fixture(FAMILY_TABLES);
  try {
    for (const statement of planInvariants(familyModel('database'), { dialect: sqliteDialect })) await fixture.exec(statement.sql);
    await fixture.exec('PRAGMA recursive_triggers = ON');
    await assert.rejects(openStore(familyModel('database'), { driver: fixture.driver, adopt: true }), { code: 'JD0002', message: /recursive_triggers/ });
  }
  finally { await fixture.dispose(); }
});

it('a store rule judges each write at its own statement, against the row as it was and as it is stored, as the database rule does', async () => {
  const runs = { store: JSON.parse(await storeAgreement(sqliteEngine(), 'store')), database: JSON.parse(await storeAgreement(sqliteEngine(), 'database')) };
  assert.deepEqual(runs.store, runs.database);
  assert.deepEqual(runs.database.writes, [
    // a row gone stale under a direct write: the save is judged against the row it replaces
    'ok', 'refused locked',
    // the parent made final and its line removed in one save, then the mirror
    'refused draft_parent', 'ok',
    // a removal never read, under a final parent; a key with no row, directly and tracked
    'refused draft_parent', 'ok', 'ok',
    // a memo whose parent the same save inserts first
    'ok',
    // the uuid the row holds, null over absence, the version alone, the revision alone, then a change
    'ok', 'ok', 'ok', 'ok', 'refused still',
    // a change inside the json member, then the guarded member
    'ok', 'refused made_once',
    // member names that read as lists
    'ok', 'ok', 'ok']);
  // nothing was written for what stored as itself; the revision alone was, unjudged
  assert.deepEqual(runs.database.items, [{ id: 1, u: '0f0e0d0c-0b0a-4908-8706-050403020100', ver: 1, revision: 7 }]);
  assert.deepEqual(runs.database.tags, [{ id: 1, made: '2020-01-01', meta: { a: 2, list: [1, 2] } }]);
  assert.deepEqual(runs.database.wide, [{ id: 1, x: 'X', 'x,y': 'C', z: 'Z', 'y,z': 'YZ' }]);
});

it('a tracked save whose only change is the version member writes nothing, stamp and rules included', async () => {
  const col = (/** @type {string} */ name, /** @type {string} */ codec = 'integer') => ({ name, codec, null: 'reject' });
  const properties = { id: { type: 'integer', 'x-entity': { key: true } }, note: { type: 'string' },
    ver: { type: 'integer', 'x-entity': { version: true } }, stamp: { type: 'string', format: 'date-time', 'x-entity': { default: 'updated' } } };
  const refuseEveryUpdate = [{ name: 'moved', on: ['update'], enforcement: 'store', assert: false }];
  const physicalModel = { $model: '0.1', entities: {
    Item: { schema: { type: 'object', properties }, invariants: refuseEveryUpdate,
      physical: { table: 'items', columns: { id: col('id'), note: col('note', 'text'), ver: col('ver'), stamp: col('stamp', 'text') } } } } };
  const documentModel = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties }, invariants: refuseEveryUpdate } } };
  const driver = nodeDriver();
  let clock = Date.UTC(2026, 0, 1);
  const runtime = { now: () => (clock += 1000) };
  for (const [versionModel, adopt] of /** @type {[any, boolean][]} */ ([[physicalModel, true], [documentModel, false]])) {
    const connection = await driver.open(':memory:');
    if (adopt) connection.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, note TEXT, ver INTEGER, stamp TEXT)');
    const store = await openStore(versionModel, { driver: { ...driver, open: async () => connection }, adopt, runtime });
    try {
      const name = adopt ? 'physical' : 'document';
      const entity = store.entity('Item');
      const created = await entity.create({ id: 1, note: 'a' });
      for (let i = 0; i < 2; i++) {
        const row = await entity.get(1);
        // a client's copy: the content unchanged, a version it should not have sent
        entity.put({ ...row, ver: 99 });
        assert.equal((await store.saveChanges()).updated, 0, name);
        entity.discard(1);
      }
      const stored = await entity.get(1);
      assert.equal(stored.ver, created.ver, `${name}: the version did not move`);
      assert.equal(stored.stamp, created.stamp, `${name}: the stamp did not move`);
    }
    finally { await store.close(); }
  }
});

it('a migration transform is judged as the entity\'s own update: by the columns it sets, and inside its transaction on every host', async () => {
  const transformModel = { $model: '0.1', entities: {
    Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } },
      physical: { table: 'docs', columns: { id: column('id'), status: column('status', 'text') } } },
    Line: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, doc: { type: 'integer' }, qty: { type: 'integer' },
      made: { type: 'string' } } },
    physical: { table: 'lines', columns: { id: column('id'), doc: column('doc_id'), qty: column('qty'), made: column('made', 'text') } },
    invariants: [{ name: 'made_once', on: ['update'], columns: ['made'], enforcement: 'store', assert: false },
      { name: 'draft_only', on: ['update'], enforcement: 'store', assert: { '$exists-row': { entity: 'Doc', match: { id: '$.new.doc', status: 'draft' } } } }] },
  } };
  const transform = (/** @type {number} */ qty) => ({ $migration: '0.2', identity: migrationIdentity(transformModel), id: `qty-${qty}`, from: shapeHash(transformModel), to: shapeHash(transformModel),
    steps: [{ kind: 'jslt', collection: 'Line', model: transformModel, stylesheet: [{ match: '$', body: { doc: '$.doc', made: '$.made', qty } }] }] });
  for (const driver of [nodeDriver(), nodeWorkerDriver()]) {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const setup = await nodeDriver().open(dbPath);
      setup.exec("CREATE TABLE docs(id INTEGER PRIMARY KEY, status TEXT); CREATE TABLE lines(id INTEGER PRIMARY KEY, doc_id INTEGER, qty INTEGER, made TEXT); "
        + "INSERT INTO docs VALUES (1, 'draft'); INSERT INTO lines VALUES (1, 1, 1, '2020-01-01')");
      await setup.close();
      const options = { baseline: transformModel, batchSize: 1, shadow: false };
      // the transform leaves `made` alone, so the guard on it does not fire
      await migrate({ driver, path: dbPath }, [transform(2)], options);
      const check = await nodeDriver().open(dbPath);
      try {
        check.exec("UPDATE docs SET status = 'final'");
        // the probe is answered inside the transform's transaction and refuses it, on a worker too
        await assert.rejects(migrate({ driver, path: dbPath }, [transform(2), transform(3)], options), { code: 'JD2096', message: /draft_only/ });
        assert.deepEqual(check.prepare('SELECT qty, made FROM lines').all([]).map((row) => ({ ...row })), [{ qty: 2, made: '2020-01-01' }]);
      }
      finally { await check.close(); }
    }
    finally { cleanup(); }
  }
});

it('an update shape past the kept ones, and every statement a save prepares, are released: a worker never runs out', async () => {
  const width = 6;
  const members = Array.from({ length: width }, (_, i) => `c${i}`);
  const wideModel = { $model: '0.1', entities: { T: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    ...Object.fromEntries(members.map((name) => [name, { type: 'integer' }])) } },
  physical: { table: 't', columns: { id: column('id'), ...Object.fromEntries(members.map((name) => [name, column(name)])) } } } } };
  // room for the store's own statements and the 32 shapes it keeps, not
  // for the 62 one-shot updates and 80 saves below had they been kept too
  for (const driver of [nodeWorkerDriver({ maxStatements: 64 }), nodeWorkerPoolDriver({ readers: 1, worker: { maxStatements: 64 } })]) {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const setup = await nodeDriver().open(dbPath);
      setup.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, ${members.map((name) => `${name} INTEGER`).join(', ')})`);
      await setup.close();
      const store = await openStore(wideModel, { driver, path: dbPath });
      try {
        const t = store.entity('T');
        await t.create({ id: 1, ...Object.fromEntries(members.map((name) => [name, 0])) });
        // every one of the 63 shapes, twice: 32 stay prepared, the rest run once each
        for (let i = 0; i < 126; i++) {
          const mask = (i % 63) + 1;
          await t.update(1, Object.fromEntries(members.filter((_, b) => mask & (1 << b)).map((name) => [name, i + 1])));
        }
        for (let i = 0; i < 80; i++) {
          const row = /** @type {any} */ (await t.get(1));
          t.put({ ...row, c0: row.c0 + 1 });
          await store.saveChanges();
        }
        assert.equal((/** @type {any} */ (await t.get(1))).c0, 206);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  }
});

it('a rule matches text by code point whatever the column\'s collation; SQLite\'s change test keeps the column\'s own', async () => {
  const collated = familyModel('database');
  const connection = await nodeDriver().open(':memory:');
  connection.exec(FAMILY_TABLES.sqlite.replace('status TEXT', 'status TEXT COLLATE NOCASE').replace('note TEXT', 'note TEXT COLLATE NOCASE')
    + "; INSERT INTO docs VALUES (1, 'DRAFT', NULL), (2, 'draft', NULL)");
  for (const statement of planInvariants(collated, { dialect: sqliteDialect })) connection.exec(statement.sql);
  const store = await openStore(collated, { driver: { ...nodeDriver(), open: async () => connection } });
  try {
    // 'DRAFT' is not 'draft' to a probe, as it is not to PostgreSQL or the query engine
    await assert.rejects(store.entity('Line').create({ id: 1, doc: 1, qty: 1, note: 'a', revision: 0 }), /jaren invariant:open_parent/);
    await store.entity('Line').create({ id: 2, doc: 2, qty: 1, note: 'a', revision: 0 });
    // a NOCASE column's case-only rewrite is no change to SQLite's own test,
    // so the revision the database moves on a change stays; a change moves it
    connection.exec("UPDATE lines SET note = 'A' WHERE id = 2");
    const line = () => connection.prepare('SELECT note, revision FROM lines WHERE id = 2').all([]).map((row) => ({ ...row }));
    assert.deepEqual(line(), [{ note: 'A', revision: 0 }]);
    connection.exec("UPDATE lines SET note = 'b' WHERE id = 2");
    assert.deepEqual(line(), [{ note: 'b', revision: 1 }]);
  }
  finally { await store.close(); }
});

it('database rules refuse to open over a UTF-16 database, whose text order is not code point order', async () => {
  const connection = await nodeDriver().open(':memory:');
  connection.exec(`PRAGMA encoding = 'UTF-16le'; ${FAMILY_TABLES.sqlite}`);
  for (const statement of planInvariants(familyModel('database'), { dialect: sqliteDialect })) connection.exec(statement.sql);
  await assert.rejects(openStore(familyModel('database'), { driver: { ...nodeDriver(), open: async () => connection } }),
    { code: 'JD0002', message: /UTF-16le database/ });
});

it('a save that changes only a document\'s memberships runs its update rules, membership arrays included', async () => {
  const labelled = { $model: '0.1', entities: {
    User: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
      labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } },
    invariants: [{ name: 'ops_not_first', on: ['update'], enforcement: 'store', assert: { $ne: ['$.new.labels[0]', 'ops'] } }] },
    Label: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  } };
  const store = await openStore(labelled, { driver: nodeDriver() });
  try {
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    for (const name of ['admin', 'ops']) await store.entity('Label').create({ name });
    const users = store.entity('User');
    users.put({ ...(await users.get('u1')), labels: ['ops'] });
    await assert.rejects(store.saveChanges(), { code: 'JD2096', message: /ops_not_first/ });
    users.discard('u1');
    users.put({ ...(await users.get('u1')), labels: ['admin', 'ops'] });
    const report = await store.saveChanges();
    assert.deepEqual([report.updated, report.joinInserted], [0, 2]);
  }
  finally { await store.close(); }
});
