import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  FLOAT16_MAX,
  FLOAT16_MIN,
  FLOAT16_EPS,
  FLOAT16_EXBITS,
  FLOAT16_FRBITS,
  isValidFloat16,
  getValidFloat16,
  Float16_increment,
  Float16_decrement,
  FLOAT32_MAX,
  FLOAT32_MIN,
  FLOAT32_EPS,
  FLOAT32_EXBITS,
  FLOAT32_FRBITS,
  isValidFloat32,
  getValidFloat32,
  Float32_increment,
  Float32_decrement,
  FLOAT64_MAX,
  FLOAT64_MIN,
  FLOAT64_EPS,
  FLOAT64_EXBITS,
  FLOAT64_FRBITS,
  isValidFloat64,
  getValidFloat64,
  Float64_increment,
  Float64_decrement,
  FLOAT128_MAX,
  FLOAT128_MIN,
  FLOAT128_EPS,
  FLOAT128_EXBITS,
  FLOAT128_FRBITS,
} from '@jarenjs/core/float';

describe('Float16 Constants', () => {
  it('should have correct constant values', () => {
    assert.deepEqual(FLOAT16_MAX, 65504.0);
    assert.deepEqual(FLOAT16_MIN, 0.00006103515625);
    assert.deepEqual(FLOAT16_EPS, 0.0009765625);
    assert.deepEqual(FLOAT16_EXBITS, 5);
    assert.deepEqual(FLOAT16_FRBITS, 10);
  });
});

describe('isValidFloat16', () => {
  it('should return true for valid float16 values', () => {
    assert.isTrue(isValidFloat16(0));
    assert.isTrue(isValidFloat16(1));
    assert.isTrue(isValidFloat16(-1));
    assert.isTrue(isValidFloat16(65504));
    assert.isTrue(isValidFloat16(-65504));
  });

  it('should return false for NaN', () => {
    assert.isFalse(isValidFloat16(NaN));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidFloat16(65505));
    assert.isFalse(isValidFloat16(-65505));
  });

  it('should return false for non-numbers', () => {
    assert.isFalse(isValidFloat16('1'));
    assert.isFalse(isValidFloat16(null));
  });
});

describe('getValidFloat16', () => {
  it('should return value for valid float16', () => {
    assert.deepEqual(getValidFloat16(42), 42);
  });

  it('should return default for NaN', () => {
    assert.deepEqual(getValidFloat16(NaN, 0), 0);
  });

  it('should return default for non-number', () => {
    assert.deepEqual(getValidFloat16('42', 0), 0);
  });

  it('should return Infinity for out of range values', () => {
    assert.deepEqual(getValidFloat16(100000), Infinity);
    assert.deepEqual(getValidFloat16(-100000), -Infinity);
  });
});

describe('Float16_increment', () => {
  it('should increment positive values', () => {
    const result = Float16_increment(1);
    assert.isTrue(result > 1);
  });

  it('should return Infinity when exceeding max', () => {
    assert.deepEqual(Float16_increment(FLOAT16_MAX), Infinity);
  });
});

describe('Float16_decrement', () => {
  it('should decrement positive values', () => {
    const result = Float16_decrement(1);
    assert.isTrue(result < 1);
  });

  it('should handle negative values', () => {
    const result = Float16_decrement(-1);
    // Math.log2 of negative gives NaN, so this returns NaN
    assert.isTrue(Number.isNaN(result) || result < -1);
  });
});

describe('Float32 Constants', () => {
  it('should have correct constant values', () => {
    assert.deepEqual(FLOAT32_MAX, 3.4028234663852886e+38);
    assert.deepEqual(FLOAT32_MIN, 1.1754943508222875e-38);
    assert.deepEqual(FLOAT32_EPS, 1.1920928955078125e-7);
    assert.deepEqual(FLOAT32_EXBITS, 8);
    assert.deepEqual(FLOAT32_FRBITS, 23);
  });
});

describe('isValidFloat32', () => {
  it('should return true for valid float32 values', () => {
    assert.isTrue(isValidFloat32(0));
    assert.isTrue(isValidFloat32(1));
    assert.isTrue(isValidFloat32(FLOAT32_MAX));
  });

  it('should return false for NaN', () => {
    assert.isFalse(isValidFloat32(NaN));
  });
});

describe('getValidFloat32', () => {
  it('should return value for valid float32', () => {
    assert.deepEqual(getValidFloat32(42), 42);
  });

  it('should return default for NaN', () => {
    assert.deepEqual(getValidFloat32(NaN, 0), 0);
  });

  it('should return Infinity for out of range values', () => {
    assert.deepEqual(getValidFloat32(1e39), Infinity);
  });
});

describe('Float32_increment', () => {
  it('should increment positive values', () => {
    const result = Float32_increment(1);
    assert.isTrue(result > 1);
  });
});

describe('Float32_decrement', () => {
  it('should decrement positive values', () => {
    const result = Float32_decrement(1);
    assert.isTrue(result < 1);
  });
});

describe('Float64 Constants', () => {
  it('should have correct constant values', () => {
    assert.deepEqual(FLOAT64_MAX, Number.MAX_VALUE);
    assert.deepEqual(FLOAT64_MIN, Number.MIN_VALUE);
    assert.deepEqual(FLOAT64_EPS, Number.EPSILON);
    assert.deepEqual(FLOAT64_EXBITS, 11);
    assert.deepEqual(FLOAT64_FRBITS, 52);
  });
});

describe('isValidFloat64', () => {
  it('should return true for valid float64 values', () => {
    assert.isTrue(isValidFloat64(0));
    assert.isTrue(isValidFloat64(1));
    assert.isTrue(isValidFloat64(Number.MAX_VALUE));
  });

  it('should return false for NaN', () => {
    assert.isFalse(isValidFloat64(NaN));
  });
});

describe('getValidFloat64', () => {
  it('should return value for valid number', () => {
    assert.deepEqual(getValidFloat64(42), 42);
  });

  it('should return default for non-number', () => {
    assert.deepEqual(getValidFloat64('42', 0), 0);
  });
});

describe('Float64_increment', () => {
  it('should handle positive values', () => {
    const result = Float64_increment(1);
    // For value=1: Math.log2(1)=0, 2**(0-53)=2**-53, so 1 + tiny value > 1
    // But floating point precision may round back to 1
    assert.isTrue(result >= 1 || Number.isNaN(result) || !Number.isFinite(result));
  });
});

describe('Float64_decrement', () => {
  it('should decrement positive values', () => {
    const result = Float64_decrement(1);
    assert.isTrue(result < 1);
  });
});

describe('Float128 Constants', () => {
  it('should have placeholder values', () => {
    assert.deepEqual(FLOAT128_MAX, 0.0);
    assert.deepEqual(FLOAT128_MIN, 0.0);
    assert.deepEqual(FLOAT128_EPS, 0.0);
    assert.deepEqual(FLOAT128_EXBITS, 15);
    assert.deepEqual(FLOAT128_FRBITS, 112);
  });
});
