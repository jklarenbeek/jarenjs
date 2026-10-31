//@ts-check

import {
  isNumberType,
  getInclusiveExclusiveBounds,
} from '@jarenjs/core';

import {
  getNumbishType,
} from '@jarenjs/core/number';

import {
  trueThat,
} from '@jarenjs/core/function';

import {
  shortestDecimal,
} from '@jarenjs/core/math';

/** `10^n` for the scales a double divides by exactly. */
const POWERS_OF_TEN = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/**
 * A test of whether a number is a whole multiple of `step`, decided on the
 * decimals the two numbers spell — the shortest decimal that reads back as
 * each ({@link shortestDecimal}: the digits `String(x)` prints) — exactly at
 * every magnitude: `0.3` is a multiple of `0.1`, `20000001` is none of
 * `10000000`, `1e308` is one of `0.5`. A step's multiples are those of its
 * magnitude. A value that is not finite is no multiple; under a step that
 * is not finite, or zero, a value is one where the quotient is whole (any
 * finite value of an infinite step, nothing of zero).
 * @param {number} step
 * @returns {(value: number) => boolean}
 */
export function multipleOfTester(step) {
  const size = Math.abs(step);
  if (!Number.isFinite(size) || size === 0) return (value) => Number.isInteger(value / step);
  const { digits, scale } = shortestDecimal(size);
  // the step is `unit × 10^-scale`
  const unit = Number(digits);
  const divisor = scale < POWERS_OF_TEN.length ? POWERS_OF_TEN[scale] : 0;
  // every whole number is a multiple where `unit` divides `10^scale` (1, 0.5, 1e-8)
  const wholeNumbers = 10n ** BigInt(scale) % BigInt(digits) === 0n;
  const wholeStep = scale === 0 && unit <= Number.MAX_SAFE_INTEGER;
  return function isMultipleOf(value) {
    if (!Number.isFinite(value)) return false;
    const x = Math.abs(value);
    if (divisor !== 0) {
      // A whole quotient can only be the one nearest the float quotient.
      // Below 1e15 that many steps is an exact integer of at most 15
      // digits over an exact power of ten: the division rounds to the
      // double that decimal spells, and a decimal of at most 15 digits is
      // the shortest one of the double it rounds to, so it is the value's
      // own decimal exactly when the two doubles are equal.
      const steps = Math.round(x / size) * unit;
      if (steps < 1e15) return x === steps / divisor;
    }
    // A whole double spells a whole decimal at every magnitude, below 2^53
    // the double itself.
    if (Number.isInteger(x)) {
      if (wholeNumbers) return true;
      if (wholeStep && x <= Number.MAX_SAFE_INTEGER) return x % unit === 0;
    }
    return isDecimalMultiple(x, digits, scale);
  };
}

/**
 * Whether the decimal a finite non-negative number spells is a whole
 * multiple of `digits × 10^-scale`: both scaled to one power of ten as
 * integers, the remainder taken exactly.
 * @param {number} x
 * @param {string} digits
 * @param {number} scale
 * @returns {boolean}
 */
function isDecimalMultiple(x, digits, scale) {
  const value = shortestDecimal(x);
  const shift = value.scale - scale;
  return shift >= 0
    ? BigInt(value.digits) % (BigInt(digits) * 10n ** BigInt(shift)) === 0n
    : BigInt(value.digits) * 10n ** BigInt(-shift) % BigInt(digits) === 0n;
}

function compileNumberMaximum(schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    getNumbishType,
    jsonSchema.maximum,
    jsonSchema.exclusiveMaximum,
  );

  let validateExclusive;
  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'exclusiveMaximum');

    validateExclusive = function validateExclusiveMaximum(data, dataPath) {
      return data < emax
        || addError(data, dataPath);
    };
  }

  let validateInclusive;
  if (max != null) {
    const addError = schemaObj.createErrorHandler(max, 'maximum');

    validateInclusive = function validateMaximum(data, dataPath) {
      return data <= max
        || addError(data, dataPath);
    };
  }

  if (validateInclusive && validateExclusive) {
    return function validateMaximumRange(data, dataPath) {
      return validateInclusive(data, dataPath)
        && validateExclusive(data, dataPath);
    };
  }

  return validateInclusive || validateExclusive;
}

function compileNumberMinimum(schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    getNumbishType,
    jsonSchema.minimum,
    jsonSchema.exclusiveMinimum,
  );

  let validateExclusive;
  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'exclusiveMinimum');

    validateExclusive = function validateExclusiveMinimum(data, dataPath) {
      return data > emin
        || addError(data, dataPath);
    };
  }

  let validateInclusive;
  if (min != null) {
    const addError = schemaObj.createErrorHandler(min, 'minimum');

    validateInclusive = function validateMinimum(data, dataPath) {
      return data >= min
        || addError(data, dataPath);
    };
  }

  if (validateInclusive && validateExclusive) {
    return function validateMinimumRange(data, dataPath) {
      return validateInclusive(data, dataPath)
        && validateExclusive(data, dataPath);
    };
  }

  return validateInclusive || validateExclusive;
}

function compileNumberMultipleOf(schemaObj, jsonSchema) {
  const mulOf = getNumbishType(jsonSchema.multipleOf);
  if (mulOf == null) return undefined;

  const addError = schemaObj.createErrorHandler(mulOf, 'multipleOf');
  const isMultipleOf = multipleOfTester(mulOf);

  return function validateMultipleOf(data, dataPath) {
    return isMultipleOf(data)
      || addError(data, dataPath);
  };
}

function compileNumberIntern(schemaObj, jsonSchema) {
  const maximum = compileNumberMaximum(schemaObj, jsonSchema);
  const minimum = compileNumberMinimum(schemaObj, jsonSchema);
  const multipleOf = compileNumberMultipleOf(schemaObj, jsonSchema);
  if (maximum == null && minimum == null && multipleOf == null)
    return undefined;

  // Single-constraint schemas are the common case; call the one
  // validator directly instead of chaining through trueThat stubs.
  const count = (maximum ? 1 : 0) + (minimum ? 1 : 0) + (multipleOf ? 1 : 0);
  if (count === 1)
    return maximum || minimum || multipleOf;

  if (multipleOf == null) {
    /**
     * @param {number} data
     * @param {string} dataPath
     * @returns {boolean}
     */
    return function validateNumberMinMax(data, dataPath) {
      return /** @type {Function} */ (maximum)(data, dataPath)
        && /** @type {Function} */ (minimum)(data, dataPath);
    };
  }

  const isMax = maximum || trueThat;
  const isMin = minimum || trueThat;

  if (schemaObj.options.skipErrors) {
    /**
     * @param {number} data
     * @param {string} dataPath
     * @returns {boolean}
     */
    return function validateNumberIntern(data, dataPath) {
      return isMax(data, dataPath)
        && isMin(data, dataPath)
        && multipleOf(data, dataPath);
    };
  }

  // The bounds and multipleOf are independent assertions about the same
  // number: being below the minimum says nothing about divisibility.
  return function validateNumberInternAll(data, dataPath) {
    let valid = isMax(data, dataPath);
    valid = isMin(data, dataPath) && valid;
    return multipleOf(data, dataPath) && valid;
  };
}

export function compileNumberBasic(schemaObj, jsonSchema) {
  const intern = compileNumberIntern(schemaObj, jsonSchema);
  if (intern == null) return undefined;

  return function validateNumber(data, dataPath) {
    return isNumberType(data)
      ? intern(data, dataPath)
      : true;
  };
}
