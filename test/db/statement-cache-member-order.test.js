//@ts-check
/**
 * @file Member order is part of a query document's identity. `$for`
 * bindings nest left to right in key order and may be correlated, `$let`
 * binds in key order, and a `$return` object's members are the output's
 * members in that order (QUERY-FORMAT §6.2, §6.3), so two documents that
 * differ only in member order are two queries and the store's statement
 * cache keys each with its members in order.
 *
 * The invariant each case pins: on one store, executing a document never
 * changes the answer of another that differs from it only in member order.
 * The second answers exactly as on a fresh store (its own row order, its
 * own output member order, and `JQ2006` where its reversed binding reads a
 * name bound after it) through `execute`, `explain()`, a transaction view,
 * the XQuery front-end's two clause orders and a predicate pushed as a
 * registered function. PostgreSQL runs when `JAREN_PG_URL` is set (two
 * connections at most, each schema dropped afterwards); a live registration
 * and the registered-function hatch are SQLite's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deterministicFragment, registerFragment } from '@jarenjs/db';
import { parseXQuery } from '@jarenjs/json/xquery';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const KEY = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  entities: {
    Author: { schema: { type: 'object', required: ['id'],
      properties: { id: { type: 'string', ...KEY }, name: { type: 'string' } } } },
    Book: { schema: { type: 'object', required: ['id'],
      properties: { id: { type: 'string', ...KEY }, by: { type: 'string', 'x-entity': { index: true } } } } },
  },
  collections: {
    shelves: {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, n: { type: 'number' },
        books: { type: 'array', items: { type: 'object', properties: { t: { type: 'string' } } } } } },
      key: '/id',
    },
  },
};

/** @param {any} store */
async function seed(store) {
  for (const [id, name] of [['a1', 'Ann'], ['a2', 'Bob']]) await store.entity('Author').create({ id, name });
  for (const [id, by] of [['b1', 'a2'], ['b2', 'a1']]) await store.entity('Book').create({ id, by });
  await store.collection('shelves').insert({ id: 's1', n: 1, books: [{ t: 'x' }, { t: 'y' }] });
  await store.collection('shelves').insert({ id: 's2', n: 2, books: [{ t: 'z' }] });
}

/** The answer as JSON text, member order included, or the refusal's code.
 * @param {() => any} run @returns {Promise<string | undefined>} */
async function answer(run) {
  try { return JSON.stringify(await run()); }
  catch (error) { return `refused ${/** @type {any} */ (error).code}`; }
}

const JOINED = { $eq: ['$b.by', '$m.id'] };
const MB = [{ $for: { m: '$.Author[*]', b: '$.Book[*]' }, $where: JOINED, $return: { b: '$b.id', m: '$m.id' } }];
const BM = [{ $for: { b: '$.Book[*]', m: '$.Author[*]' }, $where: JOINED, $return: { b: '$b.id', m: '$m.id' } }];
// a nested phrase rebinding `it`: `w` reads the inner `it` (the member) in
// one order and the outer one (the row) in the other, and both orders
// qualify for the registered-function hatch
const SHADOW_INNER = { $let: { it: '$it.n', w: '$it' }, $return: { $eq: ['$w.n', 1] } };
const SHADOW_OUTER = { $let: { w: '$it', it: '$it.n' }, $return: { $eq: ['$w.n', 1] } };
/** @param {any} where */
const filtered = (where) => [{ $for: { it: '$[*]' }, $where: where, $return: '$it.id' }];

/** Documents differing only in member order: label, target, the two
 * documents, and what the second answers on a fresh store when it is a
 * refusal. @type {Array<[string, 'store' | 'shelves', any, any, string?]>} */
const PAIRS = [
  ['entity $for binding order', 'store', MB, BM],
  ['entity $return member order', 'store',
    [{ $for: { m: '$.Author[*]' }, $return: { id: '$m.id', name: '$m.name' } }],
    [{ $for: { m: '$.Author[*]' }, $return: { name: '$m.name', id: '$m.id' } }]],
  ['collection cross product', 'shelves',
    [{ $for: { x: '$[*]', y: '$[*]' }, $return: { x: '$x.id', y: '$y.id' } }],
    [{ $for: { y: '$[*]', x: '$[*]' }, $return: { x: '$x.id', y: '$y.id' } }]],
  ['collection correlated $for', 'shelves',
    [{ $for: { s: '$[*]', k: '$s.books[*]' }, $return: { s: '$s.id', t: '$k.t' } }],
    [{ $for: { k: '$s.books[*]', s: '$[*]' }, $return: { s: '$s.id', t: '$k.t' } }], 'refused JQ2006'],
  ['collection $let order', 'shelves',
    [{ $for: { s: '$[*]' }, $let: { n: '$s.id', m: '$n' }, $return: '$m' }],
    [{ $for: { s: '$[*]' }, $let: { m: '$n', n: '$s.id' }, $return: '$m' }], 'refused JQ2006'],
  ['a predicate whose nested $let shadows the binding', 'shelves', filtered(SHADOW_INNER), filtered(SHADOW_OUTER)],
];

/** @param {any} store @param {'store' | 'shelves'} target @param {any} document @param {any} [options] */
const execute = (store, target, document, options) => (target === 'store'
  ? store.execute(document, options)
  : store.collection('shelves').execute(document, options));

