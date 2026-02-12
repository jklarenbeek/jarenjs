import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  trueThat,
  falseThat,
  fallbackFn,
  addFunctionToArray,
} from '@jarenjs/core/function';

describe('trueThat', () => {
  it('should always return true', () => {
    assert.isTrue(trueThat());
    assert.isTrue(trueThat(null));
    assert.isTrue(trueThat(undefined));
    assert.isTrue(trueThat('anything'));
    assert.isTrue(trueThat(123));
    assert.isTrue(trueThat({}));
  });

  it('should return true even with path and root arguments', () => {
    assert.isTrue(trueThat('data', '/path', { root: true }));
  });
});

describe('falseThat', () => {
  it('should always return false', () => {
    assert.isFalse(falseThat());
    assert.isFalse(falseThat(null));
    assert.isFalse(falseThat(undefined));
    assert.isFalse(falseThat('anything'));
    assert.isFalse(falseThat(123));
    assert.isFalse(falseThat({}));
  });

  it('should return false even with path and root arguments', () => {
    assert.isFalse(falseThat('data', '/path', { root: true }));
  });
});

describe('fallbackFn', () => {
  it('should return compiled function if valid', () => {
    const fn = () => 'custom';
    const result = fallbackFn(fn, trueThat);
    assert.deepEqual(result, fn);
  });

  it('should return fallback if compiled is not a function', () => {
    const result = fallbackFn(null, trueThat);
    assert.deepEqual(result, trueThat);
  });

  it('should return trueThat if fallback is not a function', () => {
    const result = fallbackFn(null, 'not a function');
    assert.deepEqual(result, trueThat);
  });

  it('should return trueThat if both are invalid', () => {
    const result = fallbackFn(null, null);
    assert.deepEqual(result, trueThat);
  });
});

describe('addFunctionToArray', () => {
  it('should add a function to the array', () => {
    const arr = [];
    const fn = () => {};
    const result = addFunctionToArray(arr, fn);
    assert.deepEqual(result.length, 1);
    assert.deepEqual(result[0], fn);
  });

  it('should add multiple functions from an array', () => {
    const arr = [];
    const fns = [() => {}, () => {}];
    const result = addFunctionToArray(arr, fns);
    assert.deepEqual(result.length, 2);
  });

  it('should filter out non-functions from array', () => {
    const arr = [];
    const fns = [() => {}, 'not a function', () => {}, 123];
    const result = addFunctionToArray(arr, fns);
    assert.deepEqual(result.length, 2);
  });

  it('should return array unchanged if fn is null', () => {
    const arr = [() => {}];
    const result = addFunctionToArray(arr, null);
    assert.deepEqual(result.length, 1);
  });

  it('should handle undefined array by creating new array', () => {
    const fn = () => {};
    const result = addFunctionToArray(undefined, fn);
    assert.deepEqual(result.length, 1);
  });
});
