//@ts-check
/**
 * @file A grouping whose order names every key ranks every two groups apart,
 * so no first row is needed to break a tie: the statement orders the groups by
 * the keys alone, each with its type beside it, and groups them in the order's
 * sequence. The order is then the grouping's own sort, which SQLite reads the
 * groups off rather than sorting them again. Every shape below answers what the
 * engine answers: absent keys under either placement, both directions, keys
 * ordered in another sequence than they are grouped, an aggregate before or
 * after the keys, and a window over the groups.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { defineModel, object, integer, string } from '@jarenjs/linq/model';
import { normalizeEntities, explainMapping } from '@jarenjs/db/model';
import { createEntityQueryEngine, createQueryState } from '@jarenjs/db/query';

const PG_URL = process.env.JAREN_PG_URL;

/** What a call answered: its value, or the code it raised. @param {() => any} call */
async function outcome(call) {
  try { return { value: await call() }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

/** The steps of a SQLite statement's query plan. @param {DatabaseSync} handle @param {string} sql */
const planOf = (handle, sql) => handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail));

const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' }, n: { type: 'number' }, t: { type: 'string' } } };
// s is absent from row 5, n from row 7, t from rows 2, 6 and 9; 2 is in three rows
const DOCUMENTS = [
  { id: 1, s: 'b', n: 2, t: 'x' }, { id: 2, s: 'a', n: 3 }, { id: 3, s: 'b', n: 1.5, t: 'y' }, { id: 4, s: 'c', n: 2, t: 'x' },
  { id: 5, n: 3, t: 'z' }, { id: 6, s: 'a', n: -1 }, { id: 7, s: 'c', t: 'x' }, { id: 8, s: 'b', n: 2, t: 'x' },
  { id: 9, s: 'é', n: 10 }, { id: 10, s: 'B', n: 0.5, t: 'z' },
];
/** @param {any} groupby @param {any[]} orderby @param {any} ret */
const grouped = (groupby, orderby, ret) => ({ $for: { it: '$[*]' }, $groupby: groupby, $orderby: orderby, $return: ret });
const COUNT = { $count: '$it' };
/** name, document, and whether SQLite reads the order off the sort it grouped by */
const QUERIES = /** @type {[string, any, boolean][]} */ ([
  ['a string key', grouped({ s: '$it.s' }, ['$s'], { s: '$s', c: COUNT }), true],
  ['a string key, descending', grouped({ s: '$it.s' }, [{ $key: '$s', $dir: 'desc' }], { s: '$s', c: COUNT }), true],
  ['a string key, absent greatest', grouped({ s: '$it.s' }, [{ $key: '$s', $empty: 'greatest' }], { s: '$s' }), false],
  ['a string key, descending, absent greatest', grouped({ s: '$it.s' }, [{ $key: '$s', $dir: 'desc', $empty: 'greatest' }], { s: '$s' }), false],
  ['two keys ordered in the other sequence, each its own way', grouped({ s: '$it.s', t: '$it.t' }, ['$t', { $key: '$s', $dir: 'desc' }], { s: '$s', t: '$t' }), true],
  ['two keys ordered in their sequence', grouped({ t: '$it.t', s: '$it.s' }, ['$t', '$s'], { s: '$s', t: '$t', c: COUNT }), true],
  ['a number key', grouped({ n: '$it.n' }, ['$n'], { n: '$n', ids: { $sum: '$it.id' } }), true],
  ['a number key, descending, then a string', grouped({ n: '$it.n', s: '$it.s' }, [{ $key: '$n', $dir: 'desc' }, { $key: '$s', $dir: 'desc' }], { n: '$n', s: '$s' }), true],
  ['the count, then the key', grouped({ s: '$it.s' }, [{ $key: COUNT, $dir: 'desc' }, '$s'], { s: '$s', c: COUNT }), false],
  ['the key, then the count', grouped({ t: '$it.t' }, ['$t', COUNT], { t: '$t', c: COUNT }), false],
  ['a key ordered twice', grouped({ s: '$it.s' }, ['$s', { $key: '$s', $dir: 'desc' }], { s: '$s' }), false],
  ['a window past the first group', { $subsequence: [grouped({ s: '$it.s', t: '$it.t' }, ['$s', '$t'], { s: '$s', t: '$t' }), 2, 3] }, true],
  ['an unordered grouping', { $for: { it: '$[*]' }, $groupby: { s: '$it.s' }, $return: { s: '$s', c: COUNT } }, false],
]);

describe('a collection grouping ordered by every key', () => {
  it('answers as the engine, on every host, and orders by the keys alone', async () => {
    const expected = new Map(QUERIES.map(([name, query]) => [name, (() => {
      try { return { value: compileJsonQuery(query)(structuredClone(DOCUMENTS)) }; }
      catch (error) { return { code: /** @type {any} */ (error).code }; }
    })()]));
    const model = { $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes: [], schema: SCHEMA } } };
    const handle = new DatabaseSync(':memory:');
    const sqlite = await adaptNodeDatabase({ exec: (sql) => handle.exec(sql), close: () => handle.close(), prepare: (sql) => handle.prepare(sql) });
    /** @type {[string, () => Promise<any>, (() => Promise<void>) | null][]} */
    const hosts = [['sqlite', async () => ({ ...nodeDriver(), open: async () => sqlite }), null]];
    if (PG_URL) {
      const { default: pg } = await import('pg');
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
      const schema = `group_order_ranked_${process.pid}`;
      hosts.push(['postgres', async () => {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        return postgresDriver(pool, { schema });
      }, async () => {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }]);
    }
    for (const [host, driverOf, release] of hosts) {
      try {
        const store = await openStore(model, { driver: await driverOf() });
        try {
          const rows = store.collection('rows');
          for (const document of DOCUMENTS) await rows.insert(document);
          for (const [name, query, ranked] of QUERIES) {
            const label = `${host}: ${name}`;
            const explained = await rows.explain(query);
            assert.equal(explained.mode, 'native', label);
            assert.deepEqual(await outcome(() => rows.execute(query, { strict: true })), expected.get(name), label);
            // the first row breaks a tie only where the order leaves one
            assert.equal(/MIN\("(?:rowid|rid)"\)$/.test(explained.sql.replace(/ LIMIT .*$/, '')),
              !/ORDER BY .*"tk\d" (?:ASC|DESC)/.test(explained.sql), label);
            if (host === 'sqlite') {
              assert.equal(planOf(handle, explained.sql).includes('USE TEMP B-TREE FOR ORDER BY'), !ranked, label);
            }
          }
        }
        finally { await store.close(); }
      }
      finally { await release?.(); }
    }
  });
});

