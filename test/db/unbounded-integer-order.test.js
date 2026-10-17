//@ts-check
/**
 * @file On SQLite an ordering over an indexed `integer` member the schema
 * does not bound reads the column in its index order whenever no row the
 * statement reads holds a number past ±(2^53 − 1). Two integers a double
 * cannot hold apart (2^60 is `1152921504606847000` from a JavaScript writer,
 * `1152921504606846976` from another) are one double, which the engine ties
 * and orders by first occurrence; SQLite orders the exact integers. A window
 * with a limit probes the column in its own LIMIT — read once, before any
 * row, in the statement's snapshot — and answers no row when such a number
 * is there; an empty answer is read again ordered by the double, which a
 * read of every row always is. Every answer here is compared with the
 * engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withStore } from './store-core-engines.js';

const T0 = 1767225600000;
/** @param {any[]} indexes @param {any} [at] */
const modelOf = (indexes, at = { type: 'integer' }) => ({ $model: '0.1', collections: { t: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, u: { type: 'integer' }, at } }, indexes } } });
const LEADS = [{ name: 'by_u', path: '$.u' }];
const FOLLOWS = [{ name: 'by_s_u', path: ['$.s', '$.u'] }];
const SERIES = [{ name: 'by_s_at', path: ['$.s', '$.at'] }];

/** Safe integers only, the edges ±(2^53 − 1) among them, with ties. */
const SAFE = [
  { id: 'r00', s: 'a', u: 5, at: T0 + 3000 }, { id: 'r01', s: 'b', u: 9007199254740991, at: T0 + 1000 },
  { id: 'r02', s: 'a', u: -9007199254740991, at: T0 }, { id: 'r03', s: 'b', u: 5, at: T0 + 1000 },
  { id: 'r04', s: 'a', u: 0, at: T0 + 2000 }, { id: 'r05', s: 'b', u: -3, at: T0 + 2000 },
  { id: 'r06', s: 'a', u: 5, at: T0 + 1000 }, { id: 'r07', s: 'b', u: 7, at: T0 },
];
/**
 * Rows another writer stores by digits the store never writes, each beside
 * the store's own spelling of the same double, in an insertion order the
 * exact integers reverse: the store's `wN` comes first, the foreign `xN` and
 * `yN` after it (`yN` above the store's digits, `xN` below them).
 * @param {number} sign
 */
const wide = (sign) => [
  { store: { id: 'w0', s: 'a', u: sign * 2 ** 60, at: sign * 2 ** 60 } },
  { foreign: `{"id":"x0","s":"a","u":${sign < 0 ? '-' : ''}1152921504606846976,"at":${sign < 0 ? '-' : ''}1152921504606846976}` },
  { foreign: `{"id":"y0","s":"a","u":${sign < 0 ? '-' : ''}1152921504606847100,"at":${sign < 0 ? '-' : ''}1152921504606847100}` },
];

/**
 * Open a file store over `rows` (a document the store writes, or a foreign
 * JSON text written through a second connection) and run `fn`.
 * @param {any[]} indexes @param {any[]} rows @param {(t: any, path: string) => Promise<void>} fn @param {any} [at]
 */
async function withRows(indexes, rows, fn, at = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-integer-order-'));
  const path = join(dir, 'store.sqlite');
  try {
    await withStore('sqlite', modelOf(indexes, at), async (store) => {
      const t = store.collection('t');
      for (const row of rows) {
        if ('foreign' in row) {
          const db = new DatabaseSync(path);
          try { db.prepare('INSERT INTO "t" ("key", "doc") VALUES (?, jsonb(?))').run(JSON.parse(row.foreign).id, row.foreign); }
          finally { db.close(); }
        }
        else await t.insert('store' in row ? row.store : row);
      }
      await fn(t, path);
    }, { path });
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The plan SQLite reads a statement by, its parameters bound as 0. @param {string} path @param {string} sql */
function planOf(path, sql) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...sql.split('?').slice(1).map(() => 0))
      .map((row) => String(row.detail));
  }
  finally { db.close(); }
}

/** @param {string} member @param {any} [where] */
const ordered = (member, where = undefined) => ({ $for: { it: '$[*]' }, ...(where === undefined ? {} : { $where: where }),
  $orderby: [`$it.${member}`], $return: '$it.id' });
/** The first `length` items of `doc`. @param {any} doc @param {number} length */
const first = (doc, length) => ({ $subsequence: [doc, 0, length] });
/** @param {any} doc */
const descending = (doc) => ({ ...doc, $orderby: [{ $key: doc.$orderby[0], $dir: 'desc' }] });

/**
 * Every window of `doc` that starts or ends inside the run, both directions,
 * and the whole: native, and equal to the engine's answer.
 * @param {any} t @param {any} doc @param {any} [externals]
 */
