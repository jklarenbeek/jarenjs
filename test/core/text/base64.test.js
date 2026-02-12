import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidBase64Full,
  isValidBase64Old,
  isValidBase64,
  isValidBase64Fast,
} from '@jarenjs/core/text/base64';

describe('isValidBase64Full', () => {
  it('should return true for valid base64 strings', () => {
    assert.isTrue(isValidBase64Full(''));
    assert.isTrue(isValidBase64Full('Zg=='));
    assert.isTrue(isValidBase64Full('Zm8='));
    assert.isTrue(isValidBase64Full('Zm9v'));
    assert.isTrue(isValidBase64Full('Zm9vYmFy'));
    assert.isTrue(isValidBase64Full('SGVsbG8gV29ybGQ='));
  });

  it('should return false for invalid base64 strings', () => {
    assert.isFalse(isValidBase64Full('Zm9v=')); // wrong padding
    assert.isFalse(isValidBase64Full('Zm9v===')); // too much padding
    assert.isFalse(isValidBase64Full('Zm9v!')); // invalid char
  });
});

describe('isValidBase64Old', () => {
  it('should return true for valid base64 strings', () => {
    assert.isTrue(isValidBase64Old(''));
    assert.isTrue(isValidBase64Old('Zg=='));
    assert.isTrue(isValidBase64Old('Zm9v'));
  });

  it('should return false for strings with wrong length', () => {
    assert.isFalse(isValidBase64Old('Zm9v='));
    assert.isFalse(isValidBase64Old('Zg'));
  });

  it('should return false for strings with invalid characters', () => {
    assert.isFalse(isValidBase64Old('Zm9v!'));
  });
});

describe('isValidBase64', () => {
  it('should return true for valid base64 strings', () => {
    assert.isTrue(isValidBase64(''));
    assert.isTrue(isValidBase64('Zg=='));
    assert.isTrue(isValidBase64('Zm8='));
    assert.isTrue(isValidBase64('Zm9v'));
    assert.isTrue(isValidBase64('SGVsbG8gV29ybGQ='));
  });

  it('should return false for invalid base64 strings', () => {
    assert.isFalse(isValidBase64('Zg'));
    assert.isFalse(isValidBase64('Zm9v!'));
  });
});

describe('isValidBase64Fast', () => {
  it('should return true for valid base64 strings', () => {
    assert.isTrue(isValidBase64Fast(''));
    assert.isTrue(isValidBase64Fast('Zg=='));
    assert.isTrue(isValidBase64Fast('Zm8='));
    assert.isTrue(isValidBase64Fast('Zm9v'));
    assert.isTrue(isValidBase64Fast('SGVsbG8gV29ybGQ='));
  });

  it('should return false for strings with wrong length', () => {
    assert.isFalse(isValidBase64Fast('Zg'));
    assert.isFalse(isValidBase64Fast('Z'));
  });

  it('should return false for strings with invalid characters', () => {
    assert.isFalse(isValidBase64Fast('Zm9v!'));
    assert.isFalse(isValidBase64Fast('Zm9@'));
  });

  it('should handle various valid characters', () => {
    assert.isTrue(isValidBase64Fast('ABCDEFGHIJKLMNOPQRSTUVWX'));
    assert.isTrue(isValidBase64Fast('abcdefghijklmnopqrstuvwx'));
    assert.isTrue(isValidBase64Fast('0123456789+/'));
  });
});
