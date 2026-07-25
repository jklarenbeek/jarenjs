import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  isStringEmpty,
  isStringWhiteSpace,
  isStringUpperCase,
  isStringLowerCase,
  isRegExpType,
  isStringRegExp,
  createRegExp,
  getSegmenter,
  isAsciiString,
  getStringLength,
  countCodePoints,
  compareCodePoints,
  hashContent,
  fnv1a,
  FNV1A_OFFSET_BASIS,
  kebabCase,
} from '@jarenjs/core/string';

describe('isStringEmpty', () => {
  it('should return true for empty string', () => {
    assert.isTrue(isStringEmpty(''));
  });

  it('should return false for non-empty string', () => {
    assert.isFalse(isStringEmpty('hello'));
    assert.isFalse(isStringEmpty(' '));
  });

  it('should return false for non-string values', () => {
    assert.isFalse(isStringEmpty(null));
    assert.isFalse(isStringEmpty(undefined));
    assert.isFalse(isStringEmpty(0));
  });
});

describe('isStringWhiteSpace', () => {
  it('should return true for whitespace-only strings', () => {
    assert.isTrue(isStringWhiteSpace(' '));
    assert.isTrue(isStringWhiteSpace('   '));
    assert.isTrue(isStringWhiteSpace('\t'));
    assert.isTrue(isStringWhiteSpace('\n'));
    assert.isTrue(isStringWhiteSpace('\t\n\r '));
  });

  it('should return true for null and undefined', () => {
    assert.isTrue(isStringWhiteSpace(null));
    assert.isTrue(isStringWhiteSpace(undefined));
  });

  it('should return true for empty string', () => {
    assert.isTrue(isStringWhiteSpace(''));
  });

  it('should return false for non-whitespace strings', () => {
    assert.isFalse(isStringWhiteSpace('hello'));
    assert.isFalse(isStringWhiteSpace(' hello '));
  });
});

describe('isStringUpperCase', () => {
  it('should return true for uppercase strings', () => {
    assert.isTrue(isStringUpperCase('HELLO'));
    assert.isTrue(isStringUpperCase('ABC'));
  });

  it('should return true for strings with no letters', () => {
    assert.isTrue(isStringUpperCase('123'));
    assert.isTrue(isStringUpperCase('!!!'));
  });

  it('should return false for lowercase strings', () => {
    assert.isFalse(isStringUpperCase('hello'));
    assert.isFalse(isStringUpperCase('Hello'));
  });
});

describe('isStringLowerCase', () => {
  it('should return true for lowercase strings', () => {
    assert.isTrue(isStringLowerCase('hello'));
    assert.isTrue(isStringLowerCase('abc'));
  });

  it('should return true for strings with no letters', () => {
    assert.isTrue(isStringLowerCase('123'));
    assert.isTrue(isStringLowerCase('!!!'));
  });

  it('should return false for uppercase strings', () => {
    assert.isFalse(isStringLowerCase('HELLO'));
    assert.isFalse(isStringLowerCase('Hello'));
  });
});

describe('isRegExpType', () => {
  it('should return true for RegExp objects', () => {
    assert.isTrue(isRegExpType(/test/));
    assert.isTrue(isRegExpType(new RegExp('test')));
    assert.isTrue(isRegExpType(/test/gi));
  });

  it('should return false for non-RegExp values', () => {
    assert.isFalse(isRegExpType('/test/'));
    assert.isFalse(isRegExpType(null));
    assert.isFalse(isRegExpType(undefined));
    assert.isFalse(isRegExpType({}));
  });
});

describe('isStringRegExp', () => {
  it('should return true for valid regex patterns', () => {
    assert.isTrue(isStringRegExp('abc'));
    assert.isTrue(isStringRegExp('[a-z]+'));
    assert.isTrue(isStringRegExp('/test/'));
    assert.isTrue(isStringRegExp('/test/gi'));
  });

  it('should return false for invalid regex patterns', () => {
    assert.isFalse(isStringRegExp('[invalid'));
    assert.isFalse(isStringRegExp('(?!unbalanced'));
  });
});

