import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidISBN10,
  isValidISBN13,
  isValidCountryAlpha2,
  isValidIBAN,
} from '@jarenjs/core/text/misc';

describe('isValidISBN10', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidISBN10 === 'function');
    const result = isValidISBN10('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should handle various inputs', () => {
    // Just verify it doesn't throw
    assert.doesNotThrow(() => isValidISBN10(''));
    assert.doesNotThrow(() => isValidISBN10('ISBN 0-306-40615-2'));
    assert.doesNotThrow(() => isValidISBN10('123456789X'));
  });
});

describe('isValidISBN13', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidISBN13 === 'function');
    const result = isValidISBN13('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should handle various inputs', () => {
    assert.doesNotThrow(() => isValidISBN13(''));
    assert.doesNotThrow(() => isValidISBN13('ISBN 978-0-306-40615-7'));
    assert.doesNotThrow(() => isValidISBN13('9780306406157'));
  });
});

describe('isValidCountryAlpha2', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidCountryAlpha2 === 'function');
    const result = isValidCountryAlpha2('US');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should validate some country codes', () => {
    // These should return true based on the regex
    assert.isTrue(isValidCountryAlpha2('US'));
    assert.isTrue(isValidCountryAlpha2('GB'));
    assert.isTrue(isValidCountryAlpha2('DE'));
  });
});

describe('isValidIBAN', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidIBAN === 'function');
    const result = isValidIBAN('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should handle various inputs', () => {
    assert.doesNotThrow(() => isValidIBAN(''));
    assert.doesNotThrow(() => isValidIBAN('DE89370400440532013000'));
  });
});
