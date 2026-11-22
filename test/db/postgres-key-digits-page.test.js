//@ts-check
/**
 * @file A load's order and a page's continuation over a `numeric` key a
 * table an earlier release created holds without the store's key CHECK,
 * where another writer re-keyed a row by digits the engine reads as another
 * row's number (`5.99999999999999999999` and `6.00000000000000000001` are 6).
 * A load orders such a key as the double the engine holds, ties by the row
 * identity, as the engine orders them; a page orders it by its digits, the
 * double's order with a unique tie-break, and its continuation carries the
 * digits a row stored where its number does not spell them, so every row
 * is paged once. A key under the CHECK keeps its statement and its number
 * continuation. PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { skipFor, withPostgres } from './store-core-engines.js';

const model = { $model: '0.1', entities: {
  Post: { schema: { type: 'object', required: ['pid'], properties: {
    pid: { type: 'integer', 'x-entity': { key: true } }, score: { type: 'number' }, name: { type: 'string' } } } },
} };
/** Each post, and the digits another writer re-keyed it by (`null`: as the store wrote it). */
const POSTS = /** @type {[number, string | null, string][]} */ ([
  [5, null, 'p5'], [6, null, 'p6'], [7, '6.00000000000000000001', 'a7'], [8, '5.99999999999999999999', 'p8'],
  [9, '9.99999999999999999999', 'p9'], [10, null, 'p10']]);
/** The engine's order by the key: the doubles (5, 6, 6, 6, 10, 10), tied by the row identity. */
const ENGINE = ['p5', 'p6', 'a7', 'p8', 'p9', 'p10'];

/**
 * A schema whose Post table holds the posts, re-keyed by another writer
 * where `earlier` (its key CHECK dropped first, as an earlier release
 * created it), and a store opened over it.
 * @param {boolean} earlier
 * @param {(store: any, pg: { pool: any, schema: string }) => Promise<void>} fn
 */
const posts = (earlier, fn) => withPostgres(async ({ pool, schema, driver }) => {
  const first = await openStore(model, { driver: driver() });
  for (const [pid, , name] of POSTS) first.entity('Post').create({ pid, score: 1, name });
  await first.saveChanges();
  await first.close();
  if (earlier) {
    const { rows } = await pool.query('SELECT c.conname AS c FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid '
      + 'JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = \'Post\' AND c.contype = \'c\' '
      + 'AND pg_catalog.pg_get_expr(c.conbin, c.conrelid) LIKE \'%trunc%\'', [schema]);
    assert.equal(rows.length, 1);
    await pool.query(`ALTER TABLE "${schema}"."Post" DROP CONSTRAINT "${rows[0].c}"`);
    for (const [pid, digits] of POSTS) if (digits !== null) await pool.query(`UPDATE "${schema}"."Post" SET pid = ${digits} WHERE pid = ${pid}`);
  }
  const store = await openStore(model, { driver: driver() });
  try { await fn(store, { pool, schema }); }
  finally { await store.close(); }
});

/**
 * Every page of `spec` at `limit`, walked by its continuations.
 * @param {any} handle @param {any} spec @param {number} limit @param {boolean} [tracking]
 * @returns {Promise<{ names: string[][], continuations: any[] }>}
 */
async function walk(handle, spec, limit, tracking = false) {
  const names = [];
  const continuations = [];
  let after;
  for (;;) {
    const page = await handle.page(spec, after === undefined ? { limit, tracking } : { limit, tracking, after });
    names.push(page.items.map((/** @type {any} */ post) => post.name));
    if (!page.hasMore) return { names, continuations };
    // a continuation that resumes before its own row pages it again, and again
    if (names.length > POSTS.length) assert.fail(`the walk does not end: ${JSON.stringify(names)}`);
    after = page.continuation;
    continuations.push(after);
  }
}

