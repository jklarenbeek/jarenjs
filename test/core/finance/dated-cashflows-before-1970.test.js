//@ts-check
/**
 * @file `xnpv` / `xirr` over numbers before 1970. A number under 1e6 in
 * magnitude is a day number (negative before 1970: 1960-01-01 is -3653) and a
 * larger one is milliseconds. Every number under 1e6 used to be a day number,
 * so a millisecond timestamp of 1960 was scaled by 86,400,000 and every dated
 * result came out as if the flows were simultaneous; reading only
 * non-negative numbers as days would have broken the day numbers instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { xirr, xnpv } from '@jarenjs/core/finance';

const start = Date.UTC(1960, 0, 1);
const end = Date.UTC(1961, 0, 1);

describe('xnpv / xirr — timestamps before 1970', () => {
  it('reads negative milliseconds as dates, like the equal Date objects', () => {
    const asDates = [new Date(start), new Date(end)];
    assert.strictEqual(xnpv(0.1, [-100, 110], [start, end]), xnpv(0.1, [-100, 110], asDates));
    assert.strictEqual(xirr([-100, 110], [start, end]), xirr([-100, 110], asDates));
    assert.ok(Math.abs(xirr([-100, 110], [start, end]) - 0.0997) < 1e-3);
  });

  it('reads negative day numbers as days, like the equal Dates and milliseconds', () => {
    const d1 = Math.round(start / 86400000);
    const d2 = Math.round(end / 86400000);
    assert.strictEqual(d1, -3653);
    const asDates = [new Date(start), new Date(end)];
    assert.strictEqual(xnpv(0.1, [-100, 110], [d1, d2]), xnpv(0.1, [-100, 110], asDates));
    assert.strictEqual(xirr([-100, 110], [d1, d2]), xirr([-100, 110], asDates));
    assert.ok(Math.abs(xirr([-100, 110], [d1, d2]) - 0.0997) < 1e-3);
  });

  it('keeps day numbers and later timestamps', () => {
    assert.strictEqual(xnpv(0.1, [-100, 110], [0, 365]), xnpv(0.1, [-100, 110], [0, 365 * 86400000]));
    assert.ok(Math.abs(xirr([-100, 110], [0, 365]) - 0.1) < 1e-6);
    assert.ok(Math.abs(xirr([-100, 110], [Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1)]) - 0.1) < 2e-3);
  });
});
