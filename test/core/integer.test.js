import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  INT8_MIN,
  INT8_MAX,
  isValidInt8,
  UINT8_MIN,
  UINT8_MAX,
  isValidUInt8,
  INT16_MIN,
  INT16_MAX,
  isValidInt16,
  UINT16_MIN,
  UINT16_MAX,
  isValidUInt16,
  INT32_MIN,
  INT32_MAX,
  isValidInt32,
  UINT32_MIN,
  UINT32_MAX,
  isValidUInt32,
  INT64_MIN,
  INT64_MAX,
  isValidInt64,
  UINT64_MIN,
  UINT64_MAX,
  isValidUInt64,
} from '@jarenjs/core/integer';

describe('Int8 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(INT8_MIN, -128);
    assert.deepEqual(INT8_MAX, 127);
  });
});

describe('isValidInt8', () => {
  it('should return true for valid int8 values', () => {
    assert.isTrue(isValidInt8(0));
    assert.isTrue(isValidInt8(127));
    assert.isTrue(isValidInt8(-128));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidInt8(128));
    assert.isFalse(isValidInt8(-129));
  });

  it('should return false for non-integers', () => {
    assert.isFalse(isValidInt8(3.14));
    assert.isFalse(isValidInt8('127'));
  });
});

describe('UInt8 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(UINT8_MIN, 0);
    assert.deepEqual(UINT8_MAX, 255);
  });
});

describe('isValidUInt8', () => {
  it('should return true for valid uint8 values', () => {
    assert.isTrue(isValidUInt8(0));
    assert.isTrue(isValidUInt8(255));
  });

  it('should return false for negative values', () => {
    assert.isFalse(isValidUInt8(-1));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidUInt8(256));
  });
});

describe('Int16 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(INT16_MIN, -32768);
    assert.deepEqual(INT16_MAX, 32767);
  });
});

describe('isValidInt16', () => {
  it('should return true for valid int16 values', () => {
    assert.isTrue(isValidInt16(0));
    assert.isTrue(isValidInt16(32767));
    assert.isTrue(isValidInt16(-32768));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidInt16(32768));
    assert.isFalse(isValidInt16(-32769));
  });
});

describe('UInt16 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(UINT16_MIN, 0);
    assert.deepEqual(UINT16_MAX, 65535);
  });
});

describe('isValidUInt16', () => {
  it('should return true for valid uint16 values', () => {
    assert.isTrue(isValidUInt16(0));
    assert.isTrue(isValidUInt16(65535));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidUInt16(65536));
    assert.isFalse(isValidUInt16(-1));
  });
});

describe('Int32 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(INT32_MIN, -2147483648);
    assert.deepEqual(INT32_MAX, 2147483647);
  });
});

describe('isValidInt32', () => {
  it('should return true for valid int32 values', () => {
    assert.isTrue(isValidInt32(0));
    assert.isTrue(isValidInt32(2147483647));
    assert.isTrue(isValidInt32(-2147483648));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidInt32(2147483648));
    assert.isFalse(isValidInt32(-2147483649));
  });
});

describe('UInt32 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(UINT32_MIN, 0);
    assert.deepEqual(UINT32_MAX, 4294967295);
  });
});

describe('isValidUInt32', () => {
  it('should return true for valid uint32 values', () => {
    assert.isTrue(isValidUInt32(0));
    assert.isTrue(isValidUInt32(4294967295));
  });

  it('should return false for out of range values', () => {
    assert.isFalse(isValidUInt32(4294967296));
    assert.isFalse(isValidUInt32(-1));
  });
});

describe('Int64 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(INT64_MIN, Number.MIN_SAFE_INTEGER);
    assert.deepEqual(INT64_MAX, Number.MAX_SAFE_INTEGER);
  });
});

describe('isValidInt64', () => {
  it('should return true for valid int64 values', () => {
    assert.isTrue(isValidInt64(0));
    assert.isTrue(isValidInt64(Number.MAX_SAFE_INTEGER));
    assert.isTrue(isValidInt64(Number.MIN_SAFE_INTEGER));
  });

  it('should return false for unsafe integers', () => {
    assert.isFalse(isValidInt64(Number.MAX_SAFE_INTEGER + 1));
    assert.isFalse(isValidInt64(Number.MIN_SAFE_INTEGER - 1));
  });
});

describe('UInt64 Constants', () => {
  it('should have correct min and max values', () => {
    assert.deepEqual(UINT64_MIN, 0);
    assert.deepEqual(UINT64_MAX, Number.MAX_SAFE_INTEGER);
  });
});

describe('isValidUInt64', () => {
  it('should return true for valid uint64 values', () => {
    assert.isTrue(isValidUInt64(0));
    assert.isTrue(isValidUInt64(Number.MAX_SAFE_INTEGER));
  });

  it('should return false for negative values', () => {
    assert.isFalse(isValidUInt64(-1));
  });

  it('should return false for unsafe integers', () => {
    assert.isFalse(isValidUInt64(Number.MAX_SAFE_INTEGER + 1));
  });
});
