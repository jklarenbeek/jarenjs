//@ts-check
/**
 * @file The bare root wildcard over a collection — `'$[*]'`, the
 * degenerate query every linq chain emits until an operator is applied
 * — is planned as the collection scan it abbreviates: a native plan
 * streamed row by row from an open statement, the same rows in the same
 * order as the `$for` phrase, and the same answer from `explain` on the
 * store and on the chain. Before this it was a path barrier that fetched
 * the collection whole and walked it in JS, so a bare `for await` over a
 * collection handle materialised the table while its own explain said
 * `streaming: 'row'`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as sqlite from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver, fromNodeModule } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';
import { recordingDriver } from './helpers.js';

const url = process.env.JAREN_PG_URL;

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, n: { type: 'integer' } } },
      key: '/id',
      indexes: [],
    },
  },
};
const FLWOR = { $for: { it: '$[*]' }, $return: '$it' };

describe("a bare '$[*]' over a collection is the collection scan", () => {
  it('plans native and streams row by row, the same rows in the same order as the $for phrase', async () => {
    const { driver, executed } = recordingDriver(nodeDriver());
    const store = await openStore(MODEL, { driver });
    const rows = store.collection('rows');
    for (let i = 0; i < 5; i++) await rows.insert({ id: i, n: i * i });
    const explained = /** @type {any} */ (await rows.explain('$[*]'));
    assert.strictEqual(explained.mode, 'native');
    assert.strictEqual(explained.streaming, 'row');
    assert.strictEqual(explained.barrier, null);
    const viaPath = await rows.execute('$[*]');
    const viaFlwor = await rows.execute(FLWOR);
    assert.deepStrictEqual(viaPath, viaFlwor);
    assert.strictEqual(/** @type {any[]} */ (viaPath).length, 5);
    const cursor = rows.query('$[*]');
    assert.strictEqual(cursor.streaming, 'row');
    const pulled = [];
    for await (const row of cursor) {
      pulled.push(row.id);
      if (pulled.length === 2) break;
    }
    assert.deepStrictEqual(pulled, [0, 1], 'two rows cost two pulls; the break releases the statement');
    assert.ok(!executed.some((sql) => /json_group_array|json_agg/i.test(sql)), 'no whole-collection aggregate was executed');
    await store.close();
  });

  it("the linq collection handle's bare chain emits '$[*]' and its explain now agrees with the store's", async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    for (let i = 0; i < 3; i++) await client.collections.rows.insert({ id: i, n: i });
    assert.strictEqual(client.collections.rows.toDocument(), '$[*]');
    const own = /** @type {any} */ (client.collections.rows.explain());
    const stores = /** @type {any} */ (await client.collections.rows.explain('$[*]'));
    assert.strictEqual(own.streaming, 'row');
    assert.strictEqual(stores.streaming, 'row');
    assert.strictEqual(stores.mode, 'native');
    const seen = [];
    for await (const row of client.collections.rows) seen.push(row.id);
    assert.deepStrictEqual(seen, [0, 1, 2]);
    await client.close();
  });
});

// A linq chain's `count()` over a collection handle emits `{ $count: '$[*]' }`.
// It was planned as a path barrier: every document fetched to be counted in
// JS, while the `$for` phrase it abbreviates planned the native `COUNT(*)`
// that the explain of a count reports. The executed statement is now the
// explained one on both engines, and the answers are the same.
const COUNT_MODEL = { $model: '0.1', collections: { items: { key: '/id', schema: { type: 'object', required: ['id'],
  properties: { id: { type: 'string' }, n: { type: ['integer', 'null'] } } } } } };
const ROOT_COUNT = { $count: '$[*]' };
// an absent member and a null one: a bare root counts documents, not members
const SEED = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c' }, { id: 'd', n: null }, { id: 'e', n: 5 }];

/** Every count below, with what each statement fetched.
 * @param {any} client @param {{ sql: string, rows: number }[]} trace */
