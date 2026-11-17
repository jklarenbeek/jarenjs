//@ts-check
/**
 * @file An entity's key, and a column referencing one, compared as the
 * engine reads it whatever digits another writer spelled it by. PostgreSQL
 * holds an `integer` or `number` key the caller writes as a `numeric`, where
 * another writer could re-key a row `6.00000000000000000001`, which the engine
 * reads as 6. A table the store creates holds each such column to its
 * double's digits below 2^53 by a CHECK, so every shape compares the key
 * exactly and as the engine, through its index; a literal past 2^53 compares
 * by its double's interval. A table an earlier release created, without the
 * CHECK, compares a literal, a literal list and an external list by the
 * interval and two such columns exactly — a listed loss — until
 * `planColumnUpgrade` adds the CHECK, refused `JD0023` naming the rows another
 * writer spelled otherwise. A key the database allocates (`bigserial`, its
 * references `bigint`) holds integers alone and compares exactly, as before,
 * and so does a key the open reads as held so. PostgreSQL where JAREN_PG_URL
 * names a server; SQLite always.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planColumnUpgrade, migrate } from '@jarenjs/db';
import { relational, sql as q } from '@jarenjs/db/relational';
import { skipFor, withPostgres, withStore } from './store-core-engines.js';

const W = '6.00000000000000000001';
/** @param {boolean} auto - whether the database allocates the post's key */
const model = (auto) => ({ $model: '0.1', entities: {
  Post: { schema: { type: 'object', required: ['pid'], properties: {
    pid: { type: 'integer', 'x-entity': { key: true, ...(auto ? { default: 'auto' } : {}) } }, score: { type: 'number' }, name: { type: 'string' },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
    kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'postRef', onDelete: 'cascade' } } } } },
  indexes: [{ name: 'by_name', path: '$.name' }] },
  Comment: { schema: { type: 'object', properties: {
    cid: { type: 'string', 'x-entity': { key: true } }, postId: { type: 'integer' }, replyTo: { type: 'integer' }, score: { type: 'number' },
    post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'cascade' } } },
    reply: { 'x-entity': { relation: { to: 'Post', via: 'replyTo', onDelete: 'cascade' } } } } },
  indexes: [{ name: 'by_score', path: '$.score' }] },
  Tag: { schema: { type: 'object', properties: { tid: { type: 'integer', 'x-entity': { key: true } } } } },
  Kid: { schema: { type: 'object', properties: { kid: { type: 'string', 'x-entity': { key: true } } } } },
  N: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'number', 'x-entity': { key: true } }, name: { type: 'string' } } } },
} });

const P = (/** @type {any} */ where) => ({ $for: { p: '$.Post[*]' }, $where: where, $orderby: ['$p.name'], $return: '$p.name' });
const C = (/** @type {any} */ where) => ({ $for: { c: '$.Comment[*]' }, $where: where, $orderby: ['$c.cid'], $return: '$c.cid' });
const join = (/** @type {any} */ bindings, /** @type {any} */ where, /** @type {string[]} */ order, /** @type {any} */ ret) =>
  ({ $for: bindings, $where: where, $orderby: order, $return: ret });
const count = (/** @type {string} */ outer, /** @type {string} */ root, /** @type {string} */ inner, /** @type {string} */ name, /** @type {any} */ where) =>
  ({ $for: { [outer]: root }, $orderby: [`$${outer}.${name}`], $return: { [outer]: `$${outer}.${name}`,
    n: { $count: { $for: where.for, $where: where.where, $return: `$${inner}` } } } });
