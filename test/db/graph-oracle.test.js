//@ts-check
/**
 * @file Graph loading against a JavaScript oracle: seeded random `where`,
 * `orderBy`, `take` and `skip` at the root and at two include levels, each
 * answer compared with the nested rows computed from the same arrays. A
 * relation's filter binds its own value whatever the statement's text
 * order — SQLite's placeholders are anonymous and take the next value in
 * the text, PostgreSQL's are numbered — so the cases put a filter on a
 * relation and another on the relation nested in it. SQLite always; the
 * PostgreSQL half needs `JAREN_PG_URL`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const CASES = 60;
const MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string', 'x-entity': { index: true } },
      age: { type: 'integer', 'x-entity': { index: true } },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['pid', 'authorId'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string', 'x-entity': { index: true } },
      stars: { type: 'integer', 'x-entity': { index: true } }, authorId: { type: 'string' },
      comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } } } } },
    Comment: { schema: { type: 'object', required: ['cid', 'postId'], properties: {
      cid: { type: 'integer', 'x-entity': { key: true } }, body: { type: 'string', 'x-entity': { index: true } },
      likes: { type: 'integer', 'x-entity': { index: true } }, postId: { type: 'integer' } } } },
  },
};
const USERS = Array.from({ length: 8 }, (_, u) => ({ id: `u${u}`, name: ['ann', 'bob', 'cy', 'di'][u % 4], age: u * 7 }));
const POSTS = Array.from({ length: 40 }, (_, p) => ({ pid: p, title: `t${p % 5}`, stars: (p * 3) % 7, authorId: `u${p % 8}` }));
const COMMENTS = Array.from({ length: 160 }, (_, c) => ({ cid: c, body: `b${c % 3}`, likes: (c * 5) % 6, postId: c % 40 }));
const OPS = /** @type {Record<string, (a: number, b: number) => boolean>} */ ({
  ge: (a, b) => a >= b, le: (a, b) => a <= b, gt: (a, b) => a > b, lt: (a, b) => a < b });

/** mulberry32: one seed, one case, so a failing case is named by its number. */
const seeded = (/** @type {number} */ seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** @param {any} store */
async function seed(store) {
  for (const row of USERS) await store.entity('User').create(row);
  for (const row of POSTS) await store.entity('Post').create(row);
  for (const row of COMMENTS) await store.entity('Comment').create(row);
}

/** @param {any} store */
async function agrees(store) {
  let nonEmpty = 0;
  for (let k = 0; k < CASES; k++) {
    const random = seeded(1000 + k);
    const pick = (/** @type {any[]} */ list) => list[Math.floor(random() * list.length)];
    const rootOp = pick(['ge', 'le', 'gt', 'lt']);
    const rootAge = pick([0, 7, 14, 21, 28, 35]);
    const postOp = pick(['ge', 'le', 'gt', 'lt']);
    const postStars = pick([0, 1, 2, 3, 4, 5, 6]);
    const titles = [pick(['t0', 't1', 't2']), pick(['t2', 't3', 't4'])];
    const likesOp = pick(['ge', 'le']);
    const likes = pick([0, 1, 2, 3, 4, 5]);
    const postWhere = random() < 0.8;
    const titleList = random() < 0.4;
    const commentWhere = random() < 0.8;
    const takePosts = random() < 0.5 ? pick([1, 2, 3]) : undefined;
    const skipPosts = takePosts !== undefined && random() < 0.5 ? pick([1, 2]) : undefined;
    const takeComments = random() < 0.4 ? pick([1, 2]) : undefined;
    const stars = { [`$${postOp}`]: ['$it.stars', postStars] };
    const spec = { orderBy: '$it.id', where: { [`$${rootOp}`]: ['$it.age', rootAge] }, include: { posts: {
      ...(postWhere ? { where: titleList
        ? { $and: [stars, { $or: [{ $eq: ['$it.title', titles[0]] }, { $eq: ['$it.title', titles[1]] }] }] } : stars } : {}),
      orderBy: [{ $key: '$it.stars', $dir: 'desc' }, '$it.pid'],
      ...(takePosts === undefined ? {} : { take: takePosts }), ...(skipPosts === undefined ? {} : { skip: skipPosts }),
      include: { comments: {
        ...(commentWhere ? { where: { [`$${likesOp}`]: ['$it.likes', likes] } } : {}), orderBy: '$it.cid',
        ...(takeComments === undefined ? {} : { take: takeComments }) } } } } };
    const expected = USERS.filter((u) => OPS[rootOp](u.age, rootAge)).map((u) => {
      let posts = POSTS.filter((p) => p.authorId === u.id);
      if (postWhere) posts = posts.filter((p) => OPS[postOp](p.stars, postStars) && (!titleList || titles.includes(p.title)));
      posts.sort((a, b) => b.stars - a.stars || a.pid - b.pid);
      if (skipPosts !== undefined) posts = posts.slice(skipPosts);
      if (takePosts !== undefined) posts = posts.slice(0, takePosts);
      return { id: u.id, posts: posts.map((p) => {
        let comments = COMMENTS.filter((c) => c.postId === p.pid);
        if (commentWhere) comments = comments.filter((c) => OPS[likesOp](c.likes, likes));
        if (takeComments !== undefined) comments = comments.slice(0, takeComments);
        return { pid: p.pid, comments: comments.map((c) => c.cid) };
      }) };
    });
    const loaded = await store.entity('User').load(spec);
    const actual = loaded.map((/** @type {any} */ u) => ({ id: u.id, posts: u.posts.map((/** @type {any} */ p) =>
      ({ pid: p.pid, comments: p.comments.map((/** @type {any} */ c) => c.cid) })) }));
    assert.deepEqual(actual, expected, `case ${k}: ${JSON.stringify(spec)}`);
    if (expected.some((u) => u.posts.some((p) => p.comments.length > 0))) nonEmpty++;
  }
  return nonEmpty;
}

describe('a graph load answers as the rows it is asked for (SQLite)', () => {
  /** @type {any} */
  let store;
  before(async () => {
    store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    await seed(store);
  });
  after(async () => { await store?.close(); });
  it(`${CASES} seeded specs with filters at three depths equal the oracle's nested rows`, async () => {
    assert.ok(await agrees(store) > CASES / 2, 'most cases select something to compare');
  });
});

describe('a graph load answers as the rows it is asked for (PostgreSQL)', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_graph_oracle_${process.pid}`;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await seed(store);
  });
  after(async () => {
    await store?.close();
    try { await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool?.end(); }
  });
  it(`${CASES} seeded specs with filters at three depths equal the oracle's nested rows`, async () => {
    assert.ok(await agrees(store) > CASES / 2, 'most cases select something to compare');
  });
});
