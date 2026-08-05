//@ts-check
/**
 * @file N+1 is a test, not a promise: a counting shim under the node
 * adapter records every statement EXECUTION, and the graph-load
 * assertions demand exactly one per `load` call — regardless of
 * include depth, parent count, per-relation clauses or repetition.
 * The contrast case runs the same shape as per-parent queries and
 * counts the N+1 the include machinery exists to avoid.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';

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
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
          comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
        },
      },
    },
    Comment: {
      schema: {
        type: 'object',
        required: ['cid'],
        properties: {
          cid: { type: 'integer', 'x-entity': { key: true } },
          postId: { type: 'integer' },
        },
      },
    },
  },
};

const counters = { executed: 0 };

/** Shim a DatabaseSync so every statement execution is counted. */
function countedDatabase(db) {
  return {
    exec: (sql) => {
      counters.executed++;
      return db.exec(sql);
    },
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => {
          counters.executed++;
          return statement.run(...params);
        },
        get: (...params) => {
          counters.executed++;
          return statement.get(...params);
        },
        all: (...params) => {
          counters.executed++;
          return statement.all(...params);
        },
        iterate: (...params) => {
          counters.executed++;
          return statement.iterate(...params);
        },
      };
    },
    function: (name, options, fn) => db.function(name, options, fn),
    aggregate: (name, spec) => db.aggregate(name, spec),
    createSession: (options) => db.createSession(options),
    close: () => db.close(),
  };
}

/** @type {any} */
let store = null;

before(async () => {
  const db = new DatabaseSync(':memory:');
  store = await openStore(MODEL, {
    driver: { open: () => adaptNodeDatabase(countedDatabase(db)) },
  });
  for (let i = 1; i <= 10; i++) {
    await store.entity('User').create({ id: `u${i}`, name: `n${i}` });
  }
  let cid = 0;
  for (let pid = 1; pid <= 30; pid++) {
    await store.entity('Post').create({
      pid, stars: pid % 5, authorId: `u${1 + ((pid - 1) % 10)}`,
    });
    for (let c = 0; c < 2; c++) {
      cid += 1;
      await store.entity('Comment').create({ cid, postId: pid });
    }
  }
});
after(async () => {
  if (store !== null) await store.close();
});

describe('exactly one statement per graph load', () => {
  it('two include levels over thirty children: one statement', async () => {
    counters.executed = 0;
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { posts: { include: { comments: true } } },
    });
    assert.strictEqual(counters.executed, 1,
      `expected ONE statement, counted ${counters.executed}`);
    assert.strictEqual(graph.length, 10);
    assert.strictEqual(
      graph.reduce((n, u) => n + u.posts.length, 0), 30);
    assert.strictEqual(
      graph.reduce((n, u) => n + u.posts.reduce((m, p) => m + p.comments.length, 0), 0),
      60);
  });

  it('per-relation where/orderBy/take and counts stay one statement', async () => {
    counters.executed = 0;
    await store.entity('User').load({
      where: { $eq: ['$it.name', 'n3'] },
      include: { posts: {
        where: { $ge: ['$it.stars', 2] },
        orderBy: { $key: '$it.stars', $dir: 'desc' },
        take: 2,
        include: { comments: { count: true } },
      } },
    });
    assert.strictEqual(counters.executed, 1);
  });

  it('repeating the load costs one statement each time, never one per row', async () => {
    counters.executed = 0;
    await store.entity('User').load({ include: { posts: true } });
    await store.entity('User').load({ include: { posts: true } });
    assert.strictEqual(counters.executed, 2);
  });

  it('the contrast: per-parent querying is the N+1 the include avoids', async () => {
    counters.executed = 0;
    const parents = await store.entity('User').load({ orderBy: '$it.id' });
    for (const parent of parents) {
      await store.execute({
        $for: { p: '$.Post[*]' },
        $where: { $eq: ['$p.authorId', '$parent'] },
        $return: '$p',
      }, { externals: { parent: parent.id } });
    }
    assert.strictEqual(counters.executed, 1 + parents.length,
      'ten parents cost eleven statements the include path collapses to one');
  });
});
