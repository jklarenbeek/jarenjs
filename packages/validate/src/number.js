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
  multipleOfTester,
} from '@jarenjs/core/math';

// The one exact test of `multipleOf`, which the form field check
// shares; the `$data` step (tools.js) reads it from here too.
export { multipleOfTester };

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
