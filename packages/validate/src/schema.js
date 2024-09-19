//@ts-check

import {
  isObjectType,
  getStringType,
} from '@jarenjs/core';

import {
  getUniqueArray,
} from '@jarenjs/core/array';

import {
  getBoolishType,
} from '@jarenjs/core/number';

import {
  falseThat,
  trueThat,
  addFunctionToArray,
} from '@jarenjs/core/function';

import {
  createIsSchemaTypeHandler,
} from './tools.js';

import { compileFormatBasic } from './format.js';
import { compileEnumBasic } from './enum.js';
import { compileNumberBasic } from './number.js';
import { compileBigIntBasic } from './bigint.js';
import { compileStringBasic } from './string.js';
import { compileObjectSchema } from './object.js';
import { compileArraySchema } from './array.js';
import { compileCombineSchema } from './combine.js';
import { compileConditionSchema } from './condition.js';

function compileRequired(schemaObj, jsonSchema) {
  // if required is not true, we have nothing.
  const required = getBoolishType(jsonSchema.required);
  if (required !== true) return undefined;

  const addError = schemaObj.createErrorHandler(required, 'required');

  // the compiled named function.
  return function validateRequiredType(data, dataPath) {
    return data === undefined
      ? addError(data, dataPath)
      : true;
  };
}

function compileTypeSimple(schemaObj, jsonSchema) {
  const type = getStringType(jsonSchema.type);
  if (type == null) return undefined;

  const isDataType = createIsSchemaTypeHandler(type);
  if (!isDataType) throw new Error(`The explicit schema type '${type}' is unknown. (TODO: add trace)`);

  const addError = schemaObj.createErrorHandler(type, 'type');

  return function validateTypeSimple(data, dataPath) {
    return isDataType(data)
      ? true
      : addError(data, dataPath);
  };
}

function compileTypeArray(schemaObj, jsonSchema) {
  const schemaTypes = getUniqueArray(jsonSchema.type);
  if (schemaTypes == null) return undefined;
  if (schemaTypes.length === 0)
    throw new Error('The schema type property can not be an empty array.');

  // collect all testable data types
  const types = [];
  const names = [];
  for (let i = 0; i < schemaTypes.length; ++i) {
    const type = schemaTypes[i];
    const callback = createIsSchemaTypeHandler(type);
    if (!callback)
      throw new Error(`The explicit schema type '${type}' of '${types} is unknown. (TODO: add trace)`);

    types.push(callback);
    names.push(type);
  }

  const addError = schemaObj.createErrorHandler(names, 'type');

  // if one has been found create a validator
  if (types.length === 1) {
    const one = types[0];
    return function validateSingleType(data, dataPath) {
      return one(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else if (types.length === 2) {
    const one = types[0];
    const two = types[1];
    return function validateDoubleTypes(data, dataPath) {
      return one(data) || two(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else if (types.length === 3) {
    const one = types[0];
    const two = types[1];
    const three = types[2];
    return function validateTripleTypes(data, dataPath) {
      return one(data) || two(data) || three(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else {
    return function validateAllTypes(data, dataPath) {
      for (let i = 0; i < types.length; ++i) {
        if (types[i](data) === true) return true;
      }
      return addError(data, dataPath);
    };
  }
}

function compileTypeBasic(schemaObj, jsonSchema) {
  const validator = compileTypeSimple(schemaObj, jsonSchema)
    || compileTypeArray(schemaObj, jsonSchema);

  const nullable = getBoolishType(jsonSchema.nullable);
  if (validator == null) {
    if (nullable !== false) return undefined;

    const addError = schemaObj.createErrorHandler(nullable, 'nullable');

    return function validateNotIsNull(data, dataPath) {
      return data === undefined
        || data !== null
        || addError(data, dataPath);
    };
  }

  if (nullable === true) {
    return function validateNullableType(data, dataPath) {
      return data === undefined
        || data === null
        || validator(data, dataPath);
    };
  }

  return function validateType(data, dataPath) {
    return data === undefined
      || validator(data, dataPath);
  };
}

export function compileSchemaObject(schemaObj, jsonSchema) {
  if (jsonSchema === true) return trueThat;
  if (jsonSchema === false) return falseThat;
  if (!isObjectType(jsonSchema))
    throw new Error('JSON Schema MUST be a boolean or Object Type');

  if (Object.keys(jsonSchema).length === 0)
    return trueThat;

  const validators = [];
  addFunctionToArray(validators, compileRequired(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileTypeBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileEnumBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileNumberBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileBigIntBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileStringBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileFormatBasic(schemaObj, jsonSchema));

  addFunctionToArray(validators, compileArraySchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileObjectSchema(schemaObj, jsonSchema));

  addFunctionToArray(validators, compileCombineSchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileConditionSchema(schemaObj, jsonSchema));

  // same as empty schema
  if (validators.length === 0)
    return trueThat;

  if (validators.length === 1)
    return validators[0];

  if (validators.length === 2) {
    const first = validators[0];
    const second = validators[1];
    return function validateDoubleSchemaObject(data, dataPath, dataRoot) {
      return first(data, dataPath, dataRoot)
        && second(data, dataPath, dataRoot);
    };
  }

  if (validators.length === 3) {
    const first = validators[0];
    const second = validators[1];
    const thirth = validators[2];
    return function validateTripleSchemaObject(data, dataPath, dataRoot) {
      return first(data, dataPath, dataRoot)
        && second(data, dataPath, dataRoot)
        && thirth(data, dataPath, dataRoot);
    };
  }

  return function validateAllSchemaObject(data, dataPath, dataRoot) {
    for (let i = 0; i < validators.length; ++i) {
      const validator = validators[i];
      if (validator(data, dataPath, dataRoot) === false) {
        return false;
      }
    }
    return true;
  };
}
