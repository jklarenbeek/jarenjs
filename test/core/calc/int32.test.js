import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mathi32_abs,
  mathi32_round,
  mathi32_ceil,
  mathi32_floor,
  mathi32_min,
  mathi32_max,
  mathi32_sqrt,
  mathi32_asin,
  mathi32_atan2,
  mathi32_PI,
  mathi32_PI2,
  mathi32_PI1H,
  mathi32_PI41,
  mathi32_PI42,
  mathi32_MULTIPLIER,
  Int32
} from '@jarenjs/core/calc';

describe('mathi32 primitives', async (t) => {
  it('mathi32_abs', () => {
    assert.equal(mathi32_abs(-5), 5);
    assert.equal(mathi32_abs(5), 5);
    assert.equal(mathi32_abs(0), 0);
  });

  it('mathi32_round', () => {
    assert.equal(mathi32_round(3.4), 3);
    assert.equal(mathi32_round(3.5), 4);
    assert.equal(mathi32_round(-3.5), -3);
  });

  it('mathi32_ceil', () => {
    assert.equal(mathi32_ceil(3.1), 4);
    assert.equal(mathi32_ceil(3.9), 4);
    assert.equal(mathi32_ceil(-3.1), -3);
  });

  it('mathi32_floor', () => {
    assert.equal(mathi32_floor(3.1), 3);
    assert.equal(mathi32_floor(3.9), 3);
    assert.equal(mathi32_floor(-3.1), -4);
  });

  it('mathi32_min', () => {
    assert.equal(mathi32_min(3, 5), 3);
    assert.equal(mathi32_min(-3, 5), -3);
    assert.equal(mathi32_min(3, 3), 3);
  });

  it('mathi32_max', () => {
    assert.equal(mathi32_max(3, 5), 5);
    assert.equal(mathi32_max(-3, 5), 5);
    assert.equal(mathi32_max(3, 3), 3);
  });

  it('mathi32_sqrt', () => {
    assert.equal(mathi32_sqrt(4), 2);
    assert.equal(mathi32_sqrt(9), 3);
    assert.equal(mathi32_sqrt(0), 0);
  });

  it('mathi32_asin', () => {
    assert.equal(mathi32_asin(0), 0);
    assert.equal(mathi32_asin(1), Math.PI / 2);
    assert.equal(mathi32_asin(-1), -Math.PI / 2);
  });

  it('mathi32_atan2', () => {
    assert.equal(mathi32_atan2(1, 1), Math.PI / 4);
    assert.equal(mathi32_atan2(0, 1), 0);
    assert.equal(mathi32_atan2(1, 0), Math.PI / 2);
  });

  it.skip('mathi32 constants', () => {
    assert.equal(mathi32_PI, Math.round(Math.PI * mathi32_MULTIPLIER));
    assert.equal(mathi32_PI2, Math.round(2 * Math.PI * mathi32_MULTIPLIER));
    assert.equal(mathi32_PI1H, Math.round((Math.PI / 2) * mathi32_MULTIPLIER));
    assert.equal(mathi32_PI41, Math.round((4 / Math.PI) * mathi32_MULTIPLIER));
    assert.equal(mathi32_PI42, Math.round((4 / (Math.PI * Math.PI)) * mathi32_MULTIPLIER));
  });
});

