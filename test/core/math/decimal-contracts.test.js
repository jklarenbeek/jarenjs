//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { roundExact } from '@jarenjs/core/math';

it('exact rounding rejects invalid precision and rounding mode without coercion', () => {
  for (const precision of [1.5, NaN, Infinity, '2', null])
    assert.throws(() => roundExact(1.234, precision), TypeError);
  assert.throws(() => roundExact(1.234, 2, 'half-evne'), TypeError);
  assert.equal(roundExact(1.234, 2), 1.23);
  assert.ok(Object.is(roundExact(-0.4), -0));
  assert.ok(Number.isNaN(roundExact(NaN)));
});
