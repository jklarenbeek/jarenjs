import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidUUID,
  isValidGUID,
  isValidIdentifier,
  isValidHtmlIdentifier,
  isValidCssIdentifier,
} from '@jarenjs/core/text/identifiers';

describe('isValidUUID', () => {
  it('should return true for valid UUIDs', () => {
    assert.isTrue(isValidUUID('550e8400-e29b-41d4-a716-446655440000'));
    assert.isTrue(isValidUUID('550e8400-e29b-41d4-a716-446655440000'));
    assert.isTrue(isValidUUID('00000000-0000-0000-0000-000000000000'));
    assert.isTrue(isValidUUID('ffffffff-ffff-ffff-ffff-ffffffffffff'));
  });

  it('should return true for UUIDs with urn:uuid: prefix', () => {
    assert.isTrue(isValidUUID('urn:uuid:550e8400-e29b-41d4-a716-446655440000'));
  });

  it('should return false for invalid UUIDs', () => {
    assert.isFalse(isValidUUID('550e8400-e29b-41d4-a716'));
    assert.isFalse(isValidUUID('not-a-uuid'));
    assert.isFalse(isValidUUID('550e8400e29b41d4a716446655440000')); // missing dashes
    assert.isFalse(isValidUUID(''));
    assert.isFalse(isValidUUID('550e8400-e29b-41d4-a716-44665544000g')); // invalid char
  });
});

describe('isValidGUID', () => {
  it('should return true for valid GUIDs', () => {
    assert.isTrue(isValidGUID('550e8400-e29b-41d4-a716-446655440000'));
    assert.isTrue(isValidGUID('00000000-0000-0000-0000-000000000000'));
  });

  it('should return true for GUIDs with braces', () => {
    assert.isTrue(isValidGUID('{550e8400-e29b-41d4-a716-446655440000}'));
  });

  it('should return false for invalid GUIDs', () => {
    assert.isFalse(isValidGUID('550e8400-e29b-41d4-a716'));
    assert.isFalse(isValidGUID('not-a-guid'));
    assert.isFalse(isValidGUID(''));
  });
});

describe('isValidIdentifier', () => {
  it('should return true for valid identifiers', () => {
    assert.isTrue(isValidIdentifier('hello'));
    assert.isTrue(isValidIdentifier('_hello'));
    assert.isTrue(isValidIdentifier('helloWorld'));
    assert.isTrue(isValidIdentifier('_'));
    assert.isTrue(isValidIdentifier('a123'));
  });

  it('should return false for invalid identifiers', () => {
    assert.isFalse(isValidIdentifier('123abc')); // starts with number
    assert.isFalse(isValidIdentifier('hello-world')); // hyphen not allowed
    assert.isFalse(isValidIdentifier('hello.world')); // dot not allowed
    assert.isFalse(isValidIdentifier('hello world')); // space not allowed
    assert.isFalse(isValidIdentifier('')); // empty
  });

  it('should return false for too long identifiers', () => {
    assert.isFalse(isValidIdentifier('a'.repeat(32))); // max 31 chars
  });
});

describe('isValidHtmlIdentifier', () => {
  it('should return true for valid HTML identifiers', () => {
    assert.isTrue(isValidHtmlIdentifier('hello'));
    assert.isTrue(isValidHtmlIdentifier('helloWorld'));
    assert.isTrue(isValidHtmlIdentifier('hello-world'));
    assert.isTrue(isValidHtmlIdentifier('hello_world'));
    assert.isTrue(isValidHtmlIdentifier('my:custom'));
  });

  it('should return false for invalid HTML identifiers', () => {
    assert.isFalse(isValidHtmlIdentifier('123abc')); // starts with number
    assert.isFalse(isValidHtmlIdentifier('-hello')); // starts with hyphen
    assert.isFalse(isValidHtmlIdentifier('hello world')); // space not allowed
    assert.isFalse(isValidHtmlIdentifier('')); // empty
  });

  it('should return false for too long identifiers', () => {
    assert.isFalse(isValidHtmlIdentifier('a'.repeat(32)));
  });
});

describe('isValidCssIdentifier', () => {
  it('should return true for valid CSS identifiers', () => {
    assert.isTrue(isValidCssIdentifier('hello'));
    assert.isTrue(isValidCssIdentifier('_hello'));
    assert.isTrue(isValidCssIdentifier('hello-world'));
    assert.isTrue(isValidCssIdentifier('hello_world'));
    assert.isTrue(isValidCssIdentifier('-hello')); // CSS allows leading hyphen
  });

  it('should return false for invalid CSS identifiers', () => {
    assert.isFalse(isValidCssIdentifier('123abc')); // starts with number
    assert.isFalse(isValidCssIdentifier('hello.world')); // dot not allowed
    assert.isFalse(isValidCssIdentifier('hello world')); // space not allowed
    assert.isFalse(isValidCssIdentifier('')); // empty
  });

  it('should return false for too long identifiers', () => {
    assert.isFalse(isValidCssIdentifier('a'.repeat(32)));
  });
});
