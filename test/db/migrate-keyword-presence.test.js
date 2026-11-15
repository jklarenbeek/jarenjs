//@ts-check
/**
 * @file A schema keyword that appears or disappears between two models:
 * the planner compares the keywords both schemas share, so a keyword on
 * one side only is a change it does not prove harmless, and the schema
 * gets the operator's draft step on both dialects, for collections and
 * entities alike. The plan of a keyword the schemas share is unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planModelMigration, sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

const base = () => ({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
const collectionModel = (/** @type {any} */ schema) => ({ $model: '0.1', collections: { items: { key: '/id', schema } } });
const entityModel = (/** @type {any} */ extra) => ({ $model: '0.1', entities: { Item: { schema: {
  type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } } }, ...extra } } } });

/** One keyword per kind: two constraints and an annotation. */
const KEYWORDS = {
  'additionalProperties': false,
  'minProperties': 1,
  'description': 'an item',
};
const DIALECTS = { sqlite: sqliteDialect, postgres: postgresDialect() };

describe('planModelMigration: a keyword present on one side only is a draft', () => {
  for (const [dialectName, dialect] of Object.entries(DIALECTS)) {
    for (const [keyword, value] of Object.entries(KEYWORDS)) {
      for (const direction of ['added', 'removed']) {
        it(`${dialectName}: collection, ${keyword} ${direction}`, () => {
          const without = collectionModel(base());
          const withKeyword = collectionModel({ ...base(), [keyword]: value });
          const [from, to] = direction === 'added' ? [without, withKeyword] : [withKeyword, without];
          const plan = planModelMigration(from, to, { dialect, id: `${keyword}-${direction}` });
          assert.deepEqual(plan.report.schemaChanged, ['items']);
          assert.deepEqual(plan.report.widened, []);
          assert.deepEqual(plan.report.drafts, ['items']);
          assert.deepEqual(plan.migration.steps.map((/** @type {any} */ step) => [step.kind, step.collection, step.draft]),
            [['jslt', 'items', true]]);
        });
        it(`${dialectName}: entity, ${keyword} ${direction}`, () => {
          const [from, to] = direction === 'added'
            ? [entityModel({}), entityModel({ [keyword]: value })]
            : [entityModel({ [keyword]: value }), entityModel({})];
          const plan = planModelMigration(from, to, { dialect, id: `${keyword}-${direction}` });
          assert.deepEqual(plan.report.widened, []);
          assert.deepEqual(plan.report.drafts, ['Item']);
          const drafts = plan.migration.steps.filter((/** @type {any} */ step) => step.draft === true);
          assert.deepEqual(drafts.map((/** @type {any} */ step) => [step.kind, step.collection]), [['jslt', 'Item']]);
        });
      }
    }
  }

  it('a keyword both schemas carry still compares by value: equal is no change, a new value a draft', () => {
    const closed = collectionModel({ ...base(), minProperties: 1 });
    const same = planModelMigration(closed, collectionModel({ ...base(), minProperties: 1 }), { dialect: sqliteDialect, id: 'same' });
    assert.deepEqual(same.report.schemaChanged, []);
    assert.deepEqual(same.migration.steps, []);
    const moved = planModelMigration(closed, collectionModel({ ...base(), minProperties: 2 }), { dialect: sqliteDialect, id: 'moved' });
    assert.deepEqual(moved.report.drafts, ['items']);
  });

  it('a removed requirement next to an absent keyword stays a widening only when nothing else changed', () => {
    const required = collectionModel(base());
    const optional = collectionModel({ type: 'object', properties: { id: { type: 'string' } } });
    // `required` disappears: the special-cased member, still a widening
    assert.deepEqual(planModelMigration(required, optional, { dialect: sqliteDialect, id: 'w' }).report.widened, ['items']);
    // `required` disappears AND an annotation appears: a draft, not a crash
    const annotated = collectionModel({ type: 'object', properties: { id: { type: 'string' } }, description: 'x' });
    const plan = planModelMigration(required, annotated, { dialect: sqliteDialect, id: 'd' });
    assert.deepEqual(plan.report.widened, []);
    assert.deepEqual(plan.report.drafts, ['items']);
  });
});
