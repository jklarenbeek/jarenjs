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
 * too. A store run is SQLite always, PostgreSQL where JAREN_PG_URL names a
 * server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryJson } from '@jarenjs/json/query';
import { decimalEdge, integersRoundingTo, intervalEdge } from '../../packages/db/src/double-interval.js';
import { boundsSafeIntegers } from '../../packages/db/src/ddl.js';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u: { type: 'integer' }, v: { type: 'integer' }, n: { type: 'number' },
        w: { type: 'number' } } },
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

  describe(`equal doubles spelled by other digits, ${engine}`, { skip: skipFor(engine) }, () => {
    it('order, group and count apart as the engine does, in the statement', async () => {
      await withForeignWriter(engine, async (store, write) => {
        const big = store.collection('big');
        // the store's spelling and another writer's of one double each
        const pairs = [[-(2 ** 62), '-4611686018427387904'], [2 ** 60, '1152921504606846976'], [2 ** 60 + 256, '1152921504606847100'],
          [2 ** 53, '9007199254740993'], [5, '5.0']];
        for (const [i, [own, foreign]] of pairs.entries()) {
          await big.insert({ id: `o${i}`, u: own, v: own, n: own, w: own });
          await write(`f${i}`, `{"id":"f${i}","u":${foreign},"v":${foreign},"n":${foreign},"w":${foreign}}`);
        }
        const fractions = [[0.1, '0.1000000000000000055511151231257827021181583404541015625'], [1.5, '1.50000000000000000000001']];
        for (const [i, [own, foreign]] of fractions.entries()) {
          await big.insert({ id: `p${i}`, n: own, w: own });
          await write(`q${i}`, `{"id":"q${i}","n":${foreign},"w":${foreign}}`);
        }
        for (const [i, digits] of far(engine).entries()) await write(`z${i}`, `{"id":"z${i}","n":${digits},"w":${digits}}`);
        const differ = [];
        for (const member of ['u', 'v', 'n', 'w']) {
          const ordered = { $for: { it: '$[*]' }, $orderby: [`$it.${member}`, '$it.id'], $return: '$it.id' };
          for (const [label, doc] of [['orderby', ordered],
            ['orderby desc', { ...ordered, $orderby: [{ $key: `$it.${member}`, $dir: 'desc' }, '$it.id'] }],
            ['window', { $subsequence: [ordered, 1, 3] }],
            ['distinct', { $distinct: { $for: { it: '$[*]' }, $return: `$it.${member}` } }],
            ['group', { $for: { it: '$[*]' }, $groupby: { k: `$it.${member}` }, $return: { k: '$k', c: { $count: '$it' } } }],
            ['group ordered', { $for: { it: '$[*]' }, $groupby: { k: `$it.${member}` }, $orderby: ['$k'], $return: { k: '$k', c: { $count: '$it' } } }],
            ['count distinct', { $count: { $distinct: { $for: { it: '$[*]' }, $return: `$it.${member}` } } }]]) {
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
    // a safe integer or a fraction stands for itself; anything else is its JSON
    assert.deepEqual(edges(5), ['5', '4', '5', '6']);
    assert.deepEqual(edges(0.5), ['0.5', '-0.5', '0.5', '1.5']);
    assert.deepEqual(edges('text'), ['"text"', '"text"', '"text"', '"text"']);
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
              // the proven member's order is its index's, the others read the double and sort
              const bare = member === 'at';
              assert.equal(explained.sql.includes(`CAST("gx_${member}" AS REAL)`), !bare, `${member} ${label}`);
              const db = new DatabaseSync(path);
              try {
                const plan = db.prepare(`EXPLAIN QUERY PLAN ${explained.sql}`).all(...explained.sql.split('?').slice(1).map(() => 0))
                  .map((row) => String(row.detail)).join(' | ');
                assert.equal(plan.includes('USE TEMP B-TREE FOR ORDER BY'), !bare, `${member} ${label}: ${plan}`);
                if (bare) assert.match(plan, /USING INDEX t_by_at/, `${member} ${label}`);
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
