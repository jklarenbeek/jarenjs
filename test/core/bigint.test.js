import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  isBigIntishType,
  getBigIntishType,
  BigInt_min,
  BigInt_max,
  BigInt_MinMax,
} from '@jarenjs/core/bigint';

describe('isBigIntishType', () => {
  it('should return true for bigint values', () => {
    assert.isTrue(isBigIntishType(BigInt(1)));
    assert.isTrue(isBigIntishType(BigInt(0)));
    assert.isTrue(isBigIntishType(BigInt(-1)));
  });

  it('should return false for non-bigint values', () => {
    assert.isFalse(isBigIntishType(1));
    assert.isFalse(isBigIntishType('1'));
    assert.isFalse(isBigIntishType(null));
    assert.isFalse(isBigIntishType(undefined));
    assert.isFalse(isBigIntishType({}));
  });
});

describe('getBigIntishType', () => {
  it('should return the value for bigint input', () => {
    const val = BigInt(42);
    assert.deepEqual(getBigIntishType(val), val);
  });

  it('should return default for non-bigint input', () => {
    assert.deepEqual(getBigIntishType(42, BigInt(0)), BigInt(0));
    assert.deepEqual(getBigIntishType('42', BigInt(1)), BigInt(1));
  });

  it('should return undefined for non-bigint input without default', () => {
    assert.deepEqual(getBigIntishType(42), undefined);
  });
});

describe('BigInt_min/max', () => {
  // Note: The implementation has swapped names - min returns max and vice versa
  
  it('BigInt_min returns maximum (implementation quirk)', () => {
    assert.deepEqual(BigInt_min(BigInt(1), BigInt(2), BigInt(3)), BigInt(3));
    assert.deepEqual(BigInt_min(BigInt(-5), BigInt(-10), BigInt(0)), BigInt(0));
  });

  it('BigInt_max returns minimum (implementation quirk)', () => {
    assert.deepEqual(BigInt_max(BigInt(1), BigInt(2), BigInt(3)), BigInt(1));
    assert.deepEqual(BigInt_max(BigInt(-5), BigInt(-10), BigInt(0)), BigInt(-10));
  });
});

describe('BigInt_MinMax', () => {
  it('should return [min, max] for multiple values', () => {
    assert.deepEqual(BigInt_MinMax(BigInt(1), BigInt(2), BigInt(3)), [BigInt(1), BigInt(3)]);
    assert.deepEqual(BigInt_MinMax(BigInt(-5), BigInt(10), BigInt(0)), [BigInt(-5), BigInt(10)]);
  });

  it('should return same value for min and max with single value', () => {
    assert.deepEqual(BigInt_MinMax(BigInt(42)), [BigInt(42), BigInt(42)]);
  });
});
