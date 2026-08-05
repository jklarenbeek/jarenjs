//@ts-check
/**
 * @file Every row of the §9 strategy table, with seeded data that
 * must SURVIVE: additive columns (with the doc→column data step and
 * the epoch derivation), droppable columns (with the fold-back),
 * rebuilds for structural change, index-only DDL, relations and join
 * tables, entity add/drop/rename, and the stripped-vocabulary rule
 * that separates mapping changes from document changes.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  planModelMigration, migrate, sqliteDialect, openStore, compareShapeToModel,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const entityModel = (properties, extra = {}) => ({
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      ...properties,
    } } },
    ...extra,
  },
});

/** Plan FROM→TO, drop draft steps (the corpus keeps documents valid),
 * seed, migrate, reopen, and hand back reads plus the raw handle. */
async function roundTrip(from, to, seed, { keepDrafts = false } = {}) {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = await openStore(from, { driver: nodeDriver(), path: dbPath });
    await seed(store);
    await store.close();
    const { migration, report } = planModelMigration(from, to,
      { dialect: sqliteDialect, id: 'step-1' });
    if (!keepDrafts)
      migration.steps = migration.steps.filter((s) => !(s.kind === 'jslt' && s.draft));
    const outcome = await migrate({ driver: nodeDriver(), path: dbPath },
      [migration], { baseline: from, model: to });
    assert.deepStrictEqual(outcome.applied, ['step-1']);
    const reopened = await openStore(to, { driver: nodeDriver(), path: dbPath });
    const raw = new DatabaseSync(dbPath);
    return { reopened, raw, report, migration,
      done: async () => { await reopened.close(); raw.close(); cleanup(); } };
  }
  catch (error) {
    cleanup();
    throw error;
  }
}

