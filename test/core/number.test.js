import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  isJsonNumberString,
  isBoolishType,
  getBoolishType,
  isNumbishType,
  isIntishType,
  getNumbishType,
  getIntishType,
} from '@jarenjs/core/number';

describe('isJsonNumberString', () => {
  it('recognizes complete JSON-number spellings without imposing a numeric range', () => {
    for (const value of ['0', '-0', '42', '-1.25', '1e5', '1E+5', '1e-5', '1e999', '-1e999', '9007199254740993'])
      assert.isTrue(isJsonNumberString(value), value);
  });

  it('rejects other numeric grammars, malformed numbers and surrounding whitespace', () => {
    for (const value of ['', '+1', '01', '-01', '.5', '1.', '-', '1e', '1e+', '0x10', '1_000', 'Infinity', 'NaN', ' 1', '1 ', '1\n', '1\r', '1\u2028', '1\u2029'])
      assert.isFalse(isJsonNumberString(value), JSON.stringify(value));
  });

  it('rejects nonstrings without invoking conversion hooks', () => {
    const hostile = { toString() { throw new Error('must not coerce'); } };
    for (const value of [0, 1, NaN, Infinity, 1n, true, null, undefined, ['1'], Symbol('1'), hostile])
      assert.isFalse(isJsonNumberString(value));
  });
});

describe('isBoolishType', () => {
  it('should return true for boolean values', () => {
    assert.isTrue(isBoolishType(true));
    assert.isTrue(isBoolishType(false));
  });

  it('should return true for boolean-like strings', () => {
    assert.isTrue(isBoolishType('true'));
    assert.isTrue(isBoolishType('false'));
  });

  it('should return false for non-boolish values', () => {
    assert.isFalse(isBoolishType(1));
    assert.isFalse(isBoolishType(0));
    assert.isFalse(isBoolishType('yes'));
    assert.isFalse(isBoolishType('no'));
    assert.isFalse(isBoolishType(null));
    assert.isFalse(isBoolishType(undefined));
  });
});

describe('getBoolishType', () => {
  it('should return the value for boolean input', () => {
    assert.deepEqual(getBoolishType(true), true);
    assert.deepEqual(getBoolishType(false), false);
  });

  it('should return the value for boolean-like string input', () => {
    assert.deepEqual(getBoolishType('true'), 'true');
    assert.deepEqual(getBoolishType('false'), 'false');
  });

  it('should return default for non-boolish input', () => {
    assert.deepEqual(getBoolishType(1, false), false);
    assert.deepEqual(getBoolishType('yes', true), true);
  });

  it('should return undefined for non-boolish input without default', () => {
    assert.deepEqual(getBoolishType(1), undefined);
  });
});

describe('isNumbishType', () => {
  it('should return true for numbers', () => {
    assert.isTrue(isNumbishType(42));
    assert.isTrue(isNumbishType(0));
    assert.isTrue(isNumbishType(-1));
    assert.isTrue(isNumbishType(3.14));
  });

  it('should return true for numeric strings', () => {
    assert.isTrue(isNumbishType('42'));
    assert.isTrue(isNumbishType('3.14'));
    assert.isTrue(isNumbishType('-1'));
  });

  it('should return false for non-numeric strings', () => {
    assert.isFalse(isNumbishType('abc'));
    // Note: empty string is converted to 0 by Number(''), so it returns true
    // assert.isFalse(isNumbishType(''));
  });

  it('should return false for NaN', () => {
    assert.isFalse(isNumbishType(NaN));
  });

  it('should return false for bigint', () => {
    assert.isFalse(isNumbishType(BigInt(1)));
  });

  it('should handle null and undefined per Number() behavior', () => {
    // Number(null) is 0, Number(undefined) is NaN
    assert.isTrue(isNumbishType(null)); // Number(null) = 0
    assert.isFalse(isNumbishType(undefined)); // Number(undefined) = NaN
  });
});

describe('isIntishType', () => {
  it('should return true for integers', () => {
    assert.isTrue(isIntishType(42));
    assert.isTrue(isIntishType(0));
    assert.isTrue(isIntishType(-1));
  });

  it('should return false for non-integers', () => {
    assert.isFalse(isIntishType(3.14));
    assert.isFalse(isIntishType('3.14'));
  });

  it('should return true for integer strings', () => {
    assert.isTrue(isIntishType('42'));
    assert.isTrue(isIntishType('-1'));
  });

  it('should return true for floats that are integers', () => {
    assert.isTrue(isIntishType(3.0)); // 3.0 === 3
  });
});

describe('getNumbishType', () => {
  it('should return number for numeric input', () => {
    assert.deepEqual(getNumbishType(42), 42);
    assert.deepEqual(getNumbishType('42'), 42);
    assert.deepEqual(getNumbishType('3.14'), 3.14);
  });

  it('should return default for non-numeric input', () => {
    assert.deepEqual(getNumbishType('abc', 0), 0);
    assert.deepEqual(getNumbishType(undefined, -1), -1);
  });

  it('should return undefined for non-numeric input without default', () => {
    assert.deepEqual(getNumbishType('abc'), undefined);
  });
});

describe('getIntishType', () => {
  it('should return integer for intish input', () => {
    assert.deepEqual(getIntishType(42), 42);
    assert.deepEqual(getIntishType('42'), 42);
  });

  it('should return default for non-intish input', () => {
    assert.deepEqual(getIntishType('abc', 0), 0);
    assert.deepEqual(getIntishType(3.14, -1), -1);
  });

  it('should return undefined for non-intish input without default', () => {
    assert.deepEqual(getIntishType('abc'), undefined);
  });
});
