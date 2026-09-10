//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planInvariants, sqliteDialect, classifyDriverError, planPhysicalMigration, migrate } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const column = (name, codec = 'integer') => ({ name, codec, null: 'reject' });
const model = { $model: '0.1', entities: {
  Entry: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
    start: { type: 'integer' }, end: { type: 'integer' }, phase: { type: 'string' },
  } }, physical: { table: 'entry', columns: {
    id: column('id'), start: column('starts'), end: column('ends'), phase: column('phase', 'text'),
  } }, invariants: [
    { name: 'ordered', on: ['insert', 'update'], enforcement: 'database', assert: { $and: [{ $le: ['$.new.start', '$.new.end'] }, { $gt: ['$.new.id', 0] }] },
      audit: { entity: 'Audit', values: { entry: '$.new.id', operation: '$.op' } } },
    { name: 'frozen', on: ['update', 'delete'], enforcement: 'database', assert: { $eq: ['$.old.phase', 'draft'] } },
  ] },
  Audit: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, entry: { type: 'integer' }, operation: { type: 'string' },
  } }, physical: { table: 'audit', columns: { id: column('id'), entry: column('entry_id'), operation: column('operation', 'text') } } },
} };

it('fresh and upgraded rules agree for every SQL writer, allocated audit keys, nulls and frozen no-ops', async () => {
  const outcomes = [];
  for (const upgraded of [false, true]) {
    const db = await nodeDriver().open(':memory:');
    db.exec(`CREATE TABLE entry(id INTEGER PRIMARY KEY, starts INTEGER, ends INTEGER, phase TEXT);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, entry_id INTEGER, operation TEXT);`);
    if (upgraded) db.exec("INSERT INTO entry VALUES(20, 1, 2, 'draft'); DELETE FROM entry");
    const statements = planInvariants(model, { dialect: sqliteDialect });
    const driver = { ...nodeDriver(), open: async () => db };
    await assert.rejects(openStore(model, { driver }), { code: 'JD0002' });
    // A refused open owns and closes its handle, so install on a fresh fixture.
    const connection = await nodeDriver().open(':memory:');
    connection.exec(`CREATE TABLE entry(id INTEGER PRIMARY KEY, starts INTEGER, ends INTEGER, phase TEXT);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, entry_id INTEGER, operation TEXT);`);
    if (upgraded) connection.exec("INSERT INTO entry VALUES(20, 1, 2, 'draft'); DELETE FROM entry");
    if (upgraded) {
      const from = structuredClone(model);
      from.entities.Entry.invariants = [];
      const migration = await planPhysicalMigration(connection, from, model, {
        id: 'install-rules', steps: statements.map((statement) => ({ kind: 'ddl', sql: statement.sql })),
        dispositions: { 'table:entry': 'preserve', 'table:audit': 'preserve' },
        assertions: [{ sql: 'SELECT * FROM entry', expected: [] }],
      });
      const target = { driver: { ...nodeDriver(), open: async () => ({ ...connection, close() {} }) } };
      await migrate(target, [migration], { baseline: from, model, shadow: false });
      assert.equal((await migrate(target, [migration], { baseline: from, model, shadow: false })).applied.length, 0);
    }
    else for (const statement of statements) connection.exec(statement.sql);
    const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => connection }, adopt: true });
    try {
      const created = await store.entity('Entry').create({ start: 1, end: 2, phase: 'draft' });
      assert.equal(created.id, 1);
      await assert.rejects(store.entity('Entry').update(1, { start: 3 }), { code: 'JD2096', class: 'constraint' });
      for (const sql of ["INSERT INTO entry(starts,ends,phase) VALUES(3,2,'draft')", "UPDATE entry SET starts=NULL WHERE id=1"])
        assert.throws(() => connection.exec(sql), (e) => classifyDriverError(e).class === 'constraint');
      await store.entity('Entry').update(1, { phase: 'frozen' });
      const before = connection.prepare('SELECT count(*) AS n FROM audit').get([]).n;
      await store.entity('Entry').update(1, { phase: 'frozen' });
      connection.exec("UPDATE entry SET phase='frozen' WHERE id=1");
      assert.equal(connection.prepare('SELECT count(*) AS n FROM audit').get([]).n, before);
      await assert.rejects(store.entity('Entry').delete(1), { code: 'JD2096' });
      assert.throws(() => connection.exec('DELETE FROM entry WHERE id=1'), /jaren invariant:frozen/);
      outcomes.push(JSON.stringify({ rows: connection.prepare('SELECT * FROM entry').all([]), audit: connection.prepare('SELECT * FROM audit').all([]) }));
    }
    finally { await store.close(); }
  }
  assert.equal(outcomes[0], outcomes[1]);
});

it('recursive audit effects and unbounded SQL predicates refuse before execution', () => {
  const recursive = structuredClone(model);
  recursive.entities.Entry.invariants[0].audit.entity = 'Entry';
  assert.throws(() => planInvariants(recursive, { dialect: sqliteDialect }), { code: 'JD0005' });
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
  const { compileJsonQuery } = await import('@jarenjs/json/query');
  const declaration = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, a: { type: ['integer', 'null'] }, b: { type: ['integer', 'null'] },
  } }, physical: { table: 'rows', columns: { id: column('id'), a: { ...column('a'), null: 'null' }, b: { ...column('b'), null: 'null' } } } } } };
  for (const expression of [{ $eq: ['$.new.a', '$.new.b'] }, { $ne: ['$.new.a', { $const: null }] },
    { $le: ['$.new.a', '$.new.b'] }, { $not: { $lt: ['$.new.a', '$.new.b'] } },
    { $and: [{ $eq: ['$.op', 'insert'] }, { $or: [{ $gt: ['$.new.a', 0] }, { $eq: ['$.new.a', null] }] }] }]) {
    const spec = structuredClone(declaration);
    spec.entities.Row.invariants = [{ name: 'truth', on: ['insert'], assert: expression, enforcement: 'database' }];
    const evaluate = compileJsonQuery(expression);
    const db = await nodeDriver().open(':memory:');
    try {
      db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER)');
      for (const statement of planInvariants(spec, { dialect: sqliteDialect })) db.exec(statement.sql);
      for (const a of [null, -1, 2]) for (const b of [null, -1, 2]) {
        const insert = () => db.prepare('INSERT INTO rows VALUES(1,?,?)').run([a, b]);
        if (evaluate({ old: null, new: { id: 1, a, b }, op: 'insert' }) === true) { insert(); db.exec('DELETE FROM rows'); }
        else assert.throws(insert, /jaren invariant:truth/);
      }
      assert.throws(() => db.exec("INSERT INTO rows VALUES(1,'wrong type',4)"), /jaren invariant:truth/);
    }
    finally { db.close(); }
  }
  for (const absent of [false, true]) {
    const spec = structuredClone(declaration);
    if (absent) spec.entities.Row.physical.columns.a.null = 'absent';
    spec.entities.Row.invariants = [{ name: 'absence', on: ['insert'], enforcement: 'database',
      assert: { $eq: [absent ? '$.new.a' : '$.old.a', null] } }];
    assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' });
  }
});

it('invariant declarations refuse unspecified writer authority and duplicate names', () => {
  for (const edit of [(m) => { delete m.entities.Entry.invariants[0].enforcement; },
    (m) => { m.entities.Entry.invariants.push(m.entities.Entry.invariants[0]); },
    (m) => { m.entities.Entry.invariants[0].on = ['replace']; }]) {
    const spec = structuredClone(model); edit(spec);
    assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' });
  }
});