async function countAnswers(client, trace) {
  const items = client.collections.items;
  /** @type {Record<string, any>} */
  const answers = {};
  /** @param {string} label @param {() => Promise<any>} run */
  const counted = async (label, run) => {
    trace.length = 0;
    answers[label] = await run();
    return [...trace];
  };
  /** one COUNT(*) statement, and no statement that fetched documents @param {any[]} calls @param {string} label */
  const native = (calls, label) => {
    assert.ok(calls.some((call) => /COUNT\(\*\)/.test(call.sql)), `${label}: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((call) => (/FROM "items"/.test(call.sql) && !/COUNT\(\*\)/.test(call.sql)) || call.rows > 1),
      `${label}: ${JSON.stringify(calls)}`);
  };
  native(await counted('empty', () => items.count()), 'empty');
  for (const doc of SEED) await items.insert(doc);
  const explained = await items.explain(ROOT_COUNT);
  assert.strictEqual(explained.mode, 'native');
  const executed = await counted('count', () => items.count());
  native(executed, 'count');
  // PostgreSQL runs it through a cursor: `DECLARE ... CURSOR FOR <the explained statement>`
  assert.ok(executed.some((call) => call.sql === explained.sql || call.sql.endsWith(` FOR ${explained.sql}`)),
    `the executed statement is the explained one: ${explained.sql} ${JSON.stringify(executed)}`);
  const hits = client.store.stats().statementCache.hits;
  native(await counted('cached', () => items.count()), 'cached');
  assert.strictEqual(client.store.stats().statementCache.hits, hits + 1, 'the second count is a statement-cache hit');
  native(await counted('document', () => items.execute(ROOT_COUNT)), 'document');
  native(await counted('filtered', () => items.where((/** @type {any} */ r) => r.n.gt(1)).count()), 'filtered');
  native(await counted('projected', () => items.select((/** @type {any} */ r) => r.n).count()), 'projected');
  await counted('windowed', () => items.take(3).count());
  await counted('skipped', () => items.skip(4).count());
  answers.residual = await items.execute(ROOT_COUNT, { pushdown: false });
  return answers;
}

const EXPECTED = { empty: 0, count: 5, cached: 5, document: 5, filtered: 2, projected: 4, windowed: 3, skipped: 1, residual: 5 };
/** @type {Record<string, any>} */
const byEngine = {};

describe("a bare count of '$[*]' over a collection is its native COUNT(*)", () => {
  it('on SQLite', async () => {
    /** @type {{ sql: string, rows: number }[]} */
    const trace = [];
    class Observed extends sqlite.DatabaseSync {
      /** @param {string} sql */
      prepare(sql) {
        const statement = super.prepare(sql);
        return new Proxy(statement, { get(target, name) {
          const member = Reflect.get(target, name, target);
          if (typeof member !== 'function') return member;
          return (/** @type {any[]} */ ...args) => {
            const result = Reflect.apply(member, target, args);
            if (['all', 'get', 'iterate'].includes(String(name)))
              trace.push({ sql, rows: Array.isArray(result) ? result.length : 1 });
            return result;
          };
        } });
      }
    }
    const driver = { ...nodeDriver(),
      open: (/** @type {string} */ path, /** @type {any} */ options) => fromNodeModule({ ...sqlite, DatabaseSync: Observed }, path, options) };
    const client = await open(COUNT_MODEL, { driver, validator: null });
    try {
      byEngine.sqlite = await countAnswers(client, trace);
      assert.deepStrictEqual(byEngine.sqlite, EXPECTED);
    }
    finally { await client.close(); }
  });

  it('on PostgreSQL, with the same answers', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const { default: pg } = await import('pg');
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `root_count_${process.pid}`;
    /** @type {{ sql: string, rows: number }[]} */
    const trace = [];
    const observed = { connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, { get(target, name) {
        const member = Reflect.get(target, name, target);
        if (name !== 'query') return typeof member === 'function' ? member.bind(target) : member;
        return async (/** @type {any[]} */ ...args) => {
          const result = await member.apply(target, args);
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          trace.push({ sql: String(sql), rows: Array.isArray(result?.rows) ? result.rows.length : 0 });
          return result;
        };
      } });
    } };
    let client;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      client = await open(COUNT_MODEL, { driver: postgresDriver(observed, { schema }), validator: null });
      byEngine.postgres = await countAnswers(client, trace);
      assert.deepStrictEqual(byEngine.postgres, EXPECTED);
      if (byEngine.sqlite !== undefined) assert.deepStrictEqual(byEngine.postgres, byEngine.sqlite);
    }
    finally {
      try { await client?.close(); }
      finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    }
  });
});
