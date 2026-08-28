//@ts-check
/**
 * @file Expression capture (QUERY-PEN.md §3): path recording, method
 * shadowing, literal embedding rules, and the escape detection that
 * keeps a stored proxy from silently emitting nonsense.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';

/** Capture one predicate's emitted $where. @param {any} fn */
const emitted = (fn) => from([]).where(fn).toDocument().$where;

describe('path recording', () => {
  it('member access records path segments', () => {
    assert.deepStrictEqual(emitted((u) => u.a.b.exists()), { $exists: '$it.a.b' });
  });

  it('at(i) records an index; negative counts from the end', () => {
    assert.deepStrictEqual(emitted((u) => u.list.at(0).exists()), { $exists: '$it.list[0]' });
    assert.deepStrictEqual(emitted((u) => u.list.at(-1).exists()), { $exists: '$it.list[-1]' });
  });

  it('all() fans a path out', () => {
    assert.deepStrictEqual(emitted((u) => u.tags.all().count().gt(0)),
      { $gt: [{ $count: '$it.tags[*]' }, 0] });
  });

  it('get() reaches non-identifier and method-colliding members', () => {
    assert.deepStrictEqual(emitted((u) => u.get('odd key').exists()),
      { $exists: "$it['odd key']" });
    assert.deepStrictEqual(emitted((u) => u.get('eq').exists()),
      { $exists: "$it['eq']" });
  });

  it('member access after an operator goes through $get', () => {
    assert.deepStrictEqual(emitted((u) => u.a.at(0).b.exists()),
      { $exists: '$it.a[0].b' }, 'still a pure path');
    assert.deepStrictEqual(emitted((u) => u.pair.at(0).add(1).flag.exists()),
      { $exists: { $get: [{ $add: ['$it.pair[0]', 1] }, 'flag'] } },
      'a post-operator member is a dynamic lookup');
    assert.deepStrictEqual(emitted((u) => u.name.upper().length().eq(3)),
      { $eq: [{ '$string-length': { $upper: '$it.name' } }, 3] },
      'length is the operator method (it shadows the member)');
  });
});

describe('string operator methods', () => {
  it('substring and replace emit their §8.7 operators', () => {
    assert.deepStrictEqual(emitted((u) => u.name.substring(1).eq('da')),
      { $eq: [{ $substring: ['$it.name', 1] }, 'da'] });
    assert.deepStrictEqual(emitted((u) => u.name.substring(0, 2).eq('ad')),
      { $eq: [{ $substring: ['$it.name', 0, 2] }, 'ad'] });
    assert.deepStrictEqual(emitted((u) => u.name.replace('a', 'o').eq('odo')),
      { $eq: [{ $replace: ['$it.name', 'a', 'o'] }, 'odo'] });
    const named = from([{ name: 'ada' }]).where((u) => u.name.replace('a', 'o').eq('odo'));
    assert.deepStrictEqual(named.toArray(), [{ name: 'ada' }]);
  });
});

describe('literal embedding', () => {
  it('plain strings are literals; $-strings escape with $$', () => {
    assert.deepStrictEqual(emitted((u) => u.name.eq('ada')), { $eq: ['$it.name', 'ada'] });
    assert.deepStrictEqual(emitted((u) => u.name.eq('$weird')), { $eq: ['$it.name', '$$weird'] });
  });

  it('data arrays and objects embed as $const', () => {
    assert.deepStrictEqual(emitted((u) => u.tags.eq(['a', 'b'])),
      { $eq: ['$it.tags', { $const: ['a', 'b'] }] });
    assert.deepStrictEqual(emitted((u) => u.point.eq({ x: 1 })),
      { $eq: ['$it.point', { $const: { x: 1 } }] });
  });

  it('a projection object with $-keys embeds through $map', () => {
    const doc = from([]).select((u) => ({ $weird: u.n })).toDocument();
    assert.deepStrictEqual(doc.$return, { $map: [['$$weird', '$it.n']] });
  });

  it('functions cannot embed (JL0005)', () => {
    assert.throws(() => from([]).where((u) => u.n.eq(() => 1)),
      (e) => e.code === 'JL0005');
  });
});

describe('escape detection (JL0002)', () => {
  it('a stored proxy cannot be replayed into a later capture', () => {
    let stolen = null;
    const q = from([{ n: 1 }]).where((u) => {
      stolen = u.n;
      return u.n.gt(0);
    });
    q.toDocument(); // the first capture was fine
    assert.throws(() => q.where(() => stolen.gt(1)),
      (e) => e.code === 'JL0002');
  });

  it('a stored proxy cannot even extend a path later', () => {
    let stolen = null;
    from([]).where((u) => { stolen = u; return u.n.gt(0); });
    assert.throws(() => from([]).where(() => stolen.name.eq('x')),
      (e) => e.code === 'JL0002');
  });
});
