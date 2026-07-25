import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toWord, wAnd, wOr, wXor, wNot, wShl, wShr, wRol, wRor, wMod,
  toBase, fromBase, wordMask, WORD_BITS,
} from '@jarenjs/core/math';

describe('#word math', function () {
  it('WORD_BITS + wordMask', () => {
    assert.deepEqual([...WORD_BITS], [8, 16, 32, 64]);
    assert.equal(wordMask(8), 0xffn);
    assert.equal(wordMask(16), 0xffffn);
  });

  it('toWord: unsigned wraparound', () => {
    assert.equal(toWord(256n, 8, false), 0n);
    assert.equal(toWord(255n, 8, false), 255n);
    assert.equal(toWord(-1n, 8, false), 255n);
  });

  it('toWord: two\'s complement signed', () => {
    assert.equal(toWord(255n, 8, true), -1n);
    assert.equal(toWord(128n, 8, true), -128n);
    assert.equal(toWord(127n, 8, true), 127n);
    assert.equal(toWord(0xffffffffn, 32, true), -1n);
  });

  it('bitwise ops', () => {
    assert.equal(wAnd(0b1100n, 0b1010n, 8, false), 0b1000n);
    assert.equal(wOr(0b1100n, 0b1010n, 8, false), 0b1110n);
    assert.equal(wXor(0b1100n, 0b1010n, 8, false), 0b0110n);
    assert.equal(wNot(0n, 8, false), 255n);
    assert.equal(wNot(0n, 8, true), -1n);
  });

  it('shifts', () => {
    assert.equal(wShl(1n, 3n, 8, false), 8n);
    assert.equal(wShl(0xffn, 4n, 8, false), 0xf0n);   // truncated to 8 bits
    assert.equal(wShr(0xf0n, 4n, 8, false), 0x0fn);
  });

  it('rotates', () => {
    assert.equal(wRol(0b10000001n, 1n, 8, false), 0b00000011n);
    assert.equal(wRor(0b00000011n, 1n, 8, false), 0b10000001n);
    // rotate is width-exact: rol by width == identity
    assert.equal(wRol(0b10110010n, 8n, 8, false), 0b10110010n);
  });

  it('wMod', () => {
    assert.equal(wMod(10n, 3n, 32, false), 1n);
    assert.throws(() => wMod(1n, 0n, 32, false), RangeError);
  });

  it('toBase / fromBase round-trip', () => {
    assert.equal(toBase(255n, 16, { upper: true }), 'FF');
    assert.equal(toBase(255n, 2), '11111111');
    assert.equal(toBase(64n, 8), '100');
    assert.equal(toBase(0n, 16), '0');
    assert.equal(fromBase('FF', 16), 255n);
    assert.equal(fromBase('0xff'), 255n);
    assert.equal(fromBase('0b1010'), 10n);
    assert.equal(fromBase('0o17'), 15n);
    for (const v of [0n, 1n, 255n, 65535n, 123456789n]) {
      assert.equal(fromBase(toBase(v, 16), 16), v);
      assert.equal(fromBase(toBase(v, 2), 2), v);
    }
  });

  it('toBase grouping + padding', () => {
    assert.equal(toBase(0xffffn, 16, { group: 2, upper: true }), 'FF FF');
    assert.equal(toBase(5n, 2, { pad: 8 }), '00000101');
    assert.equal(fromBase('FF FF', 16), 0xffffn);
  });
});
