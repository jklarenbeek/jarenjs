//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDigitCode,
  isHexDigitCode,
  isWhitespaceCode,
  isAsciiLowerCode,
  isAsciiUpperCode,
  isNameStartCode,
  isNameCharCode,
} from '@jarenjs/core/scan';

const cc = (ch) => ch.charCodeAt(0);

describe('core/scan char-code predicates', function () {
  it('isDigitCode matches 0-9 only', function () {
    assert.equal(isDigitCode(cc('0')), true);
    assert.equal(isDigitCode(cc('9')), true);
    assert.equal(isDigitCode(cc('a')), false);
    assert.equal(isDigitCode(cc('/')), false);
  });

  it('isHexDigitCode matches 0-9, a-f and A-F', function () {
    assert.equal(isHexDigitCode(cc('0')), true);
    assert.equal(isHexDigitCode(cc('f')), true);
    assert.equal(isHexDigitCode(cc('F')), true);
    assert.equal(isHexDigitCode(cc('g')), false);
  });

  it('isWhitespaceCode matches the RFC 9535 set (space, tab, LF, CR) and nothing else', function () {
    for (const ch of [' ', '\t', '\n', '\r']) assert.equal(isWhitespaceCode(cc(ch)), true);
    assert.equal(isWhitespaceCode(cc('x')), false);
    assert.equal(isWhitespaceCode(0x0b), false); // vertical tab is not RFC 9535 whitespace
    assert.equal(isWhitespaceCode(0xa0), false); // NBSP is not RFC 9535 whitespace
  });

  it('isAsciiLowerCode / isAsciiUpperCode split the ASCII letters', function () {
    assert.equal(isAsciiLowerCode(cc('a')), true);
    assert.equal(isAsciiLowerCode(cc('z')), true);
    assert.equal(isAsciiLowerCode(cc('A')), false);
    assert.equal(isAsciiUpperCode(cc('A')), true);
    assert.equal(isAsciiUpperCode(cc('Z')), true);
    assert.equal(isAsciiUpperCode(cc('a')), false);
  });
});

describe('core/scan name-character predicates', function () {
  it('isNameStartCode admits ASCII letters, underscore and any non-ASCII unit', function () {
    for (const ch of ['A', 'Z', 'a', 'z', '_', 'é', '中']) {
      assert.equal(isNameStartCode(cc(ch)), true, ch);
    }
    for (const ch of ['0', '9', '-', '.', ' ', '$']) {
      assert.equal(isNameStartCode(cc(ch)), false, ch);
    }
  });

  it('isNameCharCode adds the ASCII digits and nothing else', function () {
    assert.equal(isNameCharCode(cc('0')), true);
    assert.equal(isNameCharCode(cc('9')), true);
    assert.equal(isNameCharCode(cc('a')), true);
    // '-' and '.' belong to XML Name, not to this class; grammars that want
    // them test for them on top of this predicate.
    assert.equal(isNameCharCode(cc('-')), false);
    assert.equal(isNameCharCode(cc('.')), false);
  });
});
