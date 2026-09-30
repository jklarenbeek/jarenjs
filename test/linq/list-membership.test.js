//@ts-check
/**
 * @file Membership in the pen (QUERY-PEN.md §4): `x.in(values)` is `$eq`
 * against the sequence of the values — true when the member equals ANY of
 * them, where `.eq(array)` compares against the one array value — and
 * `x.in(path)` is every item of a list the path holds (a declared
 * parameter, an array member). Chained `.or()` and `.and()` extend ONE
 * argument list, so a chain of thousands of terms is one flat operator
 * the engine analyzes without recursing per term; 1,500 chained `.or()`
 * calls overflowed the JavaScript stack in analysis, and a store now
 * plans that chain to one bound list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { from, fromAsync } from '@jarenjs/linq';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/** Capture one predicate's emitted `$where`. @param {any} fn */
const emitted = (fn) => from([]).params({ ids: [] }).where(fn).toDocument().$where;
/** @param {string} code @param {RegExp} pattern */
const coded = (code, pattern) => (/** @type {any} */ error) => error.code === code && pattern.test(error.message);

const ROWS = [{ id: 1, tags: ['a', 'b'], sku: 'a' }, { id: 2, sku: 'c' }, { id: 3, tags: 'b', sku: 'b' }, { id: 4 }];

describe('in(values)', () => {
  it('emits $eq against a $seq of the values — escaped, captured and empty alike', () => {
    assert.deepEqual(emitted((/** @type {any} */ it) => it.sku.in(['a', 3, null, true])),
      { $eq: ['$it.sku', { $seq: ['a', 3, null, true] }] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.sku.in(['$x', it.alt])), { $eq: ['$it.sku', { $seq: ['$$x', '$it.alt'] }] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.sku.in([])), { $eq: ['$it.sku', { $seq: [] }] });
  });

  it('a path is every item of the list it holds: a declared parameter, an array member', () => {
    assert.deepEqual(emitted((/** @type {any} */ it, /** @type {any} */ p) => it.sku.in(p.ids)), { $eq: ['$it.sku', '$ids[*]'] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.sku.in(it.tags)), { $eq: ['$it.sku', '$it.tags[*]'] });
  });

  it('is membership, where eq(array) compares against one array value', () => {
    const ids = (/** @type {any} */ seq) => seq.select((/** @type {any} */ it) => it.id).toArray();
    assert.deepEqual(ids(from(ROWS).where((/** @type {any} */ it) => it.sku.in(['a', 'b']))), [1, 3]);
    assert.deepEqual(ids(from(ROWS).where((/** @type {any} */ it) => it.sku.eq(['a', 'b']))), []);
    assert.deepEqual(ids(from(ROWS).where((/** @type {any} */ it) => it.tags.eq(['a', 'b']))), [1]);
    // an absent member is in no list, so it is in the negation
    assert.deepEqual(ids(from(ROWS).where((/** @type {any} */ it) => it.sku.in(['a', 'b']).not())), [2, 4]);
    assert.deepEqual(ids(from(ROWS).params({ skus: ['c', 'b'] }).where((/** @type {any} */ it, /** @type {any} */ p) => it.sku.in(p.skus))), [2, 3]);
    assert.deepEqual(ids(from(ROWS).where((/** @type {any} */ it) => it.sku.in(it.tags))), [1]);
  });

  it('refuses what is not a list of scalars (JL0005), naming the spelling', () => {
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in('a')), coded('JL0005', /array of values .* x\.in\(p\.ids\)/));
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in([['a']])), coded('JL0005', /scalar values/));
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in([{ a: 1 }])), coded('JL0005', /scalar values/));
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in([new Date(0)])), coded('JL0005', /scalar values/));
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in([Number.NaN])), coded('JL0005', /NaN/));
    assert.throws(() => emitted((/** @type {any} */ it) => it.sku.in(it.n.add(1))), coded('JL0005', /PATH to one/));
  });
});

describe('chained .or() and .and() are one flat operator', () => {
  it('a chain extends one argument list; a grouped operand keeps its own', () => {
    assert.deepEqual(emitted((/** @type {any} */ it) => it.a.eq(1).or(it.b.eq(2)).or(it.c.eq(3))),
      { $or: [{ $eq: ['$it.a', 1] }, { $eq: ['$it.b', 2] }, { $eq: ['$it.c', 3] }] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.a.eq(1).and(it.b.eq(2)).and(it.c.eq(3))),
      { $and: [{ $eq: ['$it.a', 1] }, { $eq: ['$it.b', 2] }, { $eq: ['$it.c', 3] }] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.a.eq(1).or(it.b.eq(2)).and(it.c.eq(3))),
      { $and: [{ $or: [{ $eq: ['$it.a', 1] }, { $eq: ['$it.b', 2] }] }, { $eq: ['$it.c', 3] }] });
    assert.deepEqual(emitted((/** @type {any} */ it) => it.a.eq(1).or(it.b.eq(2).or(it.c.eq(3)))),
      { $or: [{ $eq: ['$it.a', 1] }, { $or: [{ $eq: ['$it.b', 2] }, { $eq: ['$it.c', 3] }] }] });
  });

  it('1,500 chained .or() calls analyze and answer — over an array and over a store', async () => {
    /** @param {any} it */
    const chain = (it) => {
      let predicate = it.sku.eq('s0');
      for (let i = 1; i < 1500; i++) predicate = predicate.or(it.sku.eq(`s${i * 2}`));
      return predicate;
    };
    const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, sku: `s${i}` }));
    const expected = Array.from({ length: 1500 }, (_, i) => `i${i * 2}`);
    assert.deepEqual(from(rows).where(chain).select((/** @type {any} */ it) => it.id).toArray(), expected);
    assert.equal(from([]).where(chain).toDocument().$where.$or.length, 1500);

    const store = await openStore({ $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, sku: { type: 'string', 'x-entity': { index: true } } } } } } },
    { driver: nodeDriver() });
    try {
      await store.transaction(async (/** @type {any} */ tx) => { for (const row of rows) await tx.entity('Item').create(row); });
      const bySync = from(store.sync?.entity('Item')).where(chain).orderBy((/** @type {any} */ it) => it.id)
        .select((/** @type {any} */ it) => it.id);
      assert.deepEqual(bySync.toArray(), [...expected].sort());
      const byAsync = fromAsync(store.entity('Item')).where(chain).orderBy((/** @type {any} */ it) => it.id)
        .select((/** @type {any} */ it) => it.id);
      assert.deepEqual(await byAsync.toArray(), [...expected].sort());
      // the store plans the chain to ONE bound list: the document it receives
      const plan = await store.explain(bySync.toDocument());
      assert.equal(plan.mode, 'native');
      assert.equal((plan.sql.match(/\?/g) ?? []).length, 1);
      // in() over the store, a literal list and a bound one
      const skus = expected.map((id) => `s${id.slice(1)}`);
      assert.deepEqual(from(store.sync?.entity('Item')).where((/** @type {any} */ it) => it.sku.in(skus))
        .orderBy((/** @type {any} */ it) => it.id).select((/** @type {any} */ it) => it.id).toArray(), [...expected].sort());
      assert.deepEqual(from(store.sync?.entity('Item')).params({ skus }).where((/** @type {any} */ it, /** @type {any} */ p) => it.sku.in(p.skus))
        .orderBy((/** @type {any} */ it) => it.id).select((/** @type {any} */ it) => it.id).toArray(), [...expected].sort());
    }
    finally { await store.close(); }
  });
});
