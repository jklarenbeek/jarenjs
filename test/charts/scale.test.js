//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  scaleLinear, scaleLog, scaleOrdinal, scaleBand, scaleTime,
  niceStep, axisTicksLinear, axisTicksLog, axisTicksOrdinal,
  axisTicksTime, niceTimeStep, formatTimeTick,
} from '@jarenjs/charts';
import {
  axisTicksTime as coreAxisTicksTime,
  niceTimeStep as coreNiceTimeStep,
} from '@jarenjs/core/dates';

// numOf is adapter-internal; the test reaches it by source path
import { numOf } from '../../components/charts/src/core/stream-adapter.js';

describe('scales', function () {
  it('scaleLinear maps the domain onto [0,1]', function () {
    const s = scaleLinear(10, 20);
    assert.equal(s(10), 0);
    assert.equal(s(20), 1);
    assert.equal(s(15), 0.5);
    assert.equal(s(25), 1.5); // out-of-domain maps outside, render guards clamp
  });

  it('scaleLinear on a zero-span domain centers', function () {
    assert.equal(scaleLinear(5, 5)(5), 0.5);
  });

  it('scaleLog maps decades evenly and rejects non-positive domains', function () {
    const s = scaleLog(1, 100);
    assert.equal(s(1), 0);
    assert.equal(s(10), 0.5);
    assert.equal(s(100), 1);
    assert.throws(() => scaleLog(0, 10), RangeError);
    assert.throws(() => scaleLog(-1, 10), RangeError);
    assert.ok(Number.isNaN(s(-5))); // per-value guard is NaN, not a throw
  });

  it('scaleLog handles sub-unit ranges', function () {
    const s = scaleLog(0.01, 1);
    assert.equal(s(0.1), 0.5);
  });

  it('scaleOrdinal centers categories; unknown is NaN', function () {
    const s = scaleOrdinal(['a', 'b']);
    assert.equal(s('a'), 0.25);
    assert.equal(s('b'), 0.75);
    assert.ok(Number.isNaN(s('zzz')));
  });

  it('scaleOrdinal with a single category centers it', function () {
    assert.equal(scaleOrdinal(['only'])('only'), 0.5);
  });

  it('scaleBand exposes bandwidth and step', function () {
    const s = scaleBand(['a', 'b', 'c', 'd'], 0.2);
    assert.equal(s.step, 0.25);
    assert.ok(Math.abs(s.bandwidth - 0.2) < 1e-12);
    assert.ok(Math.abs(s('a') - 0.025) < 1e-12);
    assert.ok(Math.abs(s('d') - 0.775) < 1e-12);
    assert.ok(Number.isNaN(s('zzz')));
  });

  it('scaleTime accepts Dates and epoch numbers interchangeably', function () {
    const s = scaleTime(new Date(0), new Date(1000));
    assert.equal(s(500), 0.5);
    assert.equal(s(new Date(1000)), 1);
  });
});

