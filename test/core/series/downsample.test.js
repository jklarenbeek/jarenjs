import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { downsampleSeries } from '@jarenjs/core/series';
import { mulberry32 } from '../../../scripts/lib/series-corpus.js';

// Downsampling is the one kernel here with no single right answer: two
// pictures of the same hundred thousand points can both be honest. So
// what is tested is not "which points" but the invariants that separate
// an honest picture from a flattering one — the ends are the data's
// ends, a gap is still a gap, the order is temporal, nothing is
// invented, and the same input always draws the same line.

const SCALE = 4096;

const series = (pairs) => pairs.map(([at, value]) => ({ at, value }));

/** A seeded corpus with spikes and, optionally, runs of measured gaps. */
function corpus(seed, n, gapEvery = 0) {
  const random = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const inGap = gapEvery !== 0 && Math.floor(i / gapEvery) % 4 === 3;
    // one in fifty is a spike an order of magnitude out — the feature a
    // sampler that only kept every k-th point would erase
    const spike = random() < 0.02 ? 40 : 1;
    out.push({
      at: i * 1000,
      value: inGap ? null : Math.round(spike * (random() * 20 - 10) * SCALE) / SCALE,
    });
  }
  return out;
}

/** Every invariant that holds whatever the method chose. */
function assertFaithful(result, source, target, label) {
  const { points } = result;
  assert.ok(points.length <= target, `${label}: ${points.length} points over a target of ${target}`);
  assert.strictEqual(result.renderedCount, points.length, `${label}: renderedCount`);
  assert.strictEqual(result.sourceCount, source.length, `${label}: sourceCount`);
  for (let i = 1; i < points.length; i++)
    assert.ok(points[i].at >= points[i - 1].at, `${label}: out of order at ${i}`);
  const bySource = new Set(source.map((s) => `${s.at}|${s.value}`));
  for (const point of points)
    assert.ok(bySource.has(`${point.at}|${point.value}`), `${label}: invented ${point.at}`);
  assert.strictEqual(points[0].at, source[0].at, `${label}: first point`);
  assert.strictEqual(points[points.length - 1].at, source[source.length - 1].at,
    `${label}: last point`);
}

describe('downsampleSeries — what it never does', () => {
  it('should return the series unchanged when it already fits', () => {
    const rows = corpus(1, 20);
    for (const method of ['lttb', 'minmax']) {
      const out = downsampleSeries(rows, { target: 20, method });
      assert.strictEqual(out.renderedCount, 20);
      assert.deepStrictEqual(out.points, rows);
      assert.strictEqual(downsampleSeries(rows, { target: 5000, method }).renderedCount, 20);
    }
  });

  it('should report the source and rendered counts and the method it used', () => {
    const out = downsampleSeries(corpus(2, 1000), { target: 100 });
    assert.strictEqual(out.sourceCount, 1000);
    assert.strictEqual(out.renderedCount, out.points.length);
    assert.ok(out.renderedCount <= 100);
    assert.strictEqual(out.method, 'lttb');
    assert.strictEqual(downsampleSeries(corpus(2, 1000), { target: 100, method: 'minmax' }).method,
      'minmax');
  });

  it('should draw the same line twice from the same series', () => {
    const rows = corpus(3, 3000, 250);
    for (const method of ['lttb', 'minmax']) {
      assert.deepStrictEqual(
        downsampleSeries(rows, { target: 137, method }).points,
        downsampleSeries(rows, { target: 137, method }).points);
    }
  });

  it('should hold every invariant across methods, targets and corpora', () => {
    for (let seed = 1; seed <= 4; seed++) {
      for (const gapEvery of [0, 37, 250]) {
        const rows = corpus(seed * 2654435761, 1200, gapEvery);
        for (const method of ['lttb', 'minmax']) {
          for (const target of [800, 401, 200, 47, 12]) {
            const label = `${method} ${target} seed ${seed} gaps ${gapEvery}`;
            let result;
            try {
              result = downsampleSeries(rows, { target, method });
            }
            catch (error) {
              // a target under the mandatory count is a refusal by
              // design, and the sweep reaches several of them; what is
              // not allowed is any OTHER failure
              assert.ok(error instanceof RangeError, `${label}: ${error.message}`);
              assert.ok(/cannot hold the \d+ points/.test(error.message), label);
              continue;
            }
            assertFaithful(result, rows, target, label);
          }
        }
      }
    }
  });

  it('should refuse a method or a target it does not have', () => {
    assert.throws(() => downsampleSeries([], { target: 10, method: 'every-nth' }), /method is/);
    assert.throws(() => downsampleSeries([], { target: 0 }), /positive whole number/);
    assert.throws(() => downsampleSeries([], { target: 2.5 }), /positive whole number/);
    assert.throws(() => downsampleSeries([], {}), /positive whole number/);
  });

  it('should have nothing to draw from nothing', () => {
    assert.deepStrictEqual(downsampleSeries([], { target: 10 }),
      { points: [], sourceCount: 0, renderedCount: 0, method: 'lttb' });
  });
});

