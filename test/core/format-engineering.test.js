//@ts-check
/**
 * @file Engineering notation keeps its mantissa in [1, 1000): a value that
 * rounds up to 1000 carries into the next exponent group, and the smallest
 * subnormals, which have no representable power of ten, format finitely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatNumber } from '@jarenjs/core/math';

describe('formatNumber — engineering notation', () => {
  it('carries a mantissa that rounds up to 1000', () => {
    assert.strictEqual(formatNumber(999.9996, { notation: 'eng' }), '1.000e+3');
    assert.strictEqual(formatNumber(999999.9, { notation: 'eng', precision: 1 }), '1.0e+6');
    assert.strictEqual(formatNumber(999.6, { notation: 'eng', precision: 0 }), '1e+3');
    assert.strictEqual(formatNumber(-0.00099999999, { notation: 'eng', precision: 2 }), '-1.00e-3');
  });

  it('formats the smallest subnormal finitely', () => {
    assert.strictEqual(formatNumber(5e-324, { notation: 'eng' }), '5.000e-324');
    assert.strictEqual(formatNumber(1.5e-310, { notation: 'eng', precision: 1 }), '150.0e-312');
  });

  it('keeps ordinary values', () => {
    assert.strictEqual(formatNumber(1000, { notation: 'eng' }), '1.000e+3');
    assert.strictEqual(formatNumber(123e-9, { notation: 'eng' }), '123.000e-9');
    assert.strictEqual(formatNumber(12345.678, { notation: 'eng', precision: 2 }), '12.35e+3');
    assert.strictEqual(formatNumber(0, { notation: 'eng' }), '0e+0');
    assert.strictEqual(formatNumber(1.7e308, { notation: 'eng' }), '170.000e+306');
  });
});
