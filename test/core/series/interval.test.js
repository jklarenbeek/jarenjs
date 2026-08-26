import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  containsInstant, overlapsInterval, intersectInterval, mergeIntervals,
  subtractIntervals, gapsWithin, coverageOf,
} from '@jarenjs/core/series';

/** `[start, end)` shorthand, so a table reads as a table. */
const iv = (start, end) => ({ start, end });
const pairs = (list) => list.map((i) => [i.start, i.end]);

describe('half-open containment', () => {
  const table = [
    ['the start is in', iv(0, 10), 0, true],
    ['the middle is in', iv(0, 10), 5, true],
    ['the end is out', iv(0, 10), 10, false],
    ['before is out', iv(0, 10), -1, false],
    ['after is out', iv(0, 10), 11, false],
    ['a negative epoch is no different', iv(-10, -5), -10, true],
    ['and its end is still out', iv(-10, -5), -5, false],
  ];
  for (const [name, interval, at, expected] of table) {
    it(`should agree that ${name}`, () => {
      assert.strictEqual(containsInstant(interval, at), expected);
    });
  }

  it('should read an RFC 3339 bound wherever it reads a number', () => {
    assert.isTrue(containsInstant({ start: '2026-01-01', end: '2026-01-02' }, '2026-01-01T12:00:00Z'));
    assert.isFalse(containsInstant({ start: '2026-01-01', end: '2026-01-02' }, '2026-01-02'));
  });

  it('should refuse an interval that holds no instant', () => {
    assert.throws(() => containsInstant(iv(5, 5), 5), /at or before its start/);
    assert.throws(() => containsInstant(iv(6, 5), 5), /at or before its start/);
    assert.throws(() => containsInstant(iv(NaN, 5), 5), /names no instant/);
    assert.throws(() => containsInstant(null, 5), /is not an interval/);
    assert.throws(() => containsInstant(iv(0, 5), 'noon'), /not an RFC 3339 instant/);
  });
});

describe('overlap and intersection', () => {
  const table = [
    ['touching right', iv(0, 10), iv(10, 20), false, null],
    ['touching left', iv(10, 20), iv(0, 10), false, null],
    ['one instant of overlap', iv(0, 10), iv(9, 20), true, iv(9, 10)],
    ['identical', iv(0, 10), iv(0, 10), true, iv(0, 10)],
    ['nested', iv(0, 10), iv(3, 4), true, iv(3, 4)],
    ['nested, the other way round', iv(3, 4), iv(0, 10), true, iv(3, 4)],
    ['disjoint', iv(0, 10), iv(20, 30), false, null],
    ['sharing a start', iv(0, 10), iv(0, 3), true, iv(0, 3)],
    ['sharing an end', iv(0, 10), iv(7, 10), true, iv(7, 10)],
  ];
  for (const [name, a, b, overlaps, shared] of table) {
    it(`should read ${name}`, () => {
      assert.strictEqual(overlapsInterval(a, b), overlaps);
      assert.deepStrictEqual(intersectInterval(a, b), shared);
      // both are symmetric
      assert.strictEqual(overlapsInterval(b, a), overlaps);
      assert.deepStrictEqual(intersectInterval(b, a), shared);
    });
  }

  it('should refuse either side', () => {
    assert.throws(() => overlapsInterval(iv(0, 0), iv(0, 1)), /the left interval/);
    assert.throws(() => overlapsInterval(iv(0, 1), iv(0, 0)), /the right interval/);
    assert.throws(() => intersectInterval(iv(1, 0), iv(0, 1)), /the left interval/);
    assert.throws(() => intersectInterval(iv(0, 1), 'x'), /the right interval is not an interval/);
  });
});

describe('mergeIntervals', () => {
  it('should join touching spans by default', () => {
    assert.deepStrictEqual(pairs(mergeIntervals([iv(0, 10), iv(10, 20)])), [[0, 20]]);
  });

  it('should keep touching spans apart when asked', () => {
    assert.deepStrictEqual(pairs(mergeIntervals([iv(0, 10), iv(10, 20)], { adjacent: false })),
      [[0, 10], [10, 20]]);
  });

  it('should join overlapping spans under either setting', () => {
    for (const options of [{}, { adjacent: false }, { adjacent: true }]) {
      assert.deepStrictEqual(pairs(mergeIntervals([iv(0, 10), iv(9, 20)], options)), [[0, 20]]);
    }
  });

  it('should sort before merging, and swallow a nested span', () => {
    assert.deepStrictEqual(
      pairs(mergeIntervals([iv(30, 40), iv(0, 100), iv(5, 6), iv(200, 201)])),
      [[0, 100], [200, 201]]);
  });

  it('should collapse duplicates into one span', () => {
    assert.deepStrictEqual(pairs(mergeIntervals([iv(0, 5), iv(0, 5), iv(0, 5)])), [[0, 5]]);
  });

  it('should answer an empty list with an empty list', () => {
    assert.deepStrictEqual(mergeIntervals([]), []);
  });

  it('should work over negative epochs', () => {
    assert.deepStrictEqual(pairs(mergeIntervals([iv(-100, -50), iv(-50, -1)])), [[-100, -1]]);
  });

  it('should return records nothing else holds', () => {
    const source = [{ start: 0, end: 10, who: 'ada' }];
    const merged = mergeIntervals(source);
    assert.deepStrictEqual(merged, [{ start: 0, end: 10 }]);
    merged[0].start = 999;
    assert.strictEqual(source[0].start, 0);
  });

  it('should refuse an interval that holds no instant', () => {
    assert.throws(() => mergeIntervals([iv(0, 10), iv(5, 5)]), /row 1: an interval ends at 5/);
  });
});

