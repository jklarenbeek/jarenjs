//@ts-check
/**
 * @file A model that is history is read as it was declared. A property typed
 * another kind than its column's codec decodes is refused when a store opens or
 * a model is normalized, but a migration's baseline and the model of an applied
 * step may carry one: the application that declared it cannot open that
 * baseline any more, and must still be able to plan and apply the migration
 * that retypes the property.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, normalizeEntities, openStore, planModelMigration, planPhysicalMigration, readSchema, shapeHash, sqliteDialect } from '@jarenjs/db';
import { migrationIdentity } from './migration-fixture.js';
import { tempDbPath } from './helpers.js';

const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();

/** `Row` over table `rows`, whose `flag` is typed `type` over a boolean column. @param {string} type */
const modelOf = (type) => ({ $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, flag: { type } } },
physical: { table: 'rows', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, flag: { name: 'flag', codec: 'boolean', null: 'reject' } } } } } });
const DISAGREEING = modelOf('string');
const FIXED = modelOf('boolean');
const TABLE = 'CREATE TABLE rows(id INTEGER PRIMARY KEY, flag INTEGER NOT NULL); INSERT INTO rows VALUES (1, 1), (2, 0)';

async function fixture(/** @type {(db: any, path: string) => Promise<void> | void} */ run) {
  const { dbPath, cleanup } = tempDbPath();
  const db = await driver.open(dbPath);
  try { db.exec(TABLE); await run(db, dbPath); }
  finally { await db.close(); cleanup(); }
}

it('the disagreeing model is a declaration nobody can open or normalize', async () => {
  assert.throws(() => normalizeEntities(DISAGREEING), { code: 'JD0005' });
  await assert.rejects(openStore(DISAGREEING, { driver }), { code: 'JD0005' });
});

it('a physical plan reads the baseline that disagrees and refuses a target that does', async () => fixture(async (db) => {
  const options = { id: 'retype', steps: [], dispositions: { 'table:rows': 'preserve' },
    physicalTarget: { objects: readSchema(db).objects } };
  const plan = planPhysicalMigration(db, DISAGREEING, FIXED, options);
  assert.equal(plan.id, 'retype');
  assert.throws(() => planPhysicalMigration(db, FIXED, DISAGREEING, options), { code: 'JD0005' });
  // a plan scoped to the table owns the tables both models map, the baseline's included
  const scoped = planPhysicalMigration(db, DISAGREEING, FIXED, { ...options, scope: { tables: ['rows'] }, physicalTarget: { objects: readSchema(db, { tables: ['rows'] }).objects, tables: ['rows'] } });
  assert.equal(scoped.id, 'retype');
}));

it('planModelMigration reads the baseline and names the layout change rather than the old column', () => {
  assert.throws(() => planModelMigration(DISAGREEING, FIXED, { dialect: sqliteDialect }), { code: 'JD0021', message: /changed column layouts require planTableMigration/ });
  assert.throws(() => planModelMigration(FIXED, DISAGREEING, { dialect: sqliteDialect }), { code: 'JD0005' });
});

it('an applied step carrying the disagreeing model is read to run, and the retyped model is the declaration', async () => fixture(async (db, path) => {
  const step = { kind: 'query', collection: 'Row', model: DISAGREEING, assert: { $eq: [{ $count: '$[*]' }, 2] }, expect: 'ebv' };
  const migration = { $migration: '0.2', identity: migrationIdentity(DISAGREEING, FIXED), id: 'retype',
    from: shapeHash(DISAGREEING), to: shapeHash(FIXED), steps: [step] };
  const report = await migrate({ driver, path }, [migration], { baseline: DISAGREEING, model: FIXED, batchSize: 1, shadow: false });
  assert.deepEqual(report.applied, ['retype']);
}));

it('the shadow database built from the disagreeing baseline accepts the same migration', async () => fixture(async (db, path) => {
  const migration = { $migration: '0.2', identity: migrationIdentity(DISAGREEING, FIXED), id: 'retype',
    from: shapeHash(DISAGREEING), to: shapeHash(FIXED), steps: [] };
  const report = await migrate({ driver, path }, [migration], { baseline: DISAGREEING, model: FIXED, batchSize: 1 });
  assert.deepEqual(report.applied, ['retype']);
}));
