//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planInvariants, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ruleModel as model, truthModel, ruleLifecycle, ruleTruthTable, ruleGrid, sqliteEngine, familyModel, familyLifecycle,
  FAMILY_TABLES, FAMILY_REFUSALS } from './invariant-oracle.js';

it('fresh and upgraded rules agree for every SQL writer, allocated audit keys, nulls and frozen no-ops', async () => {
  assert.equal(await ruleLifecycle(sqliteEngine(), false), await ruleLifecycle(sqliteEngine(), true));
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
