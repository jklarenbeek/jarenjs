//@ts-check
/**
 * @file `countCodePoints`, `countCharCode`, `toCodePoints`, `fnv1a` and
 * `hashContent` read a string and refuse everything else, as
 * `utf8ByteLength` does: a number, a boolean or an object has no
 * `length`, so each used to answer as if given the empty string
 * (`hashContent({})` was `hashContent('')`). Every input that answered
 * right before still answers the same.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { countCodePoints, countCharCode, toCodePoints, fnv1a, hashContent, codePointPrefixSuccessor } from '../../packages/core/src/string.js';

const given = /** @type {[unknown, string][]} */ ([
  [5, 'a number'], [0, 'a number'], [true, 'a boolean'], [10n, 'a bigint'], [Symbol('s'), 'a symbol'],
  [{}, 'an object'], [[], 'an array'], [() => 'abc', 'a function'],
  [{ length: 1, charCodeAt: () => 65 }, 'an object'], [null, 'null'], [undefined, 'undefined'],
]);

/** @type {[string, (v: any) => unknown][]} */
const helpers = [
  ['countCodePoints', (v) => countCodePoints(v)],
  ['countCharCode', (v) => countCharCode(v, 48)],
  ['toCodePoints', (v) => toCodePoints(v)],
  ['fnv1a', (v) => fnv1a(v)],
  ['hashContent', (v) => hashContent(v)],
];

describe('string helpers refuse a non-string', () => {
  for (const [name, call] of helpers) {
    it(`${name} refuses each shape that answered as the empty string, naming what was given`, () => {
      for (const [input, kind] of given)
        assert.throws(() => call(input), { name: 'TypeError', message: `${name}: expected a string, got ${kind}` }, `${name} ${kind}`);
    });
  }

  it('refuses a non-string slice too, and a seeded fnv1a', () => {
    assert.throws(() => countCharCode(/** @type {any} */ (5), 48, 0, 1), { name: 'TypeError', message: 'countCharCode: expected a string, got a number' });
    assert.throws(() => fnv1a(/** @type {any} */ ({}), fnv1a('a')), { name: 'TypeError', message: 'fnv1a: expected a string, got an object' });
  });

  it('a prefix bound over a non-string is refused, not answered "no bound"', () => {
    assert.throws(() => codePointPrefixSuccessor(/** @type {any} */ (5)), { name: 'TypeError', message: 'toCodePoints: expected a string, got a number' });
  });
});

describe('string helpers answer every string as before', () => {
  it('counts code points, lone surrogates as one', () => {
    assert.deepStrictEqual(['', 'abc', 'é€', 'a😀b', 'a\ud800', '\udc00b'].map(countCodePoints), [0, 3, 2, 3, 2, 2]);
  });

  it('counts a code unit over a slice, an end left undefined being the length', () => {
    assert.strictEqual(countCharCode('0a00b0', 48), 4);
    assert.strictEqual(countCharCode('0a00b0', 48, 1), 3);
    assert.strictEqual(countCharCode('0a00b0', 48, 0, 3), 2);
    assert.strictEqual(countCharCode('0a00b0', 48, 2, undefined), 3);
  });

  it('decodes code points, keeping a lone surrogate', () => {
    assert.deepStrictEqual(toCodePoints('a😀\ud800'), [0x61, 0x1F600, 0xD800]);
    assert.deepStrictEqual(toCodePoints(''), []);
  });

  it('hashes as before: the published values and the seed chain', () => {
    assert.strictEqual(fnv1a(''), 0x811c9dc5);
    assert.strictEqual(fnv1a('a'), 0xe40c292c);
    assert.strictEqual(hashContent(''), 'ztntfp');
    assert.strictEqual(fnv1a('cd', fnv1a('ab')), fnv1a('abcd'));
  });

  it('reads a String wrapper object as the string it wraps, as it did', () => {
    const w = /** @type {any} */ (new String('a😀0'));
    assert.strictEqual(countCodePoints(w), 3);
    assert.strictEqual(countCharCode(w, 48), 1);
    assert.deepStrictEqual(toCodePoints(w), [0x61, 0x1F600, 0x30]);
    assert.strictEqual(fnv1a(w), fnv1a('a😀0'));
    assert.strictEqual(hashContent(w), hashContent('a😀0'));
  });
});
