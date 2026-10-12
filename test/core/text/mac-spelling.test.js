//@ts-check
/**
 * @file A hardware address is written in one spelling throughout. The
 * pattern captured its first separator and never compared the rest, so
 * `aa:bb:cc-dd:ee:ff`, `Bf27.c107d3b1` and `aabb.ccdd:eeff` all passed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isValidMACAddr } from '@jarenjs/core/text/host';

describe('isValidMACAddr - one spelling per address', () => {
  it('accepts the four EUI-48 spellings, in either case', () => {
    for (const text of ['00:1A:2B:3C:4D:5E', '00-1a-2b-3c-4d-5e', '001a.2b3c.4d5e', '001A2B3C4D5E'])
      assert.strictEqual(isValidMACAddr(text), true, text);
  });

  it('refuses separators that change inside one address', () => {
    for (const text of ['aa:bb:cc-dd:ee:ff', 'aa-bb:cc-dd-ee-ff', 'aa:bb.cc:dd:ee:ff', 'aabb.ccdd:eeff', 'aabb:ccdd:eeff'])
      assert.strictEqual(isValidMACAddr(text), false, text);
  });

  it('refuses groupings that are no spelling of six octets', () => {
    for (const text of ['Bf27.c107d3b1', '3c42.87bb8c4a', 'aabb-ccdd-eeff', 'aa.bb.cc.dd.ee.ff', 'aa:bbcc:dd:eeff',
      'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'aa:bb:cc:dd:ee:ff\n', 'aa:bb:cc:dd:ee:f', ''])
      assert.strictEqual(isValidMACAddr(text), false, JSON.stringify(text));
  });
});
