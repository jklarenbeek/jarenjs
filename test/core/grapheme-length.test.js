//@ts-check
/**
 * @file `getStringLength(str, true)` counts a CR LF pair as one grapheme in an
 * otherwise ASCII string: the ASCII fast path used to return the code-unit
 * length and a `maxLength` check counted a Windows newline twice.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getStringLength } from '@jarenjs/core/string';

describe('getStringLength with graphemes', () => {
  it('counts CR LF as one cluster in an ASCII string', () => {
    assert.strictEqual(getStringLength('a\r\nb', true), 3);
    assert.strictEqual(getStringLength('\r\n', true), 1);
    assert.strictEqual(getStringLength('line one\r\nline two\r\n', true), 18);
  });

  it('keeps counting a lone CR or LF as one each', () => {
    assert.strictEqual(getStringLength('a\rb', true), 3);
    assert.strictEqual(getStringLength('a\nb', true), 3);
    assert.strictEqual(getStringLength('a\n\rb', true), 4);
  });

  it('counts pairs arithmetically and agrees with the segmenter on mixed runs', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const text of ['a\r\r\nb', '\r\n\r\n', 'x\r', '\rx', '\r\n\n\r', 'a\r\n\r\nb\r']) {
      assert.strictEqual(getStringLength(text, true), [...segmenter.segment(text)].length, JSON.stringify(text));
    }
    assert.strictEqual(getStringLength('line\r\n'.repeat(1000), true), 5000);
  });

  it('leaves the code-unit length alone when graphemes are off', () => {
    assert.strictEqual(getStringLength('a\r\nb', false), 4);
    assert.strictEqual(getStringLength('a\r\nb'), 4);
  });

  it('still counts a plain ASCII string by length', () => {
    assert.strictEqual(getStringLength('hello world', true), 11);
  });
});
