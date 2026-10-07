//@ts-check
/**
 * @file Ids are distinct within a migration list. The planner's default id
 * comes from the target fingerprint alone, so two links reaching one shape —
 * a revert and its redo, or two colliding 32-bit fingerprints — share it; a
 * list that repeats an id is refused (`JD0013`, naming the id and both
 * positions) by `migrate`, `migrationStatus` and `adoptMigrationHistory`
 * before any link runs, instead of committing the first and failing on the
 * history key at the second.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { migrate, migrationStatus, adoptMigrationHistory, planMigration, sqliteDialect, shapeHash, createModelShape } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';
import { EMPTY, document, legacy, all } from './migration-identity-helpers.js';

const collisionModel = (/** @type {string | undefined} */ value) => ({ $model: '0.1', collections: { items: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, ...(value === undefined ? {} : { n: { const: value } }) },
} } } });
const tables = (/** @type {any} */ connection) => all(connection, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
  .map((/** @type {any} */ row) => row.name);
const refusal = (/** @type {string} */ owner, /** @type {string} */ id, /** @type {number} */ first, /** @type {number} */ second) => ({
  code: 'JD0013',
  message: `JD0013: ${owner} migration list repeats the id '${id}' at positions ${first} and ${second}; each migration in a list needs its own id`,
});

describe('a migration list that repeats an id', () => {
  it('the planner repeats its default id for colliding targets and for a revert/redo chain', () => {
    const base = collisionModel(undefined), left = collisionModel('159koso'), right = collisionModel('gnt19f');
    assert.equal(shapeHash(left), shapeHash(right), 'the fixed pair collides');
    const ids = [planMigration(base, left, { dialect: sqliteDialect }), planMigration(left, right, { dialect: sqliteDialect })]
      .map((plan) => plan.migration.id);
    assert.deepEqual(ids, ['to-15ta7pe', 'to-15ta7pe']);
    const B = structuredClone(base);
    /** @type {any} */ (B.collections.items.schema.properties).extra = { type: 'string' };
    const chain = [[base, B], [B, base], [base, B]].map(([from, to]) => planMigration(from, to, { dialect: sqliteDialect }).migration.id);
    assert.deepEqual(chain, ['to-1ygk3ep', 'to-d8s308', 'to-1ygk3ep']);
  });

  it('is refused before any link runs, on a borrowed connection', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      const base = collisionModel(undefined), left = collisionModel('159koso'), right = collisionModel('gnt19f');
      await createModelShape(connection, base);
      const colliding = [planMigration(base, left, { dialect: sqliteDialect }).migration,
        planMigration(left, right, { dialect: sqliteDialect }).migration];
      assert.throws(() => migrate({ connection }, colliding, { baseline: base, shadow: false }),
        refusal('migrate()', 'to-15ta7pe', 0, 1));
      const B = structuredClone(base);
      /** @type {any} */ (B.collections.items.schema.properties).extra = { type: 'string' };
      const redo = [[base, B], [B, base], [base, B]].map(([from, to]) => planMigration(from, to, { dialect: sqliteDialect }).migration);
      assert.throws(() => migrate({ connection }, redo, { baseline: base, shadow: false }),
        refusal('migrate()', 'to-1ygk3ep', 0, 2));
      const duplicates = [document('dup', [{ kind: 'sql', sql: 'CREATE TABLE d1(x INTEGER)' }], base),
        document('dup', [{ kind: 'sql', sql: 'CREATE TABLE d2(x INTEGER)' }], base)];
      assert.throws(() => migrate({ connection }, duplicates, { baseline: base, shadow: false }), refusal('migrate()', 'dup', 0, 1));
      assert.throws(() => migrationStatus({ connection }, duplicates), refusal('migrationStatus()', 'dup', 0, 1));
      assert.deepEqual(tables(connection), ['items'], 'no link ran: no d1, no history, no identity metadata');
      const observed = { version: 1, dialect: 'sqlite', order: 'rowid',
        history: { present: true, rows: [] }, identity: { present: false, rows: [] } };
      assert.throws(() => adoptMigrationHistory({ connection }, [legacy('old'), legacy('new'), legacy('old')], { observed, model: EMPTY }),
        refusal('adoptMigrationHistory()', 'old', 0, 2));
    }
    finally { await connection.close(); }
  });

  it('is refused before an owned target opens, and the distinct list applies', async () => {
    const temp = tempDbPath();
    try {
      const duplicates = [document('dup', [{ kind: 'sql', sql: 'CREATE TABLE d1(x INTEGER)' }]),
        document('dup', [{ kind: 'sql', sql: 'CREATE TABLE d2(x INTEGER)' }])];
      const target = { driver: nodeDriver(), path: temp.dbPath };
      await assert.rejects(migrate(target, duplicates, { baseline: EMPTY }), refusal('migrate()', 'dup', 0, 1));
      await assert.rejects(migrationStatus(target, duplicates), refusal('migrationStatus()', 'dup', 0, 1));
      assert.equal(existsSync(temp.dbPath), false);
      const distinct = [duplicates[0], { ...duplicates[1], id: 'dup-2' }];
      assert.deepEqual((await migrate(target, distinct, { baseline: EMPTY, shadow: false })).applied, ['dup', 'dup-2']);
      assert.deepEqual(await migrationStatus(target, distinct),
        { applied: ['dup', 'dup-2'], pending: [], drift: null, upToDate: true, baseline: null });
    }
    finally { temp.cleanup(); }
  });
});
