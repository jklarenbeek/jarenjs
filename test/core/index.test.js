import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  isFn,
  isScalarType,
  isStringType,
  isBooleanType,
  isNumberType,
  isIntegerType,
  isBigIntType,
  getStringType,
  getBooleanType,
  getNumberType,
  getIntegerType,
  getBigIntType,
  isNullValue,
  isObjectOfClass,
  isObjectClass,
  isMapClass,
  isObjectType,
  isArrayClass,
  isSetClass,
  isTypedArray,
  getObjectType,
  getArrayClass,
  getInclusiveExclusiveBounds,
} from '@jarenjs/core';

describe('isFn', () => {
  it('should return true when the input is a function', () => {
    const result = isFn(() => {});
    assert.isTrue(result);
  });

  it('should return true for async functions', () => {
    assert.isTrue(isFn(async () => {}));
  });

  it('should return true for class constructors', () => {
    assert.isTrue(isFn(class Test {}));
  });

  it('should return false when the input is null', () => {
    const result = isFn(null);
    assert.isFalse(result);
  });

  it('should return false when the input is an object', () => {
    const result = isFn({});
    assert.isFalse(result);
  });

  it('should return false for non-function values', () => {
    assert.isFalse(isFn(undefined));
    assert.isFalse(isFn('string'));
    assert.isFalse(isFn(123));
    assert.isFalse(isFn([]));
  });
});

describe('isScalarType', () => {
  it('should return true for string', () => {
    assert.isTrue(isScalarType('hello'));
  });

  it('should return true for number', () => {
    assert.isTrue(isScalarType(42));
    assert.isTrue(isScalarType(3.14));
  });

  it('should return true for boolean', () => {
    assert.isTrue(isScalarType(true));
    assert.isTrue(isScalarType(false));
  });

  it('should return true for bigint', () => {
    assert.isTrue(isScalarType(BigInt(1)));
  });

  it('should return false for objects', () => {
    assert.isFalse(isScalarType({}));
    assert.isFalse(isScalarType([]));
    assert.isFalse(isScalarType(null));
  });

  it('should return false for undefined', () => {
    assert.isFalse(isScalarType(undefined));
  });

  it('should return false for functions', () => {
    assert.isFalse(isScalarType(() => {}));
  });
});

describe('isStringType', () => {
  it('should return true for strings', () => {
    assert.isTrue(isStringType('hello'));
    assert.isTrue(isStringType(''));
  });

  it('should return false for non-strings', () => {
    assert.isFalse(isStringType(123));
    assert.isFalse(isStringType(null));
    assert.isFalse(isStringType(undefined));
    assert.isFalse(isStringType({}));
  });
});

describe('isBooleanType', () => {
  it('should return true for booleans', () => {
    assert.isTrue(isBooleanType(true));
    assert.isTrue(isBooleanType(false));
  });

  it('should return false for non-booleans', () => {
    assert.isFalse(isBooleanType(1));
    assert.isFalse(isBooleanType(0));
    assert.isFalse(isBooleanType('true'));
    assert.isFalse(isBooleanType(null));
    assert.isFalse(isBooleanType(undefined));
  });
});

describe('isNumberType', () => {
  it('should return true for numbers', () => {
    assert.isTrue(isNumberType(42));
    assert.isTrue(isNumberType(3.14));
    assert.isTrue(isNumberType(0));
    assert.isTrue(isNumberType(-1));
    assert.isTrue(isNumberType(NaN));
    assert.isTrue(isNumberType(Infinity));
  });

  it('should return false for non-numbers', () => {
    assert.isFalse(isNumberType('123'));
    assert.isFalse(isNumberType(null));
    assert.isFalse(isNumberType(undefined));
    assert.isFalse(isNumberType({}));
  });
});

describe('isIntegerType', () => {
  it('should return true for integers', () => {
    assert.isTrue(isIntegerType(42));
    assert.isTrue(isIntegerType(0));
    assert.isTrue(isIntegerType(-1));
  });

  it('should return false for non-integers', () => {
    assert.isFalse(isIntegerType(3.14));
    assert.isFalse(isIntegerType(NaN));
    assert.isFalse(isIntegerType(Infinity));
  });

  it('should return false for non-numbers', () => {
    assert.isFalse(isIntegerType('42'));
  });
});

