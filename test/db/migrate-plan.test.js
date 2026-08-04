//@ts-check
/**
 * @file The migration planner: physical-plan diffing (collections,
 * generated columns, indexes), declared renames, the DESTRUCTIVE
 * report, the draft refusal on schema change, the key-change non-goal
 * — and the planner's output always validates against the
 * jaren-migration schema artifact.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { planMigration, shapeHash, sqliteDialect } from '@jarenjs/db';
import { compileArtifact } from '../json/schema-artifact-helpers.js';

const migrationSchema = JSON.parse(
  fs.readFileSync('packages/db/schemas/jaren-migration.schema.json', 'utf8'));
const validateMigration = compileArtifact(migrationSchema);

const USERS = {
  schema: {
    type: 'object',
    properties: { id: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } },
  },
  key: '/id',
  indexes: [{ name: 'by_first', path: '$.first' }],
};
const M0 = { $model: '0.1', collections: { users: USERS } };

const plan = (from, to, id = 't') =>
  planMigration(from, to, { dialect: sqliteDialect, id });

describe('planning collection changes', () => {
  it('an added collection becomes its full CREATE DDL', () => {
    const to = {
      $model: '0.1',
      collections: { users: USERS, events: { schema: { type: 'object' }, key: null, identity: 'integer' } },
    };
    const { migration, report } = plan(M0, to, '0001-add-events');
    assert.deepStrictEqual(report.added, ['events']);
    assert.strictEqual(report.destructive, false);
    assert.strictEqual(migration.from, shapeHash(M0));
    assert.strictEqual(migration.to, shapeHash(to));
    assert.match(migration.steps[0].sql, /^CREATE TABLE "events"/);
    assert.strictEqual(validateMigration(migration), true,
      'planner output validates against the artifact');
  });

  it('a removed collection is a loud DESTRUCTIVE drop', () => {
    const to = { $model: '0.1', collections: { other: { schema: {}, key: '/id' } } };
    const { migration, report } = plan(M0, to);
    assert.deepStrictEqual(report.removed, ['users']);
    assert.strictEqual(report.destructive, true);
    const drop = migration.steps.find((s) => s.sql === 'DROP TABLE "users"');
    assert.match(drop.note, /DESTRUCTIVE/);
  });

  it('a declared rename moves the table and rebuilds its indexes', () => {
    const to = {
      $model: '0.1',
      collections: { people: { ...USERS, 'x-rename': 'users' } },
    };
    const { migration, report } = plan(M0, to);
    assert.deepStrictEqual(report.renamed, [{ from: 'users', to: 'people' }]);
    assert.strictEqual(report.destructive, false);
    const sqls = migration.steps.map((s) => s.sql);
    assert.strictEqual(sqls[0], 'ALTER TABLE "users" RENAME TO "people"');
    // a renamed SQLite table keeps its old index names (probed): the
    // planner drops the old-prefixed index and creates the new one
    assert.ok(sqls.includes('DROP INDEX "users_by_first"'));
    assert.ok(sqls.some((sql) => sql.startsWith('CREATE INDEX "people_by_first"')));
  });

  it('an undeclared or colliding rename is a planning error', () => {
    assert.throws(() => plan(M0, {
      $model: '0.1',
      collections: { people: { ...USERS, 'x-rename': 'ghosts' } },
    }), /names 'ghosts'/);
    assert.throws(() => plan(M0, {
      $model: '0.1',
      collections: { users: USERS, twins: { ...USERS, 'x-rename': 'users' } },
    }), /collides/);
  });
});

describe('planning index and column changes', () => {
  it('an added index brings its generated column; a removed one drops both', () => {
    const to = {
      $model: '0.1',
      collections: {
        users: { ...USERS, indexes: [{ name: 'by_last', path: '$.last', unique: true }] },
      },
    };
    const { migration } = plan(M0, to);
    assert.deepStrictEqual(migration.steps.map((s) => s.sql), [
      'DROP INDEX "users_by_first"',
      'ALTER TABLE "users" DROP COLUMN "gx_first"',
      'ALTER TABLE "users" ADD COLUMN "gx_last" TEXT GENERATED ALWAYS AS '
      + '(jsonb_extract("doc", \'$."last"\')) VIRTUAL',
      'CREATE UNIQUE INDEX "users_by_last" ON "users" ("gx_last")',
    ]);
  });

  it('a type change on an indexed path is drop-plus-add in dependency order', () => {
    const to = structuredClone(M0);
    to.collections.users.schema.properties.first = { type: 'integer' };
    const { migration, report } = plan(M0, to);
    const sqls = migration.steps.filter((s) => s.kind === 'ddl').map((s) => s.sql);
    assert.deepStrictEqual(sqls, [
      'DROP INDEX "users_by_first"',
      'ALTER TABLE "users" DROP COLUMN "gx_first"',
      'ALTER TABLE "users" ADD COLUMN "gx_first" INTEGER GENERATED ALWAYS AS '
      + '(jsonb_extract("doc", \'$."first"\')) VIRTUAL',
      'CREATE INDEX "users_by_first" ON "users" ("gx_first")',
    ]);
    assert.deepStrictEqual(report.schemaChanged, ['users'],
      'the type change is also a schema change: a draft transform rides along');
  });

  it('an unchanged collection produces no steps', () => {
    const { migration } = planMigration(M0, structuredClone(M0),
      { dialect: sqliteDialect, id: 'noop' });
    assert.deepStrictEqual(migration.steps, []);
  });
});

describe('the draft rule and the non-goals', () => {
  it('a schema change emits a DRAFT identity transform, never a silent one', () => {
    const to = structuredClone(M0);
    to.collections.users.schema.required = ['id'];
    const { migration, report } = plan(M0, to);
    const draft = migration.steps.find((s) => s.kind === 'jslt');
    assert.strictEqual(draft.draft, true);
    assert.deepStrictEqual(draft.stylesheet, [], 'the identity placeholder');
    assert.match(draft.note, /cannot infer/);
    assert.deepStrictEqual(report.drafts, ['users']);
    assert.strictEqual(validateMigration(migration), true);
  });

  it('changing the key declaration refuses with the named non-goal', () => {
    const to = structuredClone(M0);
    to.collections.users.key = '/first';
    assert.throws(() => plan(M0, to), /table rebuild/);
    const identityChange = structuredClone(M0);
    identityChange.collections.users.key = null;
    identityChange.collections.users.identity = 'uuid';
    assert.throws(() => plan(M0, identityChange), /table rebuild/);
  });

  it('the planner requires its dialect explicitly', () => {
    assert.throws(() => planMigration(M0, M0), TypeError);
  });
});
