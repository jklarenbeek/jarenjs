import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  mergeIntervals, subtractIntervals, gapsWithin, coverageOf, containsInstant,
  overlapsInterval, intersectInterval, normalizeSeries, lowerBoundTime, upperBoundTime,
} from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

// The oracle is a row of instants, one boolean each, and nothing else.
// Every operation the kernel performs with binary searches and merged
// runs is also a set operation over this row, computed by looking at
// every instant - which is the whole point: two implementations that
// share no structure agreeing is evidence, and one checking itself is
// not.
//
// The universe starts BEFORE the epoch on purpose. A negative instant is
// where a `>>> 1`, a `Math.floor` or an unsigned index quietly stops
// meaning what it meant, and the corpus that never crosses zero is the
// corpus that never finds out.

const ORIGIN = -128;
const WIDTH = 256;

/** The instants covered by `intervals`, as one boolean per instant. */
function paint(intervals) {
  const covered = new Uint8Array(WIDTH);
  for (const { start, end } of intervals) {
    for (let t = Math.max(start, ORIGIN); t < Math.min(end, ORIGIN + WIDTH); t++)
      covered[t - ORIGIN] = 1;
  }
  return covered;
}

/** The maximal runs of covered instants, as `[start, end)` pairs. */
function runs(covered) {
  const out = [];
  let from = -1;
  for (let i = 0; i <= WIDTH; i++) {
    const on = i < WIDTH && covered[i] === 1;
    if (on && from < 0) from = i;
    else if (!on && from >= 0) {
      out.push([from + ORIGIN, i + ORIGIN]);
      from = -1;
    }
  }
  return out;
}

const pairs = (list) => list.map((i) => [i.start, i.end]);

/** A seeded set of intervals inside the universe, shapes deliberately mixed. */
function makeIntervals(random, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = ORIGIN + Math.floor(random() * (WIDTH - 1));
    const room = ORIGIN + WIDTH - start;
    // one in six is long enough to swallow its neighbours; the rest are
    // short, so nesting, touching and disjoint all occur
    const width = i % 6 === 0
      ? Math.max(1, Math.floor(random() * room))
      : Math.max(1, Math.floor(random() * 8));
    out.push({ start, end: Math.min(start + width, ORIGIN + WIDTH) });
  }
  return out.filter((i) => i.start < i.end);
}

describe('the interval algebra against a discrete oracle', () => {
  it('should merge, subtract, gap and cover exactly what painting the instants says', () => {
    const random = mulberry32(20260827);
    let cases = 0;
    for (let round = 0; round < 200; round++) {
      const left = makeIntervals(random, 1 + Math.floor(random() * 12));
      const right = makeIntervals(random, Math.floor(random() * 8));
      const leftPaint = paint(left);
      const rightPaint = paint(right);

      assert.deepStrictEqual(pairs(mergeIntervals(left)), runs(leftPaint),
        `round ${round}: merge`);

      const difference = new Uint8Array(WIDTH);
      for (let i = 0; i < WIDTH; i++)
        difference[i] = leftPaint[i] === 1 && rightPaint[i] === 0 ? 1 : 0;
      assert.deepStrictEqual(pairs(subtractIntervals(left, right)), runs(difference),
        `round ${round}: subtract`);

      let covered = 0;
      for (let i = 0; i < WIDTH; i++) covered += leftPaint[i];
      assert.strictEqual(coverageOf(left), covered, `round ${round}: coverage`);

      // gaps inside the hull are the holes the painting leaves between
      // the first covered instant and the last
      const merged = runs(leftPaint);
      const hull = new Uint8Array(WIDTH);
      for (let i = merged[0][0] - ORIGIN; i < merged[merged.length - 1][1] - ORIGIN; i++)
        hull[i] = leftPaint[i] === 1 ? 0 : 1;
      assert.deepStrictEqual(pairs(gapsWithin(left)), runs(hull), `round ${round}: gaps`);

      // and inside an explicit window, the holes are clipped to it
      const window = { start: ORIGIN + 10, end: ORIGIN + WIDTH - 10 };
      const inside = new Uint8Array(WIDTH);
      for (let i = window.start - ORIGIN; i < window.end - ORIGIN; i++)
        inside[i] = leftPaint[i] === 1 ? 0 : 1;
      assert.deepStrictEqual(pairs(gapsWithin(left, window)), runs(inside),
        `round ${round}: gaps in a window`);
      assert.strictEqual(coverageOf(left, window),
        runs(inside).length === 0
          ? window.end - window.start
          : (window.end - window.start) - runs(inside).reduce((n, [a, b]) => n + (b - a), 0),
        `round ${round}: clipped coverage`);
      cases++;
    }
    assert.strictEqual(cases, 200);
  });

  it('should read containment and overlap the way the painted instants do', () => {
    const random = mulberry32(1000003);
    let checks = 0;
    for (let round = 0; round < 300; round++) {
      const drawn = makeIntervals(random, 2);
      const a = drawn[0];
      const b = drawn[1] ?? drawn[0];
      const shared = [];
      for (let t = ORIGIN; t < ORIGIN + WIDTH; t++) {
        const inA = t >= a.start && t < a.end;
        const inB = t >= b.start && t < b.end;
        assert.strictEqual(containsInstant(a, t), inA);
        if (inA && inB) shared.push(t);
      }
      assert.strictEqual(overlapsInterval(a, b), shared.length > 0, `round ${round}`);
      const meet = intersectInterval(a, b);
      if (shared.length === 0) assert.strictEqual(meet, null);
      else assert.deepStrictEqual(meet,
        { start: shared[0], end: shared[shared.length - 1] + 1 }, `round ${round}`);
      checks++;
    }
    assert.strictEqual(checks, 300);
  });

  it('should cut a sorted series exactly where a full filter does', () => {
    const random = mulberry32(777);
    const rows = [];
    for (let i = 0; i < 500; i++)
      rows.push({ at: ORIGIN + Math.floor(random() * WIDTH), value: i });
    const sorted = normalizeSeries(rows);
    // the stable sort kept every duplicate instant, all of them
    assert.strictEqual(sorted.length, rows.length);
    for (let i = 1; i < sorted.length; i++)
      assert.isTrue(sorted[i - 1].at <= sorted[i].at, 'ascending');

    let queries = 0;
    for (let q = 0; q < 200; q++) {
      const start = ORIGIN + Math.floor(random() * WIDTH);
      const end = start + 1 + Math.floor(random() * 30);
      const cut = sorted.slice(lowerBoundTime(sorted, start), lowerBoundTime(sorted, end));
      const filtered = sorted.filter((s) => s.at >= start && s.at < end);
      assert.deepStrictEqual(cut, filtered, `range ${q}`);
      const at = ORIGIN + Math.floor(random() * WIDTH);
      const equal = sorted.slice(lowerBoundTime(sorted, at), upperBoundTime(sorted, at));
      assert.deepStrictEqual(equal, sorted.filter((s) => s.at === at), `instant ${q}`);
      queries++;
    }
    assert.strictEqual(queries, 200);
  });
});
