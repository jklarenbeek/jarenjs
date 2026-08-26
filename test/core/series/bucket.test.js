import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { compileBuckets, resampleSeries } from '@jarenjs/core/series';

// Every record in this file is written out in full rather than computed,
// because a bucketing test that derives its own expectation from the
// same arithmetic it is checking proves only that the code is
// consistent with itself. The interesting cases are the ones a loop
// would not have thought of: an origin before the epoch, two readings in
// the same millisecond, a bucket the caller says exists and the data
// does not, and a value that is a measured gap rather than a missing
// row.

const HOUR = 3600000;
const MINUTE = 60000;

/** `{ at, value }` from a compact `[at, value]` list. */
const series = (pairs) => pairs.map(([at, value]) => ({ at, value }));

describe('compileBuckets', () => {
  describe('fixed widths', () => {
    it('should floor to the boundary at or before an instant', () => {
      const b = compileBuckets('PT15M');
      assert.strictEqual(b.floor(Date.UTC(2026, 0, 1, 9, 0)), Date.UTC(2026, 0, 1, 9, 0));
      assert.strictEqual(b.floor(Date.UTC(2026, 0, 1, 9, 7)), Date.UTC(2026, 0, 1, 9, 0));
      assert.strictEqual(b.floor(Date.UTC(2026, 0, 1, 9, 14, 59, 999)), Date.UTC(2026, 0, 1, 9, 0));
      assert.strictEqual(b.floor(Date.UTC(2026, 0, 1, 9, 15)), Date.UTC(2026, 0, 1, 9, 15));
    });

    it('should floor a negative epoch downwards, not towards zero', () => {
      // a truncating division answers -0 here and puts 1969 in 1970's
      // first bucket; every instant before the epoch would be one
      // bucket late for the rest of the kernel's life
      const b = compileBuckets(HOUR);
      assert.strictEqual(b.floor(-1), -HOUR);
      assert.strictEqual(b.floor(-HOUR), -HOUR);
      assert.strictEqual(b.floor(-HOUR - 1), -2 * HOUR);
      assert.strictEqual(b.indexOf(-1), -1);
      assert.strictEqual(b.startOf(-1), -HOUR);
    });

    it('should align to an origin, including one before the epoch', () => {
      const b = compileBuckets({ every: HOUR, origin: -5 * MINUTE });
      assert.strictEqual(b.origin, -5 * MINUTE);
      assert.strictEqual(b.floor(0), -5 * MINUTE);
      assert.strictEqual(b.floor(55 * MINUTE - 1), -5 * MINUTE);
      assert.strictEqual(b.floor(55 * MINUTE), 55 * MINUTE);
      assert.strictEqual(b.floor(-5 * MINUTE), -5 * MINUTE);
      assert.strictEqual(b.floor(-5 * MINUTE - 1), -5 * MINUTE - HOUR);
    });

    it('should read an RFC 3339 origin wherever it reads a number', () => {
      const b = compileBuckets({ every: 'PT1H', origin: '2026-01-01T00:30:00Z' });
      assert.strictEqual(b.origin, Date.UTC(2026, 0, 1, 0, 30));
      assert.strictEqual(b.floor(Date.UTC(2026, 0, 1, 1, 0)), Date.UTC(2026, 0, 1, 0, 30));
    });

    it('should default the origin to local midnight on the clock, not to UTC\'s', () => {
      assert.strictEqual(compileBuckets('P1D').origin, 0);
      // +02:00 was two hours into 1 January when UTC reached it
      assert.strictEqual(compileBuckets('P1D', { offset: 120 }).origin, -2 * HOUR);
      assert.strictEqual(compileBuckets('P1D', { offset: 120 }).floor(0), -2 * HOUR);
    });

    it('should take the width alone as well as a record', () => {
      assert.strictEqual(compileBuckets('PT1H').width, HOUR);
      assert.strictEqual(compileBuckets(HOUR).width, HOUR);
      assert.strictEqual(compileBuckets({ every: 'PT1H' }).width, HOUR);
    });

    it('should refuse a width that is not one positive whole span', () => {
      assert.throws(() => compileBuckets('PT0S'), /positive whole number/);
      assert.throws(() => compileBuckets(0), /positive whole number/);
      assert.throws(() => compileBuckets(-HOUR), /positive whole number/);
      assert.throws(() => compileBuckets('-PT1H'), /positive ISO 8601 duration/);
      assert.throws(() => compileBuckets('PT0.0005S'), /positive whole number/);
      assert.throws(() => compileBuckets('an hour'), /positive ISO 8601 duration/);
      assert.throws(() => compileBuckets(null), /a width, or a record/);
    });

    it('should refuse a width mixing calendar and fixed units', () => {
      // a ladder of "one month and one hour" has no boundary either
      // family recognizes, and picking one silently is how a report
      // grows a thirteenth month
      assert.throws(() => compileBuckets('P1MT1H'), /mixes calendar and fixed units/);
      assert.throws(() => compileBuckets('P1Y1D'), /mixes calendar and fixed units/);
    });
  });

  describe('calendar widths', () => {
    it('should walk months rather than multiply days', () => {
      const b = compileBuckets('P1M');
      assert.strictEqual(b.calendar, true);
      assert.strictEqual(b.unit, 'month');
      assert.strictEqual(b.floor(Date.UTC(2026, 1, 14)), Date.UTC(2026, 1, 1));
      assert.strictEqual(b.floor(Date.UTC(2026, 1, 28, 23, 59, 59, 999)), Date.UTC(2026, 1, 1));
      assert.strictEqual(b.floor(Date.UTC(2026, 2, 1)), Date.UTC(2026, 2, 1));
      // February is 28 days here and 29 in 2028; a multiplier cannot be right for both
      assert.strictEqual(b.floor(Date.UTC(2028, 1, 29)), Date.UTC(2028, 1, 1));
      assert.strictEqual(b.floor(Date.UTC(2028, 2, 1)), Date.UTC(2028, 2, 1));
    });

    it('should walk months backwards past the epoch', () => {
      const b = compileBuckets('P1M');
      assert.strictEqual(b.floor(Date.UTC(1969, 11, 31, 23, 59, 59, 999)), Date.UTC(1969, 11, 1));
      assert.strictEqual(b.indexOf(Date.UTC(1969, 11, 1)), -1);
      assert.strictEqual(b.startOf(-13), Date.UTC(1968, 11, 1));
    });

    it('should take a multi-month and a multi-year ladder', () => {
      const quarters = compileBuckets('P3M');
      assert.strictEqual(quarters.floor(Date.UTC(2026, 4, 17)), Date.UTC(2026, 3, 1));
      assert.strictEqual(quarters.floor(Date.UTC(2026, 2, 31)), Date.UTC(2026, 0, 1));
      const years = compileBuckets('P1Y');
      assert.strictEqual(years.amount, 12);
      assert.strictEqual(years.floor(Date.UTC(2026, 11, 31)), Date.UTC(2026, 0, 1));
      const decades = compileBuckets('P10Y');
      assert.strictEqual(decades.floor(Date.UTC(2026, 4, 1)), Date.UTC(2020, 0, 1));
    });

    it('should keep an origin\'s day of month, clamping where the month is short', () => {
      const b = compileBuckets({ every: 'P1M', origin: '2026-01-31T00:00:00Z' });
      assert.strictEqual(b.startOf(0), Date.UTC(2026, 0, 31));
      assert.strictEqual(b.startOf(1), Date.UTC(2026, 1, 28));
      assert.strictEqual(b.startOf(2), Date.UTC(2026, 2, 31));
      assert.strictEqual(b.floor(Date.UTC(2026, 1, 27)), Date.UTC(2026, 0, 31));
      assert.strictEqual(b.floor(Date.UTC(2026, 1, 28)), Date.UTC(2026, 1, 28));
    });

    it('should stay a fixed span for a day on UTC and on a fixed offset', () => {
      // there is no ambiguity to resolve without a named zone, so the
      // integer path is the correct one and the calendar path would only
      // be slower
      assert.strictEqual(compileBuckets('P1D').calendar, false);
      assert.strictEqual(compileBuckets('P1D', { offset: -300 }).calendar, false);
      assert.strictEqual(compileBuckets('P1D', { zone: 'UTC' }).calendar, false);
    });
  });
});

