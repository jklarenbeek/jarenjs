import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { rollingSeries } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

// The oracle is the implementation nobody would ship: for every output,
// walk back through the whole series and reduce whatever falls in the
// window. It is quadratic, it shares no state between outputs, and it
// is therefore the only reference a running total and a monotone deque
// can be checked against without checking themselves.
//
// Every value in the randomized corpora is a multiple of 1/4096, the
// rule order 01 established for the same reason: a partial sum of them
// is exact, so a carried total equals a fresh one bit for bit and
// equality is the check rather than a tolerance that would hide a real
// divergence.

const SCALE = 4096;
const AGGREGATES = ['sum', 'mean', 'min', 'max', 'first', 'last', 'count'];

/** The window `(at − width, at]`, reduced from scratch. */
function scanReference(samples, width, aggregate, minPeriods) {
  return samples.map((sample) => {
    const inWindow = samples.filter((s) => s.at > sample.at - width && s.at <= sample.at);
    const readings = inWindow.filter((s) => s.value !== null).map((s) => s.value);
    const count = inWindow.length;
    let value = null;
    if (count >= minPeriods && aggregate === 'count')
      value = count;
    else if (count >= minPeriods && readings.length !== 0) {
      const sum = readings.reduce((a, b) => a + b, 0);
      value = aggregate === 'sum' ? sum
        : aggregate === 'mean' ? sum / readings.length
          : aggregate === 'min' ? Math.min(...readings)
            : aggregate === 'max' ? Math.max(...readings)
              : aggregate === 'first' ? readings[0]
                : readings[readings.length - 1];
    }
    return { at: sample.at, value, count };
  });
}

/** A seeded corpus: uneven spacing, duplicates, gaps and negative instants. */
function corpus(seed, n) {
  const random = mulberry32(seed);
  const out = [];
  let at = -50_000;
  for (let i = 0; i < n; i++) {
    // one in eight repeats the previous instant, so duplicates are in
    // every corpus rather than in one special case
    if (i !== 0 && random() < 0.125) { /* keep `at` */ }
    else at += 1 + Math.floor(random() * 5000);
    const value = random() < 0.15 ? null : Math.round((random() * 200 - 100) * SCALE) / SCALE;
    out.push({ at, value });
  }
  return out;
}

const series = (pairs) => pairs.map(([at, value]) => ({ at, value }));

describe('rollingSeries — the window', () => {
  const rows = series([[0, 1], [1000, 2], [2000, 4], [3000, 8]]);

  it('should hold the current instant and drop the one a full width behind', () => {
    // (at − 2000, at] at 2000 is {1000, 2000}, not {0, 1000, 2000}
    const out = rollingSeries(rows, { width: 2000, aggregate: 'sum' });
    assert.deepStrictEqual(out, [
      { at: 0, value: 1, count: 1 },
      { at: 1000, value: 3, count: 2 },
      { at: 2000, value: 6, count: 2 },
      { at: 3000, value: 12, count: 2 },
    ]);
  });

  it('should return one row per input sample, labelled at that sample', () => {
    assert.deepStrictEqual(rollingSeries(rows, { width: 10_000 }).map((r) => r.at),
      [0, 1000, 2000, 3000]);
    assert.deepStrictEqual(rollingSeries([], { width: 10_000 }), []);
  });

  it('should take a fixed ISO 8601 duration wherever it takes milliseconds', () => {
    assert.deepStrictEqual(
      rollingSeries(rows, { width: 'PT2S', aggregate: 'sum' }),
      rollingSeries(rows, { width: 2000, aggregate: 'sum' }));
  });

  it('should sort an unsorted input before it walks it', () => {
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    assert.deepStrictEqual(rollingSeries(shuffled, { width: 2000, aggregate: 'sum' }),
      rollingSeries(rows, { width: 2000, aggregate: 'sum' }));
  });

  it('should refuse a width that is not one positive whole span', () => {
    assert.throws(() => rollingSeries(rows, { width: 0 }), /positive whole number/);
    assert.throws(() => rollingSeries(rows, { width: -1000 }), /positive whole number/);
    assert.throws(() => rollingSeries(rows, { width: 'P1MT1H' }), /mixes calendar and fixed/);
    assert.throws(() => rollingSeries(rows, {}), /positive number of milliseconds or an ISO/);
  });

  it('should refuse an aggregate or a minPeriods it does not have', () => {
    assert.throws(() => rollingSeries(rows, { width: 1000, aggregate: 'stdev' }), /aggregate is/);
    assert.throws(() => rollingSeries(rows, { width: 1000, minPeriods: 0 }), /positive whole number/);
    assert.throws(() => rollingSeries(rows, { width: 1000, minPeriods: 1.5 }), /positive whole number/);
  });
});

