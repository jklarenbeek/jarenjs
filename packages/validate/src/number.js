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

function compileNumberMaximum(schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    getNumbishType,
    jsonSchema.maximum,
    jsonSchema.exclusiveMaximum,
  );

  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'exclusiveMaximum');

    return function validateExclusiveMaximum(data, dataPath) {
      return data < emax
        || addError(data, dataPath);
    };
  }
  else if (max != null) {
    const addError = schemaObj.createErrorHandler(max, 'maximum');

    return function validateMaximum(data, dataPath) {
      return data <= max
        || addError(data, dataPath);
    };
  }

  return undefined;
}

function compileNumberMinimum(schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    getNumbishType,
    jsonSchema.minimum,
    jsonSchema.exclusiveMinimum,
  );

  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'exclusiveMinimum');

    return function validateExclusiveMinimum(data, dataPath) {
      return data > emin
        || addError(data, dataPath);
    };
  }
  else if (min != null) {
    const addError = schemaObj.createErrorHandler(min, 'minimum');

    return function validateMinimum(data, dataPath) {
      return data >= min
        || addError(data, dataPath);
    };
  }

  return undefined;
}

function compileNumberMultipleOf(schemaObj, jsonSchema) {
  const mulOf = getNumbishType(jsonSchema.multipleOf);
  if (mulOf == null) return undefined;

  const addError = schemaObj.createErrorHandler(mulOf, 'multipleOf');

  return function validateMultipleOf(data, dataPath) {
    // Handle overflow: if data is too large, division may overflow to Infinity
    // In such cases, check if the data is divisible using alternative methods
    const q = data / mulOf;
    
    // If q overflowed to Infinity, use alternative validation methods
    if (!Number.isFinite(q)) {
      // For large integers with power-of-2 fractional multipleOf
      // we can determine validity based on the exponent
      if (Number.isInteger(data) && data !== 0) {
        // Check if multipleOf is a negative power of 2 (0.5, 0.25, 0.125, etc.)
        // These can be checked using binary representation
        const mulOfInverse = 1 / mulOf;
        if (Number.isInteger(mulOfInverse) && (mulOfInverse & (mulOfInverse - 1)) === 0) {
          // mulOfInverse is a power of 2 (1, 2, 4, 8, ...)
          // Any integer divided by 0.5, 0.25, etc. gives an integer result
          // Since data is integer and mulOf is 1/(power of 2), data/mulOf is always integer
          return true;
        }
        // For integer multipleOf, use modulo
        if (Number.isInteger(mulOf)) {
          return data % mulOf === 0 || addError(data, dataPath);
        }
      }
      // For other overflow cases, the result is not an integer
      // This handles cases like 1e308 / 0.123456789 which overflows
      return addError(data, dataPath);
    }
    
    return Math.abs(q - Math.round(q)) < 1e-6
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

export function compileNumberBasic(schemaObj, jsonSchema) {
  const intern = compileNumberIntern(schemaObj, jsonSchema);
  if (intern == null) return undefined;

  return function validateNumber(data, dataPath) {
    return isNumberType(data)
      ? intern(data, dataPath)
      : true;
  };
}