describe('resampleSeries — aggregates', () => {
  // one bucket of five readings, one of two, one of none, and a gap:
  // every aggregate answers the same corpus so the seven can be read
  // against each other
  const corpus = series([
    [0, 4], [1000, 1], [2000, null], [3000, 9], [4000, 2],
    [10000, 5], [11000, 5],
  ]);
  const spec = { every: 10000, origin: 0, fill: 'null' };

  const cases = [
    ['sum', [16, 10, null]],
    ['mean', [4, 5, null]],
    ['min', [1, 5, null]],
    ['max', [9, 5, null]],
    ['first', [4, 5, null]],
    ['last', [2, 5, null]],
    ['count', [5, 2, 0]],
  ];

  for (const [aggregate, values] of cases) {
    it(`should reduce a bucket with '${aggregate}'`, () => {
      const out = resampleSeries(corpus, { ...spec, aggregate, end: 30000 });
      assert.deepStrictEqual(out.slice(0, 3).map((row) => row.value), values);
    });
  }

  it('should count every source row, gaps and duplicates included', () => {
    const out = resampleSeries(corpus, { ...spec, aggregate: 'mean' });
    assert.deepStrictEqual(out, [
      { at: 0, count: 5, value: 4 },
      { at: 10000, count: 2, value: 5 },
    ]);
  });

  it('should report null, not zero, for a bucket whose every reading was a gap', () => {
    // "nobody reported" and "everybody reported nothing to report" are
    // different facts, and `count` is what tells them apart
    const out = resampleSeries(series([[0, null], [1000, null], [10000, 3]]),
      { every: 10000, origin: 0, aggregate: 'sum' });
    assert.deepStrictEqual(out, [
      { at: 0, count: 2, value: null },
      { at: 10000, count: 1, value: 3 },
    ]);
  });

  it('should take first and last in stable input order at a duplicate instant', () => {
    const rows = [{ at: 0, value: 1 }, { at: 0, value: 2 }, { at: 0, value: 3 }];
    assert.strictEqual(resampleSeries(rows, { every: 1000, origin: 0, aggregate: 'first' })[0].value, 1);
    assert.strictEqual(resampleSeries(rows, { every: 1000, origin: 0, aggregate: 'last' })[0].value, 3);
    assert.strictEqual(resampleSeries(rows, { every: 1000, origin: 0, aggregate: 'count' })[0].value, 3);
    // and the unsorted spelling of the same three rows keeps that order
    const shuffled = [{ at: 5, value: 9 }, { at: 0, value: 1 }, { at: 0, value: 2 }, { at: 0, value: 3 }];
    assert.strictEqual(
      resampleSeries(shuffled, { every: 1000, origin: 0, aggregate: 'first' })[0].value, 1);
  });

  it('should refuse an aggregate or fill it does not have', () => {
    assert.throws(() => resampleSeries([], { every: 1000, aggregate: 'median' }), /aggregate is/);
    assert.throws(() => resampleSeries([], { every: 1000, fill: 'previous' }), /fill is/);
  });
});

