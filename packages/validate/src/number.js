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
    return data % mulOf === 0
      || addError(data, dataPath);
  };
}

function compileNumberIntern(schemaObj, jsonSchema) {
  const maximum = compileNumberMaximum(schemaObj, jsonSchema);
  const minimum = compileNumberMinimum(schemaObj, jsonSchema);
  const multipleOf = compileNumberMultipleOf(schemaObj, jsonSchema);
  if (maximum == null && minimum == null && multipleOf == null)
    return undefined;

  const isMax = maximum || trueThat;
  const isMin = minimum || trueThat;
  const isMul = multipleOf || trueThat;

  return function validateNumberIntern(data, dataPath) {
    return isMax(data, dataPath)
      && isMin(data, dataPath)
      && isMul(data, dataPath);
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