const PC = [{ c: 'c1', p: 'p6' }, { c: 'c1', p: 'p7' }, { c: 'c2', p: 'p5' }, { c: 'c3', p: 'p6' }, { c: 'c3', p: 'p7' }];
const PER_POST = [{ p: 'p5', n: 1 }, { p: 'p6', n: 2 }, { p: 'p7', n: 2 }, { p: 'p8', n: 0 }];
const PER_COMMENT = [{ c: 'c1', n: 2 }, { c: 'c2', n: 1 }, { c: 'c3', n: 2 }];
/** Each shape, its externals, and what the engine answers once post 7 (and every row naming it) is re-keyed `W`. */
const SHAPES = /** @type {[string, any, any, unknown][]} */ ([
  ['key $eq a literal', P({ $eq: ['$p.pid', 6] }), undefined, ['p6', 'p7']],
  ['key $ne a literal', P({ $ne: ['$p.pid', 6] }), undefined, ['p5', 'p8']],
  ['key $le a literal', P({ $le: ['$p.pid', 6] }), undefined, ['p5', 'p6', 'p7']],
  ['key $gt a literal', P({ $gt: ['$p.pid', 6] }), undefined, 'p8'],
  ['key in a literal list', P({ $eq: ['$p.pid', { $seq: [6, 8] }] }), undefined, ['p6', 'p7', 'p8']],
  ['key in an external list', P({ $eq: ['$p.pid', '$ids[*]'] }), { ids: [6, 8] }, ['p6', 'p7', 'p8']],
  ['number key $eq a literal', { $for: { n: '$.N[*]' }, $where: { $eq: ['$n.id', 6] }, $orderby: ['$n.name'], $return: '$n.name' }, undefined, ['n6', 'n7']],
  ['number key in a literal list', { $for: { n: '$.N[*]' }, $where: { $eq: ['$n.id', { $seq: [6, 0.5] }] }, $orderby: ['$n.name'], $return: '$n.name' },
    undefined, ['n0.5', 'n6', 'n7']],
  ['reference $eq a literal', C({ $eq: ['$c.postId', 6] }), undefined, ['c1', 'c3']],
  ['reference in a literal list', C({ $eq: ['$c.postId', { $seq: [6] }] }), undefined, ['c1', 'c3']],
  ['reference in an external list', C({ $eq: ['$c.postId', '$ids[*]'] }), { ids: [6] }, ['c1', 'c3']],
  ['two references in one row, $eq', C({ $eq: ['$c.postId', '$c.replyTo'] }), undefined, 'c1'],
  ['two references in one row, $lt', C({ $lt: ['$c.postId', '$c.replyTo'] }), undefined, 'c2'],
  ['a key joined to a reference', join({ p: '$.Post[*]', c: '$.Comment[*]' }, { $eq: ['$c.postId', '$p.pid'] }, ['$c.cid', '$p.name'],
    { c: '$c.cid', p: '$p.name' }), undefined, PC],
  ['a reference joined to a key', join({ c: '$.Comment[*]', p: '$.Post[*]' }, { $eq: ['$p.pid', '$c.postId'] }, ['$c.cid', '$p.name'],
    { c: '$c.cid', p: '$p.name' }), undefined, PC],
  ['a key joined to a key', join({ p: '$.Post[*]', n: '$.N[*]' }, { $eq: ['$n.id', '$p.pid'] }, ['$p.name', '$n.name'], { p: '$p.name', n: '$n.name' }),
    undefined, [{ p: 'p5', n: 'n5' }, { p: 'p6', n: 'n6' }, { p: 'p6', n: 'n7' }, { p: 'p7', n: 'n6' }, { p: 'p7', n: 'n7' }]],
  ['a hop from a key to a reference', count('p', '$.Post[*]', 'c', 'name', { for: { c: '$.Comment[*]' }, where: { $eq: ['$c.postId', '$p.pid'] } }),
    undefined, PER_POST],
  ['a hop from a reference to a key', count('c', '$.Comment[*]', 'p', 'cid', { for: { p: '$.Post[*]' }, where: { $eq: ['$p.pid', '$c.postId'] } }),
    undefined, PER_COMMENT],
  ['a key joined to a number column', join({ p: '$.Post[*]', c: '$.Comment[*]' }, { $eq: ['$c.score', '$p.pid'] }, ['$c.cid', '$p.name'],
    { c: '$c.cid', p: '$p.name' }), undefined, PC],
  ['a reference joined to a number column', join({ p: '$.Post[*]', c: '$.Comment[*]' }, { $eq: ['$c.postId', '$p.score'] }, ['$c.cid', '$p.name'],
    { c: '$c.cid', p: '$p.name' }), undefined, [{ c: 'c1', p: 'p6' }, { c: 'c2', p: 'p5' }, { c: 'c3', p: 'p6' }]],
  ['a hop from a key to a number column', count('p', '$.Post[*]', 'c', 'name', { for: { c: '$.Comment[*]' }, where: { $eq: ['$c.score', '$p.pid'] } }),
    undefined, PER_POST],
  ['a hop from a number column to a key', count('c', '$.Comment[*]', 'p', 'cid', { for: { p: '$.Post[*]' }, where: { $eq: ['$p.pid', '$c.score'] } }),
    undefined, PER_COMMENT],
  ['a number key joined to a number column', join({ n: '$.N[*]', c: '$.Comment[*]' }, { $eq: ['$c.score', '$n.id'] }, ['$c.cid', '$n.name'],
    { c: '$c.cid', n: '$n.name' }), undefined,
  [{ c: 'c1', n: 'n6' }, { c: 'c1', n: 'n7' }, { c: 'c2', n: 'n5' }, { c: 'c3', n: 'n6' }, { c: 'c3', n: 'n7' }]],
  ['a join table\'s key $eq a literal', { $for: { j: '$.Post_Tag[*]' }, $where: { $eq: ['$j.Post_key', 6] }, $orderby: ['$j.Tag_key'], $return: '$j.Tag_key' },
    undefined, [1, 2]],
  ['a join table\'s key joined to a key', join({ p: '$.Post[*]', j: '$.Post_Tag[*]' }, { $eq: ['$j.Post_key', '$p.pid'] }, ['$p.name', '$j.Tag_key'],
    { p: '$p.name', t: '$j.Tag_key' }), undefined, [{ p: 'p6', t: 1 }, { p: 'p6', t: 2 }, { p: 'p7', t: 1 }, { p: 'p7', t: 2 }]],
  ['a reference no property declares, $eq a literal', { $for: { k: '$.Kid[*]' }, $where: { $eq: ['$k.postRef', 6] }, $orderby: ['$k.kid'], $return: '$k.kid' },
    undefined, ['k1', 'k2']],
  ['a reference no property declares, joined to a key', join({ p: '$.Post[*]', k: '$.Kid[*]' }, { $eq: ['$k.postRef', '$p.pid'] }, ['$k.kid', '$p.name'],
    { k: '$k.kid', p: '$p.name' }), undefined, [{ k: 'k1', p: 'p6' }, { k: 'k1', p: 'p7' }, { k: 'k2', p: 'p6' }, { k: 'k2', p: 'p7' }]],
]);

