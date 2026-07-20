import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { lerpColor } from '@jarenjs/core/color';

describe('lerpColor', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    assert.deepEqual(lerpColor('#000000', '#ffffff', 0), '#000000');
    assert.deepEqual(lerpColor('#000000', '#ffffff', 1), '#ffffff');
  });

  it('interpolates the midpoint channel-by-channel', () => {
    assert.deepEqual(lerpColor('#000000', '#ffffff', 0.5), '#808080');
    assert.deepEqual(lerpColor('#ff0000', '#0000ff', 0.5), '#800080');
  });

  it('always emits a zero-padded 6-digit #rrggbb', () => {
    const c = lerpColor('#010203', '#040506', 0.25);
    assert.isTrue(/^#[0-9a-f]{6}$/.test(c));
  });

  it('interpolates each channel independently', () => {
    assert.deepEqual(lerpColor('#204060', '#4080c0', 0.5), '#306090');
  });
});
