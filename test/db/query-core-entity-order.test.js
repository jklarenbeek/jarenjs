//@ts-check
/**
 * @file An entity ordering over a member of the json document orders by the
 * member's declared type on every engine — a number as a number, a string
 * by code point, which is how the engine sorts — in a query's `$orderby` and
 * in a graph load's include alike. A numeric member read as text is no key
 * at all on PostgreSQL, where the order would fall to the row identity.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery } from '@jarenjs/json/query';
import { onBothEngines } from './query-core-engines.js';

const META = { type: 'object', properties: {
  v: { type: 'integer' }, f: { type: 'number' }, s: { type: 'string' }, b: { type: 'boolean' },
} };
const MODEL = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    meta: META,
    posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
  } } },
  Post: { schema: { type: 'object', required: ['pid', 'authorId'], properties: {
    pid: { type: 'integer', 'x-entity': { key: true } },
    authorId: { type: 'string' },
    meta: META,
  } } },
} };

// text order differs from numeric order (`12` before `3`), and code-point
// order puts `B` before `a`
const METAS = [
  { v: 5, f: 0.5, s: 'b', b: true },
  { v: 1, f: -2.25, s: 'B', b: false },
  { v: 3, f: 10, s: 'a', b: true },
  { v: 12, f: 1e-7, s: 'ab', b: false },
];
const AUTHORS = METAS.map((meta, k) => ({ id: 'abcd'[k], meta }));
const POSTS = METAS.map((meta, k) => ({ pid: k + 1, authorId: 'a', meta }));

/** The expected order of the four documents, by position, per member. */
const ORDER = {
  v: { asc: [1, 2, 0, 3], desc: [3, 0, 2, 1] },
  f: { asc: [1, 3, 0, 2], desc: [2, 0, 3, 1] },
  s: { asc: [1, 2, 3, 0], desc: [0, 3, 2, 1] },
};

describe('an entity ordering over a json member', () => {
  it('orders by the declared type in a query and in an include, on every engine', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      for (const author of AUTHORS) await store.entity('Author').create(author);
      for (const post of POSTS) await store.entity('Post').create(post);
      for (const member of /** @type {const} */ (['v', 'f', 's'])) {
        for (const dir of /** @type {const} */ (['asc', 'desc'])) {
          const label = `${host} meta.${member} ${dir}`;
          const orderBy = { $key: `$it.meta.${member}`, $dir: dir };
          const ids = ORDER[member][dir].map((k) => AUTHORS[k].id);
          const pids = ORDER[member][dir].map((k) => POSTS[k].pid);

          const query = { $for: { it: '$.Author[*]' }, $orderby: orderBy, $return: '$it.id' };
          assert.deepEqual(compileJsonQuery(query)({ Author: structuredClone(AUTHORS) }), ids, `engine: ${label}`);
          assert.deepEqual(await store.entity('Author').execute(query), ids, label);
          assert.equal((await store.entity('Author').explain(query)).mode, 'native', label);

          const [loaded] = await store.entity('Author').load({ where: { $eq: ['$it.id', 'a'] }, include: { posts: { orderBy } } });
          assert.deepEqual(loaded.posts.map((/** @type {any} */ post) => post.pid), pids, `include: ${label}`);
          assert.deepEqual((await store.entity('Author').load({ orderBy })).map((/** @type {any} */ author) => author.id), ids,
            `root load: ${label}`);
        }
      }
    });
  });

  it('orders an include by a boolean member false first on every engine, ties in row order', async () => {
    // a query refuses a boolean ordering (the engine raises JQ2005); a load
    // include orders it as SQLite always did, and PostgreSQL now reads it too
    await onBothEngines(MODEL, async (store, host) => {
      await store.entity('Author').create(AUTHORS[0]);
      for (const post of POSTS) await store.entity('Post').create(post);
      for (const [dir, pids] of /** @type {const} */ ([['asc', [2, 4, 1, 3]], ['desc', [1, 3, 2, 4]]])) {
        const [loaded] = await store.entity('Author').load({ include: { posts: { orderBy: { $key: '$it.meta.b', $dir: dir } } } });
        assert.deepEqual(loaded.posts.map((/** @type {any} */ post) => post.pid), pids, `${host} ${dir}`);
      }
    });
  });
});

/** @param {() => any} call */
const later = (call) => Promise.resolve().then(call);