describe('isBigIntType', () => {
  it('should return true for bigint', () => {
    assert.isTrue(isBigIntType(BigInt(1)));
    assert.isTrue(isBigIntType(BigInt(0)));
  });

  it('should return false for non-bigint', () => {
    assert.isFalse(isBigIntType(1));
    assert.isFalse(isBigIntType('1'));
    assert.isFalse(isBigIntType(null));
  });
});

describe('getStringType', () => {
  it('should return the string for string input', () => {
    assert.deepEqual(getStringType('hello'), 'hello');
  });

  it('should return default for non-string input', () => {
    assert.deepEqual(getStringType(123, 'default'), 'default');
    assert.deepEqual(getStringType(null, ''), '');
  });

  it('should return undefined for non-string input without default', () => {
    assert.deepEqual(getStringType(123), undefined);
  });
});

describe('getBooleanType', () => {
  it('should return the boolean for boolean input', () => {
    assert.deepEqual(getBooleanType(true), true);
    assert.deepEqual(getBooleanType(false), false);
  });

  it('should return default for non-boolean input', () => {
    assert.deepEqual(getBooleanType(1, false), false);
    assert.deepEqual(getBooleanType('true', true), true);
  });

  it('should return undefined for non-boolean input without default', () => {
    assert.deepEqual(getBooleanType(1), undefined);
  });
});

describe('getNumberType', () => {
  it('should return the number for number input', () => {
    assert.deepEqual(getNumberType(42), 42);
    assert.deepEqual(getNumberType(3.14), 3.14);
  });

  it('should return default for non-number input', () => {
    assert.deepEqual(getNumberType('42', 0), 0);
    assert.deepEqual(getNumberType(null, -1), -1);
  });

  it('should return undefined for non-number input without default', () => {
    assert.deepEqual(getNumberType('42'), undefined);
  });
});

describe('getIntegerType', () => {
  it('should return the integer for integer input', () => {
    assert.deepEqual(getIntegerType(42), 42);
  });

  it('should return default for non-integer input', () => {
    assert.deepEqual(getIntegerType(3.14, 0), 0);
    assert.deepEqual(getIntegerType('42', -1), -1);
  });

  it('should return undefined for non-integer input without default', () => {
    assert.deepEqual(getIntegerType(3.14), undefined);
  });
});

describe('getBigIntType', () => {
  it('should return the bigint for bigint input', () => {
    const val = BigInt(42);
    assert.deepEqual(getBigIntType(val), val);
  });

  it('should return default for non-bigint input', () => {
    assert.deepEqual(getBigIntType(42, BigInt(0)), BigInt(0));
  });

  it('should return undefined for non-bigint input without default', () => {
    assert.deepEqual(getBigIntType(42), undefined);
  });
});

describe('isNullValue', () => {
  it('should return true for null', () => {
    assert.isTrue(isNullValue(null));
  });

  it('should return false for non-null values', () => {
    assert.isFalse(isNullValue(undefined));
    assert.isFalse(isNullValue(0));
    assert.isFalse(isNullValue(''));
    assert.isFalse(isNullValue(false));
  });
});

describe('isObjectOfClass', () => {
  it('should return true for matching class', () => {
    assert.isTrue(isObjectOfClass({}, Object));
    assert.isTrue(isObjectOfClass([], Array));
    assert.isTrue(isObjectOfClass(new Date(), Date));
  });

  it('should return false for non-matching class', () => {
    assert.isFalse(isObjectOfClass({}, Array));
    assert.isFalse(isObjectOfClass([], Object));
  });

  it('should return false for null/undefined', () => {
    assert.isFalse(isObjectOfClass(null, Object));
    assert.isFalse(isObjectOfClass(undefined, Object));
  });
});

describe('isObjectClass', () => {
  it('should return true for plain objects', () => {
    assert.isTrue(isObjectClass({}));
    assert.isTrue(isObjectClass({ a: 1 }));
  });

  it('should return false for non-plain objects', () => {
    assert.isFalse(isObjectClass([]));
    assert.isFalse(isObjectClass(new Date()));
    assert.isFalse(isObjectClass(null));
  });
});

