//@ts-check
/**
 * @file One-statement graph loading on a real PostgreSQL server, where a
 * placeholder is numbered rather than positional: the filters of nested
 * relations each take their own value, a many-to-many relation filters by
 * its own `where`, and a `count` include wears the profile (the child
 * entity's allow-list and mandatory predicate) as the rows it counts do.
 * The SQLite shapes are `graph.test.js`. Under `JAREN_PG_URL`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' }, age: { type: 'integer' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
      labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
    Post: { schema: { type: 'object', required: ['pid', 'authorId'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' }, stars: { type: 'integer' },
      authorId: { type: 'string' },
      author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
      comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } } } } },
    Comment: { schema: { type: 'object', required: ['cid'], properties: {
      cid: { type: 'integer', 'x-entity': { key: true } }, text: { type: 'string' }, postId: { type: 'integer' } } } },
    Label: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  },
};
const USERS = [{ id: 'u1', name: 'ada', age: 36 }, { id: 'u2', name: 'lin', age: 64 }, { id: 'u3', name: 'kid', age: 8 }];
const POSTS = [
  { pid: 1, title: 'alpha', stars: 5, authorId: 'u1' }, { pid: 2, title: 'beta', stars: 1, authorId: 'u1' },
  { pid: 3, title: 'gamma', stars: 4, authorId: 'u2' }, { pid: 4, title: 'delta', stars: 3, authorId: 'u1' },
];
const COMMENTS = [
  { cid: 1, text: 'nice', postId: 1 }, { cid: 2, text: 'wow', postId: 1 }, { cid: 3, text: 'hm', postId: 3 }, { cid: 4, text: 'lost' },
];

describe('PostgreSQL: graph loading takes each filter its own value', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_graph_${process.pid}`;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    for (const user of USERS) await store.entity('User').create(user);
    for (const post of POSTS) await store.entity('Post').create(post);
    for (const comment of COMMENTS) await store.entity('Comment').create(comment);
    for (const name of ['admin', 'dev']) await store.entity('Label').create({ name });
    await pool.query(`INSERT INTO "${schema}"."Label_User" ("Label_key", "User_key") VALUES
      ('admin', 'u1'), ('dev', 'u1'), ('admin', 'u2')`);
  });
  after(async () => {
    await store?.close();
    try { await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool?.end(); }
  });

  it('filters at two depths each filter their own relation', async () => {
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { posts: {
        where: { $ge: ['$it.stars', 4] }, orderBy: '$it.pid',
        include: { comments: { where: { $eq: ['$it.text', 'wow'] }, orderBy: '$it.cid' } },
      } },
    });
    assert.deepEqual(graph.map((/** @type {any} */ u) => [u.id, u.posts.map((/** @type {any} */ p) => [p.pid, p.comments.map((/** @type {any} */ c) => c.text)])]),
      [['u1', [[1, ['wow']]]], ['u2', [[3, []]]], ['u3', []]]);
  });

  it('a many-to-many relation filters by its where, and an empty answer is its filter\'s', async () => {
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { labels: { where: { $eq: ['$it.name', 'dev'] }, orderBy: '$it.name' } },
    });
    assert.deepEqual(graph.map((/** @type {any} */ u) => [u.id, u.labels.map((/** @type {any} */ l) => l.name)]),
      [['u1', ['dev']], ['u2', []], ['u3', []]]);
  });

  it('a count include wears the profile as the rows it counts do: the predicate binds the count and the allow-list refuses it', async () => {
    const users = store.entity('User');
    const profile = { collections: ['User', 'Post', 'Label'],
      predicates: { Post: { $ge: ['$it.stars', 4] }, Label: { $eq: ['$it.name', 'admin'] } } };
    const rows = await users.load({ orderBy: '$it.id', include: { posts: true, labels: true } }, { profile });
    const counts = await users.load({ orderBy: '$it.id',
      include: { posts: { count: true }, labels: { count: true } } }, { profile });
    assert.deepEqual(counts.map((/** @type {any} */ u) => [u.id, u.posts, u.labels]),
      rows.map((/** @type {any} */ u) => [u.id, u.posts.length, u.labels.length]));
    assert.deepEqual(counts.map((/** @type {any} */ u) => [u.id, u.posts, u.labels]), [['u1', 1, 1], ['u2', 1, 1], ['u3', 0, 0]]);
    const authors = await store.entity('Post').load({ orderBy: '$it.pid', include: { author: { count: true } } },
      { profile: { predicates: { User: { $gt: ['$it.age', 40] } } } });
    assert.deepEqual(authors.map((/** @type {any} */ p) => [p.pid, p.author]), [[1, 0], [2, 0], [3, 1], [4, 0]]);
    await assert.rejects(async () => users.explainLoad({ include: { posts: { count: true } } }, { profile: { collections: ['User'] } }),
      (/** @type {any} */ error) => error.code === 'JD0011' && /does not allow loading entity 'Post' \(include path: posts\)/.test(error.message));
  });
  it('the profile predicate of a counted relation counts toward the term bound, as the rows it counts would', async () => {
    const users = store.entity('User');
    const pairs = (/** @type {number} */ count) => Array.from({ length: count }, (_, i) =>
      ({ $and: [{ $eq: ['$it.title', `t${i}`] }, { $ge: ['$it.stars', i] }] }));
    const profile = (/** @type {number} */ count) => ({ collections: ['User', 'Post'], predicates: { Post: { $or: pairs(count) } } });
    const spec = { include: { posts: { count: true } } };
    assert.equal((await users.load(spec, { profile: profile(64) })).length, 3, '128 leaves load');
    await assert.rejects(async () => users.load(spec, { profile: profile(65) }),
      (/** @type {any} */ error) => error.code === 'JD0032' && /more predicate terms/.test(error.message));
  });
});
