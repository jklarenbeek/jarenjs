import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

const NEG_ZERO = -0;

describe('XQuery front-end fn:abs, fn:floor, fn:ceiling, fn:round, fn:round-half-to-even', () => {
  it('should map each onto the engine operator of the same name', () => {
    assert.deepStrictEqual(validated('abs($x)'), { '$abs': '$x' });
    assert.deepStrictEqual(validated('fn:floor($x)'), { '$floor': '$x' });
    assert.deepStrictEqual(validated('ceiling($x)'), { '$ceiling': '$x' });
    assert.deepStrictEqual(validated('round($x)'), { '$round': ['$x'] });
    assert.deepStrictEqual(validated('fn:round($x, -2)'), { '$round': ['$x', -2] });
    assert.deepStrictEqual(validated('round-half-to-even($x)'), { '$round-half-to-even': ['$x'] });
    assert.deepStrictEqual(validated('fn:round-half-to-even($x, 2)'), { '$round-half-to-even': ['$x', 2] });
  });

  it('should answer the F&O examples', () => {
    assert.deepStrictEqual(values('abs(10.5), abs(-10.5)'), [10.5, 10.5]);
    assert.deepStrictEqual(values('ceiling(10.5), ceiling(-10.5)'), [11, -10]);
    assert.deepStrictEqual(values('floor(10.5), floor(-10.5)'), [10, -11]);
    assert.deepStrictEqual(values('round(2.5), round(2.4999), round(-2.5)'), [3, 2, -2]);
    assert.deepStrictEqual(values('round(1.125, 2), round(8452, -2), round(3.1415e0, 2)'), [1.13, 8500, 3.14]);
    assert.deepStrictEqual(values('round-half-to-even(0.5), round-half-to-even(1.5), round-half-to-even(2.5)'), [0, 2, 2]);
    assert.deepStrictEqual(values('round-half-to-even(3.567812e+3, 2), round-half-to-even(4.7564e-3, 2)'), [3567.81, 0]);
    assert.deepStrictEqual(values('round-half-to-even(35612.25, -2)'), [35600]);
  });

  it('should keep the double rules: negative zero, NaN and the infinities', () => {
    assert.deepStrictEqual(values('round(-0.4), ceiling(-0.5), abs(-0e0)'), [NEG_ZERO, NEG_ZERO, 0]);
    assert.deepStrictEqual(values('round($x), floor($x), abs($x)', { x: NaN }), [NaN, NaN, NaN]);
    assert.deepStrictEqual(values('round($x), ceiling($x), abs($x)', { x: -Infinity }), [-Infinity, -Infinity, Infinity]);
  });

  it('should keep the empty sequence empty and refuse what is not a number', () => {
    assert.deepStrictEqual(values('abs(()), floor(()), ceiling(()), round(()), round((), 2), round-half-to-even(())'), []);
    for (const fn of ['abs', 'floor', 'ceiling', 'round', 'round-half-to-even']) {
      failsAtRun(`${fn}($x)`, { x: '1' });
      failsAtRun(`${fn}($x)`, { x: true });
      failsAtRun(`${fn}((1, 2))`);
    }
  });

  it('should refuse a precision that is not one integer', () => {
    failsAtRun('round(1.5, 0.5)');
    failsAtRun('round(1.5, ())');
    failsAtRun('round-half-to-even(1.5, "1")');
  });

  it('should refuse the arities F&O does not have', () => {
    failsWith('round()', "unsupported function 'round#0'", 0);
    failsWith('round(1, 2, 3)', "unsupported function 'round#3'", 0);
    failsWith('fn:round-half-to-even(1, 2, 3)', "unsupported function 'fn:round-half-to-even#3'", 0);
    failsWith('abs(1, 2)', "unsupported function 'abs#2'", 0);
    failsWith('floor()', "unsupported function 'floor#0'", 0);
  });
});