describe('subtractIntervals', () => {
  const table = [
    ['a cut through the middle splits', [iv(0, 100)], [iv(40, 60)], [[0, 40], [60, 100]]],
    ['a cut at the start trims', [iv(0, 100)], [iv(0, 40)], [[40, 100]]],
    ['a cut at the end trims', [iv(0, 100)], [iv(60, 100)], [[0, 60]]],
    ['a covering cut removes', [iv(0, 100)], [iv(-10, 110)], []],
    ['an exact cut removes', [iv(0, 100)], [iv(0, 100)], []],
    ['a touching cut removes nothing', [iv(0, 100)], [iv(100, 200)], [[0, 100]]],
    ['a disjoint cut removes nothing', [iv(0, 100)], [iv(200, 300)], [[0, 100]]],
    ['two cuts make three pieces', [iv(0, 100)], [iv(20, 30), iv(60, 70)],
      [[0, 20], [30, 60], [70, 100]]],
    ['one cut spans two spans', [iv(0, 10), iv(20, 30)], [iv(5, 25)], [[0, 5], [25, 30]]],
    ['nothing to cut', [], [iv(0, 10)], []],
    ['nothing to cut with', [iv(0, 10)], [], [[0, 10]]],
    ['negative epochs are no different', [iv(-100, 0)], [iv(-60, -40)], [[-100, -60], [-40, 0]]],
  ];
  for (const [name, from, remove, expected] of table) {
    it(`should agree that ${name}`, () => {
      assert.deepStrictEqual(pairs(subtractIntervals(from, remove)), expected);
    });
  }

  it('should merge both sides first, so the answer is a set difference', () => {
    assert.deepStrictEqual(
      pairs(subtractIntervals([iv(0, 50), iv(40, 100)], [iv(60, 70), iv(65, 80)])),
      [[0, 60], [80, 100]]);
  });
});

describe('gapsWithin', () => {
  it('should report the space between the spans by default', () => {
    assert.deepStrictEqual(pairs(gapsWithin([iv(0, 10), iv(30, 40), iv(50, 60)])),
      [[10, 30], [40, 50]]);
  });

  it('should report the edges only when a window says where they are', () => {
    assert.deepStrictEqual(pairs(gapsWithin([iv(10, 20)])), []);
    assert.deepStrictEqual(pairs(gapsWithin([iv(10, 20)], iv(0, 30))), [[0, 10], [20, 30]]);
  });

  it('should clip to the window', () => {
    assert.deepStrictEqual(pairs(gapsWithin([iv(0, 10), iv(30, 40)], iv(5, 35))), [[10, 30]]);
  });

  it('should call an empty window wholly a gap', () => {
    assert.deepStrictEqual(pairs(gapsWithin([], iv(0, 10))), [[0, 10]]);
  });

  it('should have no gaps to report with no spans and no window', () => {
    assert.deepStrictEqual(gapsWithin([]), []);
  });

  it('should see no gap where two spans touch', () => {
    assert.deepStrictEqual(gapsWithin([iv(0, 10), iv(10, 20)]), []);
  });

  it('should refuse a window that holds no instant', () => {
    assert.throws(() => gapsWithin([iv(0, 1)], iv(5, 5)), /the window ends at 5/);
  });
});

describe('coverageOf', () => {
  it('should count an instant once however many spans hold it', () => {
    assert.strictEqual(coverageOf([iv(0, 10), iv(5, 20)]), 20);
    assert.strictEqual(coverageOf([iv(0, 10), iv(0, 10)]), 10);
  });

  it('should count touching spans as one continuous span', () => {
    assert.strictEqual(coverageOf([iv(0, 10), iv(10, 20)]), 20);
  });

  it('should clip to a window, both ends', () => {
    assert.strictEqual(coverageOf([iv(0, 100)], iv(20, 30)), 10);
    assert.strictEqual(coverageOf([iv(0, 100)], iv(-50, 50)), 50);
    assert.strictEqual(coverageOf([iv(0, 10), iv(90, 100)], iv(5, 95)), 10);
  });

  it('should count nothing outside the window', () => {
    assert.strictEqual(coverageOf([iv(0, 10)], iv(50, 60)), 0);
  });

  it('should count nothing at all with no spans', () => {
    assert.strictEqual(coverageOf([]), 0);
    assert.strictEqual(coverageOf([], iv(0, 10)), 0);
  });

  it('should be the numerator of a ratio the caller spells', () => {
    const day = iv(0, 24 * 3600000);
    const staffed = [iv(9 * 3600000, 17 * 3600000)];
    assert.strictEqual(coverageOf(staffed, day) / (day.end - day.start), 1 / 3);
  });
});
