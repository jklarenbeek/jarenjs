//@ts-check
/**
 * @file A conjunct that can raise, evaluated on every row the engine
 * evaluates it on. The engine runs a `$where`'s conjuncts in order and
 * stops at the first false one, so from the first conjunct that can raise
 * — one the engine decides, or one that runs as a registered function — a
 * later conjunct does not narrow the rows (an index seek on it never
 * visits a row the earlier one raises on), and a window beside a
 * registered function stays in the engine (the statement stops once the
 * window is full). A conjunct before it keeps narrowing, a seek staying a
 * seek, and so does every document with no such conjunct.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reasonId } from '@jarenjs/db';

import { onBothEngines } from './query-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    t: {
      key: '/id',
      schema: { type: 'object', properties: {
        id: { type: 'string' }, o: { type: 'integer' }, p: { type: 'integer' }, k: { type: 'string' },
        u: {}, n: {}, w: { type: ['string', 'integer'] } } },
      indexes: [{ name: 'by_o', path: '$.o' }, { name: 'by_id', path: '$.id' }, { name: 'by_k', path: '$.k' }],
    },
  },
};
// `$upper` raises on a number: on b's `u` and `w`, on a's `n`
const ROWS = [{ id: 'a', o: 1, p: 2, k: 'a', u: 'x', n: 5, w: 'x' }, { id: 'b', o: 2, p: 1, k: 'b', u: 5, n: 'x', w: 5 }];
const RAISES_ON_B = { $eq: [{ $upper: '$it.u' }, 'X'] };
const RAISES_ON_A = { $eq: [{ $upper: '$it.n' }, 'X'] };
const PREFIX_RAISES_ON_B = { '$starts-with': ['$it.w', 'x'] };
const over = (/** @type {any} */ where, extra = {}) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id', ...extra });
const both = (/** @type {any[]} */ ...conjuncts) => ({ $and: conjuncts });

/** @param {any} rows @param {any} document @param {any} [options] */
async function raisesAsTheEngine(rows, document, options = {}) {
  await assert.rejects(async () => rows.execute(document, { ...options, pushdown: false }), { code: 'JQ2001' });
  await assert.rejects(async () => rows.execute(document, options), { code: 'JQ2001' });
}

/** @param {any} rows @param {any} document @param {any} expected @param {any} [options] */
async function answersAsTheEngine(rows, document, expected, options = {}) {
  assert.deepEqual(await rows.execute(document, { ...options, pushdown: false }), expected);
  assert.deepEqual(await rows.execute(document, options), expected);
}

const seeded = async (/** @type {any} */ store) => {
  const rows = store.collection('t');
  for (const row of ROWS) await rows.insert(row);
  return rows;
};

