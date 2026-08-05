//@ts-check
/**
 * @file One-statement graph loading: two levels of relations with
 * exact hand-built expectations, per-relation where/orderBy/take
 * applied inside the subquery, all three relation kinds (one-to-many,
 * one-to-one in both derived join kinds, many-to-many through the
 * join table), related-row counts, the depth bound and cycle
 * rejection (JD0032 naming the path), untranslatable include clauses,
 * and the promise-free twin.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, INCLUDE_DEPTH_DEFAULT } from '@jarenjs/db';
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
          age: { type: 'integer' },
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
          pid: { type: 'integer', 'x-entity': { key: true } },
          title: { type: 'string' },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
          author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
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
          text: { type: 'string' },
          postId: { type: 'integer' },
          post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'cascade' } } },
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

const USERS = [
  { id: 'u1', name: 'ada', age: 36 },
  { id: 'u2', name: 'lin', age: 64 },
  { id: 'u3', name: 'kid', age: 8 },
];
const POSTS = [
  { pid: 1, title: 'alpha', stars: 5, authorId: 'u1' },
  { pid: 2, title: 'beta', stars: 1, authorId: 'u1' },
  { pid: 3, title: 'gamma', stars: 4, authorId: 'u2' },
  { pid: 4, title: 'delta', stars: 3, authorId: 'u1' },
];
const COMMENTS = [
  { cid: 1, text: 'nice', postId: 1 },
  { cid: 2, text: 'wow', postId: 1 },
  { cid: 3, text: 'hm', postId: 3 },
  { cid: 4, text: 'lost' },
];

/** @type {any} */
let db = null;
/** @type {any} */
let store = null;

before(async () => {
  db = new DatabaseSync(':memory:');
  store = await openStore(MODEL, { driver: { open: () => adaptNodeDatabase(db) } });
  for (const user of USERS) await store.entity('User').create(user);
  for (const post of POSTS) await store.entity('Post').create(post);
  for (const comment of COMMENTS) await store.entity('Comment').create(comment);
  for (const name of ['admin', 'dev']) await store.entity('Label').create({ name });
  // join-table membership seeded directly — the read side is this
  // order's surface; a membership API is a later order's
  db.exec(`INSERT INTO "Label_User" ("Label_key", "User_key") VALUES
    ('admin', 'u1'), ('dev', 'u1'), ('admin', 'u2')`);
});
after(async () => {
  if (store !== null) await store.close();
});

