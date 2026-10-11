//@ts-check

import {
  isBigIntType,
  getBigIntType,
  getInclusiveExclusiveBounds,
} from '@jarenjs/core';

import {
  trueThat,
} from '@jarenjs/core/function';

function compileBigIntMaximum(schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    getBigIntType,
    jsonSchema.maximum,
    jsonSchema.exclusiveMaximum,
  );

  let validateExclusive;
  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'exclusiveMaximum');

    validateExclusive = function validateExclusiveMaximumBigInt(data, dataPath) {
      return data < emax
        || addError(data, dataPath);
    };
  }

  let validateInclusive;
  if (max != null) {
    const addError = schemaObj.createErrorHandler(max, 'maximum');

    validateInclusive = function validateMaximumBigInt(data, dataPath) {
      return data <= max
        || addError(data, dataPath);
    };
  }

  if (validateInclusive && validateExclusive) {
    return function validateMaximumRangeBigInt(data, dataPath) {
      return validateInclusive(data, dataPath)
        && validateExclusive(data, dataPath);
    };
  }

  return validateInclusive || validateExclusive;
}

function compileBigIntMinimum(schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    getBigIntType,
    jsonSchema.minimum,
    jsonSchema.exclusiveMinimum,
  );

  let validateExclusive;
  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'exclusiveMinimum');

    validateExclusive = function validateExclusiveMinimumBigInt(data, dataPath) {
      return data > emin
        || addError(data, dataPath);
    };
  }

  let validateInclusive;
  if (min != null) {
    const addError = schemaObj.createErrorHandler(min, 'minimum');

    validateInclusive = function validateMinimumBigInt(data, dataPath) {
      return data >= min
        || addError(data, dataPath);
    };
  }

  if (validateInclusive && validateExclusive) {
    return function validateMinimumRangeBigInt(data, dataPath) {
      return validateInclusive(data, dataPath)
        && validateExclusive(data, dataPath);
    };
  }

  return validateInclusive || validateExclusive;
}

function compileBigIntMultipleOf(schemaObj, jsonSchema) {
  const mulOf = getBigIntType(jsonSchema.multipleOf);
  if (mulOf == null) return undefined;

  const addError = schemaObj.createErrorHandler(mulOf, 'multipleOf');

  return function validateMultipleOfBigInt(data, dataPath) {
    return data % mulOf === BigInt(0)
      || addError(data, dataPath);
  };
}

export function compileBigIntBasic(schemaObj, jsonSchema) {
  const maximum = compileBigIntMaximum(schemaObj, jsonSchema);
  const minimum = compileBigIntMinimum(schemaObj, jsonSchema);
  const multipleOf = compileBigIntMultipleOf(schemaObj, jsonSchema);
  if (maximum == null && minimum == null && multipleOf == null) return undefined;

  const isMax = maximum || trueThat;
  const isMin = minimum || trueThat;
  const isMul = multipleOf || trueThat;

  if (schemaObj.options.skipErrors) {
    return function validateBigIntSchema(data, dataPath) {
      if (isBigIntType(data)) {
        return isMax(data, dataPath)
          && isMin(data, dataPath)
          && isMul(data, dataPath);
      }
      return true;
    };
  }

  // The type guard stays a precondition; the three assertions inside it are
  // independent and each must get to report its own fault.
  return function validateBigIntSchemaAll(data, dataPath) {
    if (!isBigIntType(data)) return true;
    let valid = isMax(data, dataPath);
    valid = isMin(data, dataPath) && valid;
    return isMul(data, dataPath) && valid;
  };
}