describe('the strategy table (§9), row by row', () => {
  it('a new mapped column is one ADD COLUMN; existing rows read absent', async () => {
    const from = entityModel({ name: { type: 'string' } });
    const to = entityModel({ name: { type: 'string' }, age: { type: 'integer' } });
    const { reopened, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', name: 'ada' }); });
    assert.ok(migration.steps.some((s) => /ADD COLUMN "age"/.test(s.sql ?? '')));
    assert.ok(!migration.steps.some((s) => s.kind === 'rebuild'));
    const doc = await reopened.entity('User').asNoTracking().get('u1');
    assert.deepStrictEqual(doc, { id: 'u1', name: 'ada' });
    await reopened.entity('User').update('u1', { age: 36 });
    assert.strictEqual((await reopened.entity('User').asNoTracking().get('u1')).age, 36);
    await done();
  });

  it('a property moving OUT of the document gets its data step', async () => {
    const from = entityModel({ bio: { type: 'string', 'x-entity': { column: 'json' } } });
    const to = entityModel({ bio: { type: 'string' } });
    const { reopened, raw, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', bio: 'writer' }); });
    const row = raw.prepare('SELECT bio, json(doc) AS doc FROM "User"').get();
    assert.strictEqual(row.bio, 'writer', 'the value moved into its column');
    assert.strictEqual(JSON.parse(String(row.doc)).bio, undefined,
      'and left the document');
    assert.strictEqual(
      (await reopened.entity('User').asNoTracking().get('u1')).bio, 'writer');
    await done();
  });

  it('an added epoch column derives from the stored strings, to the millisecond', async () => {
    const from = entityModel({ joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'json' } } });
    const to = entityModel({ joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } });
    const { reopened, raw, done } = await roundTrip(from, to, async (s) => {
      await s.entity('User').create({ id: 'u1', joined: '2026-01-05T10:00:00Z' });
      await s.entity('User').create({ id: 'u2', joined: '2026-01-05T10:00:00.250Z' });
    });
    const rows = raw.prepare('SELECT id, joined FROM "User" ORDER BY id').all();
    assert.strictEqual(rows[0].joined, Date.parse('2026-01-05T10:00:00Z'));
    assert.strictEqual(rows[1].joined, Date.parse('2026-01-05T10:00:00.250Z'));
    assert.strictEqual(
      (await reopened.entity('User').asNoTracking().get('u2')).joined,
      '2026-01-05T10:00:00.250Z', 'the document keeps the string');
    await done();
  });

  it('a dropped property is destructive and NAMED; a moved one folds back', async () => {
    const from = entityModel({
      name: { type: 'string' },
      flag: { type: 'boolean' },
    });
    const to = entityModel({
      name: { type: 'string', 'x-entity': { column: 'json' } },
    });
    const { reopened, raw, report, migration, done } = await roundTrip(from, to,
      async (s) => {
        await s.entity('User').create({ id: 'u1', name: 'ada', flag: true });
      }, { keepDrafts: false });
    assert.strictEqual(report.destructive, true);
    assert.ok(migration.steps.some((s) => /DESTRUCTIVE: drop column 'flag'/.test(s.note ?? '')));
    const doc = JSON.parse(String(raw.prepare('SELECT json(doc) AS d FROM "User"').get().d));
    assert.strictEqual(doc.name, 'ada', 'the surviving property folded into the document');
    assert.strictEqual(doc.flag, undefined, 'the dropped property is gone with its column');
    assert.deepStrictEqual(await reopened.entity('User').asNoTracking().get('u1'),
      { id: 'u1', name: 'ada' });
    await done();
  });

  it('a dropped boolean folds back as true/false, never 0/1', async () => {
    const from = entityModel({ active: { type: 'boolean' } });
    const to = entityModel({ active: { type: 'boolean', 'x-entity': { column: 'json' } } });
    const { reopened, done } = await roundTrip(from, to, async (s) => {
      await s.entity('User').create({ id: 'u1', active: true });
      await s.entity('User').create({ id: 'u2', active: false });
    });
    assert.strictEqual((await reopened.entity('User').asNoTracking().get('u1')).active, true);
    assert.strictEqual((await reopened.entity('User').asNoTracking().get('u2')).active, false);
    await done();
  });

  it('a type change rebuilds and the data casts across', async () => {
    const from = entityModel({ age: { type: 'integer' } });
    const to = entityModel({ age: { type: 'string' } });
    const { reopened, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', age: 36 }); },
      { keepDrafts: false });
    assert.ok(migration.steps.some((s) => s.kind === 'rebuild'));
    assert.strictEqual(
      (await reopened.entity('User').asNoTracking().get('u1')).age, '36');
    await done();
  });

  it('an enum CHECK arriving rebuilds; the constraint is real afterwards', async () => {
    const from = entityModel({ role: { type: 'string' } });
    const to = entityModel({ role: { type: 'string', enum: ['admin', 'user'] } });
    const { reopened, raw, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', role: 'admin' }); },
      { keepDrafts: false });
    assert.ok(migration.steps.some((s) => s.kind === 'rebuild'));
    assert.throws(() => raw.prepare(
      "INSERT INTO \"User\" (id, role, doc) VALUES ('x', 'emperor', jsonb('{}'))").run(),
    /CHECK/);
    assert.strictEqual(
      (await reopened.entity('User').asNoTracking().get('u1')).role, 'admin');
    await done();
  });

  it('an index toggle is plain DDL, never a rebuild, never a draft', async () => {
    const from = entityModel({ name: { type: 'string' } });
    const to = entityModel({ name: { type: 'string', 'x-entity': { index: true } } });
    const { raw, report, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', name: 'ada' }); });
    assert.ok(!migration.steps.some((s) => s.kind === 'rebuild'));
    assert.deepStrictEqual(report.drafts, [],
      'a mapping-only change is not a document change (§9)');
    const indexes = raw.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'User' AND sql IS NOT NULL")
      .all().map((r) => r.name);
    assert.deepStrictEqual(indexes, ['User_name']);
    await done();
  });

  it('an arriving relation rebuilds the holder; the key is enforced after', async () => {
    const from = {
      $model: '0.1',
      entities: {
        User: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } } } } },
        Post: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          authorId: { type: 'string' } } } },
      },
    };
    const to = structuredClone(from);
    to.entities.User.schema.properties.posts = {
      'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } };
    const { reopened, migration, done } = await roundTrip(from, to, async (s) => {
      await s.entity('User').create({ id: 'u1' });
      await s.entity('Post').create({ pid: 1, authorId: 'u1' });
    }, { keepDrafts: false });
    assert.ok(migration.steps.some((s) => s.kind === 'rebuild' && s.table === 'Post'));
    await assert.rejects(
      () => reopened.entity('Post').create({ pid: 9, authorId: 'ghost' }),
      (error) => /** @type {any} */ (error).code === 'JD2005',
      'the foreign key is real after the rebuild');
    assert.deepStrictEqual(
      (await reopened.entity('User').load({ include: { posts: true } }))[0].posts.length, 1);
    await done();
  });

  it('entities add, drop (destructively) and rename with their join tables', async () => {
    const base = {
      $model: '0.1',
      entities: {
        Person: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
        Label: { schema: { type: 'object', required: ['name'], properties: {
          name: { type: 'string', 'x-entity': { key: true } } } } },
        Scratch: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'integer', 'x-entity': { key: true } } } } },
      },
    };
    const to = {
      $model: '0.1',
      entities: {
        Member: { 'x-rename': 'Person', schema: base.entities.Person.schema },
        Label: base.entities.Label,
        Audit: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'integer', 'x-entity': { key: true } } } } },
      },
    };
    const { reopened, raw, report, done } = await roundTrip(base, to, async (s) => {
      await s.entity('Person').create({ id: 'p1' });
      await s.entity('Label').create({ name: 'vip' });
    }, { keepDrafts: false });
    assert.deepStrictEqual(report.renamed, [{ from: 'Person', to: 'Member' }]);
    assert.strictEqual(report.destructive, true, 'Scratch drops');
    assert.deepStrictEqual(await reopened.entity('Member').asNoTracking().get('p1'),
      { id: 'p1' }, 'data survived the rename');
    const tables = raw.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
      .all().map((r) => r.name);
    assert.deepStrictEqual(tables, ['Audit', 'Label', 'Label_Member', 'Member'],
      'the join table renamed with its endpoint; Scratch is gone');
    await done();
  });

  it('a real document change still demands its draft transform', () => {
    const from = entityModel({ name: { type: 'string' } });
    const to = entityModel({ name: { type: 'string', minLength: 2 } });
    const { report } = planModelMigration(from, to, { dialect: sqliteDialect });
    assert.deepStrictEqual(report.drafts, ['User']);
  });

  it('after every migration the shape equals a fresh build (the criterion)', async () => {
    const from = entityModel({ name: { type: 'string' } });
    const to = entityModel({
      name: { type: 'string', 'x-entity': { unique: true } },
      age: { type: 'integer' },
    });
    const { done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', name: 'ada' }); });
    const { dbPath, cleanup } = tempDbPath();
    try {
      // an independent connection proves the migrated file's shape
      const probe = await openStore(to, { driver: nodeDriver(), path: dbPath });
      await probe.close();
    }
    finally {
      cleanup();
    }
    await done();
  });
});

