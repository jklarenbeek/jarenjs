import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

const CODEPOINT = 'http://www.w3.org/2005/xpath-functions/collation/codepoint';

describe('XQuery front-end fn:remove and fn:insert-before', () => {
  it('should answer the F&O examples of fn:remove', () => {
    const abc = '("a", "b", "c")';
    assert.deepStrictEqual(values(`remove(${abc}, 0)`), ['a', 'b', 'c']);
    assert.deepStrictEqual(values(`remove(${abc}, 1)`), ['b', 'c']);
    assert.deepStrictEqual(values(`fn:remove(${abc}, 2)`), ['a', 'c']);
    assert.deepStrictEqual(values(`remove(${abc}, 3)`), ['a', 'b']);
    assert.deepStrictEqual(values(`remove(${abc}, 6)`), ['a', 'b', 'c']);
    assert.deepStrictEqual(values(`remove(${abc}, -1)`), ['a', 'b', 'c']);
    assert.deepStrictEqual(values('remove((), 3)'), []);
  });

  it('should answer the F&O examples of fn:insert-before', () => {
    const abc = '("a", "b", "c")';
    assert.deepStrictEqual(values(`insert-before(${abc}, 0, "z")`), ['z', 'a', 'b', 'c']);
    assert.deepStrictEqual(values(`insert-before(${abc}, 1, "z")`), ['z', 'a', 'b', 'c']);
    assert.deepStrictEqual(values(`fn:insert-before(${abc}, 2, "z")`), ['a', 'z', 'b', 'c']);
    assert.deepStrictEqual(values(`insert-before(${abc}, 3, "z")`), ['a', 'b', 'z', 'c']);
    assert.deepStrictEqual(values(`insert-before(${abc}, 4, "z")`), ['a', 'b', 'c', 'z']);
    assert.deepStrictEqual(values(`insert-before(${abc}, 9, ("y", "z"))`), ['a', 'b', 'c', 'y', 'z']);
    assert.deepStrictEqual(values(`insert-before(${abc}, 2, ())`), ['a', 'b', 'c']);
    assert.deepStrictEqual(values('insert-before((), 5, ("y", "z"))'), ['y', 'z']);
  });

  it('should keep array and map items whole', () => {
    assert.deepStrictEqual(values('insert-before(([1, 2], [3]), 2, [9])'), [[1, 2], [9], [3]]);
    assert.deepStrictEqual(values('remove(([1, 2], map {"a": 1}, [3]), 1)'), [{ a: 1 }, [3]]);
    // an array is one item, never its members
    assert.deepStrictEqual(values('remove($xs, 1)', { xs: [1, 2] }), []);
    assert.deepStrictEqual(values('count(insert-before($xs, 2, $xs))', { xs: [1, 2] }), [2]);
  });

  it('should take a position that is one integral number, and refuse anything else', () => {
    assert.deepStrictEqual(values('remove((1, 2, 3), 2e0)'), [1, 3]);
    assert.deepStrictEqual(values('remove((1, 2, 3), $p)', { p: -0 }), [1, 2, 3]);
    for (const p of [1.5, NaN, Infinity, -Infinity, '1', null, [1], true]) {
      failsAtRun('remove((1, 2, 3), $p)', { p });
      failsAtRun('insert-before((1, 2, 3), $p, 0)', { p });
    }
    failsAtRun('remove((1, 2, 3), ())');
    failsAtRun('insert-before((1, 2, 3), (1, 2), 0)');
  });

  it('should evaluate each operand once, outside the names it binds', () => {
    const shape = validated('remove($xs, $p)');
    assert.deepStrictEqual(Object.keys(shape), ['$let', '$return']);
    assert.deepStrictEqual(shape.$let, { rm_args: [['$xs'], ['$p']] });
    assert.deepStrictEqual(validated('insert-before($xs, $p, $ys)').$let, { ib_args: [['$xs'], ['$p'], ['$ys']] });
    assert.deepStrictEqual(values('let $rm_args := 1 return remove(($rm_args, 2), $rm_args)'), [2]);
    assert.deepStrictEqual(values('let $ib_args := 2 return insert-before((1, 3), $ib_args, $ib_args)'), [1, 2, 3]);
  });

  it('should refuse the arities F&O does not have', () => {
    failsWith('remove((1, 2))', "unsupported function 'remove#1'", 0);
    failsWith('fn:insert-before((1, 2), 1)', "unsupported function 'fn:insert-before#2'", 0);
  });
});

describe('XQuery front-end fn:compare', () => {
  it('should order by code point: -1, 0 or 1', () => {
    assert.deepStrictEqual(values('compare("abc", "abc"), compare("abc", "abd"), compare("b", "a")'), [0, -1, 1]);
    assert.deepStrictEqual(values('compare("Strasse", "Straße"), compare("", ""), compare("a", "")'), [-1, 0, 1]);
    // U+FFFD sorts before U+1F600 by code point, after it by UTF-16 unit
    assert.deepStrictEqual(values('compare($a, $b)', { a: '\uFFFD', b: '\u{1F600}' }), [-1]);
  });

  it('should answer the empty sequence when either string is empty', () => {
    assert.deepStrictEqual(values('compare("a", ()), compare((), "a"), compare((), ())'), []);
  });

  it('should refuse an operand that is neither one string nor empty', () => {
    for (const v of [1, true, null, ['a'], { a: 'b' }]) {
      failsAtRun('compare($v, "a")', { v });
      failsAtRun('compare("a", $v)', { v });
      failsAtRun('compare((), $v)', { v });
    }
    failsAtRun('compare("a", ("b", "c"))');
  });

  it('should take the codepoint collation and refuse any other', () => {
    assert.deepStrictEqual(values(`compare("a", "b", "${CODEPOINT}")`), [-1]);
    failsWith('compare("a", "b", "http://www.w3.org/2013/collation/UCA")', "unsupported construct 'collation'", 0);
    failsWith('fn:compare("a", "b", $c)', "unsupported construct 'collation'", 0);
    failsWith('compare("a")', "unsupported function 'compare#1'", 0);
  });

  it('should evaluate each operand once, outside the names it binds', () => {
    assert.deepStrictEqual(validated('compare($a, $b)').$let, { cmp_args: [['$a'], ['$b']] });
    assert.deepStrictEqual(values('let $cmp_args := "b" return compare("a", $cmp_args)'), [-1]);
  });
});
