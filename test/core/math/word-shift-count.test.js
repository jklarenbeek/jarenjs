//@ts-check
/**
 * @file Shift counts wrap with the word, as the rotations already did: a
 * negative count to `wShl`/`wShr` used to shift the other way (BigInt reads
 * a negative count as the opposite shift), where a JavaScript `<<` and the
 * rotations read it from the top of the width.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wRol, wRor, wShl, wShr } from '@jarenjs/core/math';

describe('wShl / wShr — negative and oversized counts', () => {
  it('counts a negative shift from the top of the width, like <<', () => {
    assert.strictEqual(wShl(1n, -1n), BigInt(1 << -1 >>> 0));
    assert.strictEqual(wShl(1n, -1n), 2147483648n);
    assert.strictEqual(wShr(8n, -1n), BigInt(8 >>> -1));
    assert.strictEqual(wShr(0x80000000n, -1n), 1n);
    assert.strictEqual(wShl(1n, -1n, 8), 128n);
    assert.strictEqual(wShl(1n, -9n, 8), 128n);
  });

  it('keeps the wrap of a count at or past the width', () => {
    assert.strictEqual(wShl(1n, 32n), 1n);
    assert.strictEqual(wShl(1n, 33n), 2n);
    assert.strictEqual(wShr(4n, 34n), 1n);
    assert.strictEqual(wShl(1n, 63n, 64), 1n << 63n);
  });

  it('agrees with the rotations on a count of a whole width', () => {
    assert.strictEqual(wShl(5n, 0n), 5n);
    assert.strictEqual(wRol(5n, 32n), 5n);
    assert.strictEqual(wRor(5n, -32n), 5n);
  });

  it('keeps ordinary shifts', () => {
    assert.strictEqual(wShl(3n, 4n), 48n);
    assert.strictEqual(wShr(48n, 4n), 3n);
    assert.strictEqual(wShl(0xffn, 4n, 8), 0xf0n);
    assert.strictEqual(wShl(1n, 7n, 8, true), -128n);
  });
});
