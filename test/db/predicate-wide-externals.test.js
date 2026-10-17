//@ts-check
/**
 * @file A store profile predicate, and a query's own `$where`, comparing a
 * member with an external integer past ±(2^53 − 1) keeps the rows the engine
 * keeps, whatever digits the document spells the number by. The engine
 * compares the doubles both sides are; a writer spells such a double by any
 * digits that round to it (2^60 is `1152921504606847000` from a JavaScript
 * writer, `1152921504606846976` from another), which SQLite reads as the
 * exact integer they name, so there the external binds as the two edges of
 * the interval of integers that round to its double: equal inside it, less
 * below its low edge, greater above its high one. A column that holds the
 * double (a `number` member's) compares with the number as it is.
 * PostgreSQL holds every JSON number as the `numeric` its digits spell, a
 * decimal another writer chose included, so there the external binds as
 * the edges of the interval of decimals that round to its double, each
 * with the side its tie falls on. The statement is the one a safe integer
 * binds, so a seek stays a seek, and a query's own such external runs in it
 * too. A literal, a literal list and an external list compare there as
 * the engine does too, for every double: a writer spells 5 as
 * `5.00000000000000000001` and 0 as `1e-400`. A store run is SQLite always,
 * PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryJson } from '@jarenjs/json/query';
import { decimalEdge, decimalIntervals, integersRoundingTo, intervalEdge } from '../../packages/db/src/double-interval.js';
import { boundsSafeIntegers } from '../../packages/db/src/ddl.js';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u: { type: 'integer' }, v: { type: 'integer' }, n: { type: 'number' },
        w: { type: 'number' }, x: { type: ['number', 'string'] } } },
      indexes: [{ name: 'by_v', path: '$.v' }, { name: 'by_n', path: '$.n' }],
    },
  },
};
// 2^60 and its neighbouring doubles (the spacing is 128 below it and 256
// above), 2^53 and the one above it, a safe integer, and a negative
const NUMBERS = [2 ** 60 - 128, 2 ** 60, 2 ** 60 + 256, 2 ** 53, 2 ** 53 + 2, 5, -(2 ** 62)];
const DOCS = NUMBERS.map((value, i) => ({ id: `r${i}`, u: value, v: value, n: value }));
const ALL = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
/** The ids a predicate keeps, as a `$where` over the documents. @param {any} predicate */
const kept = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
const OPERATORS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
// the externals: integers past 2^53 a document spells by digits within the
// 64-bit integers, one past them (2^64), and 2^53 itself
const EXTERNALS = [2 ** 60, 2 ** 60 - 128, 2 ** 53, -(2 ** 62), 2 ** 64];

for (const engine of ENGINES) {
  describe(`a profile predicate's external past 2^53, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keeps the rows the engine keeps, on a member read by its digits and on a column of doubles', async () => {
      await withStore(engine, MODEL, async (store) => {
        const big = store.collection('big');
        for (const doc of DOCS) await big.insert(doc);
        const differ = [];
        for (const member of ['u', 'v', 'n']) {
          for (const op of OPERATORS) {
            const predicate = { [op]: [`$it.${member}`, '$x'] };
            const profile = { externals: ['x'], predicates: { big: predicate } };
            for (const x of EXTERNALS) {
              const expected = queryJson(kept(predicate), DOCS, { x });
              const answered = await big.execute(ALL, { externals: { x }, profile });
              if (JSON.stringify(answered) !== JSON.stringify(expected)) differ.push({ member, op, x, answered, expected });
            }
          }
        }
        assert.deepEqual(differ, []);
        // the document's own such external runs in the statement too
        const document = kept({ $ge: ['$it.v', '$y'] });
        const both = { externals: { x: 2 ** 60, y: 2 ** 60 }, profile: { externals: ['x', 'y'], predicates: { big: { $eq: ['$it.u', '$x'] } } } };
        assert.equal((await big.explain(document, both)).mode, 'native');
        assert.deepEqual(await big.execute(document, both),
          queryJson(kept({ $and: [{ $eq: ['$it.u', '$x'] }, { $ge: ['$it.v', '$y'] }] }), DOCS, both.externals));
        assert.deepEqual(await big.execute(document, both), 'r1');
        // a point read is judged by the engine, as before
        const profile = { externals: ['x'], predicates: { big: { $eq: ['$it.u', '$x'] } } };
        assert.deepEqual(await big.get('r1', { externals: { x: 2 ** 60 }, profile }), DOCS[1]);
      });
    });

    it('binds into the statement a safe integer binds, which still seeks', async () => {
      await withStore(engine, MODEL, async (store) => {
        const big = store.collection('big');
        for (const doc of DOCS) await big.insert(doc);
        const profile = { externals: ['x'], predicates: { big: { $eq: ['$it.v', '$x'] } } };
        const [safe, wide] = await Promise.all([5, 2 ** 60].map((x) => big.explain(ALL, { externals: { x }, profile })));
        assert.equal(wide.sql, safe.sql);
        assert.deepEqual(wide.params, safe.params);
        assert.equal(wide.mode, 'native');
        if (engine === 'sqlite') assert.match(wide.scanNarrative, /SEARCH big USING INDEX big_by_v \(gx_v=\?\)/);
        assert.deepEqual(await big.execute(ALL, { externals: { x: 2 ** 60 }, profile }), 'r1');
      });
    });
  });
}

/**
 * Open `MODEL` on `engine` with a writer beside the store that stores a
 * document by the JSON text it is given, digits as written.
 * @param {string} engine
 * @param {(store: any, write: (key: string, text: string) => Promise<void>) => Promise<void>} fn
 */
async function withForeignWriter(engine, fn) {
  if (engine === 'postgres') {
    return withStore('postgres', MODEL, (store, pg) => fn(store, async (key, text) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      await pool.query(`INSERT INTO "${schema}"."big" ("key", "doc") VALUES ($1, $2::jsonb)`, [key, text]);
    }));
  }
  const dir = mkdtempSync(join(tmpdir(), 'jaren-wide-externals-'));
  const path = join(dir, 'store.sqlite');
  try {
    await withStore('sqlite', MODEL, (store) => fn(store, async (key, text) => {
      const db = new DatabaseSync(path);
      try { db.prepare('INSERT INTO "big" ("key", "doc") VALUES (?, jsonb(?))').run(key, text); }
      finally { db.close(); }
    }), { path });
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// the integers at and around each edge of the interval that rounds to a
// double: 2^60 (an even significand, so both ties round to it), 2^60 + 256
// (an odd one, so neither does), 2^53 (a power of two, whose lower
// neighbour is one away), and a negative
const EDGES = [2 ** 60, 2 ** 60 + 256, 2 ** 53, -(2 ** 60)].flatMap((value) => {
  const interval = /** @type {{ low: bigint, high: bigint }} */ (integersRoundingTo(value));
  return [interval.low - 1n, interval.low, interval.high, interval.high + 1n, BigInt(value)];
});

// the decimals at and within a half-unit of each edge of the interval that
// rounds to a double, PostgreSQL's `numeric` holding each as spelled (SQLite
// reads a JSON fraction as the double its own conversion rounds it to): the
// edge itself (a tie, which rounds to an even significand), a hair and a half
// either side, and 2^53's low edge, which lies half-way between integers
const DECIMALS = [2 ** 60, 2 ** 60 + 256, 2 ** 53, -(2 ** 53), -(2 ** 60 + 256)].flatMap((value) =>
  [decimalEdge(value, 'low'), decimalEdge(value, 'high')].flatMap((edge) => {
    const [whole, half = ''] = edge.replace('-', '').split('.');
    const sign = edge.startsWith('-') ? '-' : '';
    const at = (/** @type {bigint} */ offset, /** @type {string} */ fraction) => `${sign}${BigInt(whole) + offset}.${fraction}`;
    return half === ''
      ? [edge, at(-1n, '9999999999999999999'), at(0n, '0000000000000000001'), at(-1n, '5'), at(0n, '5')]
      : [edge, at(0n, '4999999999999999999'), at(0n, '5000000000000000001'), at(0n, '0'), at(1n, '0')];
  }));

for (const engine of ENGINES) {
  describe(`an external past 2^53 against digits another writer spelled, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keeps the rows the engine keeps, in a profile predicate and in a query\'s own $where', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        // the store's own documents spell each number by its shortest digits
        for (const [i, value] of NUMBERS.entries()) await big.insert({ id: `s${i}`, u: value, v: value, n: value, w: value });
        const foreign = [...EDGES.map(String), ...(engine === 'postgres' ? DECIMALS : [])];
        for (const [i, digits] of foreign.entries())
          await write(`f${i}`, `{"id":"f${i}","u":${digits},"v":${digits},"n":${digits},"w":${digits}}`);
        // what the engine reads: every document, as the numbers it holds
        const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
        assert.equal(documents.length, NUMBERS.length + foreign.length);
        const differ = [];
        for (const member of ['u', 'v', 'n', 'w']) {
          for (const op of OPERATORS) {
            const predicate = { [op]: [`$it.${member}`, '$x'] };
            for (const x of [2 ** 60, 2 ** 60 + 256, 2 ** 53, -(2 ** 53), -(2 ** 60), -(2 ** 60 + 256), 2 ** 63, -(2 ** 63), 2 ** 64, 5]) {
              const expected = queryJson(kept(predicate), documents, { x });
              const profiled = await big.execute(ALL, { externals: { x }, profile: { externals: ['x'], predicates: { big: predicate } } });
              const own = await big.execute(kept(predicate), { externals: { x } });
              if (JSON.stringify(profiled) !== JSON.stringify(expected)) differ.push({ member, op, x, profiled, expected });
              if (JSON.stringify(own) !== JSON.stringify(expected)) differ.push({ member, op, x, own, expected });
            }
          }
        }
        assert.deepEqual(differ, []);
        assert.equal((await big.explain(kept({ $eq: ['$it.v', '$x'] }), { externals: { x: 2 ** 60 } })).mode, 'native');
      });
    });
  });
}

