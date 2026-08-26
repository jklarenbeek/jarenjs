import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  toEpoch, normalizeSeries, normalizeIntervals, lowerBoundTime, upperBoundTime,
} from '@jarenjs/core/series';
import { epochAt } from '@jarenjs/core/series/normalize';
import { selectorOf, requireRow } from '@jarenjs/core/series/selector';

const DAY = 86400000;

describe('toEpoch', () => {
  it('should return a finite number unchanged', () => {
    assert.strictEqual(toEpoch(0), 0);
    assert.strictEqual(toEpoch(-DAY), -DAY);
    assert.strictEqual(toEpoch(1767225600000), 1767225600000);
  });

  it('should read every RFC 3339 form that names an instant', () => {
    assert.strictEqual(toEpoch('1970-01-01'), 0);
    assert.strictEqual(toEpoch('1970-01-01T00:00:00Z'), 0);
    assert.strictEqual(toEpoch('1970-01-01T01:00:00+01:00'), 0);
    assert.strictEqual(toEpoch('1969-12-31T23:00:00-01:00'), 0);
    assert.strictEqual(toEpoch('1969-12-31'), -DAY);
  });

  it('should refuse a value that names no instant', () => {
    // a full-time has no day, and inventing one would be a hidden clock
    assert.throws(() => toEpoch('09:30:00Z'), /not an RFC 3339 instant/);
    // no offset, no instant - there is no implicit machine zone here
    assert.throws(() => toEpoch('2026-01-01T09:30:00'), /not an RFC 3339 instant/);
    assert.throws(() => toEpoch('yesterday'), /not an RFC 3339 instant/);
    assert.throws(() => toEpoch(NaN), /not an instant/);
    assert.throws(() => toEpoch(Infinity), /not an instant/);
    // a wrapper type is not a date in this suite
    assert.throws(() => toEpoch(new Date(0)), /epoch milliseconds or an RFC 3339 string/);
    assert.throws(() => toEpoch(null), /epoch milliseconds or an RFC 3339 string/);
    assert.throws(() => toEpoch(undefined), /epoch milliseconds or an RFC 3339 string/);
  });
});

describe('normalizeSeries', () => {
  it('should sort ascending and keep every source member', () => {
    const rows = [
      { on: '2026-01-01T00:00:02Z', v: 2, tag: 'b' },
      { on: '2026-01-01T00:00:00Z', v: 0, tag: 'a' },
      { on: '2026-01-01T00:00:01Z', v: 1, tag: 'c' },
    ];
    const out = normalizeSeries(rows, { at: 'on', value: 'v' });
    assert.deepStrictEqual(out.map((s) => s.tag), ['a', 'c', 'b']);
    assert.deepStrictEqual(out.map((s) => s.value), [0, 1, 2]);
    assert.deepStrictEqual(out[0], {
      on: '2026-01-01T00:00:00Z', v: 0, tag: 'a', at: 1767225600000, value: 0,
    });
    // the source rows are untouched
    assert.strictEqual(rows[0].tag, 'b');
    assert.strictEqual('at' in rows[0], false);
  });

  it('should keep duplicate instants, in input order, all of them', () => {
    const out = normalizeSeries([
      { at: 20, value: 1 }, { at: 10, value: 2 }, { at: 10, value: 3 },
      { at: 10, value: 4 }, { at: 20, value: 5 },
    ]);
    assert.deepStrictEqual(out.map((s) => s.value), [2, 3, 4, 1, 5]);
  });

  it('should leave an already-ascending series in place', () => {
    const out = normalizeSeries([{ at: 1, value: 1 }, { at: 1, value: 2 }, { at: 2, value: 3 }]);
    assert.deepStrictEqual(out.map((s) => s.value), [1, 2, 3]);
  });

  it('should accept null as a measured gap and refuse every other absence', () => {
    assert.strictEqual(normalizeSeries([{ at: 0, value: null }])[0].value, null);
    assert.throws(() => normalizeSeries([{ at: 0 }]), /row 0, value/);
    assert.throws(() => normalizeSeries([{ at: 0, value: NaN }]), /row 0, value/);
    assert.throws(() => normalizeSeries([{ at: 0, value: '1' }]), /row 0, value/);
    assert.throws(() => normalizeSeries([{ at: 0, value: Infinity }]), /row 0, value/);
  });

  it('should name the row it refuses rather than dropping it', () => {
    assert.throws(
      () => normalizeSeries([{ at: 0, value: 0 }, { at: 1, value: 1 }, { at: 'noon', value: 2 }]),
      /row 2, at: 'noon' is not an RFC 3339 instant/);
    assert.throws(() => normalizeSeries([{ at: 0, value: 0 }, 7]), /row 1 is not an object/);
    assert.throws(() => normalizeSeries([null]), /row 0 is not an object/);
    assert.throws(() => normalizeSeries('nope'), /a series is an array of rows/);
  });

  it('should take a function selector as readily as a member name', () => {
    const out = normalizeSeries([{ pair: [10, 5] }, { pair: [0, 1] }], {
      at: (row) => row.pair[0],
      value: (row, index) => row.pair[1] + index,
    });
    assert.deepStrictEqual(out.map((s) => [s.at, s.value]), [[0, 2], [10, 5]]);
    assert.throws(() => normalizeSeries([], { at: 7 }), /'at' selector is a property name or a function/);
  });

  it('should return an empty array for no rows', () => {
    assert.deepStrictEqual(normalizeSeries([]), []);
  });
});