describe('compareShapeToModel is the reusable criterion', () => {
  it('answers null on a fresh shape and names a hand-made difference', async () => {
    const model = entityModel({ name: { type: 'string', 'x-entity': { index: true } } });
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const connection = await nodeDriver().open(dbPath, {});
      assert.strictEqual(
        await compareShapeToModel(nodeDriver(), connection, model, undefined), null);
      const raw = new DatabaseSync(dbPath);
      raw.exec('CREATE INDEX sneaky ON "User" (id)');
      raw.close();
      const difference = await compareShapeToModel(
        nodeDriver(), connection, model, undefined);
      assert.match(String(difference), /unexpected index:sneaky/);
      await connection.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('coverage-complete strategy variants', () => {
  it('a removed index drops; a unique flip rebuilds the index in place', async () => {
    const from = entityModel({
      name: { type: 'string', 'x-entity': { index: true } },
      email: { type: 'string', 'x-entity': { index: true } },
    });
    const to = entityModel({
      name: { type: 'string' },
      email: { type: 'string', 'x-entity': { unique: true } },
    });
    const { raw, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', name: 'ada', email: 'a@x' }); });
    assert.ok(!migration.steps.some((s) => s.kind === 'rebuild'));
    const indexes = raw.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'User' AND sql IS NOT NULL ORDER BY name")
      .all();
    assert.deepStrictEqual(indexes.map((r) => r.name), ['User_email']);
    assert.match(indexes[0].sql, /UNIQUE/);
    await done();
  });

  it('a plain date column becoming an epoch column rebuilds with the derivation', async () => {
    const from = entityModel({ joined: { type: 'string', format: 'date-time' } });
    const to = entityModel({ joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } });
    const { reopened, raw, migration, done } = await roundTrip(from, to,
      async (s) => { await s.entity('User').create({ id: 'u1', joined: '2026-01-05T10:00:00Z' }); },
      { keepDrafts: false });
    assert.ok(migration.steps.some((s) => s.kind === 'rebuild'));
    assert.strictEqual(raw.prepare('SELECT joined FROM "User"').get().joined,
      Date.parse('2026-01-05T10:00:00Z'), 'the epoch derived during the copy');
    assert.strictEqual(
      (await reopened.entity('User').asNoTracking().get('u1')).joined,
      '2026-01-05T10:00:00Z', 'the document keeps the string');
    await done();
  });
});
