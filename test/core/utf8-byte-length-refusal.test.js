//@ts-check
/**
 * @file `utf8ByteLength` measures a string and refuses everything else:
 * a number, a boolean or an object used to answer 0 bytes, so a
 * non-string reaching a byte bound passed it as empty. Every input that
 * answered right before still answers the same.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { utf8ByteLength } from '../../packages/core/src/string.js';

const encoded = (/** @type {string} */ s) => new TextEncoder().encode(s).length;

describe('utf8ByteLength refuses a non-string', () => {
  it('refuses each shape that answered 0, with a TypeError naming what was given', () => {
    const given = /** @type {[unknown, string][]} */ ([
      [5, 'a number'], [0, 'a number'], [true, 'a boolean'], [10n, 'a bigint'], [Symbol('s'), 'a symbol'],
      [{}, 'an object'], [[], 'an array'], [() => 'abc', 'a function'],
      [{ length: 1, charCodeAt: () => 65 }, 'an object'],
    ]);
    for (const [input, kind] of given) {
      assert.throws(() => utf8ByteLength(/** @type {any} */ (input)),
        { name: 'TypeError', message: `utf8ByteLength: expected a string, got ${kind}` }, kind);
      assert.throws(() => utf8ByteLength(/** @type {any} */ (input), 0, 1), TypeError, kind);
    }
  });

  it('still refuses null and undefined with a TypeError, now naming them', () => {
    assert.throws(() => utf8ByteLength(/** @type {any} */ (null)), { name: 'TypeError', message: 'utf8ByteLength: expected a string, got null' });
    assert.throws(() => utf8ByteLength(/** @type {any} */ (undefined)), { name: 'TypeError', message: 'utf8ByteLength: expected a string, got undefined' });
  });
});

describe('utf8ByteLength answers every string as before', () => {
  it('agrees with TextEncoder on whole strings, lone surrogates included', () => {
    for (const s of ['', 'abc', 'é', '€', '𝄞', 'a\ud800', '\udc00b', '\ud800\ud800', 'mixed é€😀 text'])
      assert.strictEqual(utf8ByteLength(s), encoded(s), JSON.stringify(s));
  });

  it('measures a slice, and an end left undefined is the string\'s length', () => {
    const s = 'aé€𝄞';
    assert.strictEqual(utf8ByteLength(s, 1), encoded(s.slice(1)));
    assert.strictEqual(utf8ByteLength(s, 0, 3), encoded(s.slice(0, 3)));
    assert.strictEqual(utf8ByteLength(s, 1, undefined), encoded(s.slice(1)));
    assert.strictEqual(utf8ByteLength(s, undefined, 2), encoded(s.slice(0, 2)));
    // a pair cut by the slice end counts its high half as a replacement
    assert.strictEqual(utf8ByteLength(s, 3, 4), 3);
  });

  it('measures a String wrapper object as the string it wraps, as it did', () => {
    assert.strictEqual(utf8ByteLength(/** @type {any} */ (new String('é€'))), 5);
    assert.strictEqual(utf8ByteLength(/** @type {any} */ (new String('abc')), 1, 2), 1);
  });
});
