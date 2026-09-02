//@ts-check
/**
 * @file The rebuild procedure's guarantees: shape equality after a
 * rebuild against a fresh build; a UDF-expression index makes the
 * rebuild IMPOSSIBLE without `registerFunctions` and routine with it;
 * `PRAGMA foreign_key_check` inside the transaction fails a broken
 * reference and rolls the whole migration back; a shadow failure
 * leaves the real database untouched (history, data and shape); and
 * the `sql` step is always visible in a dry run.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  planModelMigration, migrate, sqliteDialect, openStore,
  schemaShapeOf, createModelShape, HISTORY_TABLE,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const FROM = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'restrict' } } },
    } } },
    Post: { schema: { type: 'object', required: ['pid', 'authorId'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true } },
      stars: { type: 'integer' },
      authorId: { type: 'string' },
    } } },
  },
};
const TO = structuredClone(FROM);
TO.entities.Post.schema.properties.stars = { type: 'string' }; // rebuild Post

const planTo = (id) => {
  const { migration } = planModelMigration(FROM, TO, { dialect: sqliteDialect, id });
  migration.steps = migration.steps.filter((s) => !(s.kind === 'jslt' && s.draft));
  return migration;
};

describe('the rebuild procedure (§10)', () => {
  it('after the rebuild, the schema equals a fresh build of the target', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(FROM, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada' });
      await store.entity('Post').create({ pid: 1, stars: 5, authorId: 'u1' });
      await store.close();
      await migrate({ driver: nodeDriver(), path: dbPath }, [planTo('m1')],
        { baseline: FROM, model: TO });

      const migrated = await nodeDriver().open(dbPath, {});
      const fresh = await nodeDriver().open(':memory:', {});
      await createModelShape(fresh, TO);
      assert.deepStrictEqual(await schemaShapeOf(migrated), await schemaShapeOf(fresh),
        'indexes, foreign keys and constraints included');
      await migrated.close();
      await fresh.close();

      const reopened = await openStore(TO, { driver: nodeDriver(), path: dbPath });
      assert.strictEqual(
        (await reopened.entity('Post').asNoTracking().get(1)).stars, '5',
        'the data crossed the rebuild');
      await reopened.close();
    }
    finally {
      cleanup();
    }
  });

  it('a data step over a UDF-indexed table needs registerFunctions', async () => {
    // index maintenance fires on UPDATE: without the function the
    // step cannot run at all; with the hook it is routine. (A rebuild
    // needs no such help — see the next test — because undeclared
    // indexes die with the old table: they are drift, §12.)
    const from = { $model: '0.1', entities: { User: { schema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        bio: { type: 'string', 'x-entity': { column: 'json' } } } } } } };
    const to = structuredClone(from);
    delete to.entities.User.schema.properties.bio['x-entity'];
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(from, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ id: 'u1', bio: 'writer' });
      await store.close();
      {
        const raw = new DatabaseSync(dbPath);
        raw.function('jaren_len', { deterministic: true }, (v) => String(v ?? '').length);
        raw.exec(`CREATE INDEX "User_hand_udf" ON "User" (jaren_len(json_extract(doc, '$.bio')))`);
        raw.close();
      }
      const plan = () => planModelMigration(from, to,
        { dialect: sqliteDialect, id: 'm1' }).migration;
      await assert.rejects(
        () => migrate({ driver: nodeDriver(), path: dbPath }, [plan()],
          { baseline: from }),
        (error) => {
          assert.match(/** @type {any} */ (error).message, /jaren_len|no such function/);
          return true;
        });
      const outcome = await migrate({ driver: nodeDriver(), path: dbPath }, [plan()], {
        baseline: from,
        registerFunctions: (connection) => connection.registerFunction?.(
          'jaren_len', { deterministic: true }, (v) => String(v ?? '').length),
      });
      assert.deepStrictEqual(outcome.applied, ['m1']);
      const raw = new DatabaseSync(dbPath);
      assert.strictEqual(raw.prepare('SELECT bio FROM "User"').get().bio, 'writer');
      raw.close();
    }
    finally {
      cleanup();
    }
  });

  it('a rebuild erases an undeclared UDF index — drift dies with the old table', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(FROM, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada' });
      await store.entity('Post').create({ pid: 1, stars: 5, authorId: 'u1' });
      await store.close();
      {
        const raw = new DatabaseSync(dbPath);
        raw.function('jaren_len', { deterministic: true }, (v) => String(v ?? '').length);
        raw.exec('CREATE INDEX "Post_hand_udf" ON "Post" (jaren_len(authorId))');
        raw.close();
      }
      const outcome = await migrate({ driver: nodeDriver(), path: dbPath },
        [planTo('m1')], { baseline: FROM, model: TO });
      assert.deepStrictEqual(outcome.applied, ['m1']);
      const migrated = await nodeDriver().open(dbPath, {});
      const dump = await schemaShapeOf(migrated);
      assert.ok(!dump.some((row) => row.name === 'Post_hand_udf'),
        'the model owns the shape; undeclared indexes are drift and die');
      await migrated.close();
    }
    finally {
      cleanup();
    }
  });

  it('foreign_key_check inside the transaction fails a broken reference and rolls back', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(FROM, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada' });
      await store.entity('Post').create({ pid: 1, stars: 5, authorId: 'u1' });
      await store.close();
      // tamper the reviewable document: the copy invents an orphan key
      const tampered = planTo('m1');
      const rebuild = tampered.steps.find((s) => s.kind === 'rebuild');
      // tamper the SELECT side only: the copy invents an orphan key
      const select = rebuild.copy.indexOf('SELECT');
      rebuild.copy = rebuild.copy.slice(0, select)
        + rebuild.copy.slice(select).replace('"authorId"', "'ghost'");
      await assert.rejects(
        () => migrate({ driver: nodeDriver(), path: dbPath }, [tampered],
          { baseline: FROM, model: TO, shadow: false }),
        (error) => {
          assert.strictEqual(/** @type {any} */ (error).code, 'JD0023');
          assert.match(/** @type {any} */ (error).message, /foreign_key_check/);
          return true;
        });
      // the whole migration rolled back: data intact, history empty
      const raw = new DatabaseSync(dbPath);
      assert.strictEqual(raw.prepare('SELECT authorId FROM "Post"').get().authorId, 'u1');
      assert.strictEqual(
        raw.prepare(`SELECT COUNT(*) AS n FROM "${HISTORY_TABLE}"`).get().n, 0);
      raw.close();
    }
    finally {
      cleanup();
    }
  });

  it('a shadow failure leaves the real database untouched', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(FROM, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada' });
      await store.close();
      // the bookkeeping table appears before the shadow runs (by
      // design); the SHAPE — what schemaShapeOf sees — must not change
      const before = await (async () => {
        const probe = await nodeDriver().open(dbPath, {});
        const dump = JSON.stringify(await schemaShapeOf(probe));
        await probe.close();
        return dump;
      })();
      const tampered = planTo('m1');
      const rebuild = tampered.steps.find((s) => s.kind === 'rebuild');
      rebuild.copy = 'INSERT INTO nowhere SELECT 1';
      await assert.rejects(
        () => migrate({ driver: nodeDriver(), path: dbPath }, [tampered],
          { baseline: FROM, model: TO }),
        (error) => /** @type {any} */ (error).code === 'JD0023');
      const probe = await nodeDriver().open(dbPath, {});
      const after = JSON.stringify(await schemaShapeOf(probe));
      await probe.close();
      assert.strictEqual(after, before, 'the shadow died; the real shape never changed');
      const raw = new DatabaseSync(dbPath);
      assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM "User"').get().n, 1);
      assert.strictEqual(
        raw.prepare(`SELECT COUNT(*) AS n FROM "${HISTORY_TABLE}"`).get().n, 0,
        'nothing recorded');
      raw.close();
    }
    finally {
      cleanup();
    }
  });

  it('the sql step is always visible in a dry run, with its note', async () => {
    const from = { $model: '0.1', entities: { User: { schema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        bio: { type: 'string', 'x-entity': { column: 'json' } } } } } } };
    const to = structuredClone(from);
    delete to.entities.User.schema.properties.bio['x-entity'];
    const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'm1' });
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(from, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const dry = await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: from, model: to, dryRun: true });
      assert.strictEqual(dry.dryRun, true);
      assert.ok(dry.statements.some((line) => /-- data step \(sql\):/.test(line)));
      assert.ok(dry.statements.some((line) => /UPDATE "User" SET "bio"/.test(line)));
    }
    finally {
      cleanup();
    }
  });
});

describe('migrationStatus closes its connection on failure', () => {
  it('an edited applied migration is JD0022 through migrationStatus too', async () => {
    const { migrationStatus } = await import('@jarenjs/db');
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(FROM, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const migration = planTo('m1');
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: FROM, model: TO });
      const edited = structuredClone(migration);
      edited.steps.push({ kind: 'sql', sql: 'SELECT 1', note: 'sneaky edit' });
      await assert.rejects(
        () => migrationStatus({ driver: nodeDriver(), path: dbPath }, [edited]),
        (error) => /** @type {any} */ (error).code === 'JD0022');
    }
    finally {
      cleanup();
    }
  });
});
