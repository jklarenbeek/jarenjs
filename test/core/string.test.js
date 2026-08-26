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
  toCodePoints,
  fromCodePoints,
  countCodePoints,
  compareCodePoints,
  codePointPrefixSuccessor,
  hashContent,
  fnv1a,
  FNV1A_OFFSET_BASIS,
  kebabCase,
  slugify,
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

describe('toCodePoints / fromCodePoints', () => {
  it('should decode ASCII and BMP characters', () => {
    assert.deepEqual(toCodePoints(''), []);
    assert.deepEqual(toCodePoints('abc'), [0x61, 0x62, 0x63]);
    assert.deepEqual(toCodePoints('héllo'), [0x68, 0xE9, 0x6C, 0x6C, 0x6F]);
    assert.deepEqual(toCodePoints('日本語'), [0x65E5, 0x672C, 0x8A9E]);
  });

  it('should decode a surrogate pair into one code point', () => {
    assert.deepEqual(toCodePoints('🎉'), [0x1F389]);
    assert.deepEqual(toCodePoints('a\u{10000}b'), [0x61, 0x10000, 0x62]);
  });

  it('should keep a lone surrogate as its own code point', () => {
    // Not replaced: a caller validating text has to be able to see it.
    assert.deepEqual(toCodePoints('\uD800'), [0xD800]);
    assert.deepEqual(toCodePoints('\uDC00'), [0xDC00]);
    assert.deepEqual(toCodePoints('a\uD800b'), [0x61, 0xD800, 0x62]);
    assert.deepEqual(toCodePoints('\uDC00\uD800'), [0xDC00, 0xD800], 'reversed pair');
  });

  it('should agree with countCodePoints on length', () => {
    for (const s of ['', 'abc', 'héllo', '🎉', 'a\u{10000}b', '\uD800', 'a\uD800b', '例え.テスト']) {
      assert.deepEqual(toCodePoints(s).length, countCodePoints(s), JSON.stringify(s));
    }
  });

  it('should round-trip through fromCodePoints', () => {
    for (const s of ['', 'a', 'abc', 'héllo', '日本語', '🎉', 'a\u{10000}b',
      '\uD800', '\uDC00', 'a\uD800b', 'x'.repeat(9), 'é'.repeat(40)]) {
      assert.deepEqual(fromCodePoints(toCodePoints(s)), s, JSON.stringify(s));
    }
  });

  it('should round-trip across every fromCodePoints strategy', () => {
    // Short runs concatenate, medium ones spread, long ones spread in
    // chunks - the seams are what this checks.
    for (const len of [0, 1, 7, 8, 9, 4095, 4096, 4097, 9000]) {
      const codes = Array.from({ length: len }, (_, i) => 0x4E00 + (i % 0x100));
      assert.deepEqual(toCodePoints(fromCodePoints(codes)), codes, `length ${len}`);
    }
  });

  it('should not mutate the argument array', () => {
    const codes = [0x61, 0x62, 0x63];
    assert.deepEqual(fromCodePoints(codes), 'abc');
    assert.deepEqual(codes, [0x61, 0x62, 0x63]);
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

describe('codePointPrefixSuccessor', () => {
  // the property the whole helper exists for: it turns "starts with p"
  // into a half-open range, so an ordered index can seek instead of
  // testing every row
  const bounds = (prefix, value) => {
    const upper = codePointPrefixSuccessor(prefix);
    assert.isTrue(upper !== null, 'this suite only ranges over bounded prefixes');
    return compareCodePoints(prefix, value) <= 0 && compareCodePoints(value, upper) < 0;
  };

  it('should increment the last code point', () => {
    assert.deepEqual(codePointPrefixSuccessor('a'), 'b');
    assert.deepEqual(codePointPrefixSuccessor('pre'), 'prf');
    assert.deepEqual(codePointPrefixSuccessor('az'), 'a{');
  });

  it('should step by code point, not by UTF-16 unit', () => {
    // 'a\u{10000}' is three code units; incrementing the last of them
    // would leave a lone high surrogate and an upper bound below the
    // string it is meant to bound
    assert.deepEqual(codePointPrefixSuccessor('a\u{10000}'), 'a\u{10001}');
    assert.deepEqual(codePointPrefixSuccessor('\u{FFFF}'), '\u{10000}');
    assert.isTrue(bounds('a\u{10000}', 'a\u{10000}z'));
    assert.isTrue(bounds('\u{FFFF}', '\u{FFFF}\u{10000}'));
  });

  it('should carry when the last code point is the highest there is', () => {
    assert.deepEqual(codePointPrefixSuccessor('a\u{10FFFF}'), 'b');
    assert.deepEqual(codePointPrefixSuccessor('a\u{10FFFF}\u{10FFFF}'), 'b');
    assert.isTrue(bounds('a\u{10FFFF}', 'a\u{10FFFF}\u{10FFFF}'));
  });

  it('should answer null when no upper bound exists', () => {
    assert.deepEqual(codePointPrefixSuccessor(''), null, 'every string begins with the empty one');
    assert.deepEqual(codePointPrefixSuccessor('\u{10FFFF}'), null);
    assert.deepEqual(codePointPrefixSuccessor('\u{10FFFF}\u{10FFFF}'), null);
  });

  it('should skip the surrogate range so the bound is itself a string', () => {
    assert.deepEqual(codePointPrefixSuccessor('\u{D7FF}'), '\u{E000}');
    assert.isTrue(bounds('\u{D7FF}', '\u{D7FF}a'));
  });

  it('should bound exactly: inside iff it has the prefix', () => {
    const inside = ['pre', 'pre-a', 'pre\u{10FFFF}', 'preZ'];
    const outside = ['pr', 'prf', 'p', '', 'qre', 'PRE'];
    for (const value of inside)
      assert.isTrue(bounds('pre', value), `${JSON.stringify(value)} has the prefix`);
    for (const value of outside)
      assert.isFalse(bounds('pre', value), `${JSON.stringify(value)} does not`);
  });
});

describe('hashContent', () => {
  it('should be a deterministic base-36 FNV-1a fingerprint', () => {
    assert.deepEqual(hashContent('abc'), '7aigaz');
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

describe('slugify', () => {
  it('should lower-case and hyphenate a plain heading', () => {
    assert.deepEqual(slugify('Hello, World!'), 'hello-world');
    assert.deepEqual(slugify('Quick Start'), 'quick-start');
  });

  it('should drop symbols and keep each whitespace as one hyphen', () => {
    assert.deepEqual(slugify('§ 3.1 — Setup'), '-31--setup');
    assert.deepEqual(slugify('a\tb\nc'), 'a-b-c');
  });

  it('should keep non-ASCII letters and digits', () => {
    assert.deepEqual(slugify('Ünicode Wörks'), 'ünicode-wörks');
    assert.deepEqual(slugify('日本語 の 見出し'), '日本語-の-見出し');
  });

  it('should keep hyphens and underscores', () => {
    assert.deepEqual(slugify('snake_case-kept'), 'snake_case-kept');
  });

  it('should reduce punctuation-only text to the empty string', () => {
    assert.deepEqual(slugify('***'), '');
    assert.deepEqual(slugify(''), '');
    assert.deepEqual(slugify('!?@#'), '');
  });

  it('should drop an emoji without eating its neighbours', () => {
    assert.deepEqual(slugify('Ship 🚀 it'), 'ship--it');
  });
});

describe('fnv1a', () => {
  it('is the mixing step hashContent renders', () => {
    assert.isTrue(fnv1a('abc').toString(36) === hashContent('abc'));
    assert.isTrue(fnv1a('').toString(36) === hashContent(''));
  });

  it('is exact FNV-1a: the published 32-bit test vectors', () => {
    // the reference vectors of the FNV-1a 32-bit function; a multiply in
    // doubles instead of Math.imul once rounded the low bits away above
    // 2^53 and passed every other test here while missing all of these
    assert.isTrue(fnv1a('') === 0x811c9dc5);
    assert.isTrue(fnv1a('a') === 0xe40c292c);
    assert.isTrue(fnv1a('foobar') === 0xbf9cf968);
    assert.isTrue(fnv1a('hello') === 0x4f9f2cab);
    assert.isTrue(fnv1a('abc') === 0x1a47e90b);
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