async function assertEngineOrder(t, doc, externals = {}) {
  for (const base of [doc, descending(doc)]) {
    const engine = await t.execute(base, { pushdown: false, externals });
    assert.deepEqual(await t.execute(base, { externals }), engine, JSON.stringify(base.$orderby));
    // an empty answer is no item, one item that item
    const all = engine === undefined ? [] : Array.isArray(engine) ? engine : [engine];
    for (let start = 0; start <= all.length; start++) {
      for (const length of [1, 2, 3]) {
        const window = { $subsequence: [base, start, length] };
        assert.equal((await t.explain(window, { externals })).mode, 'native');
        assert.deepEqual(await t.execute(window, { externals }), await t.execute(window, { pushdown: false, externals }),
          `${JSON.stringify(base.$orderby)} window ${start}+${length}`);
      }
    }
    for (const read of [base, { $subsequence: [base, 0, all.length + 1] }]) {
      const items = [];
      for await (const item of t.query(read, { externals })) items.push(item);
      assert.deepEqual(items, all, `${JSON.stringify(base.$orderby)} cursor`);
    }
  }
}

describe('an ordering over an unbounded indexed integer member', () => {
  it('reads a window of safe integers in index order, with no sort and no double read', async () => {
    await withRows(LEADS, SAFE, async (t, path) => {
      // a read of every row reads the double and sorts, as a sort is all the index would save
      assert.match((await t.explain(ordered('u'))).sql, /ORDER BY CAST\("gx_u" AS REAL\) ASC NULLS FIRST, "rowid"$/);
      const explained = await t.explain({ $subsequence: [ordered('u'), 2, 3] });
      assert.doesNotMatch(explained.sql, /CAST\("gx_u" AS REAL\)/);
      assert.match(explained.sql, /ORDER BY "gx_u" ASC NULLS FIRST, "rowid" LIMIT CASE WHEN \(SELECT MAX\("gx_u"\) FROM "t"\) > 9007199254740991 OR \(SELECT MIN\("gx_u"\) FROM "t"\) < -9007199254740991 THEN 0 ELSE 3 END OFFSET 2$/);
      const plan = planOf(path, explained.sql);
      assert.ok(!plan.includes('USE TEMP B-TREE FOR ORDER BY'), plan.join(' | '));
      assert.ok(plan.includes('SCAN t USING INDEX t_by_u'), plan.join(' | '));
      // each probe is a seek to one end of the index, never a scan
      assert.deepEqual(plan.filter((line) => line.startsWith('SEARCH')), ['SEARCH t USING INDEX t_by_u', 'SEARCH t USING INDEX t_by_u']);
      assert.deepEqual(await t.execute(first(ordered('u'), 8)), ['r02', 'r05', 'r04', 'r00', 'r03', 'r06', 'r07', 'r01']);
      await assertEngineOrder(t, ordered('u'));
      // a profile that refuses a full-table scan admits the probe
      assert.deepEqual(await t.execute(first(ordered('u'), 3), { profile: { refuseFullScan: true } }), ['r02', 'r05', 'r04']);
      // a cursor left after its first item closes the guarded read, and the store reads on
      const taken = [];
      for await (const item of t.query(first(ordered('u'), 3))) {
        taken.push(item);
        break;
      }
      assert.deepEqual(taken, ['r02']);
      assert.deepEqual(await t.execute(first(ordered('u'), 2)), ['r02', 'r05']);
    });
  });

  for (const sign of [1, -1]) {
    it(`ties two spellings of one double ${sign < 0 ? 'below -' : 'past '}2^53 as the engine does, in every window`, async () => {
      await withRows(LEADS, [...SAFE, ...wide(sign)], async (t) => {
        const all = await t.execute(ordered('u'), { pushdown: false });
        // the engine's order: the store's spelling first, as it came first
        assert.deepEqual(sign > 0 ? all.slice(-3) : all.slice(0, 3), ['w0', 'x0', 'y0']);
        await assertEngineOrder(t, ordered('u'));
        // the read that answers sorts the whole table, which a profile refusing full scans refuses, as it
        // refused the one statement this read was before; the probe's read alone it admits
        const profile = { refuseFullScan: true };
        await assert.rejects(Promise.resolve().then(() => t.execute(first(ordered('u'), 3), { profile })), { code: 'JD0011' });
        await assert.rejects(async () => { for await (const _ of t.query(first(ordered('u'), 3), { profile })) break; }, { code: 'JD0011' });
      });
    });
  }

  it('probes through the filter where the column follows another key, and binds the filter twice in order', async () => {
    // the wide rows sit in series 'a': series 'b' reads bare, series 'a' falls back
    await withRows(FOLLOWS, [...SAFE, ...wide(1)], async (t, path) => {
      for (const s of ['a', 'b']) {
        const doc = ordered('u', { $eq: ['$it.s', s] });
        const explained = await t.explain(first(doc, 2));
        assert.doesNotMatch(explained.sql, /CAST\("gx_u" AS REAL\)/);
        assert.match(explained.sql, /LIMIT CASE WHEN \(SELECT MAX\("gx_u"\) FROM "t" WHERE .+\) > 9007199254740991 OR \(SELECT MIN\("gx_u"\) FROM "t" WHERE .+\) < -9007199254740991 THEN 0 ELSE 2 END$/);
        const plan = planOf(path, explained.sql);
        assert.ok(!plan.includes('USE TEMP B-TREE FOR ORDER BY'), plan.join(' | '));
        assert.deepEqual(plan.filter((line) => line.startsWith('SEARCH') || line.startsWith('SCAN')),
          ['SEARCH t USING INDEX t_by_s_u (gx_s=?)', 'SEARCH t USING INDEX t_by_s_u (gx_s=?)', 'SEARCH t USING INDEX t_by_s_u (gx_s=?)']);
        await assertEngineOrder(t, doc);
        // both reads seek the series, so a profile refusing full scans admits either
        assert.deepEqual(await t.execute(first(doc, 2), { profile: { refuseFullScan: true } }), await t.execute(first(doc, 2), { pushdown: false }));
      }
      // externals in the filter bind once for the WHERE and once for each probe read, in text order
      const bound = ordered('u', { $and: [{ $eq: ['$it.s', '$s'] }, { $gt: ['$it.u', '$lo'] }] });
      const filter = (await t.explain({ $for: { it: '$[*]' }, $where: bound.$where, $return: '$it.id' },
        { externals: { s: 'b', lo: -1 } })).sql.split('?').length - 1;
      assert.equal((await t.explain(first(bound, 2), { externals: { s: 'b', lo: -1 } })).sql.split('?').length - 1, 3 * filter);
      for (const s of ['a', 'b']) for (const lo of [-1, 5, 2 ** 53, 2 ** 60]) await assertEngineOrder(t, bound, { s, lo });
    });
  });

  it('reads a time-series range in the index the series and instant key, and ties its spellings', async () => {
    const range = (/** @type {number} */ from, /** @type {number | null} */ to) => ({ $for: { it: '$[*]' }, $where: { $and: [
      { $eq: ['$it.s', 'a'] }, { $ge: ['$it.at', from] }, ...(to === null ? [] : [{ $lt: ['$it.at', to] }])] },
    $orderby: ['$it.at'], $return: '$it.id' });
    await withRows(SERIES, [...SAFE, ...wide(1)], async (t, path) => {
      const bounded = range(T0, T0 + 3000);
      const explained = await t.explain(first(bounded, 2));
      assert.match(explained.sql, /ORDER BY "gx_at" ASC NULLS FIRST, "rowid" LIMIT CASE WHEN \(SELECT MAX\("gx_at"\) FROM "t" WHERE /);
      const plan = planOf(path, explained.sql);
      assert.ok(!plan.includes('USE TEMP B-TREE FOR ORDER BY'), plan.join(' | '));
      assert.equal(plan.filter((line) => line.startsWith('SEARCH t USING INDEX t_by_s_at (gx_s=? AND gx_at>? AND gx_at<?)')).length, 3,
        plan.join(' | '));
      // a range that ends before the wide instants reads bare; one that reaches them falls back
      assert.deepEqual(await t.execute(first(bounded, 2)), ['r02', 'r06']);
      await assertEngineOrder(t, bounded);
      await assertEngineOrder(t, range(T0, null));
      assert.deepEqual((await t.execute(first(range(T0, null), 7))).slice(-3), ['w0', 'x0', 'y0']);
      // the run's numbers count the second read
      assert.deepEqual((await t.explain(first(range(T0, null), 7))).series?.counts, { statements: 2, candidates: 7, results: 7, partial: false });
      await t.execute(first(bounded, 2));
      assert.deepEqual((await t.explain(first(bounded, 2))).series?.counts, { statements: 1, candidates: 2, results: 2, partial: false });
    });
  });

  it('answers from the snapshot its statement read, whatever another connection commits meanwhile', async () => {
    await withRows(LEADS, SAFE, async (t, path) => {
      const doc = first(ordered('u'), 20);
      const before = await t.execute(doc, { pushdown: false });
      const cursor = t.query(doc)[Symbol.asyncIterator]();
      const items = [(await cursor.next()).value];
      // the other connection commits two spellings of one double past 2^53 —
      // in the order the exact integers reverse — while the statement is open
      const db = new DatabaseSync(path);
      try {
        db.prepare('INSERT INTO "t" ("key", "doc") VALUES (?, jsonb(?))').run('x1', '{"id":"x1","s":"a","u":1152921504606847000}');
        db.prepare('INSERT INTO "t" ("key", "doc") VALUES (?, jsonb(?))').run('y1', '{"id":"y1","s":"a","u":1152921504606846976}');
      }
      finally { db.close(); }
      for (let step = await cursor.next(); step.done !== true; step = await cursor.next()) items.push(step.value);
      assert.deepEqual(items, before);
      // the next read sees the commit, and ties the two as the engine does
      const after = await t.execute(doc, { pushdown: false });
      assert.deepEqual(after.slice(-2), ['x1', 'y1']);
      assert.deepEqual(await t.execute(doc), after);
    });
  });
});
