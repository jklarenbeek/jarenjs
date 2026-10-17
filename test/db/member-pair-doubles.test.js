//@ts-check
/**
 * @file Two members compared with each other compare as the doubles the
 * engine holds, whatever digits a writer spelled each by. The engine reads a
 * JSON number as the double nearest to its digits, so `1152921504606846976`
 * and `1152921504606847000` are one number to it (2^60), and on PostgreSQL,
 * which holds every number as the `numeric` its digits spell,
 * `5.00000000000000000001` and `5`, and `0` and `1e-400`, are too. Each side
 * of such a comparison reads its double — a member in a document, a
 * collection's generated column, an entity's column or document member, a
 * join's or a hop's correlation — but a side that holds the double already
 * (SQLite's `number` column, an integer column the schema bounds within
 * ±(2^53 − 1)) is read bare, and two key columns (a key and a reference to
 * one) compare exactly, through the key's index. A store run is SQLite
 * always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryJson } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { sqliteDialect } from '../../packages/db/src/dialects/sqlite.js';
import { ENGINES, skipFor, withPostgres, withStore } from './store-core-engines.js';

const SAFE = { type: 'integer', minimum: -(2 ** 53 - 1), maximum: 2 ** 53 - 1 };
const MODEL = {
  $model: '0.1',
  collections: {
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' }, w: { type: 'number' },
        u: { type: 'integer' }, v: { type: 'integer' }, s: SAFE, t: SAFE, x: { type: ['number', 'string'] } } },
      indexes: [{ name: 'by_n', path: '$.n' }, { name: 'by_v', path: '$.v' }, { name: 'by_s', path: '$.s' }, { name: 'by_t', path: '$.t' }],
    },
  },
  entities: {
    E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
      a: { type: 'number' }, c: { type: 'number' }, b: { type: 'integer' }, d: { type: 'integer' },
      meta: { type: 'object', properties: { m: { type: 'number' }, k: { type: 'number' } } } } },
    indexes: [{ name: 'by_a', path: '$.a' }] },
    B: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
      y: { type: 'number' }, z: { type: 'integer' } } }, indexes: [{ name: 'by_y', path: '$.y' }] },
  },
};
const OPERATORS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
const INTEGER = /^-?\d+$/;

/**
 * Two spellings of one double, or of two (the controls), each pair a
 * writer beside the store may hold in two members. SQLite reads a JSON
 * fraction as the double its own conversion rounds it to, which is not
 * the engine's near a tie (a listed loss), so the decimals past a double's
 * precision are PostgreSQL's alone.
 * @param {string} engine
 * @returns {[string, string][]}
 */
const pairs = (engine) => [['1152921504606846976', '1152921504606847000'], ['1152921504606846977', '1152921504606846976'],
  ['9007199254740993', '9007199254740992'], ['5', '5'], ['5', '6'], ['0', '-0'],
  ['-1152921504606846976', '-1152921504606847000'], ['1152921504606847104', '1152921504606847000'],
  ['0', '1e-400'], ['1e400', '2e400'],
  ...(engine === 'postgres' ? /** @type {[string, string][]} */ ([['5.00000000000000000001', '5'], ['4.99999999999999999999', '5'],
    ['0.1', '0.1000000000000000000001'], ['1152921504606846975.9', '1152921504606846976']]) : [['5.0', '5']])];

/**
 * Open `MODEL` on `engine` with a raw SQL writer beside the store.
 * @param {string} engine
 * @param {(store: any, run: (sql: string) => Promise<void>) => Promise<void>} fn
 */
