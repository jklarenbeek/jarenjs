import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { lerpColor, relativeLuminance } from '@jarenjs/core/color';

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

describe('relativeLuminance', () => {
  it('anchors black at 0 and white at 1', () => {
    assert.deepEqual(relativeLuminance('#000000'), 0);
    assert.deepEqual(relativeLuminance('#ffffff'), 1);
  });

  it('weights green above red above blue (BT.709)', () => {
    const r = relativeLuminance('#ff0000');
    const g = relativeLuminance('#00ff00');
    const b = relativeLuminance('#0000ff');
    assert.isTrue(g > r && r > b);
    assert.isTrue(Math.abs(r - 0.2126) < 1e-9);
    assert.isTrue(Math.abs(g - 0.7152) < 1e-9);
    assert.isTrue(Math.abs(b - 0.0722) < 1e-9);
  });

  it('separates a light fill from a dark fill across the ink threshold', () => {
    assert.isTrue(relativeLuminance('#93c5fd') > 0.4);
    assert.isTrue(relativeLuminance('#1e40af') < 0.4);
  });
});
