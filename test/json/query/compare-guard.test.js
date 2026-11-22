//@ts-check
/**
 * @file The package-internal `compareGuard` compile option: a comparison
 * (`$eq` … `$ge`) hands it each pair of items it reads, `$distinct`,
 * `$index-of` and a grouping key each item they equate, with the operand's
 * docPath and the call's externals, before the engine compares them; it may
 * throw to refuse the call. Without it the compiled query answers as before,
 * and with one that throws nothing it answers alike — an equality join the
 * engine would serve from buckets reads every pair instead.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery } from '@jarenjs/json/query';

/** A guard recording each call. @returns {{ guard: any, seen: any[] }} */
function recorder() {
  /** @type {any[]} */
  const seen = [];
  return { seen, guard: (/** @type {any} */ item, /** @type {any} */ other, /** @type {string} */ docPath, /** @type {any} */ externals) =>
    seen.push([item, other, docPath, externals?.tag]) };
}

const ROWS = [{ k: 1, v: 'a' }, { k: 2, v: 'b' }, { k: 2, v: 'c' }];

describe('compareGuard', () => {
  it('reads each pair a comparison reads, with its docPath and the call\'s externals', () => {
    const { guard, seen } = recorder();
    const document = { $for: { r: '$[*]' }, $where: { $eq: ['$r.k', '$k'] }, $return: '$r.v' };
    const query = compileJsonQuery(document, { compareGuard: guard });
    assert.deepStrictEqual(query(ROWS, { k: 2, tag: 't' }), ['b', 'c']);
    assert.deepStrictEqual(seen, [1, 2, 2].flatMap((k) => [[k, 2, '/$where/$eq/0', 't'], [2, k, '/$where/$eq/1', 't']]));
    assert.deepStrictEqual(compileJsonQuery(document)(ROWS, { k: 2 }), ['b', 'c']);
  });

  it('reads every pair of a sequence, and refuses where it throws', () => {
    const { guard, seen } = recorder();
    assert.strictEqual(compileJsonQuery({ $lt: ['$xs[*]', 2] }, { compareGuard: guard })({}, { xs: [5, 1] }), true);
    assert.deepStrictEqual(seen.map(([item, other]) => [item, other]), [[5, 2], [2, 5], [1, 2], [2, 1]]);
    const refusing = compileJsonQuery({ $gt: ['$a', '$b'] }, { compareGuard: (/** @type {any} */ item) => {
      if (item instanceof Date) throw new RangeError('refused');
    } });
    assert.throws(() => refusing({}, { a: new Date(0), b: 'x' }), { name: 'RangeError', message: 'refused' });
  });

  it('reads what $distinct, $index-of and a grouping key equate', () => {
    const { guard, seen } = recorder();
    assert.deepStrictEqual(compileJsonQuery({ $distinct: '$xs[*]' }, { compareGuard: guard })({}, { xs: [1, 1, 2] }), [1, 2]);
    assert.deepStrictEqual(compileJsonQuery({ '$index-of': ['$xs[*]', 2] }, { compareGuard: guard })({}, { xs: [1, 2] }), 1);
    assert.deepStrictEqual(compileJsonQuery({ $for: { r: '$[*]' }, $groupby: { k: '$r.k' }, $return: '$k' }, { compareGuard: guard })(ROWS), [1, 2]);
    assert.deepStrictEqual(seen.map(([item, other, docPath]) => [item, other, docPath]), [
      [1, undefined, '/$distinct'], [1, undefined, '/$distinct'], [2, undefined, '/$distinct'],
      [1, undefined, '/$index-of/0'], [2, undefined, '/$index-of/0'], [2, undefined, '/$index-of/1'],
      [1, undefined, '/$groupby/k'], [2, undefined, '/$groupby/k'], [2, undefined, '/$groupby/k'],
    ]);
  });

  it('reads each pair of an equality join the engine would answer from buckets', () => {
    const { guard, seen } = recorder();
    const document = { $for: { a: '$.as[*]', b: '$.bs[*]' }, $where: { $eq: ['$a.k', '$b.k'] }, $return: ['$a.k', '$b.v'] };
    const data = { as: [{ k: 1 }, { k: 2 }], bs: [{ k: 2, v: 'x' }, { k: 3, v: 'y' }] };
    assert.deepStrictEqual(compileJsonQuery(document, { compareGuard: guard })(data), [2, 'x']);
    assert.deepStrictEqual(compileJsonQuery(document)(data), [2, 'x']);
    assert.strictEqual(seen.length, 8);
  });

  it('is a function where given', () => {
    assert.throws(() => compileJsonQuery({ $eq: [1, 1] }, { compareGuard: /** @type {any} */ (1) }),
      { name: 'TypeError', message: 'options.compareGuard must be a function' });
  });
});
