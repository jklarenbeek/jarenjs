//@ts-check
/**
 * @file The LZW coder behind a share token (`@jarenjs/app`): the stream is
 * pinned by hand-derived values, round-trips on generated inputs, and refuses
 * every damaged or hostile stream with `null`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compressBytes, decompressBytes, MAX_EXPANDED_BYTES } from '../../packages/app/src/share-codec.js';

const bytesOf = (text) => new TextEncoder().encode(text);

describe('@jarenjs/app — the share-token compressor', () => {
  it('writes the stream the format describes (a hand-derived pin)', () => {
    // 'aaaa': escape 'a' = 0 01100001 (1-bit codes), then code 3 ('aa') in 2
    // bits = 11, code 2 ('a') in 3 bits = 010, the end code in 3 bits = 001,
    // padded: 001100 001110 100010 -> M O i
    assert.strictEqual(compressBytes(bytesOf('aaaa')), 'MOi');
    assert.deepStrictEqual([...(decompressBytes('MOi') ?? [])], [97, 97, 97, 97]);
    // the empty input is the end code alone: 1 + 5 padding bits
    assert.strictEqual(compressBytes(new Uint8Array(0)), 'g');
    assert.deepStrictEqual([...(decompressBytes('g') ?? [1])], []);
  });

  it('round-trips generated inputs of every mix of repeats and noise', () => {
    let seed = 1;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let n = 0; n < 600; n++) {
      const bytes = new Uint8Array(Math.floor(next() ** 3 * 2000));
      const alphabet = 1 + Math.floor(next() * 255);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = n % 3 === 2 && i > 3 && next() < 0.9
          ? bytes[i - 1 - Math.floor(next() * 3)]
          : Math.floor(next() * alphabet);
      }
      const text = compressBytes(bytes);
      assert.match(text, /^[A-Za-z0-9_-]*$/);
      assert.deepStrictEqual(decompressBytes(text), bytes, `case ${n}`);
    }
  });

  it('expands a phrase that names the entry being defined (the cScSc case)', () => {
    for (const text of ['abababababab', 'aaaaaaaaaaaaaaaa', 'abcabcabcabcabc']) {
      assert.deepStrictEqual(decompressBytes(compressBytes(bytesOf(text))), bytesOf(text), text);
    }
  });

  it('answers null for text that is not a complete stream', () => {
    assert.strictEqual(decompressBytes(''), null, 'no end code');
    assert.strictEqual(decompressBytes('M'), null, 'ends inside the first byte');
    assert.strictEqual(decompressBytes('MO'), null, 'no end code');
    assert.strictEqual(decompressBytes('MOiA'), null, 'a character after the end code');
    assert.strictEqual(decompressBytes('MO+'), null, 'outside the alphabet');
    assert.strictEqual(decompressBytes('MOé'), null, 'outside ASCII');
    // escape 'a', the pending slot (3), then 5 in 3 bits when only 4 slots exist, then the end code
    assert.strictEqual(decompressBytes('MPS'), null, 'a code past the dictionary');
  });

  it('refuses one character after an end code that leaves no padding bits', () => {
    // 'abbaaaa' fills its last character exactly: nothing but the end code may follow
    assert.deepStrictEqual([...(decompressBytes('MIxRch') ?? [])], [...bytesOf('abbaaaa')]);
    assert.strictEqual(decompressBytes('MIxRchA'), null);
    assert.strictEqual(decompressBytes('MIxRchAA'), null);
  });

  it('refuses padding bits that are not zero, so a snapshot has one token', () => {
    // 'aaaa' is 17 bits: the last character 'i' carries one padding bit
    assert.deepStrictEqual([...(decompressBytes('MOi') ?? [])], [97, 97, 97, 97]);
    assert.strictEqual(decompressBytes('MOj'), null);
  });

  it('refuses a character outside the alphabet even where a valid one would decode the same', () => {
    // 'xyzxyz' -> 'PA8h6bC': the 'A' is six zero bits
    assert.deepStrictEqual([...(decompressBytes('PA8h6bC') ?? [])], [...bytesOf('xyzxyz')]);
    for (const outside of ['+', '!', '/', '=', ' ', 'é']) {
      assert.strictEqual(decompressBytes(`P${outside}8h6bC`), null, JSON.stringify(outside));
    }
  });

  it('refuses to expand past the limit and allows exactly the limit', () => {
    const atLimit = compressBytes(new Uint8Array(MAX_EXPANDED_BYTES));
    assert.strictEqual(decompressBytes(atLimit)?.length, MAX_EXPANDED_BYTES);
    // a plain boolean: a failed comparison of the expanded bytes would print all of them
    assert.ok(decompressBytes(compressBytes(new Uint8Array(MAX_EXPANDED_BYTES + 1))) === null);
  });
});