/**
 * Open `model` on `engine` with a raw SQL writer beside the store, which
 * runs a statement over the store's own tables.
 * @param {string} engine @param {any} model
 * @param {(store: any, run: (sql: string) => Promise<void>) => Promise<void>} fn
 */
async function withRawWriter(engine, model, fn) {
  if (engine === 'postgres') {
    return withStore('postgres', model, (store, pg) => fn(store, async (sql) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      const client = await pool.connect();
      try { await client.query(`SET search_path TO "${schema}"; ${sql}`); }
      finally { await client.query('RESET search_path'); client.release(); }
    }));
  }
  const dir = mkdtempSync(join(tmpdir(), 'jaren-wide-raw-'));
  const path = join(dir, 'store.sqlite');
  try {
    await withStore('sqlite', model, (store) => fn(store, async (sql) => {
      const db = new DatabaseSync(path);
      try { db.exec(sql); }
      finally { db.close(); }
    }), { path });
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// the least decimal that rounds to Infinity (the midpoint between the largest
// double and 2^1024, a tie that rounds to the infinity), and half the least
// double (a tie that rounds to zero), each as exact decimal digits
const INFINITE_EDGE = String(2n ** 1024n - 2n ** 970n);
const ZERO_EDGE = (() => { const digits = String(5n ** 1075n); return `0.${'0'.repeat(1075 - digits.length)}${digits}`; })();
// numbers past the double range and at the edges of the infinities and of
// zero, which only another writer spells; the edges are ties, and SQLite
// does not round a decimal at or just past a tie as the engine does (a
// listed loss), so they are PostgreSQL's alone
/** @param {string} engine */
/** A JSON replacer that spells the numbers JSON cannot (`Infinity`, `NaN`). @param {string} _ @param {unknown} value */
const spellNonFinite = (_, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
const far = (engine) => ['1e400', '-1e400', '2e400', '1e-400',
  ...(engine === 'postgres' ? [INFINITE_EDGE, `-${INFINITE_EDGE}`, String(2n ** 1024n - 2n ** 970n - 1n), ZERO_EDGE, `-${ZERO_EDGE}`, `${ZERO_EDGE}1`] : [])];

for (const engine of ENGINES) {
  describe(`an infinity and a number past the double range, ${engine}`, { skip: skipFor(engine) }, () => {
    it('a profile predicate\'s infinity keeps the rows the engine keeps; a query\'s own runs in the engine', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        for (const [i, value] of NUMBERS.entries()) await big.insert({ id: `s${i}`, n: value, w: value });
        for (const [i, digits] of far(engine).entries()) await write(`f${i}`, `{"id":"f${i}","n":${digits},"w":${digits}}`);
        const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
        const differ = [];
        for (const member of ['n', 'w']) {
          for (const op of OPERATORS) {
            const predicate = { [op]: [`$it.${member}`, '$x'] };
            for (const x of [Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
              const expected = queryJson(kept(predicate), documents, { x });
              const profiled = await big.execute(ALL, { externals: { x }, profile: { externals: ['x'], predicates: { big: predicate } } });
              const own = await big.execute(kept(predicate), { externals: { x } });
              if (JSON.stringify(profiled) !== JSON.stringify(expected)) differ.push({ member, op, x, profiled, expected });
              if (JSON.stringify(own) !== JSON.stringify(expected)) differ.push({ member, op, x, own, expected });
            }
          }
        }
        assert.deepEqual(differ, []);
        // what reads as the infinity: past the double range, and at the edge where PostgreSQL holds it
        assert.deepEqual(queryJson(kept({ $ge: ['$it.n', '$x'] }), documents, { x: Infinity }), engine === 'postgres' ? ['f0', 'f2', 'f4'] : ['f0', 'f2']);
        assert.equal((await big.explain(ALL, { externals: { x: Infinity },
          profile: { externals: ['x'], predicates: { big: { $lt: ['$it.n', '$x'] } } } })).mode, 'native');
      });
    });

    it('refuses a profile predicate\'s list holding an infinity, which binds as null, and answers every other list', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        await big.insert({ id: 's0', n: 5 });
        await big.insert({ id: 's1', n: 7 });
        await write('f0', '{"id":"f0","n":1e400}');
        await write('f1', '{"id":"f1","n":-1e400}');
        const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
        for (const predicate of [{ $eq: ['$it.n', '$xs[*]'] }, { $not: { $eq: ['$it.n', '$xs[*]'] } }]) {
          const profile = { externals: ['xs'], predicates: { big: predicate } };
          for (const xs of [[Infinity, 5], [-Infinity], { a: 5, b: Infinity }]) {
            await assert.rejects(async () => big.execute(ALL, { externals: { xs }, profile }), (/** @type {any} */ error) => error.code === 'JD0011'
              && /its list holds -?Infinity, which the list's JSON binds as null and the engine compares with a number written past the double range in 'n',/.test(error.message));
            // the query's own list runs in the engine
            assert.deepEqual(await big.execute(kept(predicate), { externals: { xs } }), queryJson(kept(predicate), documents, { xs }));
          }
          for (const xs of [[5, 7], [NaN, 5], { a: 7 }, [], 5])
            assert.deepEqual(await big.execute(ALL, { externals: { xs }, profile }), queryJson(kept(predicate), documents, { xs }), JSON.stringify(xs));
        }
      });
    });
  });

  describe(`a query's literal infinity, alone and in a literal list, ${engine}`, { skip: skipFor(engine) }, () => {
    const LITERALS = [Infinity, -Infinity, NaN];
    const LISTS = [[Infinity, 5], [-Infinity], [Infinity, -Infinity], [NaN, 5], [Infinity, '5', 7]];
    it('keep the documents the engine keeps, in the statement', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        for (const [i, value] of [5, 7, -3, Number.MAX_VALUE, -Number.MAX_VALUE].entries()) await big.insert({ id: `s${i}`, n: value, w: value, x: value });
        await big.insert({ id: 't0', x: '5' });
        for (const [i, digits] of far(engine).entries()) await write(`f${i}`, `{"id":"f${i}","n":${digits},"w":${digits},"x":${digits}}`);
        const differ = [];
        const compare = async (/** @type {any} */ where) => {
          const doc = kept(where);
          const mode = (await big.explain(doc)).mode;
          const native = await big.execute(doc);
          const oracle = await big.execute(doc, { pushdown: false });
          if (JSON.stringify(native) !== JSON.stringify(oracle) || mode !== 'native') differ.push({ where, mode, native, oracle });
        };
        for (const member of ['n', 'w', 'x']) {
          for (const op of OPERATORS) for (const lit of LITERALS) await compare({ [op]: [`$it.${member}`, lit] });
          for (const list of LISTS) {
            await compare({ $eq: [`$it.${member}`, { $seq: list }] });
            await compare({ $not: { $eq: [`$it.${member}`, { $seq: list }] } });
          }
        }
        assert.deepEqual(differ, [], JSON.stringify(differ, spellNonFinite));
      });
    });

    it('keep the rows the engine keeps on an entity\'s number column and document member', async () => {
      const model = { $model: '0.1', entities: { K: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' }, b: { type: 'integer' },
        meta: { type: 'object', properties: { m: { type: 'number' } } } } }, indexes: [{ name: 'by_n', path: '$.n' }] } } };
      await withRawWriter(engine, model, async (store, run) => {
        const K = store.entity('K');
        for (const [id, n] of [['o0', 5], ['o1', 7], ['o2', -3], ['o3', Number.MAX_VALUE], ['f0', 1], ['f1', 1]])
          await K.create({ id, n, b: Math.trunc(Math.min(n, 9)), meta: { m: n } });
        const json = (/** @type {string} */ text) => (engine === 'postgres' ? `'${text}'::jsonb` : `jsonb('${text}')`);
        // past the double range: the engine reads each as an infinity
        await run(`UPDATE "K" SET "n" = 9e999, "doc" = ${json('{"meta":{"m":1e400}}')} WHERE "id" = 'f0'`);
        await run(`UPDATE "K" SET "n" = -9e999, "doc" = ${json('{"meta":{"m":-1e400}}')} WHERE "id" = 'f1'`);
        const differ = [];
        const compare = async (/** @type {any} */ where) => {
          const doc = { $for: { it: '$.K[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' };
          const native = await store.execute(doc);
          const oracle = await store.execute(doc, { pushdown: false });
          if (JSON.stringify(native) !== JSON.stringify(oracle)) differ.push({ where, native, oracle });
        };
        for (const member of ['n', 'b', 'meta.m']) {
          for (const op of OPERATORS) for (const lit of LITERALS) await compare({ [op]: [`$it.${member}`, lit] });
          for (const list of LISTS) {
            await compare({ $eq: [`$it.${member}`, { $seq: list }] });
            await compare({ $not: { $eq: [`$it.${member}`, { $seq: list }] } });
          }
        }
        assert.deepEqual(differ, [], JSON.stringify(differ, spellNonFinite));
      });
    });
    it('page an entity over an infinite order value, the continuation carried through JSON', async () => {
      const model = { $model: '0.1', entities: {
        E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, a: { type: 'number' } } } },
        N: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'number', 'x-entity': { key: true } }, a: { type: 'number' } } } } } };
      await withRawWriter(engine, model, async (store, run) => {
        const E = store.entity('E');
        const N = store.entity('N');
        for (const [id, a] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]) await E.create({ id, a });
        for (const [id, a] of [[1, 1], [2, 2], [3, 3], [4, 4]]) await N.create({ id, a });
        // past the double range: the engine reads each as an infinity
        await run('UPDATE "E" SET "a" = 9e999 WHERE "id" IN (\'a\', \'b\')');
        await run('UPDATE "E" SET "a" = -9e999 WHERE "id" = \'c\'');
        await run('UPDATE "N" SET "id" = 9e999 WHERE "id" = 2');
        await run('UPDATE "N" SET "id" = -9e999 WHERE "id" = 3');
        const walk = async (/** @type {any} */ entity, /** @type {any[]} */ orderBy, /** @type {boolean} */ json) => {
          const seen = [];
          let after;
          for (let i = 0; i < 12; i++) {
            const page = await entity.page({ orderBy }, { limit: 2, ...(after === undefined ? {} : { after }) });
            seen.push(...page.items.map((/** @type {any} */ row) => row.id));
            if (page.continuation === null) return seen;
            after = json ? JSON.parse(JSON.stringify(page.continuation)) : page.continuation;
          }
          return [...seen, 'unending'];
        };
        const differ = [];
        for (const [entity, name, path] of [[E, 'E', '$it.a'], [N, 'N', '$it.id']]) {
          for (const dir of ['asc', 'desc']) {
            const orderBy = [{ $key: path, $dir: dir }, { $key: '$it.id', $dir: dir }];
            const oracle = await store.execute({ $for: { it: `$.${name}[*]` }, $orderby: orderBy, $return: '$it.id' }, { pushdown: false });
            for (const json of [false, true]) {
              const paged = await walk(entity, orderBy, json);
              if (JSON.stringify(paged, spellNonFinite) !== JSON.stringify(oracle, spellNonFinite)) differ.push({ name, dir, json, paged, oracle });
            }
          }
        }
        assert.deepEqual(differ, [], JSON.stringify(differ, spellNonFinite));
        // an infinity is spelled as JSON can carry it, the key's too
        const first = await N.page({ orderBy: [{ $key: '$it.id', $dir: 'desc' }] }, { limit: 1 });
        assert.deepEqual(first.continuation.keys, [{ $numberDouble: 'Infinity' }]);
        assert.deepEqual(first.continuation.key, { $numberDouble: 'Infinity' });
      });
    });
  });

  describe(`equal doubles spelled by other digits, ${engine}`, { skip: skipFor(engine) }, () => {
    it('order, group and count apart as the engine does, in the statement', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        // the store's spelling and another writer's of one double each
        const pairs = [[-(2 ** 62), '-4611686018427387904'], [2 ** 60, '1152921504606846976'], [2 ** 60 + 256, '1152921504606847100'],
          [2 ** 53, '9007199254740993'], [5, '5.0']];
        for (const [i, [own, foreign]] of pairs.entries()) {
          await big.insert({ id: `o${i}`, u: own, v: own, n: own, w: own, x: own });
          await write(`f${i}`, `{"id":"f${i}","u":${foreign},"v":${foreign},"n":${foreign},"w":${foreign},"x":${foreign}}`);
        }
        const fractions = [[0.1, '0.1000000000000000055511151231257827021181583404541015625'], [1.5, '1.50000000000000000000001'],
          [0, '-0'], [0, '-1e-400'], [5, '4.99999999999999999999']];
        for (const [i, [own, foreign]] of fractions.entries()) {
          await big.insert({ id: `p${i}`, n: own, w: own, x: own });
          await write(`q${i}`, `{"id":"q${i}","n":${foreign},"w":${foreign},"x":${foreign}}`);
        }
        for (const [i, digits] of far(engine).entries()) await write(`z${i}`, `{"id":"z${i}","n":${digits},"w":${digits},"x":${digits}}`);
        // a member of two kinds holds a string beside its numbers
        await big.insert({ id: 's0', x: '5' });
        const differ = [];
        for (const member of ['u', 'v', 'n', 'w', 'x']) {
          const ordered = { $for: { it: '$[*]' }, $orderby: [`$it.${member}`, '$it.id'], $return: '$it.id' };
          for (const [label, doc] of [['orderby', ordered],
            ['orderby desc', { ...ordered, $orderby: [{ $key: `$it.${member}`, $dir: 'desc' }, '$it.id'] }],
            ['window', { $subsequence: [ordered, 1, 3] }],
            ['distinct', { $distinct: { $for: { it: '$[*]' }, $return: `$it.${member}` } }],
            ['group', { $for: { it: '$[*]' }, $groupby: { k: `$it.${member}` }, $return: { k: '$k', c: { $count: '$it' } } }],
            ['group ordered', { $for: { it: '$[*]' }, $groupby: { k: `$it.${member}` }, $orderby: ['$k'], $return: { k: '$k', c: { $count: '$it' } } }],
            ['count distinct', { $count: { $distinct: { $for: { it: '$[*]' }, $return: `$it.${member}` } } }]]) {
            // a string and a number have no order: the engine refuses one
            if (member === 'x' && !['distinct', 'group', 'count distinct'].includes(label)) continue;
            const native = await big.execute(doc);
            const oracle = await big.execute(doc, { pushdown: false });
            const mode = (await big.explain(doc)).mode;
            // a count of a distinct runs in the engine on both, as before
            if (JSON.stringify(native) !== JSON.stringify(oracle) || mode !== (label === 'count distinct' ? 'set' : 'native'))
              differ.push({ member, label, mode, native, oracle });
          }
        }
        assert.deepEqual(differ, []);
      });
    });

    it('order an entity\'s number column and document member as the engine does', async () => {
      const model = { $model: '0.1', entities: { K: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' }, meta: { type: 'object', properties: { w: { type: 'integer' } } } } } } } };
      await withRawWriter(engine, model, async (store, run) => {
        const K = store.entity('K');
        await K.create({ id: 'a', n: 2 ** 60 + 256, meta: { w: 2 ** 60 } });
        await K.create({ id: 'b', n: 2 ** 60, meta: { w: 2 ** 60 } });
        await K.create({ id: 'c', n: 1, meta: { w: 1 } });
        // 'a' now holds digits above the store's 2^60 that round to it, as 'b' holds it
        await run(`UPDATE "K" SET "n" = 1152921504606847100, "doc" = ${engine === 'postgres' ? '' : 'jsonb'}('{"meta": {"w": 1152921504606847100}}') WHERE "id" = 'a'`);
        const differ = [];
        for (const member of ['n', 'meta.w']) {
          for (const doc of [{ $for: { it: '$.K[*]' }, $orderby: [`$it.${member}`, '$it.id'], $return: '$it.id' },
            { $for: { it: '$.K[*]' }, $orderby: [{ $key: `$it.${member}`, $dir: 'desc' }, { $key: '$it.id', $dir: 'desc' }], $return: '$it.id' }]) {
            const native = await store.execute(doc);
            const oracle = await store.execute(doc, { pushdown: false });
            if (JSON.stringify(native) !== JSON.stringify(oracle)) differ.push({ member, native, oracle });
          }
        }
        assert.deepEqual(differ, []);
      });
    });

    it('order and page an entity load, and order its include, as the engine does', async () => {
      const member = { n: { type: 'number' }, meta: { type: 'object', properties: { w: { type: 'integer' } } } };
      const model = { $model: '0.1', entities: {
        K: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, ...member,
          js: { 'x-entity': { relation: { to: 'J', many: true, via: 'kId', onDelete: 'cascade' } } } } } },
        J: { schema: { type: 'object', required: ['id', 'kId'], properties: { id: { type: 'string', 'x-entity': { key: true } },
          kId: { type: 'string' }, ...member } } } } };
      await withRawWriter(engine, model, async (store, run) => {
        const K = store.entity('K');
        const J = store.entity('J');
        for (const [id, n] of [['a', 2 ** 60 + 256], ['b', 2 ** 60], ['c', 1], ['d', 2 ** 60]]) {
          await K.create({ id, n, meta: { w: n } });
          await J.create({ id, kId: 'a', n, meta: { w: n } });
        }
        // 'a' now holds digits above the store's 2^60 that round to it, as 'b' and 'd' hold it
        for (const table of ['K', 'J']) {
          await run(`UPDATE "${table}" SET "n" = 1152921504606847100, "doc" = ${engine === 'postgres' ? '' : 'jsonb'}`
            + `('{"meta": {"w": 1152921504606847100}}') WHERE "id" = 'a'`);
        }
        const ids = (/** @type {any[]} */ rows) => rows.map((row) => row.id);
        const differ = [];
        for (const path of ['n', 'meta.w']) {
          for (const desc of [false, true]) {
            const terms = [{ $key: `$it.${path}`, $dir: desc ? 'desc' : 'asc' }, { $key: '$it.id', $dir: desc ? 'desc' : 'asc' }];
            const oracle = await store.execute({ $for: { it: '$.K[*]' }, $orderby: terms, $return: '$it.id' }, { pushdown: false });
            const load = ids(await K.asNoTracking().load({ orderBy: terms }));
            const included = ids((await K.asNoTracking().load({ where: { $eq: ['$it.id', 'a'] }, include: { js: { orderBy: terms } } }))[0].js);
            if (JSON.stringify(load) !== JSON.stringify(oracle)) differ.push({ path, desc, load, oracle });
            if (JSON.stringify(included) !== JSON.stringify(oracle)) differ.push({ path, desc, included, oracle });
          }
        }
        // a keyset page resumes past a page boundary inside a run of equal doubles: a, b and d are one double
        const paged = [];
        let continuation;
        for (let i = 0; i < 5 && (i === 0 || continuation != null); i++) {
          const page = await K.page({ orderBy: ['$it.n', '$it.id'] }, { limit: 1, ...(continuation === undefined ? {} : { after: continuation }) });
          paged.push(...ids(page.items));
          continuation = page.continuation;
        }
        assert.deepEqual({ differ, paged }, { differ: [], paged: ['c', 'a', 'b', 'd'] });
      });
    });
  });

  describe(`an entity number column against a wide or infinite external, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keeps the rows the engine keeps, in a query\'s own $where and in a profile predicate', async () => {
      const model = { $model: '0.1', entities: { K: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' } } } } } };
      await withRawWriter(engine, model, async (store, run) => {
        const K = store.entity('K');
        for (const [id, n] of [['o0', 2 ** 60], ['o1', 2 ** 60 + 256], ['o2', 5], ['o3', -(2 ** 60)], ['f0', 1]]) await K.create({ id, n });
        await run('UPDATE "K" SET "n" = 1152921504606846976 WHERE "id" = \'f0\'');
        const all = { $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
        const differ = [];
        for (const op of OPERATORS) {
          const predicate = { [op]: ['$it.n', '$x'] };
          const where = { ...all, $where: predicate };
          for (const x of [2 ** 60, 2 ** 60 + 256, -(2 ** 60), 5, Infinity, -Infinity]) {
            const oracle = await store.execute(where, { externals: { x }, pushdown: false });
            const own = await store.execute(where, { externals: { x } });
            const profiled = await store.execute(all, { externals: { x }, profile: { externals: ['x'], predicates: { K: predicate } } });
            if (JSON.stringify(own) !== JSON.stringify(oracle) || JSON.stringify(profiled) !== JSON.stringify(oracle))
              differ.push({ op, x, own, profiled, oracle });
          }
        }
        assert.deepEqual(differ, []);
        // SQLite's column holds the double, and a query's own integer past 2^53 runs in the engine there
        assert.equal((await store.explain({ ...all, $where: { $eq: ['$it.n', '$x'] } }, { externals: { x: 2 ** 60 } })).mode,
          engine === 'postgres' ? 'native' : 'set');
      });
    });
  });
}

describe('the integers a double stands for', () => {
  it('are the interval round-half-to-even sends to it, ties kept by an even significand', () => {
    // 2^60: the doubles are 128 apart below it and 256 above, and its
    // significand is even, so both midpoints round to it
    assert.deepEqual(integersRoundingTo(2 ** 60), { low: 2n ** 60n - 64n, high: 2n ** 60n + 128n });
    // 2^60 + 256: an odd significand, so both midpoints round away
    assert.deepEqual(integersRoundingTo(2 ** 60 + 256), { low: 2n ** 60n + 129n, high: 2n ** 60n + 383n });
    // 2^53: the integer below it is a double of its own, and 2^53 + 1 ties to it
    assert.deepEqual(integersRoundingTo(2 ** 53), { low: 2n ** 53n, high: 2n ** 53n + 1n });
    assert.deepEqual(integersRoundingTo(-(2 ** 53)), { low: -(2n ** 53n) - 1n, high: -(2n ** 53n) });
    assert.deepEqual(integersRoundingTo(-(2 ** 60)), { low: -(2n ** 60n) - 128n, high: -(2n ** 60n) + 64n });
    for (const value of [2 ** 53, 2 ** 53 + 2, 2 ** 60, 2 ** 60 + 256, 2 ** 62 * 3, 2 ** 63, 2 ** 64, 1e21, -(2 ** 61), Number.MAX_VALUE]) {
      const { low, high } = /** @type {{ low: bigint, high: bigint }} */ (integersRoundingTo(value));
      assert.deepEqual([Number(low), Number(high), Number(low - 1n) !== value, Number(high + 1n) !== value],
        [value, value, true, true], String(value));
    }
    for (const value of [0, 5, -(2 ** 53) + 1, 2 ** 53 - 1, 0.5, 2 ** 52 + 0.5]) assert.equal(integersRoundingTo(value), null);
  });

  it('bind as decimal edges, with the side each tie falls on, for a member read by its decimal digits', () => {
    const edges = (/** @type {unknown} */ value) =>
      ['low', 'lowExclusive', 'high', 'highExclusive'].map((edge) => decimalEdge(value, /** @type {any} */ (edge)));
    // 2^60: an even significand, so both ties round to it and each edge is held
    assert.deepEqual(edges(2 ** 60), ['1152921504606846912', '1152921504606846911', '1152921504606847104', '1152921504606847105']);
    // 2^60 + 256: an odd one, so neither is
    assert.deepEqual(edges(2 ** 60 + 256), ['1152921504606847104', '1152921504606847104', '1152921504606847360', '1152921504606847360']);
    // 2^53: its low edge lies half-way to the integer below it
    assert.deepEqual(edges(2 ** 53), ['9007199254740991.5', '9007199254740990.5', '9007199254740993', '9007199254740994']);
    assert.deepEqual(edges(-(2 ** 53)), ['-9007199254740993', '-9007199254740994', '-9007199254740991.5', '-9007199254740990.5']);
    // 2^64 lies past the 64-bit integers, which a decimal does not stop at
    assert.deepEqual(edges(2 ** 64), ['18446744073709550592', '18446744073709550591', '18446744073709553664', '18446744073709553665']);
    // every double is such an interval: 5's doubles lie 2^-50 apart, and
    // its even significand keeps both ties
    assert.deepEqual(edges(5), ['4.999999999999999555910790149937383830547332763671875', '3.999999999999999555910790149937383830547332763671875',
      '5.000000000000000444089209850062616169452667236328125', '6.000000000000000444089209850062616169452667236328125']);
    // 0.5 is a power of two, so the double below it is half as far as the one above
    assert.deepEqual(edges(0.5), ['0.4999999999999999722444243843710864894092082977294921875', '-0.5000000000000000277555756156289135105907917022705078125',
      '0.500000000000000055511151231257827021181583404541015625', '1.500000000000000055511151231257827021181583404541015625']);
    // zero is one interval whatever its sign, out to half the least double either side
    assert.deepEqual(edges(-0), edges(0));
    assert.deepEqual([decimalEdge(0, 'low'), decimalEdge(0, 'high')], [`-${ZERO_EDGE}`, ZERO_EDGE]);
    // the least double's odd significand rounds both ties away: one to zero, one to the next double
    const threeHalves = String(3n * 5n ** 1075n);
    const leastHigh = `0.${'0'.repeat(1075 - threeHalves.length)}${threeHalves}`;
    assert.deepEqual(edges(Number.MIN_VALUE), [ZERO_EDGE, ZERO_EDGE, leastHigh, leastHigh]);
    // the largest double's high edge is where the infinity begins, which its tie rounds to
    assert.deepEqual([decimalEdge(Number.MAX_VALUE, 'high'), decimalEdge(Number.MAX_VALUE, 'highExclusive')], [INFINITE_EDGE, INFINITE_EDGE]);
    // anything else is its JSON
    assert.deepEqual(edges('text'), ['"text"', '"text"', '"text"', '"text"']);
    assert.deepEqual(edges(NaN), ['null', 'null', 'null', 'null']);
  });

  it('bind as 64-bit integers, or as the double where an edge lies past them', () => {
    assert.equal(intervalEdge(2 ** 60, 'low'), 2n ** 60n - 64n);
    assert.equal(intervalEdge(2 ** 60, 'high'), 2n ** 60n + 128n);
    // 2^63's low edge is a 64-bit integer; its high edge is not
    assert.equal(intervalEdge(2 ** 63, 'low'), 2n ** 63n - 512n);
    assert.equal(intervalEdge(2 ** 63, 'high'), 2 ** 63);
    assert.equal(intervalEdge(-(2 ** 63), 'low'), -(2 ** 63));
    assert.equal(intervalEdge(-(2 ** 63), 'high'), -(2n ** 63n) + 512n);
    for (const value of [5, 0.5, 'text', null]) assert.equal(intervalEdge(value, 'low'), value);
  });
});

describe('an ordering over an integer member the schema bounds within ±(2^53 − 1)', () => {
  const SAFE = Number.MAX_SAFE_INTEGER;
  it('is proven by the member\'s own type and bounds alone', () => {
    assert.deepEqual([
      { type: 'integer', minimum: -SAFE, maximum: SAFE },
      { type: ['integer', 'null'], exclusiveMinimum: -(SAFE + 1), exclusiveMaximum: SAFE + 1 },
      // an epoch in milliseconds, within the instants a JavaScript Date holds
      { type: 'integer', minimum: -8640000000000000, maximum: 8640000000000000 },
      { type: 'integer', minimum: 0, exclusiveMinimum: -(SAFE + 3), maximum: 10, exclusiveMaximum: SAFE + 3 },
    ].map(boundsSafeIntegers), [true, true, true, true]);
    // 2^53 + 1 rounds to 2^53, which an inclusive 2^53 admits; an
    // exclusive bound one double further admits 2^53 itself
    assert.deepEqual([
      { type: 'integer', minimum: -SAFE, maximum: SAFE + 1 },
      { type: 'integer', minimum: -(SAFE + 1), maximum: SAFE },
      { type: 'integer', exclusiveMinimum: -SAFE, exclusiveMaximum: SAFE + 3 },
      { type: 'integer', exclusiveMinimum: -(SAFE + 3), exclusiveMaximum: SAFE },
      { type: 'integer', minimum: 0 },
      { type: 'integer', maximum: 10 },
      { type: 'number', minimum: 0, maximum: 10 },
      { type: ['integer', 'number'], minimum: 0, maximum: 10 },
      { type: ['integer', 'string'], minimum: 0, maximum: 10 },
      { minimum: 0, maximum: 10 },
      { type: 'integer', allOf: [{ minimum: 0, maximum: 10 }] },
      { type: 'integer', minimum: '0', maximum: '10' },
    ].map(boundsSafeIntegers), Array(12).fill(false));
  });

  for (const engine of ENGINES) {
    it(`reads a proven column bare, in its index order, and every other integer as the double, ${engine}`, { skip: skipFor(engine) }, async () => {
      const model = { $model: '0.1', collections: { t: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' },
        at: { type: 'integer', minimum: 0, maximum: 8640000000000000 }, u: { type: 'integer' }, w: { type: 'integer', minimum: 0, maximum: 2 ** 53 } } },
      indexes: [{ name: 'by_at', path: '$.at' }, { name: 'by_u', path: '$.u' }, { name: 'by_w', path: '$.w' }] } } };
      const dir = mkdtempSync(join(tmpdir(), 'jaren-safe-order-'));
      const path = join(dir, 'store.sqlite');
      try {
        await withStore(engine, model, async (store, pg) => {
          const t = store.collection('t');
          // ties in every member, so the row identity decides between them
          for (let i = 0; i < 12; i++) await t.insert({ id: `r${String(i).padStart(2, '0')}`, at: 1767225600000 + (i % 4) * 1000, u: (i * 5) % 7, w: i % 3 });
          await t.insert({ id: 'r12', at: 1767225600000, u: 2 ** 60, w: 2 ** 53 });
          // another writer's spellings of the doubles r12 holds, each of which a validator reads as
          // that double: a decimal past an integer, which conforms to the bounds that prove `at`, and
          // integers past 2^53, which `w`'s bound of 2^53 admits and so does not prove
          const foreign = '{"id":"r13","at":1767225600000.00000000000001,"u":1152921504606846976,"w":9007199254740993}';
          if (pg === null) {
            const db = new DatabaseSync(path);
            try { db.prepare('INSERT INTO "t" ("key", "doc") VALUES (?, jsonb(?))').run('r13', foreign); }
            finally { db.close(); }
          }
          else {
            const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
            await pool.query(`INSERT INTO "${schema}"."t" ("key", "doc") VALUES ($1, $2::jsonb)`, ['r13', foreign]);
          }
          for (const member of ['at', 'u', 'w']) {
            const ordered = { $for: { it: '$[*]' }, $orderby: [`$it.${member}`], $return: '$it.id' };
            for (const [label, doc] of [['asc', ordered], ['desc', { ...ordered, $orderby: [{ $key: `$it.${member}`, $dir: 'desc' }] }],
              ['window', { $subsequence: [ordered, 2, 4] }]]) {
              const explained = await t.explain(doc);
              assert.deepEqual([explained.mode, await t.execute(doc)], ['native', await t.execute(doc, { pushdown: false })], `${member} ${label}`);
              if (engine !== 'sqlite') continue;
              // the proven member's order is its index's; the others read the double and sort,
              // but in a window read their index's order behind the probe for a number past
              // ±(2^53 − 1), which finds r12's and r13's here, so the double order answers
              const bare = member === 'at' || label === 'window';
              assert.equal(explained.sql.includes(`CAST("gx_${member}" AS REAL)`), !bare, `${member} ${label}`);
              assert.equal(explained.sql.includes(`(SELECT MAX("gx_${member}") FROM "t") > 9007199254740991`),
                member !== 'at' && label === 'window', `${member} ${label}`);
              const db = new DatabaseSync(path);
              try {
                const plan = db.prepare(`EXPLAIN QUERY PLAN ${explained.sql}`).all(...explained.sql.split('?').slice(1).map(() => 0))
                  .map((row) => String(row.detail));
                assert.equal(plan.includes('USE TEMP B-TREE FOR ORDER BY'), !bare, `${member} ${label}: ${plan.join(' | ')}`);
                if (bare) assert.ok(plan.includes(`SCAN t USING INDEX t_by_${member}`), `${member} ${label}: ${plan.join(' | ')}`);
              }
              finally { db.close(); }
            }
          }
        }, engine === 'sqlite' ? { path } : undefined);
      }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

// the numbers a query names: integers past 2^53 and at it, safe integers, zero,
// fractions, and a double near the top of the range
const LITERALS = [2 ** 60, 2 ** 60 + 256, 2 ** 53, 5, 0, 0.1, -0.1, 1.5, -(2 ** 60), 1e300];
const LISTS = [[2 ** 60, 5], [0.1, 0], [5], [2 ** 53, -(2 ** 60), 1.5]];
// the digits another writer spells a number by beyond the store's own: an
// integer past 2^53 by its exact digits, a number by decimals past a double's
// precision on either side of it and at its interval's edges, by an exponent,
// past the double range, and zero by a sign and by a number too small to be a
// double. SQLite reads a JSON fraction as the double its own conversion rounds
// it to, which is not the engine's at or near a tie (a listed loss), so the
// decimals near an edge are PostgreSQL's alone
/** @param {string} engine */
const spellings = (engine) => ['1152921504606846976', '1152921504606846977', '-1152921504606846976', '9007199254740993',
  '5.0', '5e0', '0.0', '-0', '1e400', '-1e400', '1e-400', '-1e-400', '1e300',
  ...(engine === 'postgres' ? ['1152921504606846975.9', '9007199254740992.5', '9007199254740991.5', '5.00000000000000000001',
    '4.99999999999999999999', '0.1000000000000000000001', '0.1000000000000000055511151231257827', '-0.1000000000000000000001',
    '1.50000000000000000001', '1.0000000000000000000001e300', ...[5, 0.1, 1.5, 0].flatMap((value) => [decimalEdge(value, 'low'), decimalEdge(value, 'high')])] : [])];

for (const engine of ENGINES) {
  describe(`a literal, a literal list and an external list against digits another writer spelled, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keep the rows the engine keeps, on members read by their digits, indexed and not', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        for (const [i, value] of LITERALS.entries()) {
          const integer = Number.isInteger(value) && Math.abs(value) < 2 ** 63 ? value : undefined;
          await big.insert({ id: `s${i}`, u: integer, v: integer, n: value, w: value });
        }
        for (const [i, digits] of spellings(engine).entries()) {
          const integer = /^-?\d+$/.test(digits) && digits.replace('-', '').length < 20 ? `,"u":${digits},"v":${digits}` : '';
          await write(`f${i}`, `{"id":"f${i}"${integer},"n":${digits},"w":${digits}}`);
        }
        // what the engine reads: every document, as the numbers it holds
        const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
        const differ = [];
        const compare = async (/** @type {any} */ predicate, externals = {}) => {
          const expected = queryJson(kept(predicate), documents, externals);
          const answered = await big.execute(kept(predicate), { externals });
          if (JSON.stringify(answered) !== JSON.stringify(expected)) differ.push({ predicate, externals, answered, expected });
        };
        for (const member of ['u', 'v', 'n', 'w']) {
          for (const op of OPERATORS)
            for (const x of LITERALS.filter((value) => member === 'n' || member === 'w' || Number.isInteger(value))) await compare({ [op]: [`$it.${member}`, x] });
          for (const list of LISTS) {
            await compare({ $eq: [`$it.${member}`, { $seq: list }] });
            await compare({ $ne: [`$it.${member}`, { $seq: list }] });
            await compare({ $eq: [`$it.${member}`, '$xs[*]'] }, { xs: list });
            await compare({ $not: { $eq: [`$it.${member}`, '$xs[*]'] } }, { xs: list });
            await compare({ $eq: [`$it.${member}`, '$xs[*]'] }, { xs: { a: list[0], b: 'text' } });
          }
          // two differences on one member are one negated list
          await compare({ $and: [{ $ne: [`$it.${member}`, 5] }, { $ne: [`$it.${member}`, 2 ** 60] }] });
        }
        assert.deepEqual(differ, []);
        // each runs in the statement, but for an external list holding an
        // integer past 2^53 on SQLite, which the engine answers there
        for (const [predicate, externals, mode] of /** @type {const} */ ([[{ $eq: ['$it.v', 5] }, {}, 'native'],
          [{ $eq: ['$it.v', { $seq: [5, 2 ** 60] }] }, {}, 'native'], [{ $eq: ['$it.w', { $seq: [0.1] }] }, {}, 'native'],
          [{ $eq: ['$it.v', '$xs[*]'] }, { xs: [5, 0.1] }, 'native'],
          [{ $eq: ['$it.v', '$xs[*]'] }, { xs: [5, 2 ** 60] }, engine === 'postgres' ? 'native' : 'set']]))
          assert.equal((await big.explain(kept(predicate), { externals })).mode, mode, JSON.stringify(predicate));
        // a profile predicate's literal, as a query's own
        const profile = { predicates: { big: { $eq: ['$it.n', 5] } } };
        assert.deepEqual(await big.execute(ALL, { profile }), queryJson(kept({ $eq: ['$it.n', 5] }), documents));
      });
    });

    it('keep the rows the engine keeps on an entity\'s number columns and document member', async () => {
      const model = { $model: '0.1', entities: { K: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' }, i: { type: 'integer' },
        meta: { type: 'object', properties: { m: { type: 'number' } } } } }, indexes: [{ name: 'by_n', path: '$.n' }] } } };
      await withRawWriter(engine, model, async (store, run) => {
        const K = store.entity('K');
        for (const [j, value] of [2 ** 60, 5, 0, 0.1, -(2 ** 60), 1.5].entries())
          await K.create({ id: `o${j}`, n: value, i: Number.isInteger(value) ? value : 7, meta: { m: value } });
        const foreign = engine === 'postgres'
          ? ['1152921504606846976', '5.00000000000000000001', '1e-400', '0.1000000000000000000001', '-1152921504606846976', '4.99999999999999999999']
          : ['1152921504606846976', '5.0', '0.0', '0.1', '-1152921504606846976', '5e0'];
        for (const [j, digits] of foreign.entries()) {
          await K.create({ id: `f${j}`, n: 1, i: 1, meta: { m: 1 } });
          // SQLite holds an integer column's number as an integer or not at all
          const integer = engine === 'postgres' || /^-?\d+$/.test(digits) ? digits : String(Math.trunc(Number(digits)));
          const doc = `'{"meta": {"m": ${digits}}}'`;
          await run(`UPDATE "K" SET "n" = ${digits}, "i" = ${integer}, "doc" = ${engine === 'postgres' ? `${doc}::jsonb` : `jsonb(${doc})`} WHERE "id" = 'f${j}'`);
        }
        const all = { $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
        const differ = [];
        const ids = (/** @type {any[]} */ rows) => rows.map((row) => row.id).sort();
        const compare = async (/** @type {any} */ predicate, externals = {}) => {
          const where = { ...all, $where: predicate };
          const oracle = await store.execute(where, { externals, pushdown: false });
          const answered = await store.execute(where, { externals });
          if (JSON.stringify(answered) !== JSON.stringify(oracle)) differ.push({ predicate, externals, answered, oracle });
          if (Object.keys(externals).length > 0) return;
          // a load takes the same predicate, its literals bound
          // (a sequence of one id is the id, of none is nothing)
          const loaded = ids(await K.load({ where: predicate }));
          if (JSON.stringify(loaded) !== JSON.stringify(oracle === undefined ? [] : [oracle].flat().sort()))
            differ.push({ predicate, loaded, oracle });
        };
        for (const member of ['n', 'i', 'meta.m']) {
          for (const op of OPERATORS)
            for (const x of [2 ** 60, 5, 0, 0.1, -(2 ** 60)].filter((value) => member !== 'i' || Number.isInteger(value))) await compare({ [op]: [`$it.${member}`, x] });
          for (const list of [[2 ** 60, 5], [0.1, 0], [5]]) {
            await compare({ $eq: [`$it.${member}`, { $seq: list }] });
            await compare({ $eq: [`$it.${member}`, '$xs[*]'] }, { xs: list });
          }
        }
        assert.deepEqual(differ, []);
      });
    });
  });
}

