import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { inkFor, lerpColor, relativeLuminance } from '@jarenjs/core/color';

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

describe('inkFor is a contrast guarantee, not a guess', () => {
  /** WCAG relative-contrast ratio between two colors. */
  const ratio = (a, b) => {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('clears WCAG AA against every fill in the RGB cube', () => {
    // The point of deriving ink from luminance is that it holds for a colour
    // the author picked, not just for the palette we ship. A sweep is what
    // makes that a guarantee instead of a hope.
    let worst = Infinity;
    let worstFill = '';
    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          const fill = '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
          const contrast = ratio(fill, inkFor(fill));
          if (contrast < worst) { worst = contrast; worstFill = fill; }
        }
      }
    }
    assert.ok(worst >= 4.5,
      `worst contrast was ${worst.toFixed(2)} on ${worstFill}; AA needs 4.5`);
  });

  it('accepts the short hex form', () => {
    assert.strictEqual(inkFor('#fff'), inkFor('#ffffff'));
    assert.strictEqual(inkFor('#000'), inkFor('#000000'));
  });
});
