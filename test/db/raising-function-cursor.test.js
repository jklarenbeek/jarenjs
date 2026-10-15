//@ts-check
/**
 * @file A cursor over a statement whose filter holds a registered function
 * that can raise on a row. The engine evaluates the filter on every row
 * before its first item, so it raises before yielding one; the cursor reads
 * such a statement whole first (`streaming: 'buffered'`, the barrier
 * `bind.raisingFunction`) and raises where the engine does. A cursor whose
 * functions cannot raise — none, a lone-surrogate comparison, an operator
 * over a member typed exactly string — still pulls one row per item.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';

import { nodeDriver } from '@jarenjs/db/node';

import { onBothEngines } from './query-core-engines.js';
import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    c: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, o: { type: 'number' }, u: {}, s: { type: 'string' } } },
      indexes: [{ name: 'by_o', path: '$.o' }],
    },
  },
};

const RAISES = { $eq: [{ $upper: '$it.u' }, 'X'] };
const over = (/** @type {any} */ where, /** @type {any} */ more = {}) => ({ $for: { it: '$[*]' }, $where: where, ...more, $return: '$it.id' });

/** The first item a cursor yields, or the code it raises with what it had yielded. @param {any} cursor */
async function first(cursor) {
  const items = [];
  try {
    for await (const item of cursor) {
      items.push(item);
      break;
    }
  }
  catch (error) {
    return { code: /** @type {any} */ (error).code, items };
  }
  return { items };
}

describe('a cursor beside a registered function that can raise', () => {
  it('raises before its first item, as the engine does, ordered by an index or not', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = store.collection('c');
      await rows.insert({ id: 'a', o: 1, u: 'x', s: 'p' });
      await rows.insert({ id: 'b', o: 2, u: 5, s: 'q' });
      for (const document of [over(RAISES, { $orderby: ['$it.o'] }), over(RAISES)]) {
        const label = `${host}: ${JSON.stringify(document)}`;
        assert.deepEqual(await first(rows.query(document, { pushdown: false })), { code: 'JQ2001', items: [] }, label);
        assert.deepEqual(await first(rows.query(document)), { code: 'JQ2001', items: [] }, label);
        await assert.rejects(async () => rows.execute(document), { code: 'JQ2001' }, label);
        const plan = await rows.explain(document);
        assert.equal(plan.streaming, 'buffered', label);
        // PostgreSQL registers no function, so the conjunct stays in the engine there
        assert.equal(reasonId(plan.barrier.reason), host === 'sqlite' ? 'bind.raisingFunction' : 'predicate.operands', label);
        await assert.rejects(async () => {
          for await (const item of rows.query(document, { strictStreaming: true })) assert.fail(item);
        }, { code: 'JD0037' }, label);
      }
      // a selective conjunct first keeps narrowing, and the answer is the engine's
      const narrowed = over({ $and: [{ $eq: ['$it.s', 'p'] }, RAISES] }, { $orderby: ['$it.o'] });
      assert.deepEqual(await first(rows.query(narrowed, { pushdown: false })), { items: ['a'] });
      assert.deepEqual(await first(rows.query(narrowed)), { items: ['a'] }, host);
    });
  });

  it('an undeclared interval narrowed by its columns and decided by a registered function raises before its first item', async () => {
    const span = { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
    const store = await openStore({ $model: '0.1', collections: { b: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, span } },
      indexes: [{ name: 'by_start', path: '$.span.start' }, { name: 'by_end', path: '$.span.end' }] } } },
    { driver: nodeDriver() });
    try {
      const rows = store.collection('b');
      await rows.insert({ id: 'a', span: { start: 0, end: 100 } });
      // a reversed span, which the engine's $overlaps raises on
      await rows.insert({ id: 'z', span: { start: 500, end: 400 } });
      const document = { $for: { it: '$[*]' }, $where: { $overlaps: ['$it.span', { start: 50, end: 450 }] },
        $orderby: ['$it.id'], $return: '$it.id' };
      assert.deepEqual(await first(rows.query(document, { pushdown: false })), { code: 'JQ2001', items: [] });
      assert.deepEqual(await first(rows.query(document)), { code: 'JQ2001', items: [] });
      const plan = await rows.explain(document);
      assert.equal(plan.prefilters.length, 1);
      assert.equal(reasonId(plan.barrier.reason), 'bind.raisingFunction');
    }
    finally {
      await store.close();
    }
  });

  it('a function that cannot raise still streams one row per item', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await openStore(MODEL, { driver: statementCountingDriver(counters) });
    try {
      const rows = store.collection('c');
      for (const [document, udf] of /** @type {[any, boolean][]} */ ([
        [over({ $eq: ['$it.s', 'p\uD800'] }, { $orderby: ['$it.o'] }), true],
        [over({ $eq: [{ $upper: '$it.s' }, 'P'] }, { $orderby: ['$it.o'] }), true],
        [over({ $eq: ['$it.s', 'p'] }, { $orderby: ['$it.o'] }), false],
      ])) {
        const plan = await rows.explain(document);
        assert.equal(plan.streaming, 'row', JSON.stringify(document));
        assert.equal(plan.udfs.length > 0, udf, JSON.stringify(document));
      }
      // the rows one item pulls do not grow with the table, a raising function's do
      const pulled = [];
      let stored = 0;
      for (const size of [1000, 8000]) {
        await store.transaction(async (/** @type {any} */ tx) => {
          for (; stored < size; stored++) await tx.collection('c').insert({ id: `r${stored}`, o: stored, u: 'x', s: 'p' });
        });
        for (const where of [{ $eq: ['$it.s', 'p'] }, RAISES]) {
          Object.assign(counters, { iterate: 0, next: 0, return: 0, all: 0 });
          assert.equal((await first(rows.query(over(where, { $orderby: ['$it.o'] })))).items.length, 1);
          pulled.push({ size, raises: where === RAISES, ...counters });
        }
      }
      assert.deepEqual(pulled, [
        { size: 1000, raises: false, iterate: 1, next: 1, return: 1, all: 0 },
        { size: 1000, raises: true, iterate: 0, next: 0, return: 0, all: 1 },
        { size: 8000, raises: false, iterate: 1, next: 1, return: 1, all: 0 },
        { size: 8000, raises: true, iterate: 0, next: 0, return: 0, all: 1 },
      ]);
    }
    finally {
      await store.close();
    }
  });
});