describe('Int32 class methods', async (t) => {
  it('Int32.random', () => {
    const random = Int32.random();
    assert(random >= 0 && random < 1);
  });

  it('Int32.sqrt', () => {
    assert.equal(Int32.sqrt(4), 2);
    assert.equal(Int32.sqrt(9), 3);
    assert.equal(Int32.sqrt(0), 0);
  });

  it('Int32.sqrtEx', () => {
    assert.equal(Int32.sqrtEx(4), 2 * mathi32_MULTIPLIER);
    assert.equal(Int32.sqrtEx(9), 3 * mathi32_MULTIPLIER);
    assert.equal(Int32.sqrtEx(0), 0);
  });

  it.skip('Int32.fib', () => {
    assert.equal(Int32.fib(0), 0);
    assert.equal(Int32.fib(1), 1);
    assert.equal(Int32.fib(10), 55);
  });

  it('Int32.mag2', () => {
    assert.equal(Int32.mag2(3, 4), 25);
    assert.equal(Int32.mag2(0, 5), 25);
    assert.equal(Int32.mag2(1, 1), 2);
  });

  it('Int32.hypot', () => {
    assert.equal(Int32.hypot(3, 4), 5);
    assert.equal(Int32.hypot(0, 5), 5);
    assert.equal(Int32.hypot(1, 1), 1);
  });

  it('Int32.hypotEx', () => {
    assert.equal(Int32.hypotEx(3, 4), 5 * mathi32_MULTIPLIER);
    assert.equal(Int32.hypotEx(0, 5), 5 * mathi32_MULTIPLIER);
    assert.equal(Int32.hypotEx(1, 1), Math.round(Math.sqrt(2) * mathi32_MULTIPLIER));
  });

  it('Int32.dot', () => {
    assert.equal(Int32.dot(1, 2, 3, 4), 11);
    assert.equal(Int32.dot(0, 1, 1, 0), 0);
    assert.equal(Int32.dot(2, 3, 4, 5), 23);
  });

  it('Int32.cross', () => {
    assert.equal(Int32.cross(1, 2, 3, 4), -2);
    assert.equal(Int32.cross(0, 1, 1, 0), -1);
    assert.equal(Int32.cross(2, 3, 4, 5), -2);
  });

  it('Int32.norm', () => {
    assert.equal(Int32.norm(5, 0, 10), 0);
    assert.equal(Int32.norm(0, 0, 10), 0);
    assert.equal(Int32.norm(10, 0, 10), 1);
  });

  it('Int32.lerp', () => {
    assert.equal(Int32.lerp(5, 0, 10), 50);
    assert.equal(Int32.lerp(0, 0, 10), 0);
    assert.equal(Int32.lerp(10, 0, 10), 100);
  });

  it('Int32.map', () => {
    assert.equal(Int32.map(5, 0, 10, 0, 100), 50);
    assert.equal(Int32.map(0, 0, 10, 0, 100), 0);
    assert.equal(Int32.map(10, 0, 10, 0, 100), 100);
  });

  it('Int32.clamp', () => {
    assert.equal(Int32.clamp(5, 0, 10), 5);
    assert.equal(Int32.clamp(-5, 0, 10), 0);
    assert.equal(Int32.clamp(15, 0, 10), 10);
  });

  it('Int32.clampu', () => {
    assert.equal(Int32.clampu(5, 0, 10), 5);
    assert.equal(Int32.clampu(-5, 0, 10), 0);
    assert.equal(Int32.clampu(15, 0, 10), 10);
  });

  it.skip('Int32.clampu_u8a', () => {
    assert.equal(Int32.clampu_u8a(100), 100);
    assert.equal(Int32.clampu_u8a(-5), 0);
    assert.equal(Int32.clampu_u8a(300), 255);
  });

  it.skip('Int32.clampu_u8b', () => {
    assert.equal(Int32.clampu_u8b(100), 100);
    assert.equal(Int32.clampu_u8b(-5), 0);
    assert.equal(Int32.clampu_u8b(300), 255);
  });

  it('Int32.inRange', () => {
    assert.equal(Int32.inRange(5, 0, 10), true);
    assert.equal(Int32.inRange(-5, 0, 10), false);
    assert.equal(Int32.inRange(15, 0, 10), false);
  });

  it('Int32.intersectsRange', () => {
    assert.equal(Int32.intersectsRange(0, 5, 3, 8), true);
    assert.equal(Int32.intersectsRange(0, 2, 3, 5), false);
    assert.equal(Int32.intersectsRange(0, 10, 5, 15), true);
  });

  it('Int32.intersectsRect', () => {
    assert.equal(Int32.intersectsRect(0, 0, 5, 5, 3, 3, 5, 5), true);
    assert.equal(Int32.intersectsRect(0, 0, 5, 5, 6, 6, 5, 5), false);
    assert.equal(Int32.intersectsRect(0, 0, 10, 10, 5, 5, 10, 10), true);
  });

  it('Int32.toRadianEx', () => {
    assert.equal(Int32.toRadianEx(180), mathi32_PI);
    assert.equal(Int32.toRadianEx(90), mathi32_PI1H);
    assert.equal(Int32.toRadianEx(0), 0);
  });

  it.skip('Int32.toDegreesEx', () => {
    assert.equal(Int32.toDegreesEx(mathi32_PI), 180 * mathi32_MULTIPLIER);
    assert.equal(Int32.toDegreesEx(mathi32_PI1H), 90 * mathi32_MULTIPLIER);
    assert.equal(Int32.toDegreesEx(0), 0);
  });

  it('Int32.wrapRadians', () => {
    assert.equal(Int32.wrapRadians(mathi32_PI2), 0);
    assert.equal(Int32.wrapRadians(-mathi32_PI2), 0);
    assert.equal(Int32.wrapRadians(mathi32_PI1H), mathi32_PI1H);
  });

  it.skip('Int32.sinLpEx', () => {
    assert.equal(Int32.sinLpEx(0), 0);
    assert.equal(Int32.sinLpEx(mathi32_PI1H), mathi32_MULTIPLIER);
    assert.equal(Int32.sinLpEx(mathi32_PI), 0);
  });

  it.skip('Int32.sinLp', () => {
    assert.equal(Int32.sinLp(0), 0);
    assert.equal(Int32.sinLp(mathi32_PI1H), mathi32_MULTIPLIER);
    assert.equal(Int32.sinLp(mathi32_PI), 0);
  });
});