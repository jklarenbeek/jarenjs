//@ts-check
/**
 * @file A count over an entity window and a reversal of an entity FLWOR
 * run in the database on both engines, as `take(n).count()`, `skip(n).count()`
 * and `last()` emit them: `{ $count: { $subsequence: … } }` is `COUNT(*)`
 * over the windowed statement, and `{ $reverse: <FLWOR> }` is the FLWOR in
 * its order inverted, every row identity descending, so ties and empty
 * members come out exactly as the engine reverses them. Every answer equals
 * `pushdown: false`, and `strict: true` answers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const model = { $model: '0.1', entities: {
  Item: { schema: { type: 'object', required: ['id', 'n'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' }, g: { type: 'string' }, tag: { type: 'string' } } } },
  Tag: { schema: { type: 'object', required: ['tid'], properties: { tid: { type: 'string', 'x-entity': { key: true } }, label: { type: 'string' } } } },
} };
/** Ties in `n`, a missing `g`, and an insertion order unlike either. */
const ITEMS = [
  { id: 'i3', n: 2, g: 'b', tag: 't1' }, { id: 'i1', n: 1, tag: 't2' }, { id: 'i5', n: 2, g: 'a', tag: 't1' },
  { id: 'i2', n: 3, g: 'c' }, { id: 'i4', n: 1, g: 'a', tag: 't2' }, { id: 'i6', n: 2, tag: 't1' }];
const TAGS = [{ tid: 't1', label: 'one' }, { tid: 't2', label: 'two' }];

const flwor = (/** @type {any} */ more = {}, /** @type {any} */ ret = '$it') => ({ $for: { it: '$.Item[*]' }, $return: ret, ...more });
const window = (/** @type {any} */ inner, /** @type {number} */ start, /** @type {number} */ [length] = []) =>
  ({ $subsequence: length === undefined ? [inner, start] : [inner, start, length] });
const ids = { $return: '$it.id' };

/** Each case: its title and its document. */
const COUNTS = /** @type {[string, any][]} */ ([
  ['take(3).count()', { $count: window(flwor(), 0, [3]) }],
  ['skip(2).count()', { $count: window(flwor(), 2) }],
  ['a window past the end', { $count: window(flwor(), 10, [2]) }],
  ['a window reaching past the end', { $count: window(flwor(), 4, [10]) }],
  ['an empty window', { $count: window(flwor(), 1, [0]) }],
  ['two windows', { $count: window(window(flwor(), 1, [4]), 1, [2]) }],
  ['a filtered, ordered window', { $count: window(flwor({ $where: { $ge: ['$it.n', 2] }, $orderby: ['$it.n'] }), 1, [10]) }],
  ['a window of a member some rows lack', { $count: window(flwor({}, '$it.g'), 0, [5]) }],
  ['a window of a constructor', { $count: window(flwor({}, { n: '$it.n', id: '$it.id' }), 1, [3]) }],
  ['a window of a join', { $count: window({ $for: { it: '$.Item[*]', t: '$.Tag[*]' }, $where: { $eq: ['$it.tag', '$t.tid'] }, $return: '$t.label' }, 1, [3]) }],
]);
const REVERSALS = /** @type {[string, any][]} */ ([
  ['last()', [window({ $reverse: flwor() }, 0, [1])]],
  ['a reversal with no order', { $reverse: flwor(ids) }],
  ['a reversal of an order with ties', { $reverse: flwor({ $orderby: ['$it.n'], ...ids }) }],
  ['a reversal of a descending order with ties', { $reverse: flwor({ $orderby: [{ $key: '$it.n', $dir: 'desc' }], ...ids }) }],
  ['a reversal of an order over a member some rows lack', { $reverse: flwor({ $orderby: ['$it.g'], ...ids }) }],
  ['a reversal of two order keys', { $reverse: flwor({ $orderby: ['$it.g', { $key: '$it.n', $dir: 'desc' }], ...ids }) }],
  ['orderBy(n).last()', [window({ $reverse: flwor({ $orderby: ['$it.n'] }) }, 0, [1])]],
  ['a window of a reversal', window({ $reverse: flwor({ $where: { $ge: ['$it.n', 2] }, ...ids }) }, 1, [2])],
  ['a reversal of a projection', { $reverse: flwor({ $orderby: ['$it.n'] }, { id: '$it.id', g: '$it.g' }) }],
  ['a reversal of a join', { $reverse: { $for: { it: '$.Item[*]', t: '$.Tag[*]' }, $where: { $eq: ['$it.tag', '$t.tid'] },
    $orderby: ['$t.label'], $return: { i: '$it.id', t: '$t.tid' } } }],
  ['a count of a reversal', { $count: { $reverse: flwor() } }],
]);