describe('createRegExp', () => {
  it('should return undefined for null/undefined', () => {
    assert.deepEqual(createRegExp(null), undefined);
    assert.deepEqual(createRegExp(undefined), undefined);
  });

  it('should return RegExp as-is', () => {
    const re = /test/gi;
    assert.deepEqual(createRegExp(re), re);
  });

  it('should create RegExp from string pattern', () => {
    const result = createRegExp('test');
    assert.isTrue(result instanceof RegExp);
    assert.isTrue(result.test('test'));
  });

  it('should parse /pattern/flags format', () => {
    const result = createRegExp('/test/gi');
    assert.isTrue(result instanceof RegExp);
    assert.isTrue(result.global);
    assert.isTrue(result.ignoreCase);
  });

  it('should add unicode flag to string patterns', () => {
    const result = createRegExp('test');
    assert.isTrue(result.unicode);
  });

  it('should throw for unknown pattern types', () => {
    assert.throws(() => createRegExp(123), /Unknown Regular Expression Pattern Type/);
  });
});

describe('getSegmenter', () => {
  it('should return an Intl.Segmenter instance', () => {
    const segmenter = getSegmenter();
    assert.isTrue(segmenter instanceof Intl.Segmenter);
  });

  it('should return same instance on multiple calls', () => {
    const s1 = getSegmenter();
    const s2 = getSegmenter();
    assert.deepEqual(s1, s2);
  });
});

describe('isAsciiString', () => {
  it('should return true for ASCII strings', () => {
    assert.isTrue(isAsciiString('hello'));
    assert.isTrue(isAsciiString('Hello World 123'));
    assert.isTrue(isAsciiString('!@#$%'));
  });

  it('should return false for non-ASCII strings', () => {
    assert.isFalse(isAsciiString('héllo'));
    assert.isFalse(isAsciiString('日本語'));
    assert.isFalse(isAsciiString('🎉'));
  });

  it('should return true for empty string', () => {
    assert.isTrue(isAsciiString(''));
  });
});

describe('getStringLength', () => {
  it('should return code unit length when useGrapheme is false', () => {
    assert.deepEqual(getStringLength('hello', false), 5);
    assert.deepEqual(getStringLength('héllo', false), 5); // é is 1 code unit in UTF-16
  });

  it('should return code unit length by default', () => {
    assert.deepEqual(getStringLength('hello'), 5);
    assert.deepEqual(getStringLength('héllo'), 5);
  });

  it('should return grapheme count when useGrapheme is true', () => {
    assert.deepEqual(getStringLength('hello', true), 5);
    assert.deepEqual(getStringLength('héllo', true), 5); // é is 1 grapheme
  });

  it('should handle emoji correctly with grapheme counting', () => {
    assert.deepEqual(getStringLength('🎉', true), 1);
    assert.deepEqual(getStringLength('👨‍👩‍👧‍👦', true), 1); // family emoji is 1 grapheme
  });

  it('should handle empty string', () => {
    assert.deepEqual(getStringLength(''), 0);
    assert.deepEqual(getStringLength('', true), 0);
  });
});

describe('countCodePoints', () => {
  it('should count ASCII strings by character', () => {
    assert.deepEqual(countCodePoints(''), 0);
    assert.deepEqual(countCodePoints('hello'), 5);
  });

  it('should count BMP characters as one code point', () => {
    assert.deepEqual(countCodePoints('héllo'), 5);
    assert.deepEqual(countCodePoints('日本語'), 3);
    assert.deepEqual(countCodePoints('｡'), 1);
  });

  it('should count surrogate pairs as one code point', () => {
    assert.deepEqual(countCodePoints('🎉'), 1); // 2 UTF-16 code units
    assert.deepEqual(countCodePoints('a\u{10000}b'), 3);
    assert.deepEqual(countCodePoints('𝄞𝄞'), 2);
  });

  it('should tolerate lone surrogates as one code point each', () => {
    assert.deepEqual(countCodePoints('\uD800'), 1);
    assert.deepEqual(countCodePoints('\uDC00'), 1);
    assert.deepEqual(countCodePoints('a\uD800b'), 3); // lone high before non-low
    assert.deepEqual(countCodePoints('\uDC00\uD800'), 2); // reversed pair
  });
});