describe('an entity grouping ordered by every key', () => {
  const column = (/** @type {string} */ name, /** @type {string} */ codec, /** @type {string} */ nullPolicy) => ({ name, codec, null: nullPolicy });
  // a reads a NULL as no member at all, r holds none
  const MODEL = defineModel({ entities: {
    Row: object({ id: integer().identity('auto'), a: integer(), r: integer(), s: string() })
      .physical({ table: 'rows_t', columns: { id: column('id', 'integer', 'reject'), a: column('a', 'integer', 'absent'),
        r: column('r', 'integer', 'reject'), s: column('s', 'text', 'reject') } }),
  } });
  const SEED = `CREATE TABLE rows_t(id INTEGER PRIMARY KEY, a INTEGER, r INTEGER NOT NULL, s TEXT NOT NULL);
    INSERT INTO rows_t VALUES (1, 3, 1, 'x'), (2, NULL, 2, 'y'), (3, 1, 1, 'x'), (4, 3, 2, 'z'), (5, NULL, 1, 'y'), (6, 2, 3, 'x')`;
  /** @param {any} groupby @param {any[]} orderby @param {any} ret */
  const ordered = (groupby, orderby, ret) => ({ $for: { it: '$.Row[*]' }, $groupby: groupby, $orderby: orderby, $return: ret });
  const ROWS = { $count: '$it' };
  const CASES = /** @type {[string, any, boolean][]} */ ([
    ['a key that may be absent', ordered({ a: '$it.a' }, ['$a'], { a: '$a', c: ROWS }), true],
    ['a key that may be absent, descending', ordered({ a: '$it.a' }, [{ $key: '$a', $dir: 'desc' }], { a: '$a', c: ROWS }), true],
    ['a key that may be absent, placed greatest', ordered({ a: '$it.a' }, [{ $key: '$a', $empty: 'greatest' }], { a: '$a' }), false],
    ['a key that holds no null', ordered({ r: '$it.r' }, ['$r'], { r: '$r', ids: { $sum: '$it.id' } }), true],
    ['two keys ordered in the other sequence, each its own way', ordered({ a: '$it.a', r: '$it.r' }, [{ $key: '$r', $dir: 'desc' }, '$a'], { a: '$a', r: '$r' }), true],
    ['two keys in their sequence', ordered({ r: '$it.r', a: '$it.a' }, ['$r', '$a'], { r: '$r', a: '$a', c: ROWS }), true],
    // a text column is read with its collation spelled out, which SQLite does not match to the ordering by the key's name
    ['a text key first', ordered({ s: '$it.s', r: '$it.r', a: '$it.a' }, ['$s', '$r', '$a'], { s: '$s', r: '$r', a: '$a' }), false],
    ['the count, then the key', ordered({ s: '$it.s' }, [{ $key: ROWS, $dir: 'desc' }, '$s'], { s: '$s', c: ROWS }), false],
    // the count alone leaves groups tied, which come out by their first row
    ['the count alone', ordered({ r: '$it.r' }, [{ $key: ROWS, $dir: 'desc' }], { r: '$r', c: ROWS }), false],
  ]);

  it('answers as the engine and orders by the keys alone', async () => {
    const handle = new DatabaseSync(':memory:');
    handle.exec(SEED);
    const connection = await adaptNodeDatabase({ exec: (sql) => handle.exec(sql), close: () => handle.close(), prepare: (sql) => handle.prepare(sql) });
    const engine = createEntityQueryEngine({ connection, entities: normalizeEntities(MODEL), mapping: explainMapping(MODEL), state: createQueryState(8) });
    try {
      for (const [name, query, ranked] of CASES) {
        const explained = engine.explain(query);
        assert.equal(explained.mode, 'native', name);
        assert.deepEqual(await outcome(() => engine.execute(query, { strict: true })),
          await outcome(() => engine.execute(query, { pushdown: false })), name);
        const tied = /MIN\("t0"\."id"\)$/.test(explained.sql);
        assert.equal(tied, name === 'the count alone', name);
        assert.equal(tied, !/ORDER BY .*"tk\d" (?:ASC|DESC)/.test(explained.sql), name);
        // the order the explanation reports is the statement's: a tie-breaker exactly where the statement breaks ties
        assert.equal(explained.order.some((/** @type {any} */ term) => term.tieBreaker), tied, name);
        assert.equal(planOf(handle, explained.sql).includes('USE TEMP B-TREE FOR ORDER BY'), !ranked, name);
      }
    }
    finally { connection.close(); }
  });
});