describe('normalizeIntervals', () => {
  it('should convert both bounds and sort by start, stably', () => {
    const out = normalizeIntervals([
      { from: '2026-01-03', to: '2026-01-04', id: 'c' },
      { from: '2026-01-01', to: '2026-01-05', id: 'a' },
      { from: '2026-01-01', to: '2026-01-02', id: 'b' },
    ], { start: 'from', end: 'to' });
    assert.deepStrictEqual(out.map((i) => i.id), ['a', 'b', 'c']);
    assert.strictEqual(out[0].start, toEpoch('2026-01-01'));
    assert.strictEqual(out[0].end, toEpoch('2026-01-05'));
    assert.strictEqual(out[0].from, '2026-01-01');
  });

  it('should keep duplicate intervals', () => {
    const out = normalizeIntervals([{ start: 0, end: 5 }, { start: 0, end: 5 }]);
    assert.strictEqual(out.length, 2);
  });

  it('should refuse an empty, reversed or unreadable interval', () => {
    assert.throws(() => normalizeIntervals([{ start: 5, end: 5 }]),
      /row 0: an interval ends at 5, at or before its start 5/);
    assert.throws(() => normalizeIntervals([{ start: 6, end: 5 }]),
      /row 0: an interval ends at 5, at or before its start 6/);
    assert.throws(() => normalizeIntervals([{ start: 0, end: 1 }, { start: 0 }]),
      /row 1, end:/);
    assert.throws(() => normalizeIntervals([{ end: 1 }]), /row 0, start:/);
    assert.throws(() => normalizeIntervals({}), /intervals are an array of rows/);
  });

  it('should leave an already-ascending list in place', () => {
    const out = normalizeIntervals([{ start: 0, end: 9 }, { start: 0, end: 1 }, { start: 3, end: 4 }]);
    assert.deepStrictEqual(out.map((i) => i.end), [9, 1, 4]);
  });
});

describe('the binary bounds', () => {
  const samples = [10, 20, 20, 20, 30].map((at) => ({ at, value: at }));

  it('should bracket the rows at an instant', () => {
    assert.strictEqual(lowerBoundTime(samples, 20), 1);
    assert.strictEqual(upperBoundTime(samples, 20), 4);
    assert.deepStrictEqual(samples.slice(1, 4).map((s) => s.at), [20, 20, 20]);
  });

  it('should answer the ends of the array', () => {
    assert.strictEqual(lowerBoundTime(samples, 0), 0);
    assert.strictEqual(upperBoundTime(samples, 0), 0);
    assert.strictEqual(lowerBoundTime(samples, 40), 5);
    assert.strictEqual(upperBoundTime(samples, 40), 5);
    assert.strictEqual(lowerBoundTime([], 0), 0);
    assert.strictEqual(upperBoundTime([], 0), 0);
  });

  it('should read whichever member holds the instant', () => {
    const intervals = [{ start: 0, end: 1 }, { start: 5, end: 6 }];
    assert.strictEqual(lowerBoundTime(intervals, 5, 'start'), 1);
    assert.strictEqual(upperBoundTime(intervals, 5, 'start'), 2);
  });

  it('should agree with a linear search over every position', () => {
    const rows = [];
    for (let i = 0; i < 64; i++)
      rows.push({ at: Math.floor(i / 2) * 4 - 60 });
    for (let t = -70; t <= 70; t++) {
      let lo = 0;
      while (lo < rows.length && rows[lo].at < t) lo++;
      let hi = 0;
      while (hi < rows.length && rows[hi].at <= t) hi++;
      assert.strictEqual(lowerBoundTime(rows, t), lo, `lower at ${t}`);
      assert.strictEqual(upperBoundTime(rows, t), hi, `upper at ${t}`);
    }
  });
});

describe('the shared row readers', () => {
  it('should name the row and the member a refusal came from', () => {
    assert.strictEqual(epochAt('1970-01-01', 'at', 3), 0);
    assert.throws(() => epochAt(Symbol('x'), 'at', 3), /row 3, at:/);
  });

  it('should hand back the row it was given', () => {
    const row = { a: 1 };
    assert.strictEqual(requireRow(row, 0), row);
    assert.strictEqual(selectorOf('a', 'a')(row, 0), 1);
    const fn = (item) => item.a + 1;
    assert.strictEqual(selectorOf(fn, 'a'), fn);
  });
});
