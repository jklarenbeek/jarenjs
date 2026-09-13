//@ts-check
/** The physical lifecycle survives the public migration pen and both grammars. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import { stylesheet, rule } from '@jarenjs/linq/jslt';
import { planPhysicalMigration, planTableMigration, applyTableMigration,
  readSchema, migrationChecksum } from '@jarenjs/db';
import { compileArtifact } from '../json/schema-artifact-helpers.js';

const validators = ['jaren-migration.schema.json', 'jaren-migration.draft-07.schema.json']
  .map((name) => [name, compileArtifact(JSON.parse(readFileSync(`packages/db/schemas/${name}`, 'utf8')))]);
const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', required: ['id', 'value'], properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, value: { type: 'string' },
} }, physical: { table: 'rows', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'reject' },
} } } } };
const renamed = { $model: '0.1', entities: { Entry: model.entities.Row } };
const seed = (db) => db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO rows VALUES(1,'retained')");
async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  try { return await run(db); } finally { db.close(); }
}
async function reviewed(db) {
  seed(db);
  const plan = planTableMigration(db, { name: 'rows', primaryKey: ['id'], columns: [
    { name: 'id', type: 'INTEGER' }, { name: 'value', type: 'TEXT' }, { name: 'revision', type: 'INTEGER', default: 1 },
  ] }, { id: 'widen', allowRebuild: true });
  const physicalTarget = await fixture((target) => {
    seed(target); applyTableMigration(target, plan);
    return { objects: readSchema(target).objects, tables: ['rows'] };
  });
  return planPhysicalMigration(db, model, renamed, {
    id: 'widen', steps: [{ kind: 'table', plan }], dispositions: { 'table:rows': 'replace' }, physicalTarget,
    assertions: [{ sql: 'SELECT value FROM rows WHERE id=?', params: [1], expected: [{ value: 'retained' }] }],
  });
}

it('fromPlanned preserves the complete reviewed plan and physical header as an independent immutable value', async () => fixture(async (db) => {
  const planned = await reviewed(db);
  const pen = fromPlanned(planned, { from: model, to: renamed });
  const doc = pen.document;
  assert.deepEqual(doc, planned);
  assert.equal(migrationChecksum(doc), migrationChecksum(planned));
  assert.equal(JSON.stringify(doc.physical), JSON.stringify(planned.physical));
  assert.deepEqual(doc.steps[0].plan, planned.steps[0].plan, 'the guarded table artifact stays complete');
  assert.equal(Object.isFrozen(doc.steps[0].plan.source), true);
  assert.equal(Object.isFrozen(doc.physical.target.objects), true);
  assert.equal(Object.isFrozen(doc.physical.assertions[0].params), true);
  assert.deepEqual(pen.document, fromPlanned(planned).document);
  assert.equal(migrationChecksum(doc), migrationChecksum(fromPlanned(planned).document));
  for (const [name, validate] of validators) assert.equal(validate(doc), true, name);
  planned.physical.target.objects[0].sql = 'changed outside the pen';
  planned.physical.assertions[0].expected[0].value = 'changed';
  planned.steps[0].plan.statements.length = 0;
  assert.notEqual(doc.physical.target.objects[0].sql, 'changed outside the pen');
  assert.equal(doc.physical.assertions[0].expected[0].value, 'retained');
  assert.ok(doc.steps[0].plan.statements.length > 0);
}));

it('historical transform spellings and assertions retain their model before a later rename', () => {
  const current = structuredClone(model);
  const options = { model: current };
  const build = () => defineMigration({ id: 'historical', from: model, to: renamed })
    .transform('Row', (row) => ({ id: row.id, value: row.value.upper() }), options)
    .transform('Row', stylesheet([rule('$', (row) => ({ id: row.id, value: row.value }))]), options)
    .transform('Row', [{ match: '$', body: '$' }], options)
    .assert('Row', (row) => row.value.isEmpty(), options)
    .assert('Row', true, { ...options, expect: 'ebv' });
  const doc = build().document;
  for (const step of doc.steps) {
    assert.deepEqual(step.model, model);
    assert.equal(Object.isFrozen(step.model.entities.Row.physical.columns), true);
  }
  assert.deepEqual(doc.steps[0].stylesheet, [{ match: '$', body: { id: '$.id', value: { $upper: '$.value' } } }]);
  assert.deepEqual(doc, build().document);
  assert.equal(migrationChecksum(doc), migrationChecksum(build().document));
  for (const [name, validate] of validators) assert.equal(validate(doc), true, name);
  current.entities.Row.physical.table = 'changed';
  assert.equal(doc.steps[0].model.entities.Row.physical.table, 'rows');
});

it('an explicit current model permits a planned transform without the final model and checks the current name', () => {
  const planned = defineMigration({ id: 'rename', from: model, to: renamed }).document;
  const pen = fromPlanned(planned);
  assert.deepEqual(pen.transform('Row', [], { model }).document.steps[0], {
    kind: 'jslt', collection: 'Row', stylesheet: [], model,
  });
  assert.throws(() => pen.transform('Row', []), { code: 'JL0106' });
  assert.throws(() => pen.transform('Entry', [], { model }), { code: 'JL0106' });
  assert.throws(() => pen.assert('Entry', true, { model }), { code: 'JL0106' });
  const known = defineMigration({ id: 'rename', from: model, to: renamed });
  assert.throws(() => known.transform('Row', []), { code: 'JL0106' });
  assert.throws(() => known.assert('Row', true), { code: 'JL0106' });
});

it('malformed current model options and physical header essentials fail at the pen boundary', () => {
  const pen = defineMigration({ id: 'invalid', from: model, to: model });
  for (const options of [null, [], { unknown: true }, { model: null }, { model: {} }, { model: { $model: '0.2' } }]) {
    assert.throws(() => pen.transform('Row', [], options), { code: 'JL0101' });
    assert.throws(() => pen.assert('Row', true, options), { code: 'JL0101' });
  }
  for (const physical of [null, {}, { source: [], dispositions: {} }, { source: {}, dispositions: {}, assertions: [] }]) {
    assert.throws(() => fromPlanned({ ...pen.document, physical }), { code: 'JL0101' });
  }
});

it('both grammars refuse incomplete table artifacts, invalid historical models and malformed physical targets', async () => fixture(async (db) => {
  const planned = await reviewed(db);
  const invalid = [];
  for (const member of ['version', 'id', 'table', 'checksum', 'source', 'after', 'rebuild', 'temporary', 'unchanged', 'statements', 'finish']) {
    const doc = structuredClone(planned); delete doc.steps[0].plan[member]; invalid.push([`missing ${member}`, doc]);
  }
  for (const [member, value] of [['version', 2], ['id', ''], ['table', false], ['checksum', ''], ['rebuild', 'true'],
    ['temporary', ''], ['source', [null]], ['after', [[]]], ['unchanged', [1]], ['statements', ['']], ['finish', [null]]]) {
    const doc = structuredClone(planned); doc.steps[0].plan[member] = value; invalid.push([`invalid ${member}`, doc]);
  }
  for (const [reason, doc] of invalid) {
    assert.throws(() => fromPlanned(doc), { code: 'JL0101' }, reason);
    assert.throws(() => defineMigration({ id: 'invalid', from: model, to: renamed }).step(doc.steps[0]), { code: 'JL0101' }, reason);
    assert.throws(() => planPhysicalMigration(db, model, renamed, {
      id: 'invalid', steps: doc.steps, dispositions: { 'table:rows': 'replace' },
    }), { code: 'JD0023' }, reason);
  }
  for (const kind of ['jslt', 'query']) {
    const step = kind === 'jslt' ? { kind, collection: 'Row', stylesheet: [] } : { kind, collection: 'Row', assert: true };
    for (const current of [null, {}, { $model: '0.2' }]) {
      invalid.push([`${kind} invalid model`, { ...planned, steps: [{ ...step, model: current }] }]);
    }
  }
  for (const target of [{}, { objects: [], tables: ['rows', 'rows'] },
    { objects: [{ type: 'unknown', name: 'rows', owner: 'rows', sql: 'CREATE TABLE rows(id)' }] },
    { objects: [{ type: 'table', name: 'rows', owner: 'rows', sql: null }] },
    { objects: [{ type: 'table', name: 'rows', sql: 'CREATE TABLE rows(id)' }] }]) {
    invalid.push(['invalid target', { ...planned, physical: { ...planned.physical, target } }]);
  }
  for (const [reason, doc] of invalid) {
    for (const [name, validate] of validators) assert.equal(validate(doc), false, `${name}: ${reason}`);
  }
}));