describe('compareCodePoints', () => {
  it('should return 0 for equal strings', () => {
    assert.deepEqual(compareCodePoints('', ''), 0);
    assert.deepEqual(compareCodePoints('abc', 'abc'), 0);
    assert.deepEqual(compareCodePoints('a\u{10000}', 'a\u{10000}'), 0);
  });

  it('should order by the first differing code point', () => {
    assert.deepEqual(compareCodePoints('abc', 'abd'), -1);
    assert.deepEqual(compareCodePoints('abd', 'abc'), 1);
    assert.deepEqual(compareCodePoints('b', 'a'), 1);
  });

  it('should sort a prefix before the longer string', () => {
    assert.deepEqual(compareCodePoints('ab', 'abc'), -1);
    assert.deepEqual(compareCodePoints('abc', 'ab'), 1);
    assert.deepEqual(compareCodePoints('', 'a'), -1);
  });

  it('should order by Unicode scalar values where UTF-16 code units disagree', () => {
    // U+FF61 (halfwidth ideographic full stop) vs U+10000 (surrogate pair):
    // native < compares code units and puts the pair first — scalar order
    // puts U+FF61 first
    assert.isTrue('｡' > '\u{10000}');
    assert.deepEqual(compareCodePoints('｡', '\u{10000}'), -1);
    assert.deepEqual(compareCodePoints('\u{10000}', '｡'), 1);
  });
});

describe('hashContent', () => {
  it('should be a deterministic base-36 FNV-1a fingerprint', () => {
    assert.deepEqual(hashContent('abc'), '7aigb0');
    assert.deepEqual(hashContent('abc'), hashContent('abc'));
    assert.deepEqual(hashContent(''), 'ztntfp');
  });

  it('should distinguish different content', () => {
    assert.isTrue(hashContent('graph TD; A-->B') !== hashContent('graph TD; A-->C'));
  });

  it('should return at most 7 base-36 chars', () => {
    for (const s of ['', 'x', 'a longer string of content', '🙂 unicode']) {
      const h = hashContent(s);
      assert.isTrue(h.length <= 7);
      assert.isTrue(/^[0-9a-z]+$/.test(h));
    }
  });
});

describe('kebabCase', () => {
  it('should hyphenate camelCase', () => {
    assert.deepEqual(kebabCase('fontFamily'), 'font-family');
    assert.deepEqual(kebabCase('surfaceLo'), 'surface-lo');
    assert.deepEqual(kebabCase('edgeLabelBg'), 'edge-label-bg');
  });

  it('should leave already-lowercase or hyphenated input unchanged', () => {
    assert.deepEqual(kebabCase('background'), 'background');
    assert.deepEqual(kebabCase('line-color'), 'line-color');
    assert.deepEqual(kebabCase(''), '');
  });
});

describe('fnv1a', () => {
  it('is the mixing step hashContent renders', () => {
    assert.isTrue(fnv1a('abc').toString(36) === hashContent('abc'));
    assert.isTrue(fnv1a('').toString(36) === hashContent(''));
  });

  it('returns an unsigned 32-bit number', () => {
    for (const s of ['', 'a', 'the quick brown fox', 'ÿĀ']) {
      const h = fnv1a(s);
      assert.isTrue(Number.isInteger(h));
      assert.isTrue(h >= 0 && h <= 0xffffffff);
    }
  });

  it('seeds so a chunked hash equals the whole-string hash', () => {
    assert.isTrue(fnv1a('def', fnv1a('abc')) === fnv1a('abcdef'));
    assert.isTrue(fnv1a('c', fnv1a('b', fnv1a('a'))) === fnv1a('abc'));
    assert.isTrue(fnv1a('abc', FNV1A_OFFSET_BASIS) === fnv1a('abc'));
  });
});
