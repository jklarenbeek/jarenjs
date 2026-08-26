import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { niceTimeStep, axisTicksTime } from '@jarenjs/core/dates';

const iso = (ms) => new Date(ms).toISOString();
const years = (t) => t.map((ms) => new Date(ms).getUTCFullYear());

describe('niceTimeStep', () => {
  it('should step by clock and calendar units, not the 1/2/5 ladder', () => {
    assert.deepStrictEqual(niceTimeStep(120_000, 4), ['second', 30]);
    assert.deepStrictEqual(niceTimeStep(6 * 3600_000, 6), ['hour', 1]);
    assert.deepStrictEqual(niceTimeStep(9 * 86400_000, 4), ['day', 2]);
    assert.deepStrictEqual(niceTimeStep(2 * 31557600_000, 4), ['month', 6]);
  });

  it('should continue above one year on aligned 2/5/10 x 10^k years', () => {
    // one year is the coarsest calendar unit there is, so the ladder
    // above it is whole years on the same 1/2/5 decade steps
    const step = (spanYears, count) => niceTimeStep(spanYears * 31557600_000, count);
    assert.deepStrictEqual(step(1, 1), ['year', 1]);
    assert.deepStrictEqual(step(8, 4), ['year', 2]);
    assert.deepStrictEqual(step(20, 4), ['year', 5]);
    assert.deepStrictEqual(step(200, 4), ['year', 50]);
    assert.deepStrictEqual(step(3030, 4), ['year', 1000]);
    assert.deepStrictEqual(step(400_000, 4), ['year', 100_000]);
  });
});

describe('axisTicksTime', () => {
  it('should reach the far end of a millennial domain', () => {
    // asking for four ticks from 1970 to 5000 used to hit the 1,000-tick
    // safety cap near 2969 and leave two thirds of the axis blank
    const min = Date.UTC(1970, 0, 1);
    const max = Date.UTC(5000, 0, 1);
    const ticks = axisTicksTime(min, max, 4);
    assert.deepStrictEqual(years(ticks), [2000, 3000, 4000, 5000]);
    for (const ms of ticks)
      assert.strictEqual(iso(ms).slice(4), '-01-01T00:00:00.000Z', 'every tick is a year boundary');
  });

  it('should cover every domain it is given without reaching the cap', () => {
    const spans = [
      [Date.UTC(1970, 0, 1), Date.UTC(5000, 0, 1)],
      [Date.UTC(1, 0, 1), Date.UTC(9999, 0, 1)],
      [Date.UTC(1970, 0, 1), Date.UTC(2100, 0, 1)],
      [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1, 0, 0, 30)],
    ];
    for (const [min, max] of spans) {
      for (const count of [2, 4, 8, 20]) {
        const ticks = axisTicksTime(min, max, count);
        assert.ok(ticks.length >= 1, `${iso(min)}..${iso(max)} @${count}: ${ticks.length} ticks`);
        assert.ok(ticks.length < 1000, `${iso(min)}..${iso(max)} @${count}: hit the cap`);
        const step = (max - min) / Math.max(1, count);
        assert.ok(ticks[ticks.length - 1] > max - 2 * step,
          `${iso(min)}..${iso(max)} @${count}: stops at ${iso(ticks[ticks.length - 1])}`);
        assert.ok(ticks[0] < min + 2 * step,
          `${iso(min)}..${iso(max)} @${count}: starts at ${iso(ticks[0])}`);
      }
    }
  });

  it('should align a multi-year step to a multiple of its own amount', () => {
    // 2024 2025 2026 reads as a calendar; 1997 2022 2047 does not
    assert.deepStrictEqual(years(axisTicksTime(Date.UTC(1997, 5, 1), Date.UTC(2100, 0, 1), 4)),
      [2000, 2020, 2040, 2060, 2080, 2100]);
    assert.deepStrictEqual(years(axisTicksTime(Date.UTC(1813, 0, 1), Date.UTC(2013, 0, 1), 4)),
      [1850, 1900, 1950, 2000]);
  });

  it('should keep the answers it already gave where no defect existed', () => {
    assert.deepStrictEqual(axisTicksTime(0, 100, 4), [0, 20, 40, 60, 80, 100]);
    assert.deepStrictEqual(axisTicksTime(5, 5), [5]);
    assert.deepStrictEqual(axisTicksTime(Number.NaN, 5), []);
    const lo = Date.UTC(2026, 0, 1), hi = Date.UTC(2026, 0, 5);
    assert.deepStrictEqual(axisTicksTime(hi, lo), axisTicksTime(lo, hi), 'reversed reads the same');
    assert.deepStrictEqual(years(axisTicksTime(Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1), 4)),
      [2024, 2025, 2026, 2027]);
  });
});
