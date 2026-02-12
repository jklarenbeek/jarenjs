import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  isArrayish,
  getUniqueArray,
  isUniqueArray,
  includesAll,
} from '@jarenjs/core/array';

describe('isArrayish', () => {
  it('should return true for arrays', () => {
    assert.isTrue(isArrayish([1, 2, 3]));
    assert.isTrue(isArrayish([]));
  });

  it('should return true for Sets', () => {
    assert.isTrue(isArrayish(new Set([1, 2, 3])));
    assert.isTrue(isArrayish(new Set()));
  });

  it('should return true for TypedArrays', () => {
    assert.isTrue(isArrayish(new Uint8Array([1, 2, 3])));
    assert.isTrue(isArrayish(new Int32Array([1, 2, 3])));
    assert.isTrue(isArrayish(new Float64Array([1.1, 2.2, 3.3])));
  });

  it('should return false for non-arrayish values', () => {
    assert.isFalse(isArrayish(null));
    assert.isFalse(isArrayish(undefined));
    assert.isFalse(isArrayish('string'));
    assert.isFalse(isArrayish(123));
    assert.isFalse(isArrayish({ a: 1 }));
    assert.isFalse(isArrayish(new Map()));
  });
});

describe('getUniqueArray', () => {
  it('should return unique elements from an array', () => {
    const result = getUniqueArray([1, 2, 2, 3, 3, 3]);
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('should return undefined for null input', () => {
    const result = getUniqueArray(null);
    assert.deepEqual(result, undefined);
  });

  it('should return undefined for undefined input', () => {
    const result = getUniqueArray(undefined);
    assert.deepEqual(result, undefined);
  });

  it('should convert Set to array', () => {
    const result = getUniqueArray(new Set([1, 2, 3]));
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('should return default value for non-array/non-set input', () => {
    const result = getUniqueArray('not an array', [1, 2, 3]);
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('should handle empty arrays', () => {
    const result = getUniqueArray([]);
    assert.deepEqual(result, []);
  });

  it('should handle arrays with objects', () => {
    const obj1 = { a: 1 };
    const obj2 = { a: 1 };
    const result = getUniqueArray([obj1, obj1, obj2]);
    // Object references are compared, not deep equality
    assert.deepEqual(result, [obj1, obj2]);
  });
});

describe('isUniqueArray', () => {
  it('should return true for arrays with all unique elements', () => {
    assert.isTrue(isUniqueArray([1, 2, 3, 4, 5]));
  });

  it('should return false for arrays with duplicate elements', () => {
    assert.isFalse(isUniqueArray([1, 2, 2, 3]));
  });

  it('should return true for empty arrays', () => {
    assert.isTrue(isUniqueArray([]));
  });

  it('should return true for single element arrays', () => {
    assert.isTrue(isUniqueArray([1]));
  });

  it('should return false for null input', () => {
    assert.isFalse(isUniqueArray(null));
  });

  it('should return false for undefined input', () => {
    assert.isFalse(isUniqueArray(undefined));
  });
});

describe('includesAll', () => {
  it('should return true when all values are included', () => {
    assert.isTrue(includesAll([1, 2, 3, 4, 5], [1, 3, 5]));
  });

  it('should return false when some values are not included', () => {
    assert.isFalse(includesAll([1, 2, 3], [1, 4]));
  });

  it('should return true for empty values array', () => {
    assert.isTrue(includesAll([1, 2, 3], []));
  });

  it('should handle string arrays', () => {
    assert.isTrue(includesAll(['a', 'b', 'c'], ['a', 'c']));
    assert.isFalse(includesAll(['a', 'b'], ['c']));
  });

  it('should handle mixed types', () => {
    assert.isTrue(includesAll([1, '2', 3], [1, 3]));
    assert.isFalse(includesAll([1, 2, 3], ['1']));
  });
});
