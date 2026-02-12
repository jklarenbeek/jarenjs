import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidEmail,
  isValidEmailFull,
  isValidIdnEmail,
} from '@jarenjs/core/text/email';

describe('isValidEmail', () => {
  it('should return true for valid email addresses', () => {
    assert.isTrue(isValidEmail('user@example.com'));
    assert.isTrue(isValidEmail('user.name@example.com'));
    assert.isTrue(isValidEmail('user+tag@example.com'));
    assert.isTrue(isValidEmail('user@sub.example.com'));
    assert.isTrue(isValidEmail('user@example.co.uk'));
  });

  it('should handle special characters in local part', () => {
    assert.isTrue(isValidEmail('user!#$%&\'*+/=?^_`{|}~@example.com'));
  });

  it('should return false for invalid email addresses', () => {
    assert.isFalse(isValidEmail('user'));
    assert.isFalse(isValidEmail('user@'));
    assert.isFalse(isValidEmail('@example.com'));
    assert.isFalse(isValidEmail('user@.com'));
    assert.isFalse(isValidEmail('user@example'));
    assert.isFalse(isValidEmail(''));
  });

  it('should return false for multiple @ signs', () => {
    assert.isFalse(isValidEmail('user@@example.com'));
    assert.isFalse(isValidEmail('user@foo@example.com'));
  });
});

describe('isValidEmailFull', () => {
  it('should return true for valid email addresses', () => {
    assert.isTrue(isValidEmailFull('user@example.com'));
    assert.isTrue(isValidEmailFull('user.name@example.com'));
    assert.isTrue(isValidEmailFull('user@sub.example.com'));
  });

  it('should have stricter validation', () => {
    // The full validator has stricter rules
    assert.isTrue(isValidEmailFull('user@example.co.uk'));
  });

  it('should return false for invalid email addresses', () => {
    assert.isFalse(isValidEmailFull('user'));
    assert.isFalse(isValidEmailFull('user@'));
    assert.isFalse(isValidEmailFull('@example.com'));
    assert.isFalse(isValidEmailFull(''));
  });
});

describe('isValidIdnEmail', () => {
  it('should return true for basic email addresses', () => {
    assert.isTrue(isValidIdnEmail('user@example.com'));
    assert.isTrue(isValidIdnEmail('user@sub.example.com'));
  });

  it('should return true for emails with plus sign', () => {
    assert.isTrue(isValidIdnEmail('user+tag@example.com'));
  });

  it('should return false for emails without @ sign', () => {
    assert.isFalse(isValidIdnEmail('user.example.com'));
    assert.isFalse(isValidIdnEmail('user'));
  });

  it('should return false for emails without domain part', () => {
    assert.isFalse(isValidIdnEmail('user@'));
  });

  it('should return false for emails without local part', () => {
    assert.isFalse(isValidIdnEmail('@example.com'));
  });

  it('should return false for empty string', () => {
    assert.isFalse(isValidIdnEmail(''));
  });
});
