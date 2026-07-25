//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { CATEGORICAL, SEQUENTIAL, seriesColor, sequentialColor } from '@jarenjs/charts';

describe('categorical palette', function () {
  it('wraps series indexes past the palette length', function () {
    assert.equal(seriesColor(0), CATEGORICAL[0]);
    assert.equal(seriesColor(CATEGORICAL.length), CATEGORICAL[0]);
    assert.equal(seriesColor(3), CATEGORICAL[3]);
  });
});

describe('sequential ramp', function () {
  it('is a single-hue blue ramp, light to dark', function () {
    assert.ok(SEQUENTIAL.length >= 2);
    for (const stop of SEQUENTIAL)
      assert.match(stop, /^#[0-9a-f]{6}$/);
    assert.equal(SEQUENTIAL[0], '#60a5fa');
    assert.equal(SEQUENTIAL[SEQUENTIAL.length - 1], '#1e40af');
  });

  it('maps the endpoints exactly and interpolates between stops', function () {
    assert.equal(sequentialColor(0), SEQUENTIAL[0]);
    assert.equal(sequentialColor(1), SEQUENTIAL[SEQUENTIAL.length - 1]);
    const mid = sequentialColor(0.5);
    assert.match(mid, /^#[0-9a-f]{6}$/);
    assert.notEqual(mid, SEQUENTIAL[0]);
    assert.notEqual(mid, SEQUENTIAL[SEQUENTIAL.length - 1]);
  });

  it('clamps out-of-range and guards non-finite input', function () {
    assert.equal(sequentialColor(-1), SEQUENTIAL[0]);
    assert.equal(sequentialColor(2), SEQUENTIAL[SEQUENTIAL.length - 1]);
    assert.equal(sequentialColor(NaN), SEQUENTIAL[0]);
  });

  it('accepts a custom ramp, including a single-stop one', function () {
    assert.equal(sequentialColor(0.5, ['#000000', '#ffffff']), '#808080');
    assert.equal(sequentialColor(0.9, ['#123456']), '#123456');
  });

  it('is monotone: darker never precedes lighter along t', function () {
    let prev = Infinity;
    for (let i = 0; i <= 10; i++) {
      const hex = sequentialColor(i / 10);
      const p = parseInt(hex.slice(1), 16);
      const sum = ((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255);
      assert.ok(sum <= prev, `ramp got lighter at t=${i / 10}`);
      prev = sum;
    }
  });
});