describe('downsampleSeries — gaps', () => {
  // three readings, a two-reading gap, three readings
  const gapped = series([
    [0, 1], [1000, 5], [2000, 2],
    [3000, null], [4000, null],
    [5000, 9], [6000, 4], [7000, 7],
  ]);

  it('should keep the gap, both segments\' ends, and never a line across', () => {
    for (const method of ['lttb', 'minmax']) {
      const { points } = downsampleSeries(gapped, { target: 5, method });
      const nulls = points.filter((p) => p.value === null);
      assert.strictEqual(nulls.length, 1, method);
      assert.strictEqual(nulls[0].at, 3000, method);
      assert.deepStrictEqual(points.map((p) => p.at), [0, 2000, 3000, 5000, 7000], method);
    }
  });

  it('should keep one marker per run of gaps, however long the run', () => {
    const rows = series([[0, 1], [1000, 2]])
      .concat(series([[2000, null], [3000, null], [4000, null], [5000, null]]))
      .concat(series([[6000, 3], [7000, 4]]));
    const { points } = downsampleSeries(rows, { target: 5 });
    assert.deepStrictEqual(points.map((p) => p.at), [0, 1000, 2000, 6000, 7000]);
  });

  it('should keep a marker for a gap that opens or closes the series', () => {
    const rows = series([[0, null], [1000, 1], [2000, 2], [3000, 3], [4000, null]]);
    const { points } = downsampleSeries(rows, { target: 4 });
    assert.deepStrictEqual(points.map((p) => [p.at, p.value]),
      [[0, null], [1000, 1], [3000, 3], [4000, null]]);
  });

  it('should refuse a target that cannot hold the gaps and the ends', () => {
    // two segments and one gap need five points; four of them is a
    // picture that either bridges the hole or moves an end
    assert.throws(() => downsampleSeries(gapped, { target: 4 }),
      /a target of 4 cannot hold the 5 points this series requires/);
    assert.throws(() => downsampleSeries(gapped, { target: 1 }), RangeError);
    // and the message says what the five are
    assert.throws(() => downsampleSeries(gapped, { target: 4 }),
      /2 segment end\(s\) and 1 gap marker\(s\)/);
  });

  it('should sample each segment on its own budget', () => {
    // a long noisy segment must not spend the whole budget and leave a
    // short one with only its endpoints
    const rows = [];
    for (let i = 0; i < 400; i++) rows.push({ at: i * 1000, value: (i % 7) - 3 });
    rows.push({ at: 400_000, value: null });
    for (let i = 0; i < 40; i++) rows.push({ at: 401_000 + i * 1000, value: i });
    const { points } = downsampleSeries(rows, { target: 45 });
    const short = points.filter((p) => p.at >= 401_000);
    assert.ok(short.length >= 4, `the short segment kept only ${short.length} points`);
  });
});

describe('downsampleSeries — lttb', () => {
  it('should keep a spike a fixed-stride sampler would step over', () => {
    // a flat line with one tall reading between two strides
    const rows = [];
    for (let i = 0; i < 1000; i++) rows.push({ at: i * 1000, value: i === 501 ? 100 : 0 });
    const { points } = downsampleSeries(rows, { target: 50 });
    assert.ok(points.some((p) => p.value === 100), 'the spike was dropped');
  });

  it('should place the kept points in strictly increasing time', () => {
    const rows = corpus(11, 5000);
    for (const target of [3, 4, 10, 999]) {
      const { points } = downsampleSeries(rows, { target });
      for (let i = 1; i < points.length; i++)
        assert.ok(points[i].at > points[i - 1].at, `target ${target}, point ${i}`);
    }
  });

  it('should answer the two ends alone at a target of two', () => {
    const rows = corpus(12, 500);
    const { points } = downsampleSeries(rows, { target: 2 });
    assert.deepStrictEqual(points.map((p) => p.at), [0, 499_000]);
  });
});

describe('downsampleSeries — minmax', () => {
  it('should keep every bucket\'s extremes, in the order they happened', () => {
    // eight readings, one bucket: the lowest and the highest survive,
    // and the earlier of the two comes first
    const rows = series([[0, 0], [1000, 3], [2000, -9], [3000, 2],
      [4000, 8], [5000, 1], [6000, -2], [7000, 0]]);
    const { points } = downsampleSeries(rows, { target: 4, method: 'minmax' });
    assert.deepStrictEqual(points.map((p) => [p.at, p.value]),
      [[0, 0], [2000, -9], [4000, 8], [7000, 0]]);
  });

  it('should keep the envelope of every bucket it was given', () => {
    const rows = corpus(21, 2000);
    const target = 200;
    const { points } = downsampleSeries(rows, { target, method: 'minmax' });
    const kept = new Set(points.map((p) => p.value));
    const values = rows.map((r) => r.value);
    // the corpus-wide extremes are extremes of whichever bucket holds
    // them, so an envelope-preserving method cannot have dropped either
    assert.ok(kept.has(Math.min(...values)), 'the lowest reading was dropped');
    assert.ok(kept.has(Math.max(...values)), 'the highest reading was dropped');
  });

  it('should contribute one point when a bucket\'s extremes are the same point', () => {
    // a monotone segment: every bucket's min and max are its two ends,
    // never one point — so the count is the check that the dedup path
    // does not fire where it should not
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ at: i * 1000, value: i });
    const { renderedCount } = downsampleSeries(rows, { target: 20, method: 'minmax' });
    assert.strictEqual(renderedCount, 20);
    // and a flat one, where every bucket IS one point
    const flat = rows.map((r) => ({ ...r, value: 7 }));
    const out = downsampleSeries(flat, { target: 20, method: 'minmax' });
    assert.ok(out.renderedCount < 20 && out.renderedCount >= 2,
      `a flat line kept ${out.renderedCount}`);
  });
});
