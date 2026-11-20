//@ts-check

import {
  isScalarType,
} from '@jarenjs/core';

import {
  equalsDeep,
} from '@jarenjs/core/object';

import {
  getArrayClassMinItems,
  isComparedDeep,
  undefinedElement,
} from './tools.js';
import { isDollarDataRef } from './schema-keywords.js';

function compileConst(schemaObj, jsonSchema) {
  const constant = jsonSchema.const;
  if (constant === undefined)
    return undefined;

  // A string $data is a reference (compiled with the $data keywords); an
  // object with any other $data member is the literal value.
  if (isDollarDataRef(constant))
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

  // `const` and `enum` answer by one relation, core's `equalsDeep`: an
  // object or a function is listed when a member equals it by that
  // relation, any other value when the list holds it.
  let hasObjects = false;
  for (let i = 0; i < enums.length; ++i) {
    if (isComparedDeep(enums[i])) {
      hasObjects = true;
      break;
    }
  }

  const addError = schemaObj.createErrorHandler(enums, 'enum');

  // `NaN` equals no value, itself included, where `includes` finds it: the
  // list searched holds none (a hole stays the `undefined` it is read as).
  const listed = enums.some((e) => e !== e)
    ? Array.from(enums).filter((e) => e === e)
    : enums;

  if (hasObjects === false) {
    return function validateEnumSimple(data, dataPath) {
      return data === undefined && !undefinedElement
        ? true
        : listed.includes(data)
          ? true
          : addError(data, dataPath);
    };
  }
  else {
    return function validateEnumDeep(data, dataPath) {
      if (data === undefined && !undefinedElement) return true;
      if (!isComparedDeep(data))
        return listed.includes(data)
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
