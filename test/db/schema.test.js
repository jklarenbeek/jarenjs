//@ts-check
/**
 * @file The jaren-model schema artifact: compiles under both drafts,
 * stays inside the repository's draft-neutral subset, its committed
 * draft-07 twin is exactly the mechanical downlevel, and the grammar
 * accepts the documented example while rejecting the malformed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileArtifact, downlevelDraft07, mapRefs, draftNeutralSubsetViolations,
} from '../json/schema-artifact-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, p), 'utf8'));

const modelSchema = load('../../packages/db/schemas/jaren-model.schema.json');
const modelSchema07 = load('../../packages/db/schemas/jaren-model.draft-07.schema.json');
const migrationSchema = load('../../packages/db/schemas/jaren-migration.schema.json');
const migrationSchema07 = load('../../packages/db/schemas/jaren-migration.draft-07.schema.json');

const EXAMPLE = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          age: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
      ],
    },
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};

describe('the jaren-model artifact', () => {
  it('stays in the draft-neutral subset and its draft-07 twin is in sync', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(modelSchema), []);
    assert.deepStrictEqual(modelSchema07, mapRefs(downlevelDraft07(modelSchema)),
      'the committed twin must be exactly the mechanical downlevel');
  });

  for (const [draft, artifact] of [['2020-12', modelSchema], ['draft-07', modelSchema07]]) {
    describe(`under ${draft}`, () => {
      const validate = compileArtifact(artifact);

      it('accepts the documented example', () => {
        assert.strictEqual(validate(EXAMPLE), true);
      });

      it('rejects the malformed', () => {
        assert.strictEqual(validate({}), false);
        assert.strictEqual(validate({ $model: '0.2', collections: EXAMPLE.collections }),
          false, 'a foreign version');
        assert.strictEqual(validate({ $model: '0.1', collections: {} }),
          false, 'no collections');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { 'bad name': { schema: {} } },
        }), false, 'a non-identifier collection name');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { key: '/id' } },
        }), false, 'a collection without a schema');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { schema: {}, key: 'id' } },
        }), false, 'a key without the leading slash');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { schema: {}, key: null, identity: 'guess' } },
        }), false, 'an unknown identity');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { schema: {}, key: '/id', indexes: [{ path: '$.a' }] } },
        }), false, 'an index without a name');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { schema: {}, key: '/id', indexes: [{ name: 'a', path: [] }] } },
        }), false, 'an empty composite path');
        assert.strictEqual(validate({
          $model: '0.1',
          collections: { u: { schema: {}, key: '/id', surprises: true } },
        }), false, 'an undeclared collection member');
      });
    });
  }
});

describe('the jaren-migration artifact', () => {
  it('stays in the draft-neutral subset and its draft-07 twin is in sync', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(migrationSchema), []);
    assert.deepStrictEqual(migrationSchema07, mapRefs(downlevelDraft07(migrationSchema)));
  });

  const MIGRATION = {
    $migration: '0.1',
    id: '0002-split-name',
    from: 'aaaa', to: 'bbbb',
    steps: [
      { kind: 'ddl', sql: 'DROP INDEX "users_by_first"' },
      { kind: 'jslt', collection: 'users', stylesheet: [] },
      { kind: 'query', collection: 'users', assert: { $count: '$[*]' }, expect: 'ebv' },
    ],
  };

  for (const [draft, artifact] of [['2020-12', migrationSchema], ['draft-07', migrationSchema07]]) {
    it(`accepts the documented example and rejects the malformed under ${draft}`, () => {
      const validate = compileArtifact(artifact);
      assert.strictEqual(validate(MIGRATION), true);
      assert.strictEqual(validate({ ...MIGRATION, steps: [] }), true,
        'a pure widening carries no steps');
      assert.strictEqual(validate({ ...MIGRATION, $migration: '0.2' }), false);
      const { id: omitted, ...withoutId } = MIGRATION;
      void omitted;
      assert.strictEqual(validate(withoutId), false, 'id is required');
      assert.strictEqual(validate({
        ...MIGRATION,
        steps: [{ kind: 'teleport', sql: 'x' }],
      }), false, 'an unknown step kind');
      assert.strictEqual(validate({
        ...MIGRATION,
        steps: [{ kind: 'jslt', collection: 'users' }],
      }), false, 'a jslt step needs its stylesheet');
    });
  }
});
