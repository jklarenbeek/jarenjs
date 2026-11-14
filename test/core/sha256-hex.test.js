//@ts-check
/**
 * @file `sha256Hex`: the lowercase hex SHA-256 of a string's UTF-8 bytes,
 * of exactly the bytes an `ArrayBufferView` views, or of a whole
 * `ArrayBuffer`. The vectors are FIPS 180-2's and the digests of
 * `node:crypto`'s independent implementation; anything else is refused,
 * never coerced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../packages/core/src/string.js';

/** @param {string | Uint8Array} input */
const reference = (input) => createHash('sha256').update(input).digest('hex');

describe('sha256Hex', () => {
  it('hashes a string as its UTF-8 bytes: the FIPS 180-2 vectors', async () => {
    assert.strictEqual(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.strictEqual(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // the two-block message
    assert.strictEqual(await sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes a multibyte string as its UTF-8 bytes, and a lone surrogate as U+FFFD', async () => {
    const text = 'héllo €𝄞';
    assert.strictEqual(await sha256Hex(text), '60c94eb007cab617fb517fe63d3c6f0251ac70ecf2a0ee185488c197c57b743e');
    assert.strictEqual(await sha256Hex(text), reference(new TextEncoder().encode(text)));
    // EF BF BD where the lone surrogate stood, as TextEncoder encodes it
    assert.strictEqual(await sha256Hex('a\ud800b'), '05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b');
    assert.strictEqual(await sha256Hex('a\ud800b'), await sha256Hex('a�b'));
  });

  it('hashes exactly the bytes a view views, never its whole buffer', async () => {
    const expected = '2848698aa4b3431e3db06c343ca2cb0455f8aaf16c85cdd828c92ddf7dc134f8';
    assert.strictEqual(await sha256Hex(new Uint8Array([3, 4, 5])), expected);
    const framed = new Uint8Array([9, 3, 4, 5, 9]);
    assert.strictEqual(await sha256Hex(framed.subarray(1, 4)), expected);
    assert.strictEqual(await sha256Hex(new DataView(framed.buffer, 1, 3)), expected);
    // a view of another element type at an offset: its 8 bytes, not the buffer's 24
    const doubles = new Float64Array([1.5, -2.25, 3]);
    const middle = new Float64Array(doubles.buffer, 8, 1);
    assert.strictEqual(await sha256Hex(middle), reference(new Uint8Array(doubles.buffer, 8, 8)));
    assert.notStrictEqual(await sha256Hex(middle), reference(new Uint8Array(doubles.buffer)));
  });

  it('hashes an ArrayBuffer whole', async () => {
    assert.strictEqual(await sha256Hex(new Uint8Array([3, 4, 5]).buffer),
      '2848698aa4b3431e3db06c343ca2cb0455f8aaf16c85cdd828c92ddf7dc134f8');
    assert.strictEqual(await sha256Hex(new ArrayBuffer(0)), await sha256Hex(''));
  });

  it('answers 64 lowercase hex characters', async () => {
    for (const input of ['', 'x', new Uint8Array(1000).fill(255)])
      assert.match(await sha256Hex(input), /^[0-9a-f]{64}$/);
  });

  it('refuses anything else as a rejection naming what was given, never hashing its text', async () => {
    const given = /** @type {[unknown, string][]} */ ([
      [5, 'a number'], [true, 'a boolean'], [10n, 'a bigint'], [Symbol('s'), 'a symbol'],
      [null, 'null'], [undefined, 'undefined'], [{}, 'an object'], [[1, 2], 'an array'],
      [() => 'abc', 'a function'], [new String('abc'), 'an object'],
      [new SharedArrayBuffer(4), 'an object'], [{ buffer: new ArrayBuffer(1), byteOffset: 0, byteLength: 1 }, 'an object'],
    ]);
    for (const [input, kind] of given) {
      await assert.rejects(() => sha256Hex(/** @type {any} */ (input)), {
        name: 'TypeError',
        message: `sha256Hex: expected a string, an ArrayBuffer or an ArrayBufferView, got ${kind}`,
      });
    }
  });
});
