//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { referenceGrid } from '../adoption/oracles.js';
import { createVirtualAxis, virtualIndices, logicalScrollOffset } from '@jarenjs/core/virtual';
const fixture = JSON.parse(readFileSync(new URL('../adoption/fixtures/grid.json', import.meta.url), 'utf8'));

describe('sparse measured virtual axes', () => {
  it('matches the frozen fixed and measured retained virtualizer corpus', () => {
    for (const mode of ['fixed', 'measured']) {
      const profile = fixture[mode];
      for (const expected of fixture.expected[mode]) {
        const axis = createVirtualAxis(profile);
        let offset = expected.offset;
        for (const [i, size] of profile.sizes ?? []) {
          const anchor = axis.anchor(offset, (n) => `row-${n}`);
          axis.measure(i, `row-${i}`, size);
          offset = axis.restore(anchor, (key) => Number(key.slice(4))).offset;
        }
        // Compare the same effective scroll coordinate after the retained host's compensation.
        const reference = referenceGrid(profile, expected.offset);
        offset = reference.virtualizer.scrollOffset;
        reference.dispose();
        const range = axis.range({ offset, viewport: profile.viewport, overscan: profile.overscan });
        const items = Array.from({ length: range.end - range.start }, (_, n) => {
          const index = range.start + n, start = axis.position(index), size = axis.size(index);
          return { index, key: `row-${index}`, start, end: start + size, size };
        });
        assert.deepEqual(items, expected.items);
        assert.equal(axis.extent(), expected.totalSize);
        axis.dispose();
      }
    }
  });
  it('preserves a keyed anchor across measurements, eviction, reordering and removal', () => {
    const axis = createVirtualAxis({ count: 100, estimateSize: 44, maxMeasurements: 2, maxBytes: 100 });
    const anchor = axis.anchor(445, (i) => `row-${i}`, 'q');
    axis.measure(0, 'row-0', 88);
    assert.equal(axis.restore(anchor, () => 10, 'q').offset, 489);
    axis.update({ count: 101, indexOf: (key) => Number(key.slice(4)) + 1 });
    assert.equal(axis.restore(anchor, () => 11, 'q').offset, 533);
    assert.equal(axis.restore(anchor, () => -1, 'q').fallback, true);
    assert.equal(axis.restore(anchor, () => 11, 'other').offset, 0);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 100; i++) axis.measure(i, `row-${i}`, 30 + i % 3);
    assert.ok(axis.stats().measurements <= 2); assert.ok(axis.stats().bytes <= 100);
    axis.update({ estimateSize: 50 }); assert.equal(axis.stats().measurements, 0);
    axis.clear(); axis.dispose(); axis.dispose();
    assert.deepEqual(axis.stats(), { measurements: 0, bytes: 0, summaries: 0 });
    assert.equal(axis.measure(1, 'a', 44).reason, 'disposed');
  });
  it('accounts pins and refuses oversized measurements', () => {
    const axis = createVirtualAxis({ count: 10, estimateSize: 44, maxBytes: 1 });
    assert.equal(axis.measure(0, 'row-0', 50).state, 'budget-exhausted');
    assert.equal(axis.measure(100, 'x', 50).reason, 'invalid-measurement');
    assert.deepEqual(virtualIndices({ start: 2, end: 4 }, [0, 2, 0], 10, 1).indices, [0, 2, 3]);
    assert.equal(virtualIndices({ start: 2, end: 4 }, [0, 9], 10, 1).state, 'budget-exhausted');
    assert.equal(logicalScrollOffset(-100, 500, 'negative'), 100);
    assert.equal(logicalScrollOffset(100, 500, 'reverse'), 400);
    assert.equal(logicalScrollOffset(100, 500), 100);
    axis.dispose();
  });
});
