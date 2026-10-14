import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseXQuery, compileXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

// the result sequence of `text`: the array constructor around it makes an
// empty result [] and a singleton [item]
function values(text, externals = {}) {
  return compileXQuery(`[${text}]`)(null, externals);
}

describe('XQuery front-end fn:index-of', () => {
  it('should answer 1-based positions, in order', () => {
    assert.deepStrictEqual(values('index-of((10, 20, 30, 20), 20)'), [2, 4]);
    assert.deepStrictEqual(values('index-of(("a", "b", "c"), "a")'), [1]);
    assert.deepStrictEqual(values('index-of((5, 5, 5), 5)'), [1, 2, 3]);
  });

  it('should answer the empty sequence when nothing matches or the sequence is empty', () => {
    assert.deepStrictEqual(values('index-of((1, 2, 3), 4)'), []);
    assert.deepStrictEqual(values('index-of((), 4)'), []);
  });

  it('should keep the engine equality: numbers by value, NaN matching nothing', () => {
    assert.deepStrictEqual(values('index-of((1, 2.0, 3), 2)'), [2]);
    assert.deepStrictEqual(values('index-of((xs:double("NaN"), 1), xs:double("NaN"))'), []);
  });

  it('should read its operands from the enclosing scope, whatever they are named', () => {
    assert.deepStrictEqual(values('let $io_at := 20 return index-of((10, 20), $io_at)'), [2]);
    assert.deepStrictEqual(values('let $s := (7, 8, 7) return index-of($s, 7)'), [1, 3]);
    assert.deepStrictEqual(values('index-of(index-of((9, 8, 9), 9), 3)'), [2]);
    assert.deepStrictEqual(values('for $io_at in (1, 2) return index-of((2, 1, 2), $io_at)'), [2, 1, 3]);
  });

  it('should compose with the 1-based positional inputs', () => {
    assert.deepStrictEqual(values('subsequence((10, 20, 30), index-of((10, 20, 30), 20))'), [20, 30]);
    assert.deepStrictEqual(values('count(index-of((1, 1, 2), 1))'), [2]);
  });

  it('should still refuse a search item that is not exactly one item', () => {
    assert.throws(() => values('index-of((1, 2), (1, 2))'), (e) => {
      assert.ok(e instanceof JsonQueryRuntimeError);
      assert.strictEqual(e.code, 'JQ2001');
      return true;
    });
    assert.throws(() => values('index-of((1, 2), ())'), (e) => e instanceof JsonQueryRuntimeError && e.code === 'JQ2001');
  });

  it('should refuse the arities outside the mapping', () => {
    assert.throws(() => parseXQuery('index-of((1, 2))'), XQuerySyntaxError);
    assert.throws(() => parseXQuery('index-of((1, 2), 1, "collation")'), XQuerySyntaxError);
  });
});
