//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  scaleLinear, scaleLog, scaleOrdinal, scaleBand, scaleTime,
  niceStep, axisTicksLinear, axisTicksLog, axisTicksOrdinal,
} from '@jarenjs/charts';

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
