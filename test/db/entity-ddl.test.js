//@ts-check
/**
 * @file Entity DDL: golden SQL through the SQLite dialect (typed
 * columns, checks, foreign keys with declared on-delete, composite
 * keys, join tables), the same plans rendered differently through the
 * full test double (the D21 proof at the entity layer), and the
 * foreign-keys pragma verified ON per connection.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  explainMapping, planEntity, planJoinTable, sqliteDialect, createDialect,
  openStore,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fullDoubleDialect } from './helpers.js';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          email: { type: 'string', 'x-entity': { unique: true } },
          role: { type: 'string', enum: ['admin', 'user'] },
          created: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer', index: true } },
          profile: { type: 'object' },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
          author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'setNull' } } },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
    Grade: {
      schema: {
        type: 'object',
        properties: {
          student: { type: 'string', 'x-entity': { key: true } },
          course: { type: 'string', 'x-entity': { key: true } },
          score: { type: 'integer' },
        },
      },
    },
  },
};

const mapping = explainMapping(MODEL);
const planFor = (name, dialect) => planEntity(name, mapping.entities[name], mapping, dialect);

describe('golden entity DDL (SQLite)', () => {
  it('typed columns, a CHECK, an epoch column, and the document column', () => {
    assert.deepStrictEqual(planFor('User', sqliteDialect).createSql, [
      'CREATE TABLE "User" ('
      + '"id" TEXT PRIMARY KEY, '
      + '"email" TEXT, '
      + '"role" TEXT CHECK ("role" IN (\'admin\', \'user\')), '
      + '"created" INTEGER, '
      + '"doc" BLOB NOT NULL) STRICT',
      'CREATE UNIQUE INDEX "User_email" ON "User" ("email")',
      'CREATE INDEX "User_created" ON "User" ("created")',
    ]);
  });

  it('a one-to-one via claims its declared column as the foreign key', () => {
    assert.deepStrictEqual(planFor('Post', sqliteDialect).createSql, [
      'CREATE TABLE "Post" ('
      + '"pid" INTEGER PRIMARY KEY, '
      + '"title" TEXT, '
      + '"authorId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL, '
      + '"doc" BLOB NOT NULL) STRICT',
      'CREATE UNIQUE INDEX "Post_authorId" ON "Post" ("authorId")',
    ]);
  });

  it('composite keys render as a table-level PRIMARY KEY', () => {
    assert.match(planFor('Grade', sqliteDialect).createSql[0],
      /PRIMARY KEY \("student", "course"\)\) STRICT$/);
  });

  it('the join table carries two cascading foreign keys and a composite key', () => {
    const join = planJoinTable('Label_User', mapping.joinTables.Label_User,
      mapping, sqliteDialect);
    assert.deepStrictEqual(join.createSql, [
      'CREATE TABLE "Label_User" ('
      + '"Label_key" TEXT REFERENCES "Label" ("name") ON DELETE CASCADE, '
      + '"User_key" TEXT REFERENCES "User" ("id") ON DELETE CASCADE, '
      + 'PRIMARY KEY ("Label_key", "User_key")) STRICT',
    ]);
    assert.deepStrictEqual(join.expectedForeignKeys.map((fk) => fk.references),
      ['Label', 'User']);
  });
});

describe('the dialect proof at the entity layer (D21)', () => {
  it('the same mapping renders correspondingly different DDL through the double', () => {
    const doubled = fullDoubleDialect(createDialect);
    for (const name of ['User', 'Post', 'Grade']) {
      const viaSqlite = planFor(name, sqliteDialect).createSql;
      const viaDouble = planFor(name, doubled).createSql;
      assert.strictEqual(viaDouble.length, viaSqlite.length);
      for (let i = 0; i < viaSqlite.length; i++)
        assert.notStrictEqual(viaDouble[i], viaSqlite[i]);
      assert.match(viaDouble[0], /\[doc\] JSONDOC NOT NULL/);
    }
    const doubledUser = planFor('User', doubled).createSql[0];
    assert.match(doubledUser, /\[role\] VALTYPE CHECK \(\[role\] IN \('admin', 'user'\)\)/);
  });
});

describe('the pragma', () => {
  it('foreign keys are switched ON and verified per connection', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    // the observable proof: a violating write is refused (entity.test
    // covers behaviour; here the capability claim itself)
    await assert.rejects(
      () => store.entity('Post').create({ title: 'x', authorId: 'ghost' }),
      (error) => error.code === 'JD2005');
    await store.close();
    assert.strictEqual(sqliteDialect.pragma.foreignKeys(true), 'PRAGMA foreign_keys = ON');
    assert.strictEqual(sqliteDialect.pragma.foreignKeys(false), 'PRAGMA foreign_keys = OFF');
    assert.match(sqliteDialect.introspect.foreignKeysOn(), /pragma_foreign_keys/);
    assert.match(sqliteDialect.introspect.foreignKeyList('Post'),
      /pragma_foreign_key_list\('Post'\)/);
  });
});
