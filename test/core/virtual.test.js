//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixedRange } from '@jarenjs/core/virtual';

describe('fixed virtual ranges', () => {
  it('computes a million-row window without enumerating its source', () => {
    assert.deepEqual(fixedRange({ count: 1000000, size: 44, viewport: 440, offset: 0, overscan: 12 }),
      { start: 0, end: 22, offset: 0, extent: 44000000 });
    assert.deepEqual(fixedRange({ count: 1000000, size: 44, viewport: 440, offset: 440 }),
      { start: 10, end: 20, offset: 440, extent: 44000000 });
  });
  it('handles fractional boundaries, empty, hidden and clamped viewports', () => {
    assert.equal(fixedRange({ count: 100, size: 44, viewport: 440, offset: 1 }).end, 11);
    for (const count of [0, 100]) {
      const range = fixedRange({ count, size: 44, viewport: 0, overscan: 12 });
      assert.equal(range.start, range.end);
    }
    assert.deepEqual(fixedRange({ count: 3, size: 44, viewport: 44, offset: Infinity }),
      { start: 0, end: 1, offset: 0, extent: 132 });
    assert.equal(fixedRange({ count: 3, size: 44, viewport: 44, offset: 9999 }).start, 2);
    for (const change of [{count: -1}, {count: 0.5}, {size: 0}, {overscan: -1}])
      assert.throws(() => fixedRange({ count: 3, size: 44, viewport: 44, ...change }), RangeError);
  });
});
