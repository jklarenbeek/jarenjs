import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidAlpha,
  isValidAlphaNumeric,
  isValidNumeric,
  isValidHexaDecimal,
  isValidHexColor,
} from '@jarenjs/core/text/basic';

describe('isValidAlpha', () => {
  it('should return true for alphabetic strings', () => {
    assert.isTrue(isValidAlpha('abc'));
    assert.isTrue(isValidAlpha('ABC'));
    assert.isTrue(isValidAlpha('AbC'));
  });

  it('should return false for non-alphabetic strings', () => {
    assert.isFalse(isValidAlpha('abc123'));
    assert.isFalse(isValidAlpha('123'));
    assert.isFalse(isValidAlpha('abc-123'));
    assert.isFalse(isValidAlpha(''));
  });
});

describe('isValidAlphaNumeric', () => {
  it('should return true for alphanumeric strings', () => {
    assert.isTrue(isValidAlphaNumeric('abc123'));
    assert.isTrue(isValidAlphaNumeric('ABC'));
    assert.isTrue(isValidAlphaNumeric('123'));
    assert.isTrue(isValidAlphaNumeric('a1B2c3'));
  });

  it('should return false for non-alphanumeric strings', () => {
    assert.isFalse(isValidAlphaNumeric('abc-123'));
    assert.isFalse(isValidAlphaNumeric('abc_123'));
    assert.isFalse(isValidAlphaNumeric(''));
    assert.isFalse(isValidAlphaNumeric('hello world'));
  });
});

describe('isValidNumeric', () => {
  it('should return true for numeric strings', () => {
    assert.isTrue(isValidNumeric('123'));
    assert.isTrue(isValidNumeric('0'));
    assert.isTrue(isValidNumeric('9876543210'));
  });

  it('should return false for non-numeric strings', () => {
    assert.isFalse(isValidNumeric('abc'));
    assert.isFalse(isValidNumeric('12.34'));
    assert.isFalse(isValidNumeric('-123'));
    assert.isFalse(isValidNumeric(''));
    assert.isFalse(isValidNumeric('12a'));
  });
});

describe('isValidHexaDecimal', () => {
  it('should return true for hexadecimal strings', () => {
    assert.isTrue(isValidHexaDecimal('0123456789'));
    assert.isTrue(isValidHexaDecimal('abcdef'));
    assert.isTrue(isValidHexaDecimal('ABCDEF'));
    assert.isTrue(isValidHexaDecimal('a1B2c3D4'));
  });

  it('should return false for non-hexadecimal strings', () => {
    assert.isFalse(isValidHexaDecimal('ghij'));
    assert.isFalse(isValidHexaDecimal('0x123')); // 0x prefix not allowed
    assert.isFalse(isValidHexaDecimal(''));
    assert.isFalse(isValidHexaDecimal('123g'));
  });
});

describe('isValidHexColor', () => {
  it('should return true for 3-digit hex colors', () => {
    assert.isTrue(isValidHexColor('#FFF'));
    assert.isTrue(isValidHexColor('#fff'));
    assert.isTrue(isValidHexColor('#a1B'));
  });

  it('should return true for 6-digit hex colors', () => {
    assert.isTrue(isValidHexColor('#FFFFFF'));
    assert.isTrue(isValidHexColor('#ffffff'));
    assert.isTrue(isValidHexColor('#a1B2c3'));
  });

  it('should return false for invalid hex colors', () => {
    assert.isFalse(isValidHexColor('FFF')); // missing #
    assert.isFalse(isValidHexColor('#FF')); // too short
    assert.isFalse(isValidHexColor('#FFFF')); // 4 digits
    assert.isFalse(isValidHexColor('#FFFFFFF')); // 7 digits
    assert.isFalse(isValidHexColor('#GGG')); // invalid characters
    assert.isFalse(isValidHexColor(''));
  });
});
