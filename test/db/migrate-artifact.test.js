//@ts-check
/**
 * @file The planner's entity path validates against the artifact,
 * strategy row by strategy row (MIGRATION-FORMAT §9): every change the
 * table names is planned from a model pair, the produced document
 * validates under both published grammars, carries the step kinds the row
 * promises, and plans twice to one document — the gate the collection
 * path had (`migrate-plan.test.js`) and the entity path did not.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { planModelMigration, sqliteDialect } from '@jarenjs/db';
import { compileArtifact } from '../json/schema-artifact-helpers.js';

const validate = {
  latest: compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.schema.json', 'utf8'))),
  draft7: compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.draft-07.schema.json', 'utf8'))),
};

const ent = (props, required = ['id']) => ({
  schema: { type: 'object', required, properties: { id: { type: 'string', 'x-entity': { key: true } }, ...props } },
});
const model = (entities) => ({ $model: '0.1', entities });
const post = (extra = {}) => ({
  schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' }, ...extra } },
});
const label = { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } };
const hasMany = { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } };
const belongsToMany = { 'x-entity': { relation: { to: 'Label', many: true } } };

/** The §9 strategy table, one row per entry: the change, the model pair, the step kinds the row promises, whether the report says DESTRUCTIVE. */
const ROWS = [
  ['add mapped column (property added)', model({ User: ent({ name: { type: 'string' } }) }),
    model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) }), ['ddl', 'jslt'], false],
  ['add mapped column (moved out of the document)', model({ User: ent({ age: { type: 'integer', 'x-entity': { column: 'json' } } }) }),
    model({ User: ent({ age: { type: 'integer' } }) }), ['ddl', 'sql'], false],
  ['drop mapped column (property removed)', model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) }),
    model({ User: ent({ name: { type: 'string' } }) }), ['ddl', 'jslt'], true],
  ['drop mapped column (moved into the document)', model({ User: ent({ age: { type: 'integer' } }) }),
    model({ User: ent({ age: { type: 'integer', 'x-entity': { column: 'json' } } }) }), ['sql', 'ddl'], false],
  ['change type', model({ User: ent({ age: { type: 'integer' } }) }),
    model({ User: ent({ age: { type: 'string' } }) }), ['rebuild', 'jslt'], false],
  ['change an enum CHECK', model({ User: ent({ role: { type: 'string', enum: ['a'] } }) }),
    model({ User: ent({ role: { type: 'string', enum: ['a', 'b'] } }) }), ['rebuild', 'jslt'], false],
  ['change the epoch flavor', model({ User: ent({ at: { type: 'string', format: 'date-time' } }) }),
    model({ User: ent({ at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } }) }), ['rebuild'], false],
  ['add an index', model({ User: ent({ name: { type: 'string' } }) }),
    model({ User: ent({ name: { type: 'string', 'x-entity': { index: true } } }) }), ['ddl'], false],
  ['drop a unique index', model({ User: ent({ name: { type: 'string', 'x-entity': { unique: true } } }) }),
    model({ User: ent({ name: { type: 'string' } }) }), ['ddl'], false],
  ['add a version token', model({ User: ent({}) }),
    model({ User: ent({ rev: { type: 'integer', 'x-entity': { version: true } } }) }), ['ddl', 'jslt'], false],
  ['add a relation (foreign key rebuilds the holder)', model({ User: ent({}), Post: post() }),
    model({ User: ent({ posts: hasMany }), Post: post() }), ['jslt', 'rebuild'], false],
  ['drop a relation (the foreign key folds into the document the target declares)', model({ User: ent({ posts: hasMany }), Post: post() }),
    model({ User: ent({}), Post: post({ authorId: { type: 'string', 'x-entity': { column: 'json' } } }) }), ['jslt', 'rebuild'], false],
  ['add a relation (join table)', model({ User: ent({}), Label: label }),
    model({ User: ent({ labels: belongsToMany }), Label: label }), ['jslt', 'ddl'], false],
  ['drop a relation (join table)', model({ User: ent({ labels: belongsToMany }), Label: label }),
    model({ User: ent({}), Label: label }), ['jslt', 'ddl'], true],
  ['entity added', model({ User: ent({}) }), model({ User: ent({}), Other: ent({}) }), ['ddl'], false],
  ['entity dropped', model({ User: ent({}), Other: ent({}) }), model({ User: ent({}) }), ['ddl'], true],
  ['entity renamed (x-rename)', model({ Person: ent({ name: { type: 'string' } }) }),
    model({ Member: { 'x-rename': 'Person', ...ent({ name: { type: 'string' } }) } }), ['ddl'], false],
];

describe('the planner’s entity path validates against the artifact, row by row (§9)', () => {
  for (const [name, from, to, kinds, destructive] of ROWS) {
    it(name, () => {
      const { migration, report } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'r' });
      assert.strictEqual(validate.latest(migration), true, `2020-12: ${JSON.stringify(migration.steps)}`);
      assert.strictEqual(validate.draft7(migration), true, 'draft-07');
      const produced = migration.steps.map((step) => step.kind);
      for (const kind of kinds) {
        assert.ok(produced.includes(kind), `${name}: a ${kind} step is promised; got ${produced.join(', ')}`);
      }
      assert.strictEqual(report.destructive, destructive, 'the report says what is lost');
      assert.deepStrictEqual(planModelMigration(from, to, { dialect: sqliteDialect, id: 'r' }).migration, migration,
        'planning twice is one document');
    });
  }

  it('a step the artifact does not describe is refused by the artifact, not silently accepted', () => {
    const { migration } = planModelMigration(ROWS[0][1], ROWS[0][2], { dialect: sqliteDialect, id: 'r' });
    assert.strictEqual(validate.latest({ ...migration, steps: [{ kind: 'shell', run: 'rm -rf /' }] }), false);
    assert.strictEqual(validate.latest({ ...migration, steps: [{ kind: 'jslt', collection: 'User', stylesheet: {} }] }), false,
      'a jslt step carries the rules ARRAY');
  });
});
