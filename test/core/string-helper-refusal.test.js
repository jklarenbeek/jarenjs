//@ts-check
/**
 * @file `countCodePoints`, `countCharCode`, `toCodePoints`, `fnv1a`,
 * `hashContent`, `isAsciiString`, `getStringLength` and `slugify` read a
 * string and refuse everything else, as `utf8ByteLength` does, and
 * `fromCodePoints` refuses what is no list of code points: a number, a
 * boolean or an object has no `length`, so each used to answer as if given
 * the empty string (`hashContent({})` was `hashContent('')`,
 * `isAsciiString(5)` was `true`, `getStringLength(5, true)` was `NaN`).
 * Every input that answered right before still answers the same.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  countCodePoints, countCharCode, toCodePoints, fnv1a, hashContent, codePointPrefixSuccessor,
  isAsciiString, getStringLength, fromCodePoints, slugify,
} from '../../packages/core/src/string.js';

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
  ['isAsciiString', (v) => isAsciiString(v)],
  ['getStringLength', (v) => getStringLength(v)],
  ['slugify', (v) => slugify(v)],
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

describe('the length, ASCII, slug and code-point builders refuse what they answered wrong for', () => {
  it('a grapheme length of a non-string is refused, not NaN', () => {
    assert.throws(() => getStringLength(/** @type {any} */ (5), true), { name: 'TypeError', message: 'getStringLength: expected a string, got a number' });
    assert.throws(() => getStringLength(/** @type {any} */ ({}), true), { name: 'TypeError', message: 'getStringLength: expected a string, got an object' });
  });

  it('fromCodePoints refuses a value that is no list of code points, a string among them', () => {
    const refused = /** @type {[unknown, string][]} */ ([
      [5, 'a number'], [true, 'a boolean'], [10n, 'a bigint'], [Symbol('s'), 'a symbol'], [{}, 'an object'],
      [new Set([65]), 'an object'], [() => 65, 'a function'], ['65', 'a string'], [new String('65'), 'an object'],
      [null, 'null'], [undefined, 'undefined'],
    ]);
    for (const [input, kind] of refused)
      assert.throws(() => fromCodePoints(/** @type {any} */ (input)), { name: 'TypeError', message: `fromCodePoints: expected an array of code points, got ${kind}` }, kind);
  });

  it('answers every string, array, typed array and array-like as before', () => {
    assert.deepStrictEqual(['', 'abc', 'abc\x7f', 'é', 'a😀'].map(isAsciiString), [true, true, true, false, false]);
    assert.deepStrictEqual(['', 'abc', 'a😀', 'e\u0301', 'a\r\nb', '🇳🇱'].map((s) => getStringLength(s)), [0, 3, 3, 2, 4, 4]);
    assert.deepStrictEqual(['', 'abc', 'a😀', 'e\u0301', 'a\r\nb', '🇳🇱'].map((s) => getStringLength(s, true)), [0, 3, 2, 1, 3, 1]);
    assert.strictEqual(fromCodePoints([]), '');
    assert.strictEqual(fromCodePoints([0x61, 0x1F600, 0xD800]), 'a😀\ud800');
    assert.strictEqual(fromCodePoints(new Uint32Array([65, 66])), 'AB');
    assert.strictEqual(fromCodePoints(Array.from('abcdefghij', (c) => c.charCodeAt(0))), 'abcdefghij');
    // a short array-like object is still read, as it was (unchanged, not a promise)
    assert.strictEqual(fromCodePoints(/** @type {any} */ ({ length: 2, 0: 65, 1: 66 })), 'AB');
    assert.deepStrictEqual(['Hello, World!', '§ 3.1 — Setup', '***', 'Ünicode Wörks'].map(slugify), ['hello-world', '-31--setup', '', 'ünicode-wörks']);
  });

  it('reads a String wrapper object as the string it wraps, as it did', () => {
    const w = /** @type {any} */ (new String('A é'));
    assert.strictEqual(isAsciiString(w), false);
    assert.strictEqual(getStringLength(w), 3);
    assert.strictEqual(getStringLength(w, true), 3);
    assert.strictEqual(slugify(w), 'a-é');
  });
});