describe('rollingSeries — gaps and duplicates', () => {
  it('should count a measured gap as a row and leave it out of the number', () => {
    const out = rollingSeries(series([[0, 4], [1000, null], [2000, 6]]),
      { width: 10_000, aggregate: 'mean' });
    assert.deepStrictEqual(out, [
      { at: 0, value: 4, count: 1 },
      { at: 1000, value: 4, count: 2 },
      { at: 2000, value: 5, count: 3 },
    ]);
  });

  it('should report null for a window whose every row was a gap', () => {
    const out = rollingSeries(series([[0, null], [1000, null]]),
      { width: 10_000, aggregate: 'sum' });
    assert.deepStrictEqual(out.map((r) => [r.value, r.count]), [[null, 1], [null, 2]]);
  });

  it('should give every reading at one instant the same window, and so the same answer', () => {
    // a window is a span of time; all three readings are inside the one
    // ending at their shared instant, so reporting a running 1, 3, 7
    // would be answering "in which order did they arrive" instead
    const out = rollingSeries(series([[0, 1], [0, 2], [0, 4]]),
      { width: 1000, aggregate: 'sum' });
    assert.deepStrictEqual(out.map((r) => r.value), [7, 7, 7]);
    assert.deepStrictEqual(out.map((r) => r.count), [3, 3, 3]);
  });

  it('should take first and last from the window\'s own ends, in input order', () => {
    const rows = series([[0, 1], [1000, null], [1000, 2], [1000, 3], [2000, null]]);
    assert.deepStrictEqual(rollingSeries(rows, { width: 5000, aggregate: 'first' })
      .map((r) => r.value), [1, 1, 1, 1, 1]);
    assert.deepStrictEqual(rollingSeries(rows, { width: 5000, aggregate: 'last' })
      .map((r) => r.value), [1, 3, 3, 3, 3]);
    // and once the window has moved past the first reading, `first`
    // becomes the earliest one still inside it
    assert.deepStrictEqual(rollingSeries(rows, { width: 1500, aggregate: 'first' })
      .map((r) => r.value), [1, 1, 1, 1, 2]);
  });
});

describe('rollingSeries — minPeriods', () => {
  const rows = series([[0, 1], [1000, 2], [2000, 4], [3000, 8]]);

  it('should withhold a value until the window holds enough rows', () => {
    const out = rollingSeries(rows, { width: 3000, aggregate: 'sum', minPeriods: 3 });
    assert.deepStrictEqual(out.map((r) => r.value), [null, null, 7, 14]);
    // the real count is reported even where the value is withheld
    assert.deepStrictEqual(out.map((r) => r.count), [1, 2, 3, 3]);
  });

  it('should count rows rather than readings, so a window of gaps satisfies it', () => {
    // "readings were due and none carried a number" is a different fact
    // from "the window has not filled yet", and both are reported
    const out = rollingSeries(series([[0, null], [1000, null], [2000, 4]]),
      { width: 5000, aggregate: 'mean', minPeriods: 2 });
    assert.deepStrictEqual(out.map((r) => [r.value, r.count]), [[null, 1], [null, 2], [4, 3]]);
  });
});

describe('rollingSeries — against the scan reference', () => {
  for (const aggregate of AGGREGATES) {
    it(`should match a fresh scan per window for '${aggregate}'`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const rows = corpus(seed * 7919, 240);
        for (const width of [1, 2500, 12_000, 90_000, 10_000_000]) {
          for (const minPeriods of [1, 4]) {
            assert.deepStrictEqual(
              rollingSeries(rows, { width, aggregate, minPeriods }),
              scanReference(rows, width, aggregate, minPeriods),
              `seed ${seed}, width ${width}, minPeriods ${minPeriods}`);
          }
        }
      }
    });
  }

  it('should keep the deque correct when the window is wider than the series', () => {
    // a window nothing ever leaves is the case a deque that only ever
    // pops from the front would still pass, so it is checked with one
    // that everything leaves immediately beside it
    const rows = corpus(4242, 400);
    for (const width of [1, 100_000_000]) {
      for (const aggregate of ['min', 'max']) {
        assert.deepStrictEqual(rollingSeries(rows, { width, aggregate }),
          scanReference(rows, width, aggregate, 1));
      }
    }
  });
});

describe('rollingSeries — complexity', () => {
  // The claim is structural, so it is checked structurally: a counting
  // selector moves once per row if the kernel reads each row a constant
  // number of times, and moves quadratically if it re-scans a window.
  it('should read each row a constant number of times, whatever the window holds', () => {
    const rows = corpus(31337, 4000);
    const reads = [];
    for (const width of [1000, 1_000_000]) {
      let count = 0;
      rollingSeries(rows.map((r) => ({ ...r, on: r.at })), {
        width, aggregate: 'max', at: (item) => { count++; return item.on; },
      });
      reads.push(count);
    }
    // the selector runs at normalization and nowhere else, so a
    // thousand-fold wider window costs it nothing at all
    assert.strictEqual(reads[0], 4000);
    assert.strictEqual(reads[1], 4000);
  });

  it('should stay linear in the corpus when the window scales with it', () => {
    // The claim is about the WINDOW: a wider one must not make the
    // kernel read more. So COUNT the reads rather than time them.
    //
    // `canonicalSeries` hands a canonical array straight back, and
    // `typeof` is satisfied by an accessor — so a corpus whose `value`
    // is a counting getter is the kernel's own working array, and every
    // read the aggregation loop makes is visible. A ring or a deque
    // reads each row a bounded number of times whatever the window
    // holds; a scan-per-output implementation reads it once per output
    // it is still inside, which a thousand-fold wider window multiplies.
    //
    // The earlier form was a stopwatch, and the site gate runs five
    // stages at once: it measured the HOST, reading 46.6x and then 25.1x
    // on a machine where it reads ~1x idle. A counter cannot be
    // descheduled (order 02's rule, applied where a counter reaches).
    const counting = (rows) => {
      let reads = 0;
      const array = rows.map((row) => ({
        at: row.at,
        get value() { reads++; return row.value; },
      }));
      return { array, reads: () => reads };
    };
    const readsAt = (width) => {
      const rows = corpus(90210, 4000);
      const { array, reads } = counting(rows);
      rollingSeries(array, { width, aggregate: 'max' });
      return reads();
    };
    const narrow = readsAt(1);
    const widened = readsAt(500_000);
    const ratio = widened / narrow;
    assert.ok(ratio < 3,
      `widening the window multiplied the kernel's reads ${ratio.toFixed(1)}x `
      + `(${widened} reads at a 500 s window against ${narrow} at one row, over 4000 rows)`);
  });
});
