import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  translateIRegexp,
  compileIRegexp,
  isValidIRegexp,
} from '@jarenjs/core/text/iregexp';

describe('translateIRegexp', () => {
  it('should translate dots outside character classes to [^\\n\\r]', () => {
    assert.deepEqual(translateIRegexp('a.b'), 'a[^\\n\\r]b');
    assert.deepEqual(translateIRegexp('.'), '[^\\n\\r]');
    assert.deepEqual(translateIRegexp('[.]'), '[.]'); // literal inside a class
  });

  it('should translate \\- outside a character class to -', () => {
    assert.deepEqual(translateIRegexp('a\\-b'), 'a-b');
    assert.deepEqual(translateIRegexp('[\\-]'), '[\\-]'); // kept inside a class
  });

  it('should pass through single-character escapes', () => {
    assert.deepEqual(translateIRegexp('\\(\\)'), '\\(\\)');
    assert.deepEqual(translateIRegexp('\\[\\]\\{\\}'), '\\[\\]\\{\\}');
    assert.deepEqual(translateIRegexp('\\n\\r\\t'), '\\n\\r\\t');
    assert.deepEqual(translateIRegexp('\\^a'), '\\^a');
  });

  it('should pass through unescaped ^ and $ unchanged (anchor semantics)', () => {
    assert.deepEqual(translateIRegexp('^ab$'), '^ab$');
    assert.deepEqual(translateIRegexp('a[$]'), 'a[$]');
  });

  it('should pass through unicode category escapes', () => {
    assert.deepEqual(translateIRegexp('\\p{L}'), '\\p{L}');
    assert.deepEqual(translateIRegexp('\\p{Lu}'), '\\p{Lu}');
    assert.deepEqual(translateIRegexp('\\P{Lu}'), '\\P{Lu}');
    assert.deepEqual(translateIRegexp('[\\p{Nd}]'), '[\\p{Nd}]');
  });

  it('should pass through range quantifiers', () => {
    assert.deepEqual(translateIRegexp('a{2}'), 'a{2}');
    assert.deepEqual(translateIRegexp('a{2,}'), 'a{2,}');
    assert.deepEqual(translateIRegexp('a{2,4}'), 'a{2,4}');
  });

  it('should keep a trailing -] of a character class', () => {
    assert.deepEqual(translateIRegexp('[a-]'), '[a\\-]');
    assert.deepEqual(translateIRegexp('[-a]'), '[\\-a]');
  });

  it('should accept the empty pattern and empty branches', () => {
    assert.deepEqual(translateIRegexp(''), '');
    assert.deepEqual(translateIRegexp('a|'), 'a|');
  });

  it('should return null for constructs I-Regexp excludes', () => {
    assert.deepEqual(translateIRegexp('(?=a)a'), null); // lookahead
    assert.deepEqual(translateIRegexp('(?:a)'), null); // non-capturing group
    assert.deepEqual(translateIRegexp('(?i)a'), null); // inline flags
    assert.deepEqual(translateIRegexp('(a)\\1'), null); // backreference
    assert.deepEqual(translateIRegexp('\\d'), null); // multi-char escape
    assert.deepEqual(translateIRegexp('\\w'), null);
    assert.deepEqual(translateIRegexp('\\b5'), null); // word boundary
    assert.deepEqual(translateIRegexp('\\$'), null); // not an I-Regexp escape
    assert.deepEqual(translateIRegexp('a*?'), null); // lazy quantifier
    assert.deepEqual(translateIRegexp('a{1,2}?'), null);
  });

  it('should return null for malformed patterns', () => {
    assert.deepEqual(translateIRegexp('(['), null);
    assert.deepEqual(translateIRegexp('a)'), null);
    assert.deepEqual(translateIRegexp('[]'), null); // empty class
    assert.deepEqual(translateIRegexp('[^]'), null); // forbidden by RFC 9485
    assert.deepEqual(translateIRegexp('\\p{Xx}'), null); // unknown category
    assert.deepEqual(translateIRegexp('\\p{Lul}'), null); // bad subcategory
    assert.deepEqual(translateIRegexp('\\p{L'), null); // unterminated
    assert.deepEqual(translateIRegexp('a{'), null); // unterminated quantifier
    assert.deepEqual(translateIRegexp('a{,2}'), null); // missing lower bound
  });

  it('should return null for lone surrogates', () => {
    assert.deepEqual(translateIRegexp('\uD800'), null);
    assert.deepEqual(translateIRegexp('\uDC00'), null);
    assert.deepEqual(translateIRegexp('[\uD800]'), null);
    assert.deepEqual(translateIRegexp('\u{10000}'), '\u{10000}'); // proper pair is fine
  });
});

describe('compileIRegexp', () => {
  it('should compile a search (unanchored) RegExp by default', () => {
    const re = compileIRegexp('[jk]');
    assert.isTrue(re instanceof RegExp);
    assert.deepEqual(re.source, '[jk]');
    assert.isTrue(re.unicode);
    assert.isTrue(re.test('kilo'));
  });

  it('should anchor the whole pattern when fullMatch is true', () => {
    const re = compileIRegexp('[jk]', true);
    assert.deepEqual(re.source, '^(?:[jk])$');
    assert.isTrue(re.test('j'));
    assert.isFalse(re.test('kilo'));
  });

  it('should match dots against anything but line terminators', () => {
    const re = compileIRegexp('a.b', true);
    assert.isTrue(re.test('axb'));
    assert.isFalse(re.test('a\nb'));
    assert.isFalse(re.test('a\rb'));
  });

  it('should return null for invalid patterns', () => {
    assert.deepEqual(compileIRegexp('(?=a)a'), null);
    assert.deepEqual(compileIRegexp('([', true), null);
    assert.deepEqual(compileIRegexp('a{2,1}'), null); // valid grammar, invalid RegExp bounds
  });
});

describe('isValidIRegexp', () => {
  it('should accept the full I-Regexp feature set', () => {
    assert.isTrue(isValidIRegexp('a|b'));
    assert.isTrue(isValidIRegexp('(ab)+'));
    assert.isTrue(isValidIRegexp('a{2,4}'));
    assert.isTrue(isValidIRegexp('[a-c]'));
    assert.isTrue(isValidIRegexp('[^a-c]'));
    assert.isTrue(isValidIRegexp('[\\n-\\r]'));
    assert.isTrue(isValidIRegexp('\\p{L}'));
    assert.isTrue(isValidIRegexp('a\\-b'));
    assert.isTrue(isValidIRegexp(''));
  });

  it('should reject non-I-Regexp patterns', () => {
    assert.isFalse(isValidIRegexp('(?=a)a'));
    assert.isFalse(isValidIRegexp('\\d'));
    assert.isFalse(isValidIRegexp('a*?'));
    assert.isFalse(isValidIRegexp('[^]'));
    assert.isFalse(isValidIRegexp('\uD800'));
  });

  it('should reject non-string input', () => {
    assert.isFalse(isValidIRegexp(5));
    assert.isFalse(isValidIRegexp(null));
    assert.isFalse(isValidIRegexp(undefined));
    assert.isFalse(isValidIRegexp(/a/));
  });
});
