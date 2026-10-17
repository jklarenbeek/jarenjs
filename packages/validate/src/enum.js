//@ts-check

import {
  isScalarType,
} from '@jarenjs/core';

import {
  equalsDeep,
} from '@jarenjs/core/object';

import {
  getArrayClassMinItems,
} from './tools.js';
import { isDollarDataReference } from './dollar-data.js';

function compileConst(schemaObj, jsonSchema) {
  const constant = jsonSchema.const;
  if (constant === undefined)
    return undefined;

  if (isDollarDataReference(constant))
    return undefined;

  const addError = schemaObj.createErrorHandler(constant, 'const');

  if (constant === null || isScalarType(constant)) {
    return function validatePrimitiveConst(data, dataPath) {
      return constant === data
        || addError(data, dataPath);
    };
  }
  else {
    return function validateComplexConst(data, dataPath) {
      return equalsDeep(constant, data)
        || addError(data, dataPath);
    };
  }
}

function compileEnum(schemaObj, jsonSchema) {
  // An empty list admits no value (2019-09 on, an enum may be empty).
  const enums = getArrayClassMinItems(jsonSchema.enum, 0);
  if (enums == null) return undefined;

  let hasObjects = false;
  for (let i = 0; i < enums.length; ++i) {
    const e = enums[i];
    if (e != null && typeof e === 'object') {
      hasObjects = true;
      break;
    }
  }

  const addError = schemaObj.createErrorHandler(enums, 'enum');

  if (hasObjects === false) {
    return function validateEnumSimple(data, dataPath) {
      return data === undefined
        ? true
        : enums.includes(data)
          ? true
          : addError(data, dataPath);
    };
  }
  else {
    return function validateEnumDeep(data, dataPath) {
      if (data === undefined) return true;
      if (data === null || typeof data !== 'object')
        return enums.includes(data)
          ? true
          : addError(data, dataPath);

      for (let i = 0; i < enums.length; ++i) {
        if (equalsDeep(enums[i], data) === true)
          return true;
      }
      return addError(data, dataPath);
    };
  }
}

export function compileEnumBasic(schemaObj, jsonSchema) {
  return [
    compileConst(schemaObj, jsonSchema),
    compileEnum(schemaObj, jsonSchema),
  ];
}
