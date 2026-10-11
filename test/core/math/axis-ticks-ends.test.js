//@ts-check
/**
 * An axis includes the multiples of its step at both ends of the domain.
 * The count of steps was a floor of a quotient, and `0.3 / 0.1` is
 * `2.9999999999999996`: the domain `[0, 0.3]` lost its tick at `0.3`, and
 * `[0.1, 0.7]` lost `0.7`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { axisTicksLinear } from '@jarenjs/core/math';

describe('axisTicksLinear — the end of the domain keeps its tick', function () {
  it('includes a multiple of the step the quotient rounds just below', () => {
    assert.deepEqual(axisTicksLinear(0, 0.3, 3), [0, 0.1, 0.2, 0.3]);
    assert.deepEqual(axisTicksLinear(-0.3, 0.3, 6), [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
    assert.deepEqual(axisTicksLinear(0.1, 0.7, 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    assert.deepEqual(axisTicksLinear(40, 40.001, 6), [40, 40.0002, 40.0004, 40.0006, 40.0008, 40.001]);
  });

  it('still leaves out a multiple that is genuinely outside the domain', () => {
    assert.deepEqual(axisTicksLinear(0, 0.29, 3), [0, 0.1, 0.2]);
    assert.deepEqual(axisTicksLinear(0, 51, 5), [0, 10, 20, 30, 40, 50]);
    assert.deepEqual(axisTicksLinear(-25, 25, 5), [-20, -10, 0, 10, 20]);
  });

  it('keeps a degenerate domain at one tick', () => {
    assert.deepEqual(axisTicksLinear(0.3, 0.3), [0.3]);
  });
});