describe('a graph load ordering over a nullable member', () => {
  // a JSON null and a missing member are one empty key on every engine: the
  // two tie and fall to the row order, in a root load as in an include
  const NULLABLE = { type: 'object', properties: { sn: { type: ['string', 'null'] }, vn: { type: ['integer', 'null'] } } };
  const model = { $model: '0.1', entities: {
    A: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, meta: NULLABLE,
      posts: { 'x-entity': { relation: { to: 'P', many: true, via: 'aid', onDelete: 'cascade' } } },
    } } },
    P: { schema: { type: 'object', required: ['pid', 'aid'], properties: {
      pid: { type: 'string', 'x-entity': { key: true } }, aid: { type: 'string' }, meta: NULLABLE,
    } } },
  } };
  const metas = [{ sn: 'b', vn: 3 }, { sn: null, vn: null }, { sn: 'B', vn: 12 }, {}, { sn: 'a', vn: -1 }];
  const ids = ['d', 'a', 'e', 'c', 'b'];
  /** @type {Record<string, Record<string, string[]>>} */
  const expected = {
    sn: { asc: ['a', 'c', 'e', 'b', 'd'], desc: ['d', 'b', 'e', 'a', 'c'] },
    vn: { asc: ['a', 'c', 'b', 'd', 'e'], desc: ['e', 'd', 'b', 'a', 'c'] },
  };

  it('orders a root load as an include orders, the null and the missing member tied, on every engine', async () => {
    await onBothEngines(model, async (store, host) => {
      for (const [k, meta] of metas.entries()) await store.entity('A').create({ id: ids[k], meta });
      for (const [k, meta] of metas.entries()) await store.entity('P').create({ pid: `p${ids[k]}`, aid: 'd', meta });
      for (const member of ['sn', 'vn']) {
        for (const dir of ['asc', 'desc']) {
          const label = `${host} meta.${member} ${dir}`;
          const orderBy = { $key: `$it.meta.${member}`, $dir: dir };
          assert.deepEqual((await store.entity('A').load({ orderBy })).map((/** @type {any} */ a) => a.id),
            expected[member][dir], `root load: ${label}`);
          const [loaded] = await store.entity('A').load({ where: { $eq: ['$it.id', 'd'] }, include: { posts: { orderBy } } });
          assert.deepEqual(loaded.posts.map((/** @type {any} */ p) => p.pid), expected[member][dir].map((id) => `p${id}`),
            `include: ${label}`);
        }
      }
    });
  });
});

describe('an ordering over a member of more than one type', () => {
  // the engine refuses to compare a number with a string (JQ2005): a query
  // leaves the ordering to it, and a graph load, which has no residual,
  // refuses the ordering by code
  const MIXED = { type: 'object', properties: { u: { type: ['integer', 'string'] } } };
  const model = { $model: '0.1',
    entities: {
      A: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, meta: MIXED,
        posts: { 'x-entity': { relation: { to: 'P', many: true, via: 'aid', onDelete: 'cascade' } } },
      } } },
      P: { schema: { type: 'object', required: ['pid', 'aid'], properties: {
        pid: { type: 'string', 'x-entity': { key: true } }, aid: { type: 'string' }, meta: MIXED,
      } } },
    },
    collections: { rows: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, u: { type: ['integer', 'string'] } } } } },
  };
  const values = [3, 'x', 12, 'A', 2];

  it('leaves a query to the engine and refuses a graph load, on every engine', async () => {
    await onBothEngines(model, async (store, host) => {
      for (const [k, u] of values.entries()) await store.entity('A').create({ id: `a${k}`, meta: { u } });
      for (const [k, u] of values.entries()) await store.entity('P').create({ pid: `p${k}`, aid: 'a0', meta: { u } });
      for (const [k, u] of values.entries()) await store.collection('rows').insert({ id: `r${k}`, u });
      for (const dir of ['asc', 'desc']) {
        const label = `${host} ${dir}`;
        const orderBy = { $key: '$it.meta.u', $dir: dir };
        const query = { $for: { it: '$.A[*]' }, $orderby: orderBy, $return: '$it.id' };
        const authors = values.map((u, k) => ({ id: `a${k}`, meta: { u } }));
        assert.throws(() => compileJsonQuery(query)({ A: authors }), { code: 'JQ2005' }, `engine: ${label}`);
        await assert.rejects(later(() => store.entity('A').execute(query)), { code: 'JQ2005' }, label);
        assert.equal((await store.entity('A').explain(query)).mode, 'set', label);
        await assert.rejects(later(() => store.entity('A').load({ orderBy })), { code: 'JD0032' }, `root load: ${label}`);
        await assert.rejects(later(() => store.entity('A').load({ include: { posts: { orderBy } } })), { code: 'JD0032' },
          `include: ${label}`);
        const ordered = { $for: { it: '$[*]' }, $orderby: { $key: '$it.u', $dir: dir }, $return: '$it.id' };
        await assert.rejects(later(() => store.collection('rows').execute(ordered)), { code: 'JQ2005' }, `collection: ${label}`);
        assert.equal((await store.collection('rows').explain(ordered)).mode, 'set', `collection: ${label}`);
      }
    });
  });
});

describe('a keyset page over a document member', () => {
  it('refuses by naming the member path it was given', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      for (const author of AUTHORS) await store.entity('Author').create(author);
      await assert.rejects(later(() => store.entity('Author').page({ orderBy: '$it.meta.s' }, { limit: 2 })),
        (/** @type {any} */ error) => {
          assert.equal(error.code, 'JD0032', host);
          assert.match(error.message, /a keyset orders by mapped columns — '\$\.meta\.s' is a document path/, host);
          assert.doesNotMatch(error.message, /object Object/, host);
          return true;
        });
    });
  });
});