describe('a conjunct that can raise keeps the engine order of evaluation', () => {
  it('a window ordered by an indexed key, beside a registered function, raises as the engine does', async () => {
    await onBothEngines(MODEL, async (store) => {
      const rows = await seeded(store);
      for (const window of [
        { $subsequence: [over(RAISES_ON_B, { $orderby: ['$it.o'] }), 0, 1] },
        { $subsequence: [over(RAISES_ON_B), 0, 1] },
        { $subsequence: [over(PREFIX_RAISES_ON_B, { $orderby: ['$it.o'] }), 0, 1] },
        { $subsequence: [{ ...over(RAISES_ON_B, { $orderby: ['$it.o'] }), $return: { i: '$it.id' } }, 0, 1] },
      ]) {
        await raisesAsTheEngine(rows, window);
        const plan = await rows.explain(window);
        assert.equal(plan.mode, 'set');
      }
    });
  });

  it('names the window as the cause where the function is registered', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      if (host !== 'sqlite') return;
      const rows = await seeded(store);
      const plan = await rows.explain({ $subsequence: [over(RAISES_ON_B, { $orderby: ['$it.o'] }), 0, 1] });
      assert.equal(plan.udfs.length, 1);
      assert.equal(reasonId((plan.reasons ?? plan.residual.reasons)[0].reason), 'plan.registeredFunction');
    });
  });

  it('a count, a fetch, a sum or a distinct beside a later indexed conjunct raises as the engine does', async () => {
    await onBothEngines(MODEL, async (store) => {
      const rows = await seeded(store);
      for (const where of [both(RAISES_ON_A, { $eq: ['$it.id', 'none'] }), both(RAISES_ON_A, { $eq: ['$it.k', 'b'] }),
        both(RAISES_ON_A, { $eq: ['$it.k', 'none'] }), both(RAISES_ON_B, { $eq: ['$it.k', 'a'] })]) {
        await raisesAsTheEngine(rows, { $count: over(where) });
        await raisesAsTheEngine(rows, over(where));
        await raisesAsTheEngine(rows, { $sum: { ...over(where), $return: '$it.o' } });
        await raisesAsTheEngine(rows, { $distinct: over(where) });
      }
    });
  });

  it('a conjunct the engine decides, before a later indexed one, raises as the engine does', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = await seeded(store);
      // a profile registers no function, so on SQLite too the conjunct is the engine's
      const options = host === 'sqlite' ? { profile: { maxRows: 100 } } : {};
      for (const first of [PREFIX_RAISES_ON_B, RAISES_ON_B]) {
        await raisesAsTheEngine(rows, over(both(first, { $eq: ['$it.k', 'a'] })), options);
        await raisesAsTheEngine(rows, over(both(first, { $eq: ['$it.k', 'none'] })), options);
      }
    });
  });

  it('a conjunct before the one that can raise keeps narrowing: the engine never evaluates the later one there', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = await seeded(store);
      await answersAsTheEngine(rows, { $count: over(both({ $eq: ['$it.k', 'b'] }, RAISES_ON_A)) }, 1);
      await answersAsTheEngine(rows, { $count: over(both({ $eq: ['$it.k', 'none'] }, RAISES_ON_A)) }, 0);
      await answersAsTheEngine(rows, { $count: over(both({ $eq: ['$it.p', 9] }, RAISES_ON_A)) }, 0);
      await answersAsTheEngine(rows, over(both({ $eq: ['$it.k', 'a'] }, PREFIX_RAISES_ON_B)), 'a');
      await answersAsTheEngine(rows, { $subsequence: [over(both({ $lt: ['$it.o', 2] }, RAISES_ON_B), { $orderby: ['$it.o'] }), 0, 1] }, 'a');
      if (host !== 'sqlite') return;
      const seek = await rows.explain({ $count: over(both({ $eq: ['$it.k', 'b'] }, RAISES_ON_A)) });
      assert.equal(seek.mode, 'native');
      assert.match(seek.scanNarrative, /^SEARCH t USING INDEX t_by_k \(gx_k=\?\)/);
    });
  });

  it('a conjunct the engine decides that cannot raise leaves a later one narrowing: its seek, and a profile\'s row bound', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = await seeded(store);
      for (let i = 0; i < 6; i++) await rows.insert({ id: `z${i}`, o: 10 + i, p: 0, k: `z${i}`, u: 'q', n: 'q', w: 'q' });
      // a profile registers no function: an equality of two untyped members is the engine's, alone or in a disjunction
      const options = host === 'sqlite' ? { profile: { maxRows: 1 } } : {};
      for (const total of [{ $eq: ['$it.u', '$it.n'] }, { $or: [{ $ne: ['$it.u', '$it.n'] }, { $not: { $exists: '$it.w' } }] }]) {
        const document = over(both(total, { $eq: ['$it.k', 'b'] }));
        assert.deepEqual(await rows.execute(document, options), await rows.execute(document, { pushdown: false }));
        if (host !== 'sqlite') continue;
        const plan = await rows.explain(document, options);
        assert.match(plan.scanNarrative, /^SEARCH t USING INDEX t_by_k \(gx_k=\?\)/, JSON.stringify(total));
      }
    });
  });

  it('a document with no conjunct that can raise keeps its plan: a seek stays a seek, a window a LIMIT', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = await seeded(store);
      for (const [document, expected] of /** @type {[any, any][]} */ ([
        [over(both({ $gt: ['$it.p', 0] }, { $eq: ['$it.k', 'b'] })), 'b'],
        [{ $count: over(both({ $eq: ['$it.k', 'none'] }, { $gt: ['$it.p', 0] })) }, 0],
        [{ $subsequence: [over({ $gt: ['$it.p', 0] }, { $orderby: ['$it.o'] }), 0, 1] }, 'a'],
        [{ $subsequence: [over({ '$starts-with': ['$it.k', 'a'] }, { $orderby: ['$it.o'] }), 0, 1] }, 'a'],
      ])) {
        await answersAsTheEngine(rows, document, expected);
        const plan = await rows.explain(document);
        assert.equal(plan.mode, 'native', `${host}: ${JSON.stringify(document)}`);
        if (host === 'sqlite' && !('$subsequence' in document))
          assert.match(plan.scanNarrative, /^SEARCH t USING INDEX t_by_k \(gx_k=\?\)/);
      }
    });
  });
});
