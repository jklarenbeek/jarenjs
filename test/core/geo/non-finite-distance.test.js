//@ts-check
/**
 * @file `haversineDistance` over a non-finite coordinate answers NaN. Its
 * guard against a rounding excess over 1 used to turn NaN into 1, so a missing
 * longitude measured exactly half the planet (20,015,114 m) instead of
 * failing visibly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EARTH_RADIUS, haversineDistance } from '@jarenjs/core/geo';

describe('haversineDistance — non-finite input', () => {
  it('answers NaN for NaN in any coordinate', () => {
    assert.ok(Number.isNaN(haversineDistance(NaN, 0, 1, 1)));
    assert.ok(Number.isNaN(haversineDistance(0, NaN, 1, 1)));
    assert.ok(Number.isNaN(haversineDistance(0, 0, NaN, 1)));
    assert.ok(Number.isNaN(haversineDistance(0, 0, 1, NaN)));
    assert.ok(Number.isNaN(haversineDistance(Infinity, 0, 1, 1)));
  });

  it('keeps the antipodal clamp and ordinary distances', () => {
    assert.strictEqual(haversineDistance(0, 0, 180, 0), Math.PI * EARTH_RADIUS);
    assert.strictEqual(haversineDistance(10, 10, 10, 10), 0);
    assert.strictEqual(Math.round(haversineDistance(4.9041, 52.3676, 2.3522, 48.8566)), 429_862);
  });
});
