//@ts-check
/**
 * @file `saveChanges()` end to end: a multi-entity save inside ONE
 * transaction (savepoint counted by a shim), insert batching with
 * generated keys recovered through `RETURNING` and paired correctly,
 * the data-not-a-boolean return shape, and the promise-free twin.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, BATCH_PARAM_BUDGET, BATCH_ROW_BOUND } from '@jarenjs/db';
import { adaptNodeDatabase, nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

describe('one transaction, counts, and the return shape', () => {
  it('a multi-entity save runs in exactly one savepoint and reports data', async () => {
    const db = new DatabaseSync(':memory:');
    let savepoints = 0;
    const shim = {
      exec: (sql) => {
        if (/^SAVEPOINT /.test(sql)) savepoints++;
        return db.exec(sql);
      },
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          run: (...params) => statement.run(...params),
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
          iterate: (...params) => statement.iterate(...params),
        };
      },
      function: (name, options, fn) => db.function(name, options, fn),
      aggregate: (name, spec) => db.aggregate(name, spec),
      createSession: (options) => db.createSession(options),
      close: () => db.close(),
    };
    const store = await openStore(MODEL, {
      driver: { open: () => adaptNodeDatabase(shim) },
    });
    const users = store.entity('User');
    const ada = await users.create({ id: 'u1', name: 'ada' });
    await store.entity('Label').create({ name: 'admin' });
    await store.entity('Post').create({ title: 'old', authorId: 'u1' });

    savepoints = 0;
    users.put({ ...ada, name: 'ada2' });
    store.entity('Post').add({ title: 'fresh', authorId: 'u1' });
    users.put({ ...(await users.get('u1')), name: 'ada2', labels: ['admin'] });
    store.entity('Post').remove(1);
    const report = await store.saveChanges();

    assert.strictEqual(savepoints, 1, 'all statements share one transaction');
    assert.strictEqual(report.inserted, 1);
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(report.deleted, 1);
    assert.strictEqual(report.joinInserted, 1);
    assert.strictEqual(report.fallbacks, 0);
    assert.ok(Array.isArray(report.statements)
      && report.statements.every((s) => typeof s.sql === 'string'
        && typeof s.rows === 'number'));
    assert.ok(typeof report.elapsedMs === 'number' && report.elapsedMs >= 0);
    assert.deepStrictEqual(Object.keys(report.concurrency).sort(),
      ['checked', 'unversioned']);
    await store.close();
  });

  it('an empty save is a zero-statement report, not an error', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const report = await store.saveChanges();
    assert.strictEqual(report.statements.length, 0);
    assert.strictEqual(report.inserted + report.updated + report.deleted, 0);
    await store.close();
  });

  it('the promise-free twin saves the same way', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const sync = store.sync.entity('User');
    sync.create({ id: 's1', name: 'sync' });
    const made = sync.get('s1');
    store.sync.entity('User').put({ ...made, name: 'sync2' });
    const report = store.sync.saveChanges();
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(store.sync.entity('User').asNoTracking().get('s1').name, 'sync2');
    await store.close();
  });
});

describe('insert batching and key recovery', () => {
  it('same-shape inserts coalesce up to the documented bound', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    const posts = store.entity('Post');
    const total = 250;
    for (let i = 0; i < total; i++) posts.add({ title: `p${i}`, authorId: 'u1' });
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, total);
    // Post rows bind (title, authorId, doc) = 3 parameters — the row
    // bound, not the parameter budget, is the binding constraint here
    const paramsPerRow = 3;
    const rowsPerBatch = Math.max(1, Math.min(BATCH_ROW_BOUND,
      Math.floor(BATCH_PARAM_BUDGET / paramsPerRow)));
    assert.strictEqual(report.statements.length, Math.ceil(total / rowsPerBatch));
    assert.match(report.statements[0].sql, /VALUES \(\?, \?, jsonb\(\?\)\), \(\?/);
    await store.close();
  });

  it('RETURNING pairs every generated key with its own document', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    const posts = store.entity('Post');
    for (let i = 0; i < 40; i++) posts.add({ title: `t${i}`, authorId: 'u1' });
    await store.saveChanges();
    const stored = await posts.asNoTracking().load({ orderBy: '$it.pid' });
    assert.strictEqual(stored.length, 40);
    stored.forEach((post, i) => {
      assert.strictEqual(post.title, `t${i}`,
        'ascending keys pair with insertion order');
    });
    await store.close();
  });

  it('a batched insert entity re-tracks under its generated identity', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    const posts = store.entity('Post');
    posts.add({ title: 'one', authorId: 'u1' });
    await store.saveChanges();
    const saved = await posts.get(1);
    posts.put({ ...saved, title: 'renamed' });
    const report = await store.saveChanges();
    assert.strictEqual(report.updated, 1);
    assert.strictEqual((await posts.asNoTracking().get(1)).title, 'renamed');
    await store.close();
  });
});