/** Whether a shape compares a key with a number rather than with another column. @param {string} name */
const withNumber = (name) => /a literal|list/.test(name);

/**
 * The statements of the shapes that compare two columns: as stored, a key exactly.
 * @param {any} store
 */
async function pairsCompareExactly(store) {
  const sql = async (/** @type {string} */ name) => (await store.explain(/** @type {any} */ (SHAPES.find((shape) => shape[0] === name))[1])).sql;
  assert.match(await sql('a key joined to a reference'), /JOIN "Comment" AS "t1" ON "t1"\."postId" = "t0"\."pid" ORDER BY/);
  assert.match(await sql('a hop from a key to a reference'), /WHERE "h0"\."postId" = "t0"\."pid"\)/);
  assert.match(await sql('two references in one row, $eq'), /WHERE \("t0"\."postId" IS NOT NULL AND "t0"\."replyTo" IS NOT NULL AND "t0"\."postId" = "t0"\."replyTo"\)/);
  // a number column beside it reads the double, the key exactly against it
  assert.match(await sql('a key joined to a number column'), /ON \("t0"\."pid" = \(\(CASE WHEN abs\("t1"\."score"\)/);
  assert.doesNotMatch(await sql('a join table\'s key joined to a key'), /::float8/);
}

/**
 * Posts 5 to 8, numbers 5, 6, 7 and 0.5, three comments, two links and two
 * kids naming posts 6 and 7; then, where `rekey`, another writer re-keys
 * post 7, every row naming it and number 7 as `W`.
 * @param {any} store @param {any} pool @param {string} schema @param {boolean} rekey
 */
async function fill(store, pool, schema, rekey) {
  for (const pid of [5, 6, 7, 8]) await store.entity('Post').create({ pid, score: pid, name: `p${pid}` });
  for (const id of [5, 6, 7, 0.5]) await store.entity('N').create({ id, name: `n${id}` });
  await store.saveChanges();
  for (const [cid, postId, replyTo, score] of [['c1', 6, 7, 6], ['c2', 5, 6, 5], ['c3', 7, 5, 6]])
    await store.entity('Comment').create({ cid, postId, replyTo, score });
  await store.saveChanges();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`INSERT INTO "Tag" (tid, doc) VALUES (1, '{}'), (2, '{}'); INSERT INTO "Post_Tag" ("Post_key", "Tag_key") VALUES (6, 1), (7, 2); `
      + `INSERT INTO "Kid" (kid, "postRef", doc) VALUES ('k1', 6, '{}'), ('k2', 7, '{}')`);
    if (rekey) {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const [table, column] of [['Post', 'pid'], ['Comment', 'postId'], ['Comment', 'replyTo'], ['N', 'id'], ['Post_Tag', 'Post_key'], ['Kid', 'postRef']])
        await client.query(`UPDATE "${table}" SET "${column}" = ${W} WHERE "${column}" = 7`);
      await client.query('COMMIT');
    }
  }
  finally {
    await client.query('RESET search_path');
    client.release();
  }
}

/**
 * Drop every key CHECK of a schema's tables, leaving them as an earlier release created them.
 * @param {any} pool @param {string} schema @returns {Promise<string[]>} the dropped constraints, `<table>.<name>`
 */
async function dropKeyChecks(pool, schema) {
  const { rows } = await pool.query('SELECT t.relname AS t, c.conname AS c FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid '
    + 'JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND c.contype = \'c\' AND pg_catalog.pg_get_expr(c.conbin, c.conrelid) LIKE \'%trunc%\' ORDER BY 1, 2', [schema]);
  for (const row of rows) await pool.query(`ALTER TABLE "${schema}"."${row.t}" DROP CONSTRAINT "${row.c}"`);
  return rows.map((/** @type {any} */ row) => `${row.t}.${row.c}`);
}

/**
 * Open `model(createAuto)` to create the tables, then `model(openAuto)` over
 * them — where `earlier`, once their key CHECKs are dropped.
 * @param {boolean} createAuto @param {boolean} openAuto @param {boolean} earlier
 * @param {(store: any, pg: { pool: any, schema: string, driver: () => any }) => Promise<void>} fn
 */
const reopened = (createAuto, openAuto, earlier, fn) => withPostgres(async (pg) => {
  await (await openStore(model(createAuto), { driver: pg.driver() })).close();
  if (earlier) await dropKeyChecks(pg.pool, pg.schema);
  const store = await openStore(model(openAuto), { driver: pg.driver() });
  try { await fn(store, pg); }
  finally { await store.close(); }
});