describe('one-statement graph loading', () => {
  it('two levels deep, exactly as composed by hand', async () => {
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { posts: { orderBy: '$it.pid', include: { comments: { orderBy: '$it.cid' } } } },
    });
    assert.deepStrictEqual(graph, [
      { id: 'u1', name: 'ada', age: 36, posts: [
        { pid: 1, title: 'alpha', stars: 5, authorId: 'u1', comments: [
          { cid: 1, text: 'nice', postId: 1 },
          { cid: 2, text: 'wow', postId: 1 },
        ] },
        { pid: 2, title: 'beta', stars: 1, authorId: 'u1', comments: [] },
        { pid: 4, title: 'delta', stars: 3, authorId: 'u1', comments: [] },
      ] },
      { id: 'u2', name: 'lin', age: 64, posts: [
        { pid: 3, title: 'gamma', stars: 4, authorId: 'u2', comments: [
          { cid: 3, text: 'hm', postId: 3 },
        ] },
      ] },
      { id: 'u3', name: 'kid', age: 8, posts: [] },
    ]);
  });

  it('where, orderBy and take act INSIDE the include subquery', async () => {
    const graph = await store.entity('User').load({
      where: { $gt: ['$it.age', 10] },
      orderBy: '$it.name',
      include: { posts: {
        where: { $ge: ['$it.stars', 3] },
        orderBy: { $key: '$it.stars', $dir: 'desc' },
        take: 2,
      } },
    });
    assert.deepStrictEqual(
      graph.map((u) => [u.id, u.posts.map((p) => p.title)]),
      [['u1', ['alpha', 'delta']], ['u2', ['gamma']]],
      'filtered to stars>=3, ordered desc, capped at two, per parent');
  });

  it('a required foreign key derives the inner join kind', async () => {
    const graph = await store.entity('Post').load({
      orderBy: '$it.pid',
      include: { author: true },
    });
    assert.deepStrictEqual(graph.map((p) => [p.pid, p.author.name]),
      [[1, 'ada'], [2, 'ada'], [3, 'lin'], [4, 'ada']]);
    assert.deepStrictEqual(
      store.entity('Post').explainLoad({ include: { author: true } }).includes,
      [{ path: 'author', kind: 'inner (fk required)', count: false }]);
  });

  it('an optional foreign key derives the left join kind and loads null', async () => {
    const graph = await store.entity('Comment').load({
      orderBy: '$it.cid',
      include: { post: true },
    });
    assert.deepStrictEqual(graph.map((c) => [c.cid, c.post?.title ?? null]),
      [[1, 'alpha'], [2, 'alpha'], [3, 'gamma'], [4, null]],
      'the orphan reads null, never a phantom row');
    assert.deepStrictEqual(
      store.entity('Comment').explainLoad({ include: { post: true } }).includes,
      [{ path: 'post', kind: 'left (fk optional)', count: false }]);
  });

  it('many-to-many rides the join table in one statement', async () => {
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { labels: { orderBy: '$it.name' } },
    });
    assert.deepStrictEqual(graph.map((u) => [u.id, u.labels.map((l) => l.name)]),
      [['u1', ['admin', 'dev']], ['u2', ['admin']], ['u3', []]]);
  });

  it('count: true projects the related-row count, not the rows', async () => {
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { posts: { count: true } },
    });
    assert.deepStrictEqual(graph.map((u) => [u.id, u.posts]),
      [['u1', 3], ['u2', 1], ['u3', 0]]);
  });

  it('the promise-free twin loads, explains and queries the same surfaces', () => {
    const graph = store.sync.entity('User').load({
      orderBy: '$it.id',
      include: { posts: { count: true } },
    });
    assert.deepStrictEqual(graph.map((u) => [u.id, u.posts]),
      [['u1', 3], ['u2', 1], ['u3', 0]]);
    const explained = store.sync.entity('User').explainLoad({
      orderBy: '$it.id', include: { posts: true },
    });
    assert.strictEqual(explained.pagination, 'none');
    assert.deepStrictEqual(explained.includes,
      [{ path: 'posts', kind: 'oneToMany', count: false }]);
    const rows = store.sync.execute({
      $for: { u: '$.User[*]' },
      $where: { $gt: ['$u.age', 10] },
      $orderby: ['$u.id'],
      $return: '$u.id',
    });
    assert.deepStrictEqual(rows, ['u1', 'u2']);
    const untracked = store.sync.entity('User').asNoTracking()
      .load({ orderBy: '$it.id' });
    assert.strictEqual(Object.isFrozen(untracked[0]), false,
      'the untracked twin returns plain data');
  });
});

describe('the include specification is validated (JD0032)', () => {
  const code = (error) => {
    assert.strictEqual(/** @type {any} */ (error).code, 'JD0032');
    return true;
  };

  it('an unknown relation names itself and its path', async () => {
    await assert.rejects(
      () => store.entity('User').load({ include: { ghosts: true } }),
      (error) => {
        code(error);
        assert.match(/** @type {any} */ (error).message, /ghosts/);
        return true;
      });
  });

  it('the default depth bound refuses level four and prints itself', async () => {
    await assert.rejects(
      () => store.entity('User').load({ include: { posts: { include: {
        comments: { include: { post: { include: { author: true } } } },
      } } } }),
      (error) => {
        code(error);
        assert.match(/** @type {any} */ (error).message,
          new RegExp(`depth bound of ${INCLUDE_DEPTH_DEFAULT}`));
        assert.match(/** @type {any} */ (error).message, /posts\.comments\.post/);
        return true;
      });
    // exactly at the bound is legal
    const graph = await store.entity('User').load({
      where: { $eq: ['$it.id', 'u2'] },
      include: { posts: { include: { comments: { include: { post: true } } } } },
    });
    assert.strictEqual(graph[0].posts[0].comments[0].post.title, 'gamma');
  });

  it('an explicit maxDepth tightens the bound', async () => {
    await assert.rejects(
      () => store.entity('User').load({
        maxDepth: 1,
        include: { posts: { include: { comments: true } } },
      }), code);
  });

  it('a cyclic include specification is rejected', async () => {
    /** @type {any} */
    const include = {};
    include.posts = { include };
    await assert.rejects(() => store.entity('User').load({ include }), code);
  });

  it('an untranslatable include filter or ordering is refused, not silently residual', async () => {
    await assert.rejects(
      () => store.entity('User').load({
        include: { posts: { where: { $eq: ['$it.title', '$it.text'] } } },
      }), code);
    await assert.rejects(
      () => store.entity('Post').load({ orderBy: '$it.author' }),
      (error) => {
        code(error);
        assert.match(/** @type {any} */ (error).message, /typed entity paths/);
        return true;
      });
  });
});