for (const engine of ENGINES) {
  describe(`a key column against a literal and a list, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keeps the exact comparison on a database-allocated key, a reference to one and a join table\'s sides', async () => {
      // each may be a `bigint` on PostgreSQL, which reads no fractional bound
      const model = { $model: '0.1', entities: {
        Post: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' },
          tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
        Comment: { schema: { type: 'object', properties: {
          cid: { type: 'string', 'x-entity': { key: true } }, postId: { type: 'integer' },
          post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'cascade' } } } } } },
        Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } } } };
      await withStore(engine, model, async (store) => {
        for (const title of ['a', 'b', 'c']) await store.entity('Post').create({ title });
        await store.entity('Comment').create({ cid: 'c1', postId: 2 });
        await store.entity('Tag').create({ name: 'red' });
        store.entity('Post').link(2, 'tags', 'red');
        await store.saveChanges();
        const differ = [];
        for (const [root, member] of [['Post', 'pid'], ['Comment', 'postId'], ['Post_Tag', 'Post_key']]) {
          for (const [where, externals] of /** @type {[any, any][]} */ ([[{ $eq: [`$it.${member}`, 2] }, {}], [{ $lt: [`$it.${member}`, 3] }, {}],
            [{ $ne: [`$it.${member}`, 2] }, {}], [{ $eq: [`$it.${member}`, { $seq: [2, 3] }] }, {}], [{ $eq: [`$it.${member}`, '$xs[*]'] }, { xs: [2] }]])) {
            const query = { $for: { it: `$.${root}[*]` }, $where: where, $orderby: [`$it.${member}`], $return: `$it.${member}` };
            const oracle = await store.execute(query, { externals, pushdown: false });
            const answered = await store.execute(query, { externals });
            if (JSON.stringify(answered) !== JSON.stringify(oracle)) differ.push({ root, where, answered, oracle });
          }
        }
        assert.deepEqual(differ, []);
        assert.deepEqual(await store.execute({ $for: { it: '$.Post_Tag[*]' }, $where: { $eq: ['$it.Post_key', 2] }, $return: '$it.Tag_key' }), 'red');
      });
    });
  });
}

describe('a literal and a list against a column of numbers by their digits, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('still seek through the column\'s index, the external list too', async () => {
    const model = { $model: '0.1', collections: MODEL.collections, entities: { K: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' } } }, indexes: [{ name: 'by_n', path: '$.n' }] } } };
    await withRawWriter('postgres', model, async (store, run) => {
      await run(`INSERT INTO "big" ("key", "doc") SELECT 'k' || g, jsonb_build_object('id', 'k' || g, 'v', g, 'w', g) FROM generate_series(1, 20000) g;
        INSERT INTO "K" ("id", "n", "doc") SELECT 'k' || g, g, '{}'::jsonb FROM generate_series(1, 20000) g; ANALYZE "big"; ANALYZE "K"`);
      const big = store.collection('big');
      const own = (/** @type {any} */ where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });
      const entity = (/** @type {any} */ where) => ({ $for: { it: '$.K[*]' }, $where: where, $return: '$it.id' });
      const plans = {
        literal: await big.explain(own({ $eq: ['$it.v', 5] })),
        list: await big.explain(own({ $eq: ['$it.v', { $seq: [5, 70, 9000] }] })),
        entityList: await store.explain(entity({ $eq: ['$it.n', { $seq: [5, 70, 9000] }] })),
        entityExternalList: await store.explain(entity({ $eq: ['$it.n', '$xs[*]'] }), { externals: { xs: [5, 70, 9000] } }),
      };
      const seeks = Object.fromEntries(Object.entries(plans).map(([name, plan]) =>
        [name, /Index (Only )?Scan using "?(big_by_v|K_by_n)"? on "?(big|K)"?( t0)?\b/.test(String(plan.scanNarrative)) && !/Seq Scan/.test(String(plan.scanNarrative))]));
      assert.deepEqual(seeks, { literal: true, list: true, entityList: true, entityExternalList: true }, JSON.stringify(Object.values(plans).map((plan) => plan.scanNarrative)));
      assert.deepEqual(await big.execute(own({ $eq: ['$it.v', { $seq: [5, 70, 9000] }] })), ['k5', 'k70', 'k9000']);
      assert.deepEqual(await store.execute({ ...entity({ $eq: ['$it.n', '$xs[*]'] }), $orderby: ['$it.n'] }, { externals: { xs: [9000, 5, 70] } }), ['k5', 'k70', 'k9000']);
      // a load reads the same column through the same intervals
      const load = await store.entity('K').explainLoad({ where: { $eq: ['$it.n', { $seq: [5, 70, 9000] }] } });
      assert.match(load.sql, /\bIN \(SELECT unnest\(ARRAY\(SELECT DISTINCT "interval_row"\."n" FROM .* AS "interval_row" ON /);
    });
  });
});

describe('the intervals a list\'s numbers stand for', () => {
  it('are one tuple of decimal edges a finite number, and none for anything else', () => {
    const tuple = (/** @type {number} */ value) => ['low', 'lowExclusive', 'high', 'highExclusive'].map((edge) => decimalEdge(value, /** @type {any} */ (edge)));
    assert.equal(decimalIntervals([5, 'a', 2 ** 60, Infinity, NaN, null, -0]), JSON.stringify([tuple(5), tuple(2 ** 60), tuple(0)]));
    assert.equal(decimalIntervals([]), '[]');
  });
});
