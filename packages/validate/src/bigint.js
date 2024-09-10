//@ts-check

import {
  isBigIntType,
  getBigIntType,
  getInclusiveExclusiveBounds,
} from '@jaren/core';

import {
  trueThat,
} from '@jaren/core/function';

function compileBigIntMaximum(schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    getBigIntType,
    jsonSchema.maximum,
    jsonSchema.exclusiveMaximum,
  );

  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'exclusiveMaximum');

    return function validateExclusiveMaximumBigInt(data, dataPath) {
      return data < emax
        || addError(data, dataPath);
    };
  }
  else if (max != null) {
    const addError = schemaObj.createErrorHandler(max, 'maximum');

    return function validateMaximumBigInt(data, dataPath) {
      return data <= max
        || addError(data, dataPath);
    };
  }

  return undefined;
}

function compileBigIntMinimum(schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    getBigIntType,
    jsonSchema.minimum,
    jsonSchema.exclusiveMinimum,
  );

  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'exclusiveMinimum');

    return function validateExclusiveMinimumBigInt(data, dataPath) {
      return data > emin
        || addError(data, dataPath);
    };
  }
  else if (min != null) {
    const addError = schemaObj.createErrorHandler(min, 'minimum');

    return function validateMinimumBigInt(data, dataPath) {
      return data >= min
        || addError(data, dataPath);
    };
  }

  return undefined;
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

  return function validateBigIntSchema(data, dataPath) {
    if (isBigIntType(data)) {
      return isMax(data, dataPath)
        && isMin(data, dataPath)
        && isMul(data, dataPath);
    }
    return true;
  };
}
