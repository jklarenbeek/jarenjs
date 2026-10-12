//@ts-check
/**
 * @file `lerpColor` and `relativeLuminance` read a three-digit hex the way
 * `inkFor` does. They parsed `#abc` as the number 0x0abc, so every channel
 * came out wrong (`#fff` blended as 0x00, 0x0f, 0xff).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inkFor, lerpColor, relativeLuminance } from '@jarenjs/core/color';

describe('three-digit hex colors', () => {
  it('blends #fff and #000 to the middle grey', () => {
    assert.strictEqual(lerpColor('#fff', '#000', 0.5), '#808080');
    assert.strictEqual(lerpColor('#fff', '#000', 0), '#ffffff');
    assert.strictEqual(lerpColor('#fff', '#000', 1), '#000000');
  });

  it('blends a short and a long form as two long forms', () => {
    assert.strictEqual(lerpColor('#f00', '#0000ff', 0.5), lerpColor('#ff0000', '#0000ff', 0.5));
    assert.strictEqual(lerpColor('#f00', '#0000ff', 0.5), '#800080');
    assert.strictEqual(lerpColor('#abc', '#abc', 0.3), '#aabbcc');
  });

  it('measures the luminance of #abc as that of #aabbcc', () => {
    assert.strictEqual(relativeLuminance('#fff'), 1);
    assert.strictEqual(relativeLuminance('#000'), 0);
    assert.strictEqual(relativeLuminance('#abc'), relativeLuminance('#aabbcc'));
    assert.strictEqual(inkFor('#fff'), '#1f2020');
  });

  it('keeps the six-digit answers', () => {
    assert.strictEqual(lerpColor('#000000', '#808080', 0.5), '#404040');
    assert.strictEqual(relativeLuminance('#ffffff'), 1);
  });
});