describe('axis ticks', function () {
  it('linear ticks snap to nice numbers, never raw span divisions', function () {
    // 0..51 with 5 requested ticks must NOT yield 12.75-style values
    assert.deepEqual(axisTicksLinear(0, 51, 5), [0, 10, 20, 30, 40, 50]);
    assert.deepEqual(axisTicksLinear(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(axisTicksLinear(-25, 25, 5), [-20, -10, 0, 10, 20]);
  });

  it('linear ticks handle degenerate domains', function () {
    assert.deepEqual(axisTicksLinear(7, 7), [7]);
    assert.deepEqual(axisTicksLinear(NaN, 1), []);
  });

  it('niceStep picks 1/2/5 x 10^k', function () {
    assert.equal(niceStep(51, 5), 10);
    assert.equal(niceStep(10, 5), 2);
    assert.equal(niceStep(4.9, 5), 1);
    assert.equal(niceStep(0.5, 5), 0.1);
  });

  it('log ticks are decade powers over the domain', function () {
    assert.deepEqual(axisTicksLog(1, 1000), [1, 10, 100, 1000]);
    assert.deepEqual(axisTicksLog(0.5, 250), [1, 10, 100]);
    // the 10-220x benchmark-ratio shape
    assert.deepEqual(axisTicksLog(10, 220), [10, 100]);
    assert.throws(() => axisTicksLog(0, 10), RangeError);
  });

  it('log ticks inside one decade fall back to the endpoints', function () {
    assert.deepEqual(axisTicksLog(15, 80), [15, 80]);
  });

  it('ordinal ticks center on bands', function () {
    assert.deepEqual(axisTicksOrdinal(['a', 'b']), [
      { label: 'a', pos: 0.25 },
      { label: 'b', pos: 0.75 },
    ]);
    assert.deepEqual(axisTicksOrdinal([]), []);
  });
});

describe('time ticks land on calendar boundaries', function () {
  const labels = (min, max, count = 4) => {
    const step = niceTimeStep(max - min, count);
    return axisTicksTime(min, max, count).map((t) => formatTimeTick(t, step));
  };

  it('should step by clock units, not by the 1/2/5 ladder', function () {
    // the numeric ladder puts these 50 s apart, which is not a unit
    // anybody reads a clock in
    assert.deepEqual(labels(Date.UTC(2024, 6, 21, 10, 0, 0), Date.UTC(2024, 6, 21, 10, 2, 0)),
      ['10:00:00', '10:00:30', '10:01:00', '10:01:30', '10:02:00']);
    assert.deepEqual(labels(Date.UTC(2026, 6, 27, 0, 0, 0), Date.UTC(2026, 6, 27, 6, 0, 0)),
      ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00']);
  });

  it('should step by calendar units over long spans', function () {
    assert.deepEqual(labels(Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1)),
      ['2024', '2025', '2026', '2027']);
    assert.deepEqual(labels(Date.UTC(2026, 0, 1), Date.UTC(2026, 4, 1)),
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });

  it('should match the label granularity to the step', function () {
    // one string per tick, never the same label repeated across an axis
    for (const [lo, hi] of [
      [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)],
      [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 10)],
      [Date.UTC(2026, 0, 1, 0), Date.UTC(2026, 0, 1, 8)],
    ]) {
      const out = labels(lo, hi);
      assert.equal(new Set(out).size, out.length, out.join(' '));
    }
  });

  it('should fall back to the numeric ladder below a second', function () {
    const ticks = axisTicksTime(0, 100, 4);
    assert.ok(ticks.length > 1);
    assert.deepEqual(ticks, [0, 20, 40, 60, 80, 100]);
  });

  it('should keep the historical label shape with no step', function () {
    assert.equal(formatTimeTick(Date.UTC(2026, 6, 27, 14, 30, 5)), '14:30:05');
    assert.equal(formatTimeTick(Date.UTC(2026, 6, 27)), '2026-07-27', 'a day boundary shows the date');
  });

  it('should handle degenerate and reversed domains', function () {
    assert.deepEqual(axisTicksTime(5, 5), [5]);
    assert.deepEqual(axisTicksTime(Number.NaN, 5), []);
    const lo = Date.UTC(2026, 0, 1), hi = Date.UTC(2026, 0, 5);
    assert.deepEqual(axisTicksTime(hi, lo), axisTicksTime(lo, hi), 'reversed reads the same');
  });

  it('should step by aligned multi-year amounts over a millennial domain', function () {
    // four ticks from 1970 to 5000 used to hit the 1,000-tick guard near
    // 2969 and leave the last two thirds of the axis blank
    assert.deepEqual(labels(Date.UTC(1970, 0, 1), Date.UTC(5000, 0, 1)),
      ['2000', '3000', '4000', '5000']);
  });

  it('should delegate to the kernel rather than be a second planner', function () {
    // the time-axis planner lives in core so a non-chart consumer can
    // reach it without importing this component; these are those names
    assert.equal(axisTicksTime, coreAxisTicksTime);
    assert.equal(niceTimeStep, coreNiceTimeStep);
  });
});

describe('date strings are plottable', function () {

  it('should lift an RFC 3339 string to its instant', function () {
    // the whole point: a date in a JSON document reaches a time axis
    assert.equal(numOf('2026-07-27T14:30:05Z'), Date.UTC(2026, 6, 27, 14, 30, 5));
    assert.equal(numOf('2026-07-27'), Date.UTC(2026, 6, 27), 'a bare date is UTC midnight');
    // two spellings of one instant land on the same point
    assert.equal(numOf('2026-07-27T14:30:05+02:00'), numOf('2026-07-27T12:30:05Z'));
  });

  it('should still refuse a numeric string', function () {
    // accepting "5" where the config asked for a number is a type
    // confusion, not a date — it passes through unplottable
    assert.equal(numOf('5'), '5');
    assert.equal(numOf('nonsense'), 'nonsense');
    assert.equal(numOf('14:30:05Z'), '14:30:05Z', 'a full-time has no instant');
  });

  it('should pass numbers, Dates and non-values through as before', function () {
    assert.equal(numOf(42), 42);
    assert.equal(numOf(new Date(1000)), 1000);
    assert.equal(numOf(null), null);
    assert.equal(numOf(undefined), undefined);
  });
});