describe('resampleSeries — the window', () => {
  const corpus = series([[1500, 1], [2500, 3], [7500, 5]]);

  it('should derive its window from the data when it was given none', () => {
    const out = resampleSeries(corpus, { every: 1000, origin: 0, fill: 'null' });
    assert.deepStrictEqual(out.map((row) => row.at), [1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  });

  it('should emit the empty edge buckets an explicit window asks for', () => {
    const out = resampleSeries(corpus, { every: 1000, origin: 0, start: 0, end: 10000, fill: 'null' });
    assert.strictEqual(out.length, 10);
    assert.deepStrictEqual(out[0], { at: 0, value: null, count: 0 });
    assert.deepStrictEqual(out[9], { at: 9000, value: null, count: 0 });
  });

  it('should keep the window half-open at both ends', () => {
    const out = resampleSeries(series([[0, 1], [1000, 2], [2000, 3]]),
      { every: 1000, origin: 0, start: 1000, end: 2000, aggregate: 'sum' });
    assert.deepStrictEqual(out, [{ at: 1000, value: 2, count: 1 }]);
  });

  it('should enumerate empty buckets over a window with no data at all', () => {
    const out = resampleSeries([], { every: 1000, origin: 0, start: 0, end: 3000, fill: 'zero' });
    assert.deepStrictEqual(out, [
      { at: 0, value: 0, count: 0 },
      { at: 1000, value: 0, count: 0 },
      { at: 2000, value: 0, count: 0 },
    ]);
  });

  it('should have nothing to enumerate with neither data nor both bounds', () => {
    assert.deepStrictEqual(resampleSeries([], { every: 1000 }), []);
    assert.deepStrictEqual(resampleSeries([], { every: 1000, start: 0 }), []);
    assert.deepStrictEqual(resampleSeries([], { every: 1000, end: 1000 }), []);
  });

  it('should start the first bucket at the boundary holding the window start', () => {
    const out = resampleSeries(corpus, { every: 1000, origin: 0, start: 1500, end: 3000, fill: 'null' });
    assert.deepStrictEqual(out.map((row) => row.at), [1000, 2000]);
  });

  it('should refuse a reversed or empty window', () => {
    assert.throws(() => resampleSeries(corpus, { every: 1000, start: 5000, end: 1000 }), /at or before/);
    assert.throws(() => resampleSeries(corpus, { every: 1000, start: 1000, end: 1000 }), /at or before/);
  });
});

describe('resampleSeries — fill policies', () => {
  // 10, a hole of three buckets, 50 — one shape, five answers
  const corpus = series([[0, 10], [4000, 50]]);
  const spec = { every: 1000, origin: 0, aggregate: 'mean' };

  it('should omit an empty bucket by default', () => {
    assert.deepStrictEqual(resampleSeries(corpus, spec).map((r) => r.at), [0, 4000]);
  });

  it('should emit null, zero, the last value or the line between', () => {
    const values = (fill) => resampleSeries(corpus, { ...spec, fill }).map((r) => r.value);
    assert.deepStrictEqual(values('null'), [10, null, null, null, 50]);
    assert.deepStrictEqual(values('zero'), [10, 0, 0, 0, 50]);
    assert.deepStrictEqual(values('locf'), [10, 10, 10, 10, 50]);
    assert.deepStrictEqual(values('linear'), [10, 20, 30, 40, 50]);
  });

  it('should keep the source count at zero for every filled bucket', () => {
    // the value is the caller's policy; the count is the measurement,
    // and the measurement is that nothing was measured
    const out = resampleSeries(corpus, { ...spec, fill: 'locf' });
    assert.deepStrictEqual(out.map((r) => r.count), [1, 0, 0, 0, 1]);
  });

  it('should never extrapolate at the leading edge', () => {
    const out = resampleSeries(corpus, { ...spec, fill: 'locf', start: -3000, end: 5000 });
    assert.deepStrictEqual(out.map((r) => r.value), [null, null, null, 10, 10, 10, 10, 50]);
  });

  it('should leave a trailing gap null under linear and carry it under locf', () => {
    // locf carries a value it observed; linear needs a value on both
    // sides and has none, so it says so
    const spread = { ...spec, start: 0, end: 7000 };
    assert.deepStrictEqual(
      resampleSeries(corpus, { ...spread, fill: 'linear' }).map((r) => r.value),
      [10, 20, 30, 40, 50, null, null]);
    assert.deepStrictEqual(
      resampleSeries(corpus, { ...spread, fill: 'locf' }).map((r) => r.value),
      [10, 10, 10, 10, 50, 50, 50]);
  });

  it('should not use a measured gap as an anchor to interpolate from', () => {
    // the middle bucket HELD a reading and the reading was "no value";
    // treating that as an endpoint would draw a line through the one
    // instant the sensor said it had nothing
    const out = resampleSeries(series([[0, 10], [2000, null], [4000, 50]]),
      { ...spec, fill: 'linear' });
    assert.deepStrictEqual(out, [
      { at: 0, value: 10, count: 1 },
      { at: 1000, value: 20, count: 0 },
      { at: 2000, value: null, count: 1 },
      { at: 3000, value: 40, count: 0 },
      { at: 4000, value: 50, count: 1 },
    ]);
  });

  it('should make an empty count bucket zero under every fill that emits it', () => {
    for (const fill of ['null', 'zero', 'locf', 'linear']) {
      const out = resampleSeries(corpus, { every: 1000, origin: 0, aggregate: 'count', fill });
      assert.deepStrictEqual(out.map((r) => r.value), [1, 0, 0, 0, 1], fill);
    }
  });
});

describe('resampleSeries — the source rows', () => {
  it('should read an instant and a reading wherever the caller keeps them', () => {
    const rows = [
      { on: '2026-01-01T00:00:30Z', reading: 2 },
      { on: '2026-01-01T00:00:10Z', reading: 4 },
    ];
    const out = resampleSeries(rows, {
      every: 'PT1M', origin: '2026-01-01T00:00:00Z', at: 'on', value: 'reading', aggregate: 'sum',
    });
    assert.deepStrictEqual(out, [{ at: Date.UTC(2026, 0, 1), value: 6, count: 2 }]);
  });

  it('should refuse a row it cannot read, naming it', () => {
    assert.throws(() => resampleSeries([{ at: 0, value: 1 }, { at: 'soon', value: 2 }],
      { every: 1000 }), /row 1, at:/);
    assert.throws(() => resampleSeries([{ at: 0, value: 'warm' }], { every: 1000 }),
      /row 0, value:/);
  });
});
