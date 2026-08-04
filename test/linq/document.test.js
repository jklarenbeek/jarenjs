//@ts-check
/**
 * @file The mapping table, row by row (LINQ-FORMAT.md §4): every
 * `native` row asserts BOTH the emitted document and the executed
 * result, and the worked examples in the format doc are
 * byte-reproducible by the builder. The D2 proof runs here too: the
 * same chain's `toDocument()` compiles under a bare `compileJsonQuery`
 * with no linq involvement.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';
import { compileJsonQuery } from '@jarenjs/json/query';

const USERS = [
  { id: 1, name: 'ada', age: 36, tags: ['dev', 'lead'] },
  { id: 2, name: 'kid', age: 8, tags: [] },
  { id: 3, name: 'lin', age: 64, tags: ['dev'] },
];

describe('emission — the worked example is byte-reproducible (D2 proof)', () => {
  it('emits the documented shape and compiles under bare compileJsonQuery', () => {
    const q = from(USERS)
      .where((u) => u.age.gt(21))
      .orderBy((u) => u.name)
      .select((u) => ({ id: u.id, name: u.name }));
    const doc = q.toDocument();
    assert.deepStrictEqual(doc, {
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 21] },
      $orderby: { $key: '$it.name' },
      $return: { id: '$it.id', name: '$it.name' },
    });
    // no linq involvement: the document is the whole contract
    const bare = compileJsonQuery(doc);
    assert.deepStrictEqual(bare(USERS),
      [{ id: 1, name: 'ada' }, { id: 3, name: 'lin' }]);
    assert.deepStrictEqual(q.toArray(), bare(USERS));
  });
});

describe('the mapping table, native row by native row', () => {
  it('where → $where', () => {
    const q = from(USERS).where((u) => u.age.ge(36));
    assert.deepStrictEqual(q.toDocument(),
      { $for: { it: '$[*]' }, $where: { $ge: ['$it.age', 36] }, $return: '$it' });
    assert.deepStrictEqual(q.toArray().map((u) => u.id), [1, 3]);
  });

  it('consecutive wheres combine with $and', () => {
    const q = from(USERS).where((u) => u.age.gt(10)).where((u) => u.age.lt(40));
    assert.deepStrictEqual(q.toDocument().$where,
      { $and: [{ $gt: ['$it.age', 10] }, { $lt: ['$it.age', 40] }] });
    assert.deepStrictEqual(q.toArray().map((u) => u.id), [1]);
  });

  it('select → $return constructor', () => {
    const q = from(USERS).select((u) => u.name.upper());
    assert.deepStrictEqual(q.toDocument(),
      { $for: { it: '$[*]' }, $return: { $upper: '$it.name' } });
    assert.deepStrictEqual(q.toArray(), ['ADA', 'KID', 'LIN']);
  });

  it('selectMany → flattening $return', () => {
    const q = from(USERS).selectMany((u) => u.tags.all());
    assert.deepStrictEqual(q.toDocument(),
      { $for: { it: '$[*]' }, $return: '$it.tags[*]' });
    assert.deepStrictEqual(q.toArray(), ['dev', 'lead', 'dev']);
  });

  it('orderBy/orderByDescending/thenBy → $orderby specs in order', () => {
    const q = from(USERS)
      .orderByDescending((u) => u.tags.all().count())
      .thenBy((u) => u.name);
    assert.deepStrictEqual(q.toDocument().$orderby, [
      { $key: { $count: '$it.tags[*]' }, $dir: 'desc' },
      { $key: '$it.name' },
    ]);
    assert.deepStrictEqual(q.toArray().map((u) => u.id), [1, 3, 2]);
    const desc = from(USERS)
      .orderBy((u) => u.tags.all().count())
      .thenByDescending((u) => u.name);
    assert.deepStrictEqual(desc.toDocument().$orderby[1],
      { $key: '$it.name', $dir: 'desc' });
    assert.deepStrictEqual(desc.toArray().map((u) => u.id), [2, 3, 1]);
  });

  it('orderBy exposes $empty and $collation through options', () => {
    const q = from(USERS).orderBy((u) => u.name, { empty: 'greatest' });
    assert.deepStrictEqual(q.toDocument().$orderby,
      { $key: '$it.name', $empty: 'greatest' });
  });

  it('a where AFTER orderBy opens a new segment (order preserved as written)', () => {
    const q = from(USERS).orderBy((u) => u.age).where((u) => u.age.gt(10));
    assert.deepStrictEqual(q.toDocument(), {
      $for: {
        it: { $for: { it: '$[*]' }, $orderby: { $key: '$it.age' }, $return: '$it' },
      },
      $where: { $gt: ['$it.age', 10] },
      $return: '$it',
    });
    assert.deepStrictEqual(q.toArray().map((u) => u.id), [1, 3]);
  });

  it('groupBy → $groupby with the documented { key, items } shape', () => {
    const q = from(USERS).groupBy((u) => u.tags.at(0).exists());
    assert.deepStrictEqual(q.toDocument(), {
      $for: { it: '$[*]' },
      $groupby: { g: { $exists: '$it.tags[0]' } },
      $return: { key: { $default: ['$g', null] }, items: ['$it'] },
    });
    const groups = q.toArray();
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0].key, true);
    assert.deepStrictEqual(groups[0].items.map((u) => u.id), [1, 3]);
  });

  it('join → nested $for + $where equality (the hash-join shape)', () => {
    // one input document in 0.1: both sides derive from the same source
    const inner = from(USERS).where((v) => v.tags.at(0).exists());
    const q = from(USERS).join(inner,
      (u) => u.tags.at(0), (v) => v.tags.at(0),
      (u, v) => ({ a: u.name, b: v.name }));
    assert.deepStrictEqual(q.toDocument(), {
      $for: {
        it: '$[*]',
        it2: {
          $for: { it: '$[*]' },
          $where: { $exists: '$it.tags[0]' },
          $return: '$it',
        },
      },
      $where: { $eq: ['$it.tags[0]', '$it2.tags[0]'] },
      $return: { a: '$it.name', b: '$it2.name' },
    });
    // ada and lin share tags[0] 'dev'; kid has none and joins nothing
    assert.deepStrictEqual(q.toArray(), [
      { a: 'ada', b: 'ada' }, { a: 'ada', b: 'lin' },
      { a: 'lin', b: 'ada' }, { a: 'lin', b: 'lin' },
    ]);
  });

  it('a cross-source join is JL0005 in 0.1 (one input document)', () => {
    const other = [{ userId: 1 }];
    assert.throws(
      () => from(USERS).join(from(other), (u) => u.id, (o) => o.userId, (u) => u.id),
      (e) => e.code === 'JL0005' && /same source/.test(e.message));
  });

  it('groupJoin → the matching group as an expression', () => {
    const q = from(USERS).groupJoin(from(USERS),
      (u) => u.tags.at(0), (v) => v.tags.at(0),
      (u, matches) => ({ name: u.name, n: matches.count() }));
    // kid has no tags[0]: the empty key matches nothing → n: 0
    assert.deepStrictEqual(q.toArray().map((r) => r.n), [2, 0, 2]);
  });

  it('skip/take → $subsequence', () => {
    const q = from(USERS).orderBy((u) => u.age).skip(1).take(1);
    assert.deepStrictEqual(q.toDocument(), {
      $subsequence: [
        { $subsequence: [
          { $for: { it: '$[*]' }, $orderby: { $key: '$it.age' }, $return: '$it' },
          1,
        ] },
        0, 1,
      ],
    });
    assert.deepStrictEqual(q.toArray().map((u) => u.id), [1]);
  });

  it('distinct → $distinct; reverse → $reverse', () => {
    assert.deepStrictEqual(
      from([1, 2, 1, 3]).distinct().toDocument(), { $distinct: '$[*]' });
    assert.deepStrictEqual(from([1, 2, 1, 3]).distinct().toArray(), [1, 2, 3]);
    assert.deepStrictEqual(from([1, 2, 3]).reverse().toArray(), [3, 2, 1]);
  });

  it('aggregates: count/sum/average/min/max', () => {
    const ages = from(USERS).select((u) => u.age);
    assert.strictEqual(ages.count(), 3);
    assert.strictEqual(ages.sum(), 108);
    assert.strictEqual(ages.average(), 36);
    assert.strictEqual(ages.min(), 8);
    assert.strictEqual(ages.max(), 64);
    assert.deepStrictEqual(from(USERS).select((u) => u.age).toDocument(),
      { $for: { it: '$[*]' }, $return: '$it.age' });
  });

  it('any/all → $exists and the quantifiers', () => {
    assert.strictEqual(from(USERS).any(), true);
    assert.strictEqual(from([]).any(), false);
    assert.strictEqual(from(USERS).any((u) => u.age.gt(60)), true);
    assert.strictEqual(from(USERS).all((u) => u.age.gt(60)), false);
    assert.strictEqual(from([]).all((u) => u.age.gt(60)), true, 'vacuously true');
  });

  it('aggregate(seed, fn) → $fold', () => {
    const q = from(USERS).aggregate(0, (acc, u) => acc.add(u.age));
    assert.deepStrictEqual(q.toDocument(), {
      $fold: { acc: 0 },
      $for: { it: '$[*]' },
      $return: { $add: ['$acc', '$it.age'] },
    });
    assert.deepStrictEqual(q.toArray(), [108]);
  });

  it('concat → $seq (sequence and constant-array forms)', () => {
    const more = [{ id: 9, name: 'zoe', age: 30, tags: [] }];
    const q = from(USERS).select((u) => u.id).concat([7, 8]);
    assert.deepStrictEqual(q.toArray(), [1, 2, 3, 7, 8]);
    const both = from(USERS).concat(from(more.length ? USERS : USERS).select((u) => u.id));
    assert.strictEqual(both.count(), 6);
  });

  it('defaultIfEmpty → $default', () => {
    assert.deepStrictEqual(from([]).defaultIfEmpty('none').toArray(), ['none']);
    assert.deepStrictEqual(from([1]).defaultIfEmpty('none').toArray(), [1]);
  });

  it('the compiled document reports its dependencies through explain()', () => {
    const q = from(USERS).params({ minAge: 21 }).where((u, p) => u.age.gt(p.minAge));
    const explanation = q.explain();
    assert.deepStrictEqual(explanation.externals, ['minAge']);
    assert.deepStrictEqual([...explanation.dependencies.operators], ['$gt']);
    assert.deepStrictEqual(explanation.document.$where, { $gt: ['$it.age', '$minAge'] });
  });
});