describe('an entity key another writer spelled in a table an earlier release created, PostgreSQL', { skip: skipFor('postgres') }, () => {
  for (const [title, createAuto, openAuto] of /** @type {[string, boolean, boolean][]} */ ([
    ['a key the caller writes', false, false], ['a key the model allocates over a table that holds it as numeric', false, true]])) {
    it(`compares ${title} with a number as the engine reads it, and with another column exactly`, async () => {
      await reopened(createAuto, openAuto, true, async (store, { pool, schema }) => {
        await fill(store, pool, schema, true);
        for (const [name, query, externals, expected] of SHAPES.filter(([name]) => withNumber(name))) {
          const options = externals === undefined ? {} : { externals };
          assert.equal((await store.explain(query, options)).mode, 'native', name);
          assert.deepEqual(await store.execute(query, { ...options, pushdown: false }), expected, `${name}: the engine`);
          assert.deepEqual(await store.execute(query, options), expected, name);
        }
        const loaded = await store.entity('Post').asNoTracking().load({ where: { $eq: ['$it.pid', 6] } });
        assert.deepEqual(loaded.map((/** @type {any} */ post) => post.name).sort(), ['p6', 'p7']);
        // the listed loss: two columns compare the key exactly, so a join drops the re-keyed post's other spelling
        await pairsCompareExactly(store);
        const keyJoin = /** @type {any} */ (SHAPES.find(([name]) => name === 'a key joined to a reference'));
        assert.deepEqual(await store.execute(keyJoin[1]), [{ c: 'c1', p: 'p6' }, { c: 'c2', p: 'p5' }, { c: 'c3', p: 'p7' }]);
        assert.deepEqual(await store.execute(keyJoin[1], { pushdown: false }), keyJoin[3]);
      });
    });
  }

  for (const [title, createAuto, openAuto] of /** @type {[string, boolean, boolean][]} */ ([
    ['a key the database allocates', true, true], ['a key the caller writes over a table that holds it as bigint', true, false]])) {
    it(`compares ${title} exactly, as stored`, async () => {
      await reopened(createAuto, openAuto, false, async (store, { pool, schema }) => {
        await fill(store, pool, schema, false);
        const sql = async (/** @type {any} */ query, /** @type {any} */ externals = undefined) =>
          (await store.explain(query, externals === undefined ? {} : { externals })).sql;
        assert.match(await sql(P({ $eq: ['$p.pid', 6] })), /WHERE \("t0"\."pid" IS NOT NULL AND "t0"\."pid" = \$1\)/);
        assert.match(await sql(C({ $eq: ['$c.postId', { $seq: [6] }] })), /"t0"\."postId" IN \(SELECT \(i\.e #>> '\{\}'\)::numeric/);
        await pairsCompareExactly(store);
        for (const [name, query, externals] of SHAPES) {
          const options = externals === undefined ? {} : { externals };
          assert.deepEqual(await store.execute(query, options), await store.execute(query, { ...options, pushdown: false }), name);
        }
      });
    });
  }

  for (const earlier of [true, false]) it(`still seeks the key's index, and the reference's, through every comparison that did${earlier ? '' : ', under the key\'s CHECK'}`, async () => {
    await reopened(false, false, earlier, async (store, { pool, schema }) => {
      const s = `"${schema}"`;
      await pool.query(`INSERT INTO ${s}."Post" (pid, score, name, doc) SELECT g, g, 'p' || g, '{}'::jsonb FROM generate_series(1, 20000) g;`
        + `INSERT INTO ${s}."N" (id, name, doc) SELECT g, 'n' || g, '{}'::jsonb FROM generate_series(1, 20000) g;`
        + `INSERT INTO ${s}."Comment" (cid, "postId", "replyTo", score, doc) SELECT 'c' || g, g, 1 + g % 20000, g, '{}'::jsonb FROM generate_series(1, 20000) g;`
        + `INSERT INTO ${s}."Tag" (tid, doc) SELECT g, '{}'::jsonb FROM generate_series(1, 20000) g;`
        + `INSERT INTO ${s}."Post_Tag" ("Post_key", "Tag_key") SELECT g, 1 + (g * 7) % 20000 FROM generate_series(1, 20000) g;`
        + `ANALYZE ${s}."Post"; ANALYZE ${s}."N"; ANALYZE ${s}."Comment"; ANALYZE ${s}."Tag"; ANALYZE ${s}."Post_Tag"`);
      const one = { $eq: ['$c.cid', 'c77'] };
      const post = { $eq: ['$p.name', 'p77'] };
      const ten = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
      const seeks = /** @type {[any, any, RegExp[], unknown][]} */ ([
        [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', 77] }, $return: '$p.name' }, undefined, [/Index Scan using "Post_pkey"/], 'p77'],
        [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', { $seq: [77, 78] }] }, $orderby: ['$p.name'], $return: '$p.name' }, undefined,
          [/Index (Only )?Scan using "Post_pkey"/], ['p77', 'p78']],
        [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', '$ids[*]'] }, $orderby: ['$p.name'], $return: '$p.name' }, { ids: [77, 78] },
          [/Index (Only )?Scan using "Post_pkey"/], ['p77', 'p78']],
        [{ $for: { n: '$.N[*]' }, $where: { $eq: ['$n.id', 77] }, $return: '$n.name' }, undefined, [/Index Scan using "N_pkey"/], 'n77'],
        [{ $for: { c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', 77] }, $return: '$c.cid' }, undefined, [/Index Scan using "Comment_postId"/], 'c77'],
        [{ $for: { c: '$.Comment[*]', p: '$.Post[*]' }, $where: { $and: [one, { $eq: ['$p.pid', '$c.postId'] }] }, $return: { c: '$c.cid', p: '$p.name' } },
          undefined, [/Nested Loop/, /Index Scan using "Post_pkey"/], { c: 'c77', p: 'p77' }],
        [{ $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $and: [post, { $eq: ['$c.postId', '$p.pid'] }] }, $return: { c: '$c.cid', p: '$p.name' } },
          undefined, [/Nested Loop/, /Index Scan using "Comment_postId"/], { c: 'c77', p: 'p77' }],
        [{ $for: { c: '$.Comment[*]' }, $where: one, $return: { $count: { $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', '$c.postId'] }, $return: '$p' } } },
          undefined, [/Index Only Scan using "Post_pkey"/], 1],
        [{ $for: { p: '$.Post[*]' }, $where: post, $return: { $count: { $for: { c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', '$p.pid'] }, $return: '$c' } } },
          undefined, [/Index Only Scan using "Comment_postId"/], 1],
        [{ $for: { c: '$.Comment[*]', p: '$.Post[*]' }, $where: { $and: [one, { $eq: ['$p.pid', '$c.score'] }] }, $return: { c: '$c.cid', p: '$p.name' } },
          undefined, [/Nested Loop/, /Index Scan using "Post_pkey"/], { c: 'c77', p: 'p77' }],
        [{ $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $and: [post, { $eq: ['$c.score', '$p.pid'] }] }, $return: { c: '$c.cid', p: '$p.name' } },
          undefined, [/Nested Loop/, /Index Scan using "Comment_by_score"/], { c: 'c77', p: 'p77' }],
        [{ $for: { c: '$.Comment[*]' }, $where: one, $return: { $count: { $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', '$c.score'] }, $return: '$p' } } },
          undefined, [/Index Only Scan using "Post_pkey"/], 1],
        [{ $for: { c: '$.Comment[*]', n: '$.N[*]' }, $where: { $and: [one, { $eq: ['$n.id', '$c.score'] }] }, $return: { c: '$c.cid', n: '$n.name' } },
          undefined, [/Nested Loop/, /Index Scan using "N_pkey"/], { c: 'c77', n: 'n77' }],
        // ten outer rows: a planner that may hash the doubles reads every post instead
        [{ $for: { c: '$.Comment[*]', p: '$.Post[*]' }, $where: { $and: [{ $eq: ['$c.cid', { $seq: ten.map((g) => `c${g}`) }] }, { $eq: ['$p.pid', '$c.postId'] }] },
          $orderby: ['$c.cid'], $return: '$p.name' }, undefined, [/Nested Loop/, /Index Scan using "Post_pkey"/], ten.map((g) => `p${g}`).sort()],
        [{ $for: { p: '$.Post[*]', j: '$.Post_Tag[*]' }, $where: { $and: [post, { $eq: ['$j.Post_key', '$p.pid'] }] }, $return: '$j.Tag_key' },
          undefined, [/Nested Loop/, /Index Scan using "Post_by_name"/, /Index Scan (using|on) "Post_Tag_pkey"/], 540],
      ]);
      for (const [query, externals, plans, expected] of seeks) {
        const options = externals === undefined ? {} : { externals };
        const narrative = String((await store.explain(query, options)).scanNarrative);
        for (const plan of plans) assert.match(narrative, plan, `${JSON.stringify(query.$where)}: ${narrative}`);
        assert.doesNotMatch(narrative, /Hash Join|Merge Join/, JSON.stringify(query.$where));
        assert.deepEqual(await store.execute(query, options), expected, JSON.stringify(query.$where));
      }
    });
  });
});

/** The columns holding a key, as each model creates them on PostgreSQL: `<table>.<column>` of every key CHECK. */
const KEY_CHECKED = {
  caller: ['Comment.postId', 'Comment.replyTo', 'Kid.postRef', 'N.id', 'Post.pid', 'Post_Tag.Post_key', 'Post_Tag.Tag_key', 'Tag.tid'],
  allocated: ['N.id', 'Post_Tag.Tag_key', 'Tag.tid'],
};
/** Every key CHECK of a schema's tables, `<table>.<column>`. @param {any} pool @param {string} schema */
const keyChecked = async (pool, schema) => (await pool.query('SELECT t.relname AS t, a.attname AS c FROM pg_catalog.pg_constraint c '
  + 'JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace '
  + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] '
  + 'WHERE n.nspname = $1 AND c.contype = \'c\' AND pg_catalog.pg_get_expr(c.conbin, c.conrelid) LIKE \'%trunc%\' ORDER BY 1, 2', [schema]))
  .rows.map((/** @type {any} */ row) => `${row.t}.${row.c}`);

describe('an entity key under its CHECK, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('holds every column holding a key to its double\'s digits, and refuses another writer\'s other digits', async () => {
    for (const [auto, expected] of /** @type {[boolean, string[]][]} */ ([[false, KEY_CHECKED.caller], [true, KEY_CHECKED.allocated]])) {
      await withPostgres(async ({ pool, schema, driver }) => {
        const store = await openStore(model(auto), { driver: driver() });
        try {
          await fill(store, pool, schema, false);
          // a string key, a non-key number column and a key the database allocates carry none
          assert.deepEqual(await keyChecked(pool, schema), expected);
          if (auto) return;
          const s = `"${schema}"`;
          for (const [table, column] of [['Post', 'pid'], ['Comment', 'postId'], ['Comment', 'replyTo'], ['N', 'id'], ['Post_Tag', 'Post_key'], ['Kid', 'postRef']]) {
            for (const digits of [W, '6.9999999999999999999', '1e-400'])
              await assert.rejects(pool.query(`UPDATE ${s}."${table}" SET "${column}" = ${digits} WHERE "${column}" = 7`), { code: '23514' }, `${table}.${column} ${digits}`);
          }
          // the double's own digits, another spelling of them, and a value at or past 2^53 or a NaN-free infinity stay writable
          await pool.query(`INSERT INTO ${s}."N" (id, name, doc) VALUES (0.30000000000000004, 'a', '{}'), (0.300000000000000040, 'b', '{}') ON CONFLICT DO NOTHING;`
            + `INSERT INTO ${s}."N" (id, name, doc) VALUES (5e-324, 'c', '{}'), (-5e-324, 'd', '{}'), (9007199254740993, 'e', '{}'), ('Infinity', 'f', '{}')`);
          await assert.rejects(pool.query(`INSERT INTO ${s}."N" (id, name, doc) VALUES (4.9e-324, 'g', '{}')`), { code: '23514' });
          // the store's own statement that would write such a key is refused as a constraint failure
          const connection = await driver().open();
          try {
            await assert.rejects(relational(connection).execute({ op: 'update', table: 'Post', set: { pid: q.binary('+', q.column('pid'), q.param('d')) },
              where: q.binary('=', q.column('pid'), q.param('p')) }, { externals: { d: 1e-20, p: 8 } }),
            (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
          }
          finally { await connection.close(); }
        }
        finally { await store.close(); }
      });
    }
  });

  it('holds a composite key\'s number member so too, and compares it exactly', async () => {
    const composite = { $model: '0.1', entities: { R: { schema: { type: 'object', required: ['a', 'b'], properties: {
      a: { type: 'integer', 'x-entity': { key: true } }, b: { type: 'string', 'x-entity': { key: true } }, v: { type: 'number' } } } } } };
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(composite, { driver: driver() });
      try {
        await store.entity('R').create({ a: 6, b: 'x', v: 1 });
        await store.saveChanges();
        assert.deepEqual(await keyChecked(pool, schema), ['R.a']);
        await assert.rejects(pool.query(`UPDATE "${schema}"."R" SET a = ${W}`), { code: '23514' });
        assert.match((await store.explain({ $for: { r: '$.R[*]' }, $where: { $eq: ['$r.a', 6] }, $return: '$r.b' })).sql, /"t0"\."a" = \$1/);
      }
      finally { await store.close(); }
    });
  });

  it('compares the key exactly in every shape, as the engine, and a literal past 2^53 by its double\'s interval', async () => {
    await reopened(false, false, false, async (store, { pool, schema }) => {
      await fill(store, pool, schema, false);
      // another writer spells number 0.5's double by other digits it equals
      await pool.query(`UPDATE "${schema}"."N" SET id = 0.50000000000000000000 WHERE id = 0.5`);
      const sql = async (/** @type {any} */ query, /** @type {any} */ externals = undefined) =>
        (await store.explain(query, externals === undefined ? {} : { externals })).sql;
      assert.match(await sql(P({ $eq: ['$p.pid', 6] })), /WHERE \("t0"\."pid" IS NOT NULL AND "t0"\."pid" = \$1\)/);
      assert.match(await sql(C({ $eq: ['$c.postId', { $seq: [6] }] })), /"t0"\."postId" IN \(SELECT \(i\.e #>> '\{\}'\)::numeric/);
      assert.match(await sql(P({ $eq: ['$p.pid', '$ids[*]'] }), { ids: [6] }), /"t0"\."pid" IN \(SELECT \(i\.e #>> '\{\}'\)::numeric/);
      assert.match(await sql(P({ $eq: ['$p.pid', 2 ** 53] })), /"t0"\."pid" >= \$1 AND "t0"\."pid" <= \$2/);
      assert.match(await sql(P({ $eq: ['$p.pid', { $seq: [6, 2 ** 60] }] })), /"interval_row"\."pid" >= \("interval_edge"\.e ->> 0\)::numeric/);
      assert.match(await sql({ $for: { p: '$.Post[*]' }, $orderby: ['$p.pid'], $return: '$p.name' }), /ORDER BY "t0"\."pid" ASC, "t0"\."rid"/);
      await pairsCompareExactly(store);
      for (const [name, query, externals] of SHAPES) {
        const options = externals === undefined ? {} : { externals };
        assert.equal((await store.explain(query, options)).mode, 'native', name);
        assert.deepEqual(await store.execute(query, options), await store.execute(query, { ...options, pushdown: false }), name);
      }
      assert.deepEqual(await store.execute({ $for: { n: '$.N[*]' }, $where: { $eq: ['$n.id', 0.5] }, $return: '$n.name' }), 'n0.5');
      const first = await store.entity('Post').page({ orderBy: ['$it.pid'] }, { limit: 2 });
      const next = await store.entity('Post').page({ orderBy: ['$it.pid'] }, { limit: 2, after: first.continuation });
      assert.deepEqual([...first.items, ...next.items].map((/** @type {any} */ post) => post.name), ['p5', 'p6', 'p7', 'p8']);
      const loaded = await store.entity('Post').asNoTracking().load({ where: { $eq: ['$it.pid', 6] }, include: { kids: true } });
      assert.deepEqual(loaded.map((/** @type {any} */ post) => [post.name, post.kids.map((/** @type {any} */ kid) => kid.kid)]), [['p6', ['k1']]]);
    });
  });

  it('opens a table an earlier release created as before, refuses its upgrade naming the rows another writer spelled otherwise, and adds the CHECK once none is', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const s = `"${schema}"`;
      const created = await openStore(model(false), { driver: driver() });
      try { await fill(created, pool, schema, false); }
      finally { await created.close(); }
      const fresh = await (async () => { const store = await openStore(model(false), { driver: driver() }); try { return await store.introspect(); } finally { await store.close(); } })();
      assert.deepEqual(fresh.report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint'), []);
      assert.equal((await dropKeyChecks(pool, schema)).length, KEY_CHECKED.caller.length);
      // another writer re-keys post 7 and every row naming it, and spells two numbers by digits no double has
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${s}`);
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        for (const [table, column] of [['Post', 'pid'], ['Comment', 'postId'], ['Comment', 'replyTo'], ['Post_Tag', 'Post_key'], ['Kid', 'postRef']])
          await client.query(`UPDATE "${table}" SET "${column}" = ${W} WHERE "${column}" = 7`);
        await client.query('UPDATE "N" SET id = 8.00000000000000000001 WHERE id = 7');
        await client.query('INSERT INTO "N" (id, name, doc) VALUES (1e-400, \'tiny\', \'{}\')');
        await client.query('COMMIT');
      }
      finally {
        await client.query('RESET search_path');
        client.release();
      }
      const upgradeOf = async () => {
        const connection = await driver().open();
        try { return await planColumnUpgrade(connection, model(false)); }
        finally { await connection.close(); }
      };
      // the earlier table opens, introspects and answers as before: a literal by the interval, a pair exactly
      const earlier = await openStore(model(false), { driver: driver() });
      try {
        assert.deepEqual((await earlier.introspect()).model, fresh.model);
        assert.match((await earlier.explain(P({ $eq: ['$p.pid', 6] }))).sql, /"t0"\."pid" >= \$1 AND "t0"\."pid" <= \$2/);
        assert.deepEqual(await earlier.execute(P({ $eq: ['$p.pid', 6] })), ['p6', 'p7']);
      }
      finally { await earlier.close(); }
      await assert.rejects(upgradeOf(), (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
        && error.table === 'Post' && JSON.stringify(error.columns) === '["pid"]' && JSON.stringify(error.rows) === `[["${W}"]]`
        && /SET "pid" = round\("pid", 323\)::float8::text::numeric WHERE NOT \(CASE WHEN abs\("pid"\)/.test(error.message)
        && /as a key of its own with the rows referencing it/.test(error.message));
      // re-spelled as its double, post 7 would be post 6: the host gives it its key back, with the rows naming it
      await pool.query(`SET search_path TO ${s}; BEGIN; SET CONSTRAINTS ALL DEFERRED; UPDATE "Post" SET pid = 7 WHERE pid = ${W}; `
        + `UPDATE "Comment" SET "postId" = 7 WHERE "postId" = ${W}; UPDATE "Comment" SET "replyTo" = 7 WHERE "replyTo" = ${W}; `
        + `UPDATE "Post_Tag" SET "Post_key" = 7 WHERE "Post_key" = ${W}; UPDATE "Kid" SET "postRef" = 7 WHERE "postRef" = ${W}; COMMIT; RESET search_path`);
      // a value below the least double is named, not raised as the cast's range error
      /** @type {any} */
      let refused;
      await assert.rejects(upgradeOf(), (/** @type {any} */ error) => { refused = error; return error.code === 'JD0023' && error.table === 'N'; });
      assert.deepEqual(refused.rows.map((/** @type {string[]} */ row) => (row[0].length > 30 ? `${row[0].slice(0, 6)}…${row[0].slice(-3)}` : row[0])),
        ['0.0000…001', '8.00000000000000000001']);
      // the statement the refusal names writes each as the number it reads as
      await pool.query(`SET search_path TO ${s}; ${/\((UPDATE .*?)\) or, where/.exec(refused.message)?.[1]}; RESET search_path`);
      assert.deepEqual((await pool.query(`SELECT id::text AS id, name FROM ${s}."N" ORDER BY id`)).rows.map((/** @type {any} */ row) => `${row.name}=${row.id}`),
        ['tiny=0', 'n0.5=0.5', 'n5=5', 'n6=6', 'n7=8']);
      const { migration, report } = await upgradeOf();
      // each column once, in the order the tables are planned
      assert.deepEqual(report.upgraded, ['Post.pid', 'Comment.postId', 'Comment.replyTo', 'Tag.tid', 'Kid.postRef', 'N.id', 'Post_Tag.Post_key', 'Post_Tag.Tag_key']);
      assert.ok(migration.steps.every((/** @type {any} */ step) => /^ALTER TABLE "\w+" ADD CHECK \(CASE WHEN abs\(/.test(step.sql)), JSON.stringify(migration.steps));
      assert.deepEqual((await migrate({ driver: driver() }, [migration], { baseline: model(false), model: model(false), shadow: false })).applied, [migration.id]);
      assert.deepEqual(await keyChecked(pool, schema), KEY_CHECKED.caller);
      assert.deepEqual((await upgradeOf()).migration.steps, []);
      const upgraded = await openStore(model(false), { driver: driver() });
      try {
        assert.match((await upgraded.explain(P({ $eq: ['$p.pid', 6] }))).sql, /"t0"\."pid" = \$1/);
        assert.deepEqual(await upgraded.execute(P({ $eq: ['$p.pid', 7] })), 'p7');
        await assert.rejects(pool.query(`UPDATE ${s}."Post" SET pid = ${W} WHERE pid = 7`), { code: '23514' });
      }
      finally { await upgraded.close(); }
    });
  });

  it('reads a key CHECK added NOT VALID as no CHECK, and the upgrade adds one that is', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(model(false), { driver: driver() })).close();
      await dropKeyChecks(pool, schema);
      const check = 'CASE WHEN abs(pid) >= 9007199254740992 OR pid = trunc(pid) THEN true WHEN abs(pid) < 5 * power(10::numeric, -324) THEN false '
        + 'ELSE pid = pid::float8::text::numeric END';
      await pool.query(`ALTER TABLE "${schema}"."Post" ADD CHECK (${check}) NOT VALID`);
      const store = await openStore(model(false), { driver: driver() });
      try { assert.match((await store.explain(P({ $eq: ['$p.pid', 6] }))).sql, /"t0"\."pid" >= \$1 AND "t0"\."pid" <= \$2/); }
      finally { await store.close(); }
      // a column without either CHECK gains both, and is named once
      await pool.query(`ALTER TABLE "${schema}"."Post" DROP CONSTRAINT "Post_pid_check"`);
      const connection = await driver().open();
      try {
        const { migration, report } = await planColumnUpgrade(connection, model(false));
        assert.deepEqual(report.upgraded.filter((/** @type {string} */ name) => name === 'Post.pid'), ['Post.pid']);
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql).filter((/** @type {string} */ text) => text.startsWith('ALTER TABLE "Post"')),
          ['ALTER TABLE "Post" ADD CHECK ("pid" <> \'NaN\')', `ALTER TABLE "Post" ADD CHECK (${check.replaceAll('pid', '"pid"')})`]);
      }
      finally { await connection.close(); }
      await pool.query(`ALTER TABLE "${schema}"."Post" VALIDATE CONSTRAINT "Post_pid_check1"`);
      const validated = await openStore(model(false), { driver: driver() });
      try { assert.match((await validated.explain(P({ $eq: ['$p.pid', 6] }))).sql, /"t0"\."pid" = \$1/); }
      finally { await validated.close(); }
    });
  });

  it('opens the model introspect() reads back over the tables, and refuses a fractional key a session at extra_float_digits 0 writes', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model(false), { driver: driver() });
      await fill(store, pool, schema, false);
      const { model: derived, report } = await store.introspect();
      await store.close();
      assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint' || row.code === 'unguarded-number'), []);
      const reopenedStore = await openStore(derived, { driver: driver() });
      try { assert.match((await reopenedStore.explain({ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.pid', 6] }, $return: '$p.name' })).sql, /"t0"\."pid" = \$1/); }
      finally { await reopenedStore.close(); }
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}"; SET extra_float_digits = 0`);
        await assert.rejects(client.query('INSERT INTO "N" (id, name, doc) VALUES (0.30000000000000004, \'x\', \'{}\')'), { code: '23514' });
        await client.query('INSERT INTO "N" (id, name, doc) VALUES (9, \'y\', \'{}\'), (0.25, \'z\', \'{}\')');
      }
      finally {
        await client.query('RESET extra_float_digits; RESET search_path');
        client.release();
      }
    });
  });
});

describe('an entity key, SQLite', () => {
  it('compares a key and a reference exactly, as stored', async () => {
    await withStore('sqlite', model(false), async (store) => {
      const sql = async (/** @type {any} */ query) => (await store.explain(query)).sql;
      assert.match(await sql(P({ $eq: ['$p.pid', 6] })), /"t0"\."pid" = \?/);
      assert.match(await sql(/** @type {any} */ (SHAPES.find(([name]) => name === 'a key joined to a reference'))[1]), /ON "t1"\."postId" = "t0"\."pid"/);
      assert.doesNotMatch(await sql(/** @type {any} */ (SHAPES.find(([name]) => name === 'two references in one row, $eq'))[1]), /AS REAL/);
    });
  });
});
