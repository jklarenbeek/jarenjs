//@ts-check

import {
  isStringType,
} from '@jarenjs/core';

import {
  getIntishType,
} from '@jarenjs/core/number';

import {
  createRegExp,
} from '@jarenjs/core/string';

import {
  trueThat,
} from '@jarenjs/core/function';

function compileMinLength(schemaObj, jsonSchema) {
  const min = getIntishType(jsonSchema.minLength) || 0;
  if (min < 1) return undefined;

  const addError = schemaObj.createErrorHandler(min, 'minLength');

  return function validateIsMinLength(len = 0, dataPath) {
    return len >= min
      || addError(len, dataPath);
  };
}

function compileMaxLength(schemaObj, jsonSchema) {
  const max = getIntishType(jsonSchema.maxLength) || -1;
  if (max < 0) return undefined;

  const addError = schemaObj.createErrorHandler(max, 'maxlength');

  return function validateIsMaxLength(len = 0, dataPath) {
    return len <= max
      || addError(len, dataPath);
  };
}

function compilePattern(schemaObj, jsonSchema) {
  const pattern = createRegExp(jsonSchema.pattern);
  if (pattern == null) return undefined;

  const addError = schemaObj.createErrorHandler(pattern, 'pattern');

  return function validateIsMatch(str = '', dataPath) {
    return pattern.test(str)
      || addError(str, dataPath);
  };
}

function compileStringIntern(schemaObj, jsonSchema) {
  const minLength = compileMinLength(schemaObj, jsonSchema);
  const maxLength = compileMaxLength(schemaObj, jsonSchema);
  const pattern = compilePattern(schemaObj, jsonSchema);
  if ((minLength || maxLength || pattern) == null) return undefined;

  const isMinLength = minLength || trueThat;
  const isMaxLength = maxLength || trueThat;
  const isMatch = pattern || trueThat;

  return function validateStringIntern(data, dataPath) {
    const len = data.length;
    return isMinLength(len, dataPath)
      && isMaxLength(len, dataPath)
      && isMatch(data, dataPath);
  };
}

export function compileStringBasic(schemaObj, jsonSchema) {
  const intern = compileStringIntern(schemaObj, jsonSchema);
  if (intern == null) return undefined;

  return function validateStringBasic(data, dataPath) {
    return isStringType(data)
      && intern(data, dataPath);
  };
}