for (const engine of ENGINES) {
  describe(`one store answers each member order as a fresh store does (${engine})`, { skip: skipFor(engine) }, () => {
    /** Run two documents on one fresh, seeded store and answer both.
     * @param {(store: any, document: any) => any} run @param {any} first @param {any} second */
    const sequence = (run, first, second) => withStore(engine, MODEL, async (store) => {
      await seed(store);
      return [await answer(() => run(store, first)), await answer(() => run(store, second))];
    });

    for (const [label, target, a, b, refusal] of PAIRS) {
      it(label, async () => {
        const run = (/** @type {any} */ store, /** @type {any} */ document) => execute(store, target, document);
        const [aFresh, bAfterA] = await sequence(run, a, b);
        const [bFresh, aAfterB] = await sequence(run, b, a);
        assert.notEqual(aFresh, bFresh, 'the fixture is only meaningful while the two orders answer differently');
        if (refusal !== undefined) assert.equal(bFresh, refusal);
        assert.equal(bAfterA, bFresh, 'the second document answers as on a fresh store');
        assert.equal(aAfterB, aFresh, 'and the other way round');
      });
    }

    it('explain() shows the second document its own plan', async () => {
      const plan = (/** @type {any} */ store, /** @type {any} */ document) => store.explain(document);
      const [mbPlan, bmAfter] = await withStore(engine, MODEL, async (store) => {
        await seed(store);
        await store.execute(MB);
        return [await answer(() => plan(store, MB)), await answer(() => plan(store, BM))];
      });
      const [bmFresh] = await sequence(plan, BM, MB);
      assert.notEqual(mbPlan, bmFresh, 'the two binding orders plan differently');
      assert.equal(bmAfter, bmFresh);
    });

    it('a transaction view answers the second document as a fresh store does', async () => {
      const bmFresh = await withStore(engine, MODEL, async (store) => {
        await seed(store);
        return answer(() => store.execute(BM));
      });
      const inView = await withStore(engine, MODEL, async (store) => {
        await seed(store);
        await store.execute(MB);
        return store.transaction(async (/** @type {any} */ tx) => answer(() => tx.execute(BM)));
      });
      assert.equal(inView, bmFresh);
    });

    it('the XQuery front-end\'s two clause orders are two queries', async () => {
      const [xy, yx] = ['for $x in $xs?*, $y in $ys?* return map { "x": $x, "y": $y }',
        'for $y in $ys?*, $x in $xs?* return map { "x": $x, "y": $y }'].map((text) => parseXQuery(text));
      assert.deepEqual(Object.keys(xy.$for), ['x', 'y'], 'the front-end binds in clause order');
      assert.deepEqual(Object.keys(yx.$for), ['y', 'x']);
      // the front-end has no context item, so its sources are externals and
      // the document runs over a collection (`store.execute` wants an
      // entity array the text cannot name)
      const externals = { externals: { xs: ['1', '2'], ys: ['a', 'b'] } };
      const run = (/** @type {any} */ store, /** @type {any} */ document) => execute(store, 'shelves', document, externals);
      const [xyFresh, yxAfter] = await sequence(run, xy, yx);
      const [yxFresh, xyAfter] = await sequence(run, yx, xy);
      assert.notEqual(xyFresh, yxFresh, 'the clause orders nest differently');
      assert.equal(yxAfter, yxFresh);
      assert.equal(xyAfter, xyFresh);
    });
  });
}

describe('a rerun live registration and a pushed predicate (sqlite)', () => {
  it('a mode: \'rerun\' registration answers the second document as a fresh store does, before and after a write', async () => {
    const write = (/** @type {any} */ store) => store.entity('Book').create({ id: 'b3', by: 'a2' });
    const fresh = await withStore('sqlite', MODEL, async (store) => {
      await seed(store);
      const before = await answer(() => store.execute(BM));
      await write(store);
      return [before, await answer(() => store.execute(BM))];
    });
    const live = await withStore('sqlite', MODEL, async (store) => {
      await seed(store);
      await store.execute(MB);
      const registration = await store.live(BM, { mode: 'rerun' });
      try {
        const before = JSON.stringify(registration.result.rows);
        await write(store);
        await registration.refresh?.();
        return [before, JSON.stringify(registration.result.rows)];
      }
      finally { registration.close(); }
    }, { capture: true });
    assert.notEqual(fresh[0], await withStore('sqlite', MODEL, async (store) => { await seed(store); return answer(() => store.execute(MB)); }),
      'the fixture is only meaningful while the two orders answer differently');
    assert.deepEqual(live, fresh);
  });

  it('a predicate fragment registers one function per member order', async () => {
    const inner = deterministicFragment(SHADOW_INNER);
    const outer = deterministicFragment(SHADOW_OUTER);
    assert.ok(inner !== null && outer !== null, 'both orders qualify for the hatch');
    assert.notEqual(inner.key, outer.key, 'two member orders, two identities');
    /** @type {Map<string, string>} */
    const registered = new Map();
    /** @type {Array<[string, Function]>} */
    const installed = [];
    const connection = { registerFunction: (/** @type {string} */ name, /** @type {any} */ _options, /** @type {Function} */ fn) => {
      installed.push([name, fn]);
    } };
    const innerName = registerFragment(connection, registered, inner);
    const outerName = registerFragment(connection, registered, outer);
    assert.notEqual(innerName, outerName, 'the second order never calls the first one\'s function');
    assert.equal(installed.length, 2);
    const row = JSON.stringify({ id: 's1', n: 1 });
    assert.deepEqual(installed.map(([, fn]) => fn(row)), [0, 1], 'and each function tests its own order');
    // the store really pushes this predicate as a registered function
    const sql = await withStore('sqlite', MODEL, async (store) => (await store.collection('shelves').explain(filtered(SHADOW_OUTER))).sql);
    assert.match(String(sql), /jaren_p_/);
  });
});