describe('a page and a load over a key another writer re-keyed, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('orders a load by the double the engine holds, tied by the row identity, as the engine orders', async () => {
    await posts(true, async (store) => {
      const loaded = await store.entity('Post').asNoTracking().load({ orderBy: '$it.pid' });
      assert.deepEqual(loaded.map((/** @type {any} */ post) => post.name), ENGINE);
      assert.deepEqual(await store.execute({ $for: { p: '$.Post[*]' }, $orderby: ['$p.pid'], $return: '$p.name' }, { pushdown: false }), ENGINE);
      const descending = await store.entity('Post').asNoTracking().load({ orderBy: { $key: '$it.pid', $dir: 'desc' } });
      assert.deepEqual(descending.map((/** @type {any} */ post) => post.name), ['p9', 'p10', 'p6', 'a7', 'p8', 'p5']);
      assert.match((await store.entity('Post').explainLoad({ orderBy: '$it.pid' })).sql, /ORDER BY \(CASE WHEN abs\("r"\."pid"\)/);
    });
  });

  for (const tracking of [false, true]) {
    it(`pages every row once, by the key and by a tied column, in either direction${tracking ? ', tracked' : ''}`, async () => {
      await posts(true, async (store) => {
        const handle = store.entity('Post');
        for (const [spec, flat] of /** @type {[any, string[]][]} */ ([
          // the digits' order: the doubles never decrease, and the digits break their ties
          [{ orderBy: '$it.pid' }, ['p5', 'p8', 'p6', 'a7', 'p9', 'p10']],
          [{ orderBy: { $key: '$it.pid', $dir: 'desc' } }, ['p10', 'p9', 'a7', 'p6', 'p8', 'p5']],
          // every score ties: the key orders the rows, and a re-keyed row ends a page
          [{ orderBy: '$it.score' }, ['p5', 'p8', 'p6', 'a7', 'p9', 'p10']],
        ])) {
          for (const limit of [1, 2, 4]) {
            const { names } = await walk(handle, spec, limit, tracking);
            assert.deepEqual(names.flat(), flat, `${JSON.stringify(spec)}, ${limit} a page`);
          }
        }
      });
    });
  }

  it('carries a row\'s stored digits where its number does not spell them, and still resumes from a number', async () => {
    await posts(true, async (store) => {
      const handle = store.entity('Post');
      const { continuations } = await walk(handle, { orderBy: '$it.pid' }, 1);
      assert.deepEqual(continuations.map((continuation) => continuation.key), [5, '5.99999999999999999999', 6, '6.00000000000000000001', '9.99999999999999999999']);
      assert.deepEqual(continuations[1].keys, ['5.99999999999999999999']);
      assert.deepEqual(continuations[1].order, [{ column: 'pid', desc: false, nullsFirst: true }]);
      // a continuation emitted before the writer re-keyed a row resumes past its number, as it always did
      const resumed = await handle.page({ orderBy: '$it.pid' }, { limit: 10, after: { ...continuations[0], keys: [6], key: 6 } });
      assert.deepEqual(resumed.items.map((/** @type {any} */ post) => post.name), ['a7', 'p9', 'p10']);
      // a decimal in exponent form is the number it names, as the server reads it
      const exponent = await handle.page({ orderBy: '$it.pid' }, { limit: 10, after: { ...continuations[0], keys: ['6e0'], key: '6e0' } });
      assert.deepEqual(exponent.items.map((/** @type {any} */ post) => post.name), ['a7', 'p9', 'p10']);
      for (const digits of ['six', '6e', 'NaN', 'Infinity', '']) {
        await assert.rejects(handle.page({ orderBy: '$it.pid' }, { limit: 1, after: { ...continuations[1], keys: [digits], key: digits } }),
          (/** @type {any} */ error) => error.code === 'JD0035', digits);
      }
    });
  });

  it('keeps a key under the CHECK its statement and its number continuation', async () => {
    await posts(false, async (store) => {
      const handle = store.entity('Post');
      assert.match((await handle.explainLoad({ orderBy: '$it.pid' })).sql, /ORDER BY "r"\."pid" ASC, "r"\."rid"$/);
      const { names, continuations } = await walk(handle, { orderBy: '$it.pid' }, 2);
      assert.deepEqual(names, [['p5', 'p6'], ['a7', 'p8'], ['p9', 'p10']]);
      assert.deepEqual(continuations.map((continuation) => continuation.key), [6, 8]);
      // the digits of a store-written key resume the page as its number does
      const resumed = await handle.page({ orderBy: '$it.pid' }, { limit: 2, after: { ...continuations[0], keys: ['6'], key: '6' } });
      assert.deepEqual(resumed.items.map((/** @type {any} */ post) => post.name), ['a7', 'p8']);
    });
  });
});
