//@ts-check
/**
 * @file The extended jaren-model artifact: `entities` beside
 * `collections` (either satisfies the document), entity declarations
 * validated under both drafts, and the twin still exactly the
 * mechanical downlevel.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import {
  compileArtifact, downlevelDraft07, mapRefs, draftNeutralSubsetViolations,
} from '../json/schema-artifact-helpers.js';

const modelSchema = JSON.parse(
  fs.readFileSync('packages/db/schemas/jaren-model.schema.json', 'utf8'));
const modelSchema07 = JSON.parse(
  fs.readFileSync('packages/db/schemas/jaren-model.draft-07.schema.json', 'utf8'));

const ENTITIES_ONLY = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Post: { schema: { type: 'object', properties: { pid: { type: 'integer', 'x-entity': { key: true } } } } },
  },
};
const BOTH = {
  $model: '0.1',
  collections: { logs: { schema: { type: 'object' }, key: null, identity: 'integer' } },
  entities: ENTITIES_ONLY.entities,
};

describe('the extended jaren-model artifact', () => {
  it('stays draft-neutral and its twin is the mechanical downlevel', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(modelSchema), []);
    assert.deepStrictEqual(modelSchema07, mapRefs(downlevelDraft07(modelSchema)));
  });

  for (const [draft, artifact] of [['2020-12', modelSchema], ['draft-07', modelSchema07]]) {
    it(`entities-only, both, and the malformed under ${draft}`, () => {
      const validate = compileArtifact(artifact);
      assert.strictEqual(validate(ENTITIES_ONLY), true);
      assert.strictEqual(validate(BOTH), true);
      assert.strictEqual(validate({ $model: '0.1' }), false,
        'a model needs collections or entities');
      assert.strictEqual(validate({ $model: '0.1', entities: {} }), false,
        'entities must be non-empty');
      assert.strictEqual(validate({
        $model: '0.1',
        entities: { 'bad name': { schema: {} } },
      }), false);
      assert.strictEqual(validate({
        $model: '0.1',
        entities: { User: {} },
      }), false, 'an entity needs its schema');
      assert.strictEqual(validate({
        $model: '0.1',
        entities: { User: { schema: {}, surprises: true } },
      }), false, 'entity declarations are closed');
    });
  }
});
