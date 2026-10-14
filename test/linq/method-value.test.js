//@ts-check
/**
 * @file A method name read without its call (`x.tags.length`, `x.name.upper`)
 * is a function, and `>`, `+`, `==`, a template literal or `String()` over it
 * used to embed `false` or the closure's source text. Converting it to a
 * primitive is a coded refusal (JL0108) naming the method and its call;
 * calling it, `typeof` and `get(name)` are as before (QUERY-PEN.md §14.9).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, LinqBuildError } from '@jarenjs/linq';

const ROWS = [
  { id: 1, name: 'ab', tags: ['a', 'b'], length: 7 },
  { id: 2, name: 'c', tags: [], length: 3 },
];

/**
 * The refusal of reading `method` as a value.
 * @param {string} method
 */
const refusal = (method) => `JL0108: .${method} is a method of a captured expression, read here `
  + `without its call, so it is a function and not the value — ==, +, a template literal, `
  + `String() and < would act on the function itself; call it as .${method}(…), or read a `
  + `document member of that name with get('${method}')`;

/** @param {string} method */
const refused = (method) => (/** @type {any} */ e) => e instanceof LinqBuildError && e.code === 'JL0108'
  && e.message === refusal(method);

describe('a method read without its call, then coerced, is refused', () => {
  /** @type {[string, string, (x: any) => unknown][]} */
  const FILTERS = [
    ['> inside and()', 'length', (x) => x.name.eq('ab').and(x.tags.length > 0)],
    ['== inside and()', 'upper', (x) => x.name.eq('ab').and(x.name.upper == 'AB')],
    ['< inside or()', 'length', (x) => x.name.eq('ab').or(x.tags.length < 1)],
    ['>= as the whole answer', 'length', (x) => x.tags.length >= 1],
  ];
  for (const [label, method, fn] of FILTERS) {
    it(`${label} answers JL0108 naming .${method}`, () => {
      assert.throws(() => from(ROWS).where(fn).toDocument(), refused(method));
    });
  }

  /** @type {[string, string, (x: any) => unknown][]} */
  const PROJECTIONS = [
    ['+ with a string', 'upper', (x) => x.name.upper + '!'],
    ['+ with a number', 'length', (x) => x.tags.length + 1],
    ['a template literal', 'upper', (x) => `${x.name.upper}`],
    ['String()', 'lower', (x) => String(x.name.lower)],
    ['Number()', 'length', (x) => Number(x.tags.length)],
    ['unary minus', 'length', (x) => -x.tags.length],
    ['a binary method read as a value', 'eq', (x) => `${x.name.eq}`],
    ['a template literal in an object member', 'concat', (x) => ({ label: `${x.name.concat}` })],
  ];
  for (const [label, method, fn] of PROJECTIONS) {
    it(`${label} answers JL0108 naming .${method}`, () => {
      assert.throws(() => from(ROWS).select(fn).toDocument(), refused(method));
    });
  }

  it('the refusal is the same in the other pens\' callbacks', () => {
    assert.throws(() => from(ROWS).select((x) => ({ a: `${x.name.upper}` })).toArray(), refused('upper'));
    assert.throws(() => from(ROWS).orderBy((x) => x.name.upper + '').toDocument(), refused('upper'));
  });
});

describe('a method read without its call is otherwise as before', () => {
  it('typeof is function, and calling it builds the expression', () => {
    from(ROWS).select((x) => {
      assert.strictEqual(typeof x.name.upper, 'function');
      assert.strictEqual(typeof x.tags.length, 'function');
      return x.name.upper();
    }).toDocument();
    assert.deepStrictEqual(
      from(ROWS).where((x) => x.name.length().gt(1)).toDocument().$where,
      { $gt: [{ '$string-length': '$it.name' }, 1] });
    assert.deepStrictEqual(from(ROWS).where((x) => x.name.length().gt(1)).select((x) => x.id).toArray(), [1]);
    assert.deepStrictEqual(from(ROWS).select((x) => x.name.upper()).toArray(), ['AB', 'C']);
  });

  it('get(name) reads a document member of that name, and the method is still the method', () => {
    assert.deepStrictEqual(from(ROWS).where((x) => x.get('length').gt(5)).select((x) => x.id).toArray(), [1]);
    assert.deepStrictEqual(from(ROWS).select((x) => x.name.concat('!')).toArray(), ['ab!', 'c!']);
  });

  it('the method is not refused for being held, passed or compared by identity', () => {
    from(ROWS).select((x) => {
      const method = x.name.upper;
      assert.strictEqual(typeof method, 'function');
      assert.notStrictEqual(method, undefined);
      assert.strictEqual(method() !== undefined, true);
      return method();
    }).toDocument();
  });
});
