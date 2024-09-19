import { describe, it } from 'node:test';
import * as assert from '@jarenjs/tools/assert';

import { isFn } from '@jarenjs/core';

describe('isFn', () => {

  // Returns true for a function
  it('should return true when the input is a function', () => {
    const result = isFn(() => {});
    assert.isTrue(result);
  });

  // Returns false for null
  it('should return false when the input is null', () => {
    const result = isFn(null);
    assert.isFalse(result);
  });

  // Returns false for an object
  it('should return false when the input is an object', () => {
    const result = isFn({});
    assert.isFalse(result);
  });
});