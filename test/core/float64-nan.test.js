//@ts-check
/**
 * @file `getValidFloat64` answers the default for NaN like its 16- and 32-bit
 * twins; it used to hand NaN back as a valid value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getValidFloat16, getValidFloat32, getValidFloat64 } from '@jarenjs/core/float';

describe('getValidFloat — NaN', () => {
  it('replaces NaN with the default in all three widths', () => {
    assert.strictEqual(getValidFloat16(NaN, 5), 5);
    assert.strictEqual(getValidFloat32(NaN, 5), 5);
    assert.strictEqual(getValidFloat64(NaN, 5), 5);
  });

  it('keeps a number, an infinity and a non-number as before', () => {
    assert.strictEqual(getValidFloat64(1.5, 5), 1.5);
    assert.strictEqual(getValidFloat64(Infinity, 5), Infinity);
    assert.strictEqual(getValidFloat64('1.5', 5), 5);
    assert.ok(Number.isNaN(getValidFloat64(NaN)));
  });
});
