//@ts-check
/**
 * @file `encodeUrlAttribute` keeps the brackets that delimit an IPv6 literal
 * host: written as `%5B::1%5D` they are no host, and the URL stops parsing.
 * Everywhere else a bracket is encoded like any character outside the set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { encodeUrlAttribute } from '@jarenjs/view/helpers';

describe('view/helpers — encodeUrlAttribute', () => {
  it('keeps an IPv6 literal host a host, so the URL still parses', () => {
    for (const [given, expected] of [
      ['http://[::1]:8080/a', 'http://[::1]:8080/a'],
      ['https://[2001:db8::1]/x y', 'https://[2001:db8::1]/x%20y'],
      ['//[fe80::1]/p', '//[fe80::1]/p'],
      ['http://user@[::1]/a', 'http://user@[::1]/a'],
      ['http://[::ffff:192.0.2.1]/a', 'http://[::ffff:192.0.2.1]/a'],
    ]) {
      assert.strictEqual(encodeUrlAttribute(given), expected, given);
      assert.doesNotThrow(() => new URL(encodeUrlAttribute(given), 'https://base.test/'), given);
    }
  });

  it('encodes a bracket anywhere else, the literal host\'s neighbours included', () => {
    assert.strictEqual(encodeUrlAttribute('http://[::1]/a[1]?q=[2]#f[3]'), 'http://[::1]/a%5B1%5D?q=%5B2%5D#f%5B3%5D');
    assert.strictEqual(encodeUrlAttribute('https://x.test/a[1]'), 'https://x.test/a%5B1%5D');
    assert.strictEqual(encodeUrlAttribute('/a/[::1]/b'), '/a/%5B::1%5D/b');
    assert.strictEqual(encodeUrlAttribute('http://x.test//[::1]'), 'http://x.test//%5B::1%5D');
    assert.strictEqual(encodeUrlAttribute('http://[::1]//[::2]'), 'http://[::1]//%5B::2%5D');
    assert.strictEqual(encodeUrlAttribute('http://[nothex]/a'), 'http://%5Bnothex%5D/a');
  });

  it('is unchanged for everything else: spaces, non-ASCII, an existing octet, a lone percent', () => {
    assert.strictEqual(encodeUrlAttribute('a b'), 'a%20b');
    assert.strictEqual(encodeUrlAttribute('https://x.test/€'), 'https://x.test/%E2%82%AC');
    assert.strictEqual(encodeUrlAttribute('/a%20b%'), '/a%20b%25');
    assert.strictEqual(encodeUrlAttribute('a\\b'), 'a%5Cb');
    assert.strictEqual(encodeUrlAttribute('\u{1F600}'), '%F0%9F%98%80');
  });
});
