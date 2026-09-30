//@ts-check
/**
 * @file The planner-stability gate (MIGRATION-FORMAT §5): a corpus of model
 * pairs — additive, widening, a narrowing with and without its transform, a
 * rename, an index, an entity rebuild and a physical plan — is planned and
 * compared with committed golden documents. Planner output is not promised
 * stable across releases before 1.0, so a host persists the documents it
 * applies and never re-plans an applied link; this gate makes a change to
 * what the planner writes for an unchanged pair impossible to ship
 * unnoticed. Regenerating the goldens is a deliberate act, named in the
 * release notes:
 *
 *   JAREN_WRITE_PLANNER_GOLDENS=1 node --test test/db/planner-goldens.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { planModelMigration, planPhysicalMigration, planTableMigration, sqliteDialect, readSchema, migrationChecksum } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { canonicalizeJson } from '@jarenjs/json/canonical';

const DIR = new URL('./fixtures/planner-goldens/', import.meta.url);
const WRITE = process.env.JAREN_WRITE_PLANNER_GOLDENS === '1';

const collection = (/** @type {any} */ schema, /** @type {any[]} */ indexes = []) => ({ schema, key: '/id', indexes });
const docs = (/** @type {any} */ properties, /** @type {string[] | undefined} */ required = undefined) =>
  ({ type: 'object', ...(required === undefined ? {} : { required }), properties });
const models = (/** @type {any} */ collections) => ({ $model: '0.1', collections });
const ent = (/** @type {any} */ properties) =>
  ({ schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, ...properties } } });

/** Every pair the gate plans: a name, and the plan it makes. */
const CORPUS = {
  'additive': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } })) }),
    models({ docs: collection(docs({ name: { type: 'string' } })), notes: collection(docs({ text: { type: 'string' } })) }),
  { dialect: sqliteDialect, id: 'additive' }),
  'widening': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } }, ['name'])) }),
    models({ docs: collection(docs({ name: { type: 'string' } })) }), { dialect: sqliteDialect, id: 'widening' }),
  'narrowing-draft': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } })) }),
    models({ docs: collection(docs({ name: { type: 'string', maxLength: 3 } })) }), { dialect: sqliteDialect, id: 'narrowing' }),
  'narrowing-transform': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } })) }),
    models({ docs: collection(docs({ name: { type: 'string', maxLength: 3 } })) }),
  { dialect: sqliteDialect, id: 'narrowing', transform: { kind: 'host', run: 'truncate', version: '1' } }),
  'rename': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } })) }),
    models({ records: { ...collection(docs({ name: { type: 'string' } })), 'x-rename': 'docs' } }), { dialect: sqliteDialect, id: 'rename' }),
  'index': () => planModelMigration(models({ docs: collection(docs({ name: { type: 'string' } })) }),
    models({ docs: collection(docs({ name: { type: 'string' } }), [{ name: 'by_name', path: '$.name' }]) }), { dialect: sqliteDialect, id: 'index' }),
  'entity-rebuild': () => planModelMigration({ $model: '0.1', entities: { User: ent({ age: { type: 'integer' } }) } },
    { $model: '0.1', entities: { User: ent({ age: { type: 'string' } }) } },
    { dialect: sqliteDialect, id: 'retype', transform: { User: { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: { id: '$.id' } }] } } }),
  // planned over a seeded in-memory file: physicalPlan() below
  'physical': () => null,
};

/** The physical pair plans over a seeded file, through the driver the store uses. */
async function physicalPlan() {
  const connection = await nodeDriver().open(':memory:', {});
  try {
    connection.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX item_name ON item(name); INSERT INTO item VALUES (1, 'a');");
    const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' } } },
    physical: { table: 'item', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'null' } } } } } };
    const table = planTableMigration(connection, { name: 'item', primaryKey: ['id'], columns: [
      { name: 'id', type: 'INTEGER', nullable: false }, { name: 'name', type: 'TEXT' },
      { name: 'revision', type: 'INTEGER', nullable: false, default: 1 }] }, { id: 'revision', allowRebuild: true });
    const objects = readSchema(connection).objects;
    const migration = planPhysicalMigration(connection, model, model, { id: 'revision', steps: [{ kind: 'table', plan: table }],
      dispositions: Object.fromEntries(objects.map((/** @type {any} */ o) => [`${o.type}:${o.name}`, o.type === 'table' ? 'replace' : 'preserve'])),
      scope: { tables: ['item'] } });
    return { migration, report: null };
  }
  finally { connection.close(); }
}

describe('planner goldens: an unchanged pair of models plans to the committed document', () => {
  for (const name of Object.keys(CORPUS)) {
    it(name, async () => {
      const planned = name === 'physical' ? await physicalPlan() : CORPUS[/** @type {keyof typeof CORPUS} */ (name)]();
      const actual = JSON.parse(canonicalizeJson(planned));
      const file = new URL(`${name}.json`, DIR);
      if (WRITE) {
        fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      assert.ok(fs.existsSync(file), `no golden for '${name}' — generate it: JAREN_WRITE_PLANNER_GOLDENS=1 node --test test/db/planner-goldens.test.js`);
      const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(actual, golden,
        `the planner's output for the unchanged pair '${name}' changed. If the change is deliberate, regenerate the goldens `
        + '(JAREN_WRITE_PLANNER_GOLDENS=1 node --test test/db/planner-goldens.test.js) and name the pair in the release notes '
        + '— a host that re-plans at load compares migrationChecksum and meets it as this release\'s planner change (MIGRATION-FORMAT §5)');
      assert.equal(migrationChecksum(actual.migration), migrationChecksum(golden.migration));
    });
  }
});
