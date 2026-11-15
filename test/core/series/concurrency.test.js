//@ts-check

/**
 * `concurrencyOf` and `shortGaps` against a unit-grid oracle on seeded
 * random intervals (duplicates, touching and nested spans), their edge
 * cases and refusals, and their cost growing with the input over an
 * eightfold step.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { concurrencyOf, shortGaps, CONCURRENCY_MEMBERS, SHORT_GAPS_MEMBERS } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';
import { growthRatio } from '../../lib/growth.js';

/**
 * @param {() => number} random
 * @param {number} n
 * @param {number} span - the grid the intervals fall on
 */
function randomIntervals(random, n, span) {
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(random() * span);
    const end = start + 1 + Math.floor(random() * 12);
    out.push({ start, end });
    if (random() < 0.15)
      out.push({ start, end });
    if (random() < 0.15)
      out.push({ start: end, end: end + 1 + Math.floor(random() * 5) });
  }
  return out;
}

describe('concurrencyOf counts every interval over the window', () => {
  it('equals a unit-grid count on 1000 seeded random sets', () => {
    const random = mulberry32(0xC0C0);
    for (let n = 0; n < 1000; n++) {
      const intervals = randomIntervals(random, Math.floor(random() * 12), 60);
      const lo = Math.floor(random() * 30) - 5;
      const window = { start: lo, end: lo + 1 + Math.floor(random() * 60) };
      const atLeast = random() < 0.5 ? undefined : Math.floor(random() * 4);
      const got = concurrencyOf(intervals, window, atLeast === undefined ? {} : { atLeast });
      assert.strictEqual(got[0].start, window.start);
      assert.strictEqual(got.at(-1)?.end, window.end);
      for (let i = 0; i < got.length; i++) {
        if (i > 0) {
          assert.strictEqual(got[i].start, got[i - 1].end);
          assert.notStrictEqual(got[i].count, got[i - 1].count, 'two neighbours of one count were left apart');
        }
        for (let t = got[i].start; t < got[i].end; t++) {
          const want = intervals.filter((iv) => iv.start <= t && t < iv.end).length;
          assert.strictEqual(got[i].count, want, `set ${n} at ${t}: ${JSON.stringify({ intervals, window })}`);
        }
        if (atLeast === undefined)
          assert.ok(!('meets' in got[i]));
        else assert.strictEqual(got[i].meets, got[i].count >= atLeast);
      }
    }
  });

  it('a handover is counted once, an empty window is one zero span, and RFC 3339 bounds are read', () => {
    assert.deepStrictEqual(concurrencyOf([{ start: 0, end: 10 }, { start: 10, end: 20 }], { start: 0, end: 20 }), [{ start: 0, end: 20, count: 1 }]);
    assert.deepStrictEqual(concurrencyOf([], { start: 0, end: 5 }, { atLeast: 1 }), [{ start: 0, end: 5, count: 0, meets: false }]);
    assert.deepStrictEqual(concurrencyOf([{ start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' }],
      { start: '2026-03-02T08:00:00Z', end: '2026-03-02T09:30:00Z' }, { atLeast: 0 }), [
      { start: Date.parse('2026-03-02T08:00:00Z'), end: Date.parse('2026-03-02T09:00:00Z'), count: 0, meets: true },
      { start: Date.parse('2026-03-02T09:00:00Z'), end: Date.parse('2026-03-02T09:30:00Z'), count: 1, meets: true }]);
  });

  it('refuses what is not an interval, a window or a whole minimum', () => {
    assert.throws(() => concurrencyOf([{ start: 5, end: 5 }], { start: 0, end: 10 }), /interval 0/);
    assert.throws(() => concurrencyOf([], { start: 10, end: 0 }), /the window/);
    assert.throws(() => concurrencyOf(/** @type {any} */ ('x'), { start: 0, end: 1 }), /array/);
    assert.throws(() => concurrencyOf([], { start: 0, end: 1 }, { atLeast: 1.5 }), /atLeast/);
    assert.throws(() => concurrencyOf([], { start: 0, end: 1 }, { atLeast: -1 }), /atLeast/);
    assert.throws(() => concurrencyOf([], { start: 0, end: 1 }, /** @type {any} */ ({ atleast: 1 })), /atleast.*atLeast/s);
    assert.deepStrictEqual([...CONCURRENCY_MEMBERS], ['atLeast']);
  });
});

describe('shortGaps finds the breaks shorter than a threshold', () => {
  it('equals a unit-grid reading on 1000 seeded random sets', () => {
    const random = mulberry32(0x5A95);
    for (let n = 0; n < 1000; n++) {
      const intervals = randomIntervals(random, Math.floor(random() * 10), 80);
      const under = 1 + Math.floor(random() * 10);
      const got = shortGaps(intervals, { under });
      // the oracle: uncovered unit cells between the first start and the last end, run by run
      const covered = (/** @type {number} */ t) => intervals.some((iv) => iv.start <= t && t < iv.end);
      /** @type {{ start: number, end: number }[]} */
      const want = [];
      if (intervals.length > 0) {
        const first = Math.min(...intervals.map((iv) => iv.start));
        const last = Math.max(...intervals.map((iv) => iv.end));
        for (let t = first; t < last; t++) {
          if (covered(t))
            continue;
          let e = t;
          while (e < last && !covered(e))
            e++;
          if (e - t < under)
            want.push({ start: t, end: e });
          t = e;
        }
      }
      assert.deepStrictEqual(got, want, `set ${n}: ${JSON.stringify({ intervals, under })}`);
    }
  });

  it('touching intervals leave no gap, a gap exactly the threshold is long enough, and edges are not gaps', () => {
    assert.deepStrictEqual(shortGaps([{ start: 0, end: 10 }, { start: 10, end: 20 }], { under: 5 }), []);
    assert.deepStrictEqual(shortGaps([{ start: 0, end: 10 }, { start: 15, end: 20 }], { under: 5 }), []);
    assert.deepStrictEqual(shortGaps([{ start: 15, end: 20 }, { start: 0, end: 10 }], { under: 6 }), [{ start: 10, end: 15 }]);
    assert.deepStrictEqual(shortGaps([{ start: 0, end: 10 }], { under: 100 }), []);
    const shifts = [{ start: '2026-03-02T06:00:00Z', end: '2026-03-02T14:00:00Z' }, { start: '2026-03-02T22:00:00Z', end: '2026-03-03T06:00:00Z' }];
    assert.deepStrictEqual(shortGaps(shifts, { under: 'PT11H' }), [{ start: Date.parse('2026-03-02T14:00:00Z'), end: Date.parse('2026-03-02T22:00:00Z') }]);
  });

  it('refuses a threshold that is not a positive fixed width', () => {
    assert.throws(() => shortGaps([], { under: 0 }), /under/);
    assert.throws(() => shortGaps([], { under: 'P1M' }), /calendar duration/);
    assert.throws(() => shortGaps([], /** @type {any} */ ({})), /under/);
    assert.throws(() => shortGaps([], /** @type {any} */ ({ under: 1, within: 2 })), /within/);
    assert.deepStrictEqual([...SHORT_GAPS_MEMBERS], ['under']);
  });
});

describe('the helpers grow with their input', () => {
  /** @param {number} n */
  const corpus = (n) => randomIntervals(mulberry32(0x1234 + n), n, n * 4);

  it('concurrencyOf over 1,250 then 10,000 intervals grows near eightfold, not sixty-four', () => {
    const small = corpus(1250);
    const large = corpus(10000);
    const ratio = growthRatio((list) => concurrencyOf(list, { start: 0, end: list.length * 4 + 20 }), small, large, { limit: 23 });
    assert.ok(ratio < 23, `concurrencyOf grew ${ratio.toFixed(1)}x over an eightfold step`);
  });

  it('shortGaps over 1,250 then 10,000 intervals grows near eightfold, not sixty-four', () => {
    const ratio = growthRatio((list) => shortGaps(list, { under: 3 }), corpus(1250), corpus(10000), { limit: 23 });
    assert.ok(ratio < 23, `shortGaps grew ${ratio.toFixed(1)}x over an eightfold step`);
  });
});