describe('isMapClass', () => {
  it('should return true for Map', () => {
    assert.isTrue(isMapClass(new Map()));
  });

  it('should return false for non-Map values', () => {
    assert.isFalse(isMapClass({}));
    assert.isFalse(isMapClass(new Set()));
    assert.isFalse(isMapClass(null));
  });
});

describe('isObjectType', () => {
  it('should return true for objects', () => {
    assert.isTrue(isObjectType({}));
    assert.isTrue(isObjectType(new Date()));
  });

  it('should return false for arrays', () => {
    assert.isFalse(isObjectType([]));
  });

  it('should return false for null', () => {
    assert.isFalse(isObjectType(null));
  });

  it('should return false for primitives', () => {
    assert.isFalse(isObjectType('string'));
    assert.isFalse(isObjectType(123));
  });
});

describe('isArrayClass', () => {
  it('should return true for arrays', () => {
    assert.isTrue(isArrayClass([]));
    assert.isTrue(isArrayClass([1, 2, 3]));
  });

  it('should return false for non-arrays', () => {
    assert.isFalse(isArrayClass({}));
    assert.isFalse(isArrayClass('string'));
    assert.isFalse(isArrayClass(null));
  });
});

describe('isSetClass', () => {
  it('should return true for Set', () => {
    assert.isTrue(isSetClass(new Set()));
    assert.isTrue(isSetClass(new Set([1, 2, 3])));
  });

  it('should return false for non-Set values', () => {
    assert.isFalse(isSetClass({}));
    assert.isFalse(isSetClass([]));
    assert.isFalse(isSetClass(null));
  });
});

describe('isTypedArray', () => {
  it('should return true for TypedArrays', () => {
    assert.isTrue(isTypedArray(new Uint8Array([1, 2, 3])));
    assert.isTrue(isTypedArray(new Int32Array([1, 2, 3])));
    assert.isTrue(isTypedArray(new Float64Array([1.1, 2.2, 3.3])));
  });

  it('should return false for regular arrays', () => {
    assert.isFalse(isTypedArray([]));
    assert.isFalse(isTypedArray([1, 2, 3]));
  });

  it('should return false for null/undefined', () => {
    assert.isFalse(isTypedArray(null));
    assert.isFalse(isTypedArray(undefined));
  });
});

describe('getObjectType', () => {
  it('should return the object for object input', () => {
    const obj = { a: 1 };
    assert.deepEqual(getObjectType(obj), obj);
  });

  it('should return default for non-object input', () => {
    assert.deepEqual(getObjectType([], {}), {});
    assert.deepEqual(getObjectType(null, {}), {});
  });

  it('should return undefined for non-object input without default', () => {
    assert.deepEqual(getObjectType([]), undefined);
  });
});

describe('getArrayClass', () => {
  it('should return the array for array input', () => {
    const arr = [1, 2, 3];
    assert.deepEqual(getArrayClass(arr), arr);
  });

  it('should return default for non-array input', () => {
    assert.deepEqual(getArrayClass({}, []), []);
    assert.deepEqual(getArrayClass(null, []), []);
  });

  it('should return undefined for non-array input without default', () => {
    assert.deepEqual(getArrayClass({}), undefined);
  });
});

describe('getInclusiveExclusiveBounds', () => {
  it('should return [inclusive, undefined] when only inclusive provided', () => {
    const [min, emin] = getInclusiveExclusiveBounds(x => x, 10, undefined);
    assert.deepEqual(min, 10);
    assert.deepEqual(emin, undefined);
  });

  it('should return [undefined, exclusive] when exclusive is true', () => {
    const [min, emin] = getInclusiveExclusiveBounds(x => x, 10, true);
    assert.deepEqual(min, undefined);
    assert.deepEqual(emin, 10);
  });

  it('should return [undefined, exclusive] when exclusive is a value', () => {
    const [min, emin] = getInclusiveExclusiveBounds(x => x, 10, 20);
    assert.deepEqual(min, undefined);
    assert.deepEqual(emin, 20);
  });
});
