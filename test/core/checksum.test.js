//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '@jarenjs/core/checksum';

const utf8 = new TextEncoder();

describe('core/checksum — CRC-32', () => {
  it('matches independent reference checksums, including the empty byte sequence', () => {
    assert.equal(crc32(new Uint8Array()), 0);
    assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926);
    assert.equal(crc32(utf8.encode('abc')), 0x352441c2);
    assert.equal(crc32(new Uint8Array([0])), 0xd202ef8d);
    assert.equal(crc32(Uint8Array.from({ length: 256 }, (_, i) => i)), 0x29058c73);
  });

  it('checks only a view’s bytes and preserves the complete underlying buffer', () => {
    const bytes = new Uint8Array([255, 97, 98, 99, 255]);
    assert.equal(crc32(bytes.subarray(1, 4)), 0x352441c2);
    assert.deepEqual(bytes, new Uint8Array([255, 97, 98, 99, 255]));
  });
});