async function withRawWriter(engine, fn) {
  if (engine === 'postgres') {
    return withStore('postgres', MODEL, (store, pg) => fn(store, async (sql) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      const client = await pool.connect();
      try { await client.query(`SET search_path TO "${schema}"; ${sql}`); }
      finally { await client.query('RESET search_path'); client.release(); }
    }));
  }
  const dir = mkdtempSync(join(tmpdir(), 'jaren-member-pair-'));
  const path = join(dir, 'store.sqlite');
  try {
    await withStore('sqlite', MODEL, (store) => fn(store, async (sql) => {
      const db = new DatabaseSync(path);
      try { db.exec(sql); }
      finally { db.close(); }
    }), { path });
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const engine of ENGINES) {
  describe(`two members compared with each other, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keep the documents the engine keeps, whatever digits a writer spelled each by', async () => {
      await withRawWriter(engine, async (store, run) => {
        const big = store.collection('big');
        await big.insert({ id: 's0', n: 5, w: 5, u: 2 ** 60, v: 2 ** 60, s: 5, t: 5, x: 5 });
        await big.insert({ id: 's1', n: 0.1, w: 2 ** 60, u: 7, v: 2 ** 60 + 256, s: -3, t: 4, x: 'five' });
        const json = (/** @type {string} */ text) => (engine === 'postgres' ? `'${text}'::jsonb` : `jsonb('${text}')`);
        for (const [i, [p, q]] of pairs(engine).entries()) {
          const integers = INTEGER.test(p) && INTEGER.test(q) && p.replace('-', '').length < 20 && q.replace('-', '').length < 20;
          const safe = integers && Math.abs(Number(p)) < 2 ** 53 && Math.abs(Number(q)) < 2 ** 53;
          await run(`INSERT INTO big (key, doc) VALUES ('f${i}', ${json(`{"id":"f${i}","n":${p},"w":${q}`
            + `${integers ? `,"u":${p},"v":${q}` : ''}${safe ? `,"s":${p},"t":${q}` : ''},"x":${p}}`)})`);
        }
        // what the engine reads: every document, as the numbers it holds
        const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
        const kept = (/** @type {any} */ where) => ({ $for: { it: '$[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
        const differ = [];
        for (const [left, right] of [['n', 'w'], ['u', 'v'], ['n', 'v'], ['u', 'w'], ['s', 't'], ['s', 'u'], ['x', 'w'], ['v', 'n']]) {
          for (const op of OPERATORS) {
            const where = { [op]: [`$it.${left}`, `$it.${right}`] };
            assert.equal((await big.explain(kept(where))).mode, 'native', JSON.stringify(where));
            const answered = await big.execute(kept(where));
            const expected = queryJson(kept(where), documents);
            if (JSON.stringify(answered) !== JSON.stringify(expected)) differ.push({ where, answered, expected });
          }
        }
        assert.deepEqual(differ, []);
      });
    });

    it('keep the rows the engine keeps on entity columns, document members, joins and hops', async () => {
      await withRawWriter(engine, async (store, run) => {
        const E = store.entity('E');
        const B = store.entity('B');
        await E.create({ id: 'o0', a: 5, c: 5, b: 5, d: 5, meta: { m: 5, k: 5 } });
        await B.create({ id: 'o0', y: 5, z: 5 });
        // an integer column holding an integer that is no double is refused
        // by the engine's read (JD2003), so only the others are written there
        const readable = (/** @type {string} */ digits) => INTEGER.test(digits) && digits.replace('-', '').length < 20
          && (BigInt(Number(digits)) === BigInt(digits) || (engine === 'postgres' && String(Number(digits)) === digits));
        for (const [i, [p, q]] of pairs(engine).entries()) {
          await E.create({ id: `f${i}`, a: 1, c: 1, b: 1, d: 1, meta: { m: 1, k: 1 } });
          await B.create({ id: `f${i}`, y: 1, z: 1 });
          const integers = readable(p) && readable(q);
          // SQLite holds a number past the double range in a column as the infinity
          const finite = engine === 'postgres' || !(p.includes('e400') || q.includes('e400'));
          const doc = `'{"meta": {"m": ${p}, "k": ${q}}}'`;
          await run(`UPDATE "E" SET ${finite ? `"a" = ${p}, "c" = ${q}, ` : ''}${integers ? `"b" = ${p}, "d" = ${q}, ` : ''}`
            + `"doc" = ${engine === 'postgres' ? `${doc}::jsonb` : `jsonb(${doc})`} WHERE "id" = 'f${i}'`);
          if (finite) await run(`UPDATE "B" SET "y" = ${q}${integers ? `, "z" = ${q}` : ''} WHERE "id" = 'f${i}'`);
        }
        const differ = [];
        const compare = async (/** @type {any} */ query) => {
          assert.equal((await store.explain(query)).mode, 'native', JSON.stringify(query.$where ?? query.$return));
          const oracle = await store.execute(query, { pushdown: false });
          const answered = await store.execute(query);
          if (JSON.stringify(answered) !== JSON.stringify(oracle)) differ.push({ query, answered, oracle });
        };
        for (const [left, right] of [['a', 'c'], ['b', 'd'], ['a', 'b'], ['a', 'meta.m'], ['meta.m', 'meta.k'], ['b', 'meta.k']])
          for (const op of OPERATORS)
            await compare({ $for: { it: '$.E[*]' }, $where: { [op]: [`$it.${left}`, `$it.${right}`] }, $orderby: ['$it.id'], $return: '$it.id' });
        for (const [left, right] of [['a', 'y'], ['b', 'z'], ['c', 'y']]) {
          await compare({ $for: { e: '$.E[*]', b: '$.B[*]' }, $where: { $eq: [`$e.${left}`, `$b.${right}`] },
            $orderby: ['$e.id', '$b.id'], $return: { e: '$e.id', b: '$b.id' } });
          for (const op of ['$lt', '$ge', '$ne'])
            await compare({ $for: { e: '$.E[*]', b: '$.B[*]' }, $where: { $and: [{ $eq: ['$e.id', '$b.id'] }, { [op]: [`$e.${left}`, `$b.${right}`] }] },
              $orderby: ['$e.id'], $return: '$e.id' });
          await compare({ $for: { e: '$.E[*]' }, $orderby: ['$e.id'], $return: { id: '$e.id',
            k: { $count: { $for: { b: '$.B[*]' }, $where: { $eq: [`$b.${right}`, `$e.${left}`] }, $return: '$b' } } } });
        }
        assert.deepEqual(differ, []);
      });
    });

    it('read a side bare where it holds the double already, and two keys exactly', async () => {
      const model = { $model: '0.1', entities: {
        Post: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, score: { type: 'number' } } } },
        Comment: { schema: { type: 'object', properties: {
          cid: { type: 'string', 'x-entity': { key: true } }, postId: { type: 'integer' }, replyTo: { type: 'integer' }, score: { type: 'number' },
          post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'cascade' } } },
          reply: { 'x-entity': { relation: { to: 'Post', via: 'replyTo', onDelete: 'cascade' } } } } } } } };
      await withStore(engine, MODEL, async (store) => {
        const sql = async (/** @type {any} */ where) => (await store.collection('big').explain(
          { $for: { it: '$[*]' }, $where: where, $return: '$it.id' })).sql;
        const doubles = engine === 'postgres' ? /::float8/ : /AS REAL/;
        // two integer columns the schema bounds within ±(2^53 − 1): every
        // value its own double, on an engine whose column holds no digits
        if (engine === 'sqlite') assert.doesNotMatch(await sql({ $lt: ['$it.s', '$it.t'] }), doubles);
        else assert.match(await sql({ $lt: ['$it.s', '$it.t'] }), doubles);
        assert.match(await sql({ $lt: ['$it.u', '$it.v'] }), doubles);
      });
      await withStore(engine, model, async (store) => {
        const keys = await store.explain({ $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', '$p.pid'] }, $return: '$c.cid' });
        assert.deepEqual(keys.joins[1].on, [{ op: 'eq', left: { binding: 'c', column: 'postId' }, right: { binding: 'p', column: 'pid' } }]);
        assert.doesNotMatch(keys.sql, /::float8|AS REAL/);
        const scores = await store.explain({ $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $eq: ['$c.score', '$p.score'] }, $return: '$c.cid' });
        assert.deepEqual(scores.joins[1].on, [{ op: 'eq', left: { binding: 'c', column: 'score' }, right: { binding: 'p', column: 'score' }, doubles: true }]);
        if (engine === 'postgres') assert.match(scores.sql, /::float8/);
        else assert.doesNotMatch(scores.sql, /AS REAL/);
        // a key against another number column reads the doubles, two key columns of one row do not
        const mixed = await store.explain({ $for: { c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', '$c.score'] }, $return: '$c.cid' });
        if (engine === 'postgres') assert.match(mixed.sql, /::float8/);
        // and answers as the engine, a key that may be a `bigint` beside a `numeric` too
        for (let i = 0; i < 3; i++) await store.entity('Post').create({ score: i + 1 });
        await store.entity('Comment').create({ cid: 'c1', postId: 2, replyTo: 1, score: 2 });
        await store.entity('Comment').create({ cid: 'c2', postId: 3, replyTo: 3, score: 1 });
        for (const query of [{ $for: { c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', '$c.score'] }, $orderby: ['$c.cid'], $return: '$c.cid' },
          { $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $eq: ['$c.postId', '$p.score'] }, $orderby: ['$c.cid'], $return: '$c.cid' },
          { $for: { p: '$.Post[*]', c: '$.Comment[*]' }, $where: { $eq: ['$c.score', '$p.pid'] }, $orderby: ['$c.cid'], $return: '$c.cid' }]) {
          assert.equal((await store.explain(query)).mode, 'native');
          assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), JSON.stringify(query.$where));
        }
        const references = await store.explain({ $for: { c: '$.Comment[*]' }, $where: { $lt: ['$c.postId', '$c.replyTo'] }, $return: '$c.cid' });
        assert.equal(references.mode, 'native');
        assert.doesNotMatch(references.sql, /::float8|AS REAL/);
      });
    });
  });
}

describe('two number columns PostgreSQL holds by their digits', () => {
  it('equal as their doubles, beside a range of each around the other', () => {
    const pg = postgresDialect();
    const sql = pg.doubleEqual('"l"', '"r"');
    const near = (/** @type {string} */ column, /** @type {string} */ to) =>
      `${column} >= (CASE WHEN ${to} < -1e308 THEN '-Infinity'::numeric WHEN ${to} > 1e308 THEN 1e307 ELSE ${to} - (abs(${to}) * 0.0000000000000005 + 1e-323) END)`
      + ` AND ${column} <= (CASE WHEN ${to} > 1e308 THEN 'Infinity'::numeric WHEN ${to} < -1e308 THEN -1e307 ELSE ${to} + (abs(${to}) * 0.0000000000000005 + 1e-323) END)`;
    assert.equal(sql, `(${near('"l"', '"r"')} AND ${near('"r"', '"l"')} AND ${pg.doubleRead('"l"')} = ${pg.doubleRead('"r"')})`);
    assert.equal(sqliteDialect.doubleEqual, undefined);
  });
});

describe('two number columns of a join and a hop, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('compare a codec\'s columns as they are, and a writer\'s digits as the double', async () => {
    // a `double precision` column holds the double, an `integer` one an integer
    const model = { $model: '0.1', entities: { P: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, w: { type: 'number' }, q: { type: 'integer' } } },
    physical: { table: 'p', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, w: { name: 'w', codec: 'number', null: 'reject' },
      q: { name: 'q', codec: 'integer', null: 'reject' } } } } } };
    await withPostgres(async (pg) => {
      await pg.pool.query(`CREATE TABLE "${pg.schema}".p (id integer PRIMARY KEY, w double precision NOT NULL, q integer NOT NULL)`);
      const store = await openStore(model, { driver: pg.driver() });
      try {
        for (const [id, w, q] of [[1, 5, 5], [2, 4.5, 5], [3, 6, 5]]) await store.entity('P').create({ id, w, q });
        await store.saveChanges();
        for (const op of OPERATORS) {
          const query = { $for: { it: '$.P[*]' }, $where: { [op]: ['$it.w', '$it.q'] }, $orderby: ['$it.id'], $return: '$it.id' };
          const explained = await store.explain(query);
          assert.equal(explained.mode, 'native');
          assert.doesNotMatch(explained.sql, /::float8/);
          assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }));
        }
      }
      finally { await store.close(); }
    });
  });

  it('still seek through either column\'s index', async () => {
    await withStore('postgres', MODEL, async (store, pg) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      await store.entity('E').create({ id: 'x', a: 1, c: 1 });
      await store.entity('B').create({ id: 'x', y: 1 });
      await pool.query(`INSERT INTO "${schema}"."E" (id, a, c, doc) SELECT 'e' || g, g, g, '{}'::jsonb FROM generate_series(1, 20000) g`);
      await pool.query(`INSERT INTO "${schema}"."B" (id, y, doc) SELECT 'b' || g, g, '{}'::jsonb FROM generate_series(1, 20000) g`);
      await pool.query(`ANALYZE "${schema}"."E"; ANALYZE "${schema}"."B"`);
      // a hop's correlation finds the related rows through `by_y`
      const hop = await store.explain({ $for: { e: '$.E[*]' }, $where: { $eq: ['$e.id', 'e7'] },
        $return: { $count: { $for: { b: '$.B[*]' }, $where: { $eq: ['$b.y', '$e.a'] }, $return: '$b' } } });
      assert.match(hop.scanNarrative, /Index (Only )?Scan using "B_by_y"/, hop.scanNarrative);
      assert.deepEqual(await store.execute({ $for: { e: '$.E[*]' }, $where: { $eq: ['$e.id', 'e7'] },
        $return: { $count: { $for: { b: '$.B[*]' }, $where: { $eq: ['$b.y', '$e.a'] }, $return: '$b' } } }), 1);
    });
  });
});