for (const engine of ENGINES) {
  describe(`a count over an entity window and an entity reversal on ${engine}`, { skip: skipFor(engine) }, () => {
    /** @param {(store: any) => Promise<void>} fn */
    const seeded = (fn) => withStore(engine, model, async (store) => {
      for (const item of ITEMS) store.entity('Item').create(item);
      for (const tag of TAGS) store.entity('Tag').create(tag);
      await store.saveChanges();
      await fn(store);
    });

    it('counts a window in the database as the engine counts it', () => seeded(async (store) => {
      for (const [title, document] of COUNTS) {
        const plan = await store.explain(document);
        assert.equal(plan.mode, 'native', `${title}: ${JSON.stringify(plan.reasons)}`);
        assert.match(plan.sql, /^SELECT COUNT\(\*\) AS "value" FROM \(SELECT 1 AS "_row" FROM .* LIMIT /, title);
        const expected = await store.execute(document, { pushdown: false });
        assert.equal(typeof expected, 'number', title);
        assert.deepEqual(await store.execute(document), expected, title);
        assert.deepEqual(await store.execute(document, { strict: true }), expected, title);
      }
    }));

    it('reverses a FLWOR in the database as the engine reverses it, its ties and empty members included', () => seeded(async (store) => {
      for (const [title, document] of REVERSALS) {
        const plan = await store.explain(document);
        assert.equal(plan.mode, 'native', `${title}: ${JSON.stringify(plan.reasons)}`);
        const expected = await store.execute(document, { pushdown: false });
        assert.deepEqual(await store.execute(document), expected, title);
        assert.deepEqual(await store.execute(document, { strict: true }), expected, title);
      }
      // the inverted order is the statement's, and explain reports it
      const plan = await store.explain({ $reverse: flwor({ $orderby: ['$it.n'], ...ids }) });
      assert.match(plan.sql, / DESC NULLS LAST, "t0"\."(rid|rowid)" DESC$/);
      assert.deepEqual(plan.order.map((/** @type {any} */ term) => term.desc), [true, true]);
      assert.deepEqual(await store.execute({ $reverse: flwor({ $orderby: ['$it.n'], ...ids }) }), ['i2', 'i6', 'i5', 'i3', 'i4', 'i1']);
      assert.deepEqual(await store.execute({ $reverse: flwor(ids) }), ['i6', 'i4', 'i2', 'i5', 'i1', 'i3']);
      // a cursor reads the reversed statement one item per pull, and a windowed count as its one item
      for (const document of [{ $reverse: flwor({ $orderby: ['$it.g'], ...ids }) }, window({ $reverse: flwor(ids) }, 1, [3]),
        { $count: window(flwor(), 2, [3]) }]) {
        const items = [];
        for await (const item of store.entity('Item').cursor(document, { strict: true })) items.push(item);
        const expected = await store.execute(document, { pushdown: false });
        assert.deepEqual(items, Array.isArray(expected) ? expected : [expected], JSON.stringify(document));
      }
    }));

    it('leaves the windowed sum, a grouping\'s reversal and a reversal of a distinct to the engine, answering alike', () => seeded(async (store) => {
      for (const document of [
        { $sum: window(flwor({}, '$it.n'), 0, [3]) },
        { $reverse: flwor({ $groupby: { k: '$it.n' } }, '$k') },
        { $reverse: { $distinct: flwor({}, '$it.n') } },
      ]) {
        assert.equal((await store.explain(document)).mode, 'set', JSON.stringify(document));
        assert.deepEqual(await store.execute(document), await store.execute(document, { pushdown: false }));
      }
    }));
  });
}
