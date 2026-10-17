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
 * double (a `number` member's) compares with the number as it is, and
 * PostgreSQL compares both as the engine does over the digits the store
 * wrote. The statement is the one a safe integer binds, so a seek stays a
 * seek, and a query's own such external runs in it too. A store run is
 * SQLite always, PostgreSQL where JAREN_PG_URL names a server; documents
 * another writer spelled are SQLite's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryJson } from '@jarenjs/json/query';
import { integersRoundingTo, intervalEdge } from '../../packages/db/src/double-interval.js';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u: { type: 'integer' }, v: { type: 'integer' }, n: { type: 'number' } } },
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
 * Open `MODEL` on SQLite with a writer beside the store that stores a
 * document by the JSON text it is given, digits as written.
 * @param {(store: any, write: (key: string, text: string) => Promise<void>) => Promise<void>} fn
 */
async function withForeignWriter(fn) {
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

describe('an external past 2^53 against digits another writer spelled, sqlite', () => {
  it('keeps the rows the engine keeps, in a profile predicate and in a query\'s own $where', async () => {
    await withForeignWriter(async (store, write) => {
      const big = store.collection('big');
      // the store's own documents spell each number by its shortest digits
      for (const [i, value] of NUMBERS.entries()) await big.insert({ id: `s${i}`, u: value, v: value, n: value });
      for (const [i, digits] of EDGES.entries()) await write(`f${i}`, `{"id":"f${i}","u":${digits},"v":${digits},"n":${digits}}`);
      // what the engine reads: every document, as the numbers it holds
      const documents = await big.execute({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }, { pushdown: false });
      assert.equal(documents.length, NUMBERS.length + EDGES.length);
      const differ = [];
      for (const member of ['u', 'v', 'n']) {
        for (const op of OPERATORS) {
          const predicate = { [op]: [`$it.${member}`, '$x'] };
          for (const x of [2 ** 60, 2 ** 60 + 256, 2 ** 53, -(2 ** 60), 2 ** 63, -(2 ** 63), 5]) {
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
