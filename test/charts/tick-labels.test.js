//@ts-check
/**
 * A compact number label picks its unit after rounding. Rounding to three
 * digits inside `k` or `M` could carry into 1000 of that unit, so
 * 999,999 read `1000k` and 999,999,999 read `1000M` where the next unit
 * was due (`1M`, `1G`) — in tick labels, tooltips and gauge readings alike.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { formatTickValue } from '@jarenjs/charts';

describe('formatTickValue — the unit follows the rounding', function () {
  it('carries into the next unit instead of printing 1000 of this one', () => {
    assert.equal(formatTickValue(999.5), '1k');
    assert.equal(formatTickValue(999500), '1M');
    assert.equal(formatTickValue(999999), '1M');
    assert.equal(formatTickValue(999999999), '1G');
    assert.equal(formatTickValue(-999999), '-1M');
  });

  it('leaves values that do not round up to the unit alone', () => {
    const expected = [
      [0, '0'], [0.5, '0.5'], [999, '999'], [999.4, '999'], [1000, '1k'], [1234, '1.23k'], [999499, '999k'],
      [123456, '123k'], [1e6, '1M'], [2.5e6, '2.5M'], [1e9, '1G'], [1.5e12, '1500G'], [0.0004, '0.0004'], [-1234, '-1.23k'],
    ];
    for (const [value, label] of expected) assert.equal(formatTickValue(/** @type {number} */ (value)), label, String(value));
  });
});
