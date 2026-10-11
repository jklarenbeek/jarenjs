//@ts-check
/**
 * @file `lerpColor` extrapolates, and every channel stays inside 0-255: a
 * blend factor outside [0, 1] used to overflow into the next channel or
 * return a malformed colour such as `#80`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lerpColor } from '@jarenjs/core/color';

describe('lerpColor — factors outside [0, 1]', () => {
  it('holds an overshooting channel at ff instead of spilling into the next', () => {
    assert.strictEqual(lerpColor('#000000', '#808080', 2), '#ffffff');
    assert.strictEqual(lerpColor('#ff0000', '#00ff00', 1.5), '#00ff00');
  });

  it('holds an undershooting channel at 00 and keeps seven characters', () => {
    assert.strictEqual(lerpColor('#000000', '#808080', -1), '#000000');
    assert.strictEqual(lerpColor('#ff8000', '#000000', -0.5), '#ffc000');
    assert.strictEqual(lerpColor('#102030', '#304050', -1).length, 7);
  });

  it('is unchanged inside the interval', () => {
    assert.strictEqual(lerpColor('#000000', '#ffffff', 0), '#000000');
    assert.strictEqual(lerpColor('#000000', '#ffffff', 1), '#ffffff');
    assert.strictEqual(lerpColor('#000000', '#ffffff', 0.5), '#808080');
  });
});
