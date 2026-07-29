//@ts-check

import {
  isStringType,
} from '@jarenjs/core';

import {
  getIntishType,
} from '@jarenjs/core/number';

import {
  createRegExp,
  getStringLength,
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

  const addError = schemaObj.createErrorHandler(max, 'maxLength');

  return function validateIsMaxLength(len = 0, dataPath) {
    return len <= max
      || addError(len, dataPath);
  };
}

function compilePattern(schemaObj, jsonSchema) {
  // Skip if pattern is a $data reference object (has $data property)
  if (jsonSchema.pattern && typeof jsonSchema.pattern === 'object' && jsonSchema.pattern.$data) return undefined;

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
  const useGrapheme = schemaObj.options.useGrapheme;

  if (schemaObj.options.skipErrors) {
    return function validateStringIntern(data, dataPath) {
      const len = getStringLength(data, useGrapheme);
      return isMinLength(len, dataPath)
        && isMaxLength(len, dataPath)
        && isMatch(data, dataPath);
    };
  }

  // Length and pattern are independent assertions over the same string:
  // `len` is computed before any of them and `isMatch` reads the raw data,
  // so a failed `minLength` says nothing about whether `pattern` holds.
  // Short-circuiting them is a boolean-mode optimization; when errors are
  // recorded it would hide half the reasons the value is wrong.
  return function validateStringInternAll(data, dataPath) {
    const len = getStringLength(data, useGrapheme);
    let valid = isMinLength(len, dataPath);
    valid = isMaxLength(len, dataPath) && valid;
    return isMatch(data, dataPath) && valid;
  };
}

export function compileStringBasic(schemaObj, jsonSchema) {
  const intern = compileStringIntern(schemaObj, jsonSchema);
  if (intern == null) return undefined;

  // Fast path for simple maxLength-only schemas (most common case)
  // This inlines the validation to reduce function call overhead
  const max = getIntishType(jsonSchema.maxLength) ?? -1;
  const min = getIntishType(jsonSchema.minLength) || 0;
  const hasPattern = jsonSchema.pattern != null;
  const useGrapheme = schemaObj.options.useGrapheme;

  if (!hasPattern) {
    if (!useGrapheme) {
      // Simple maxLength-only without grapheme counting
      if (max >= 0 && min < 1) {
        const addError = schemaObj.createErrorHandler(max, 'maxLength');
        return function validateStringMaxLength(data, dataPath) {
          if (!isStringType(data)) return true;
          return data.length <= max || addError(data.length, dataPath);
        };
      }

      // Simple minLength-only without grapheme counting
      if (min > 0 && max < 0) {
        const addError = schemaObj.createErrorHandler(min, 'minLength');
        return function validateStringMinLength(data, dataPath) {
          if (!isStringType(data)) return true;
          return data.length >= min || addError(data.length, dataPath);
        };
      }
    } else {
      // Fast path WITH grapheme counting - inline the ASCII fast-path logic
      // This avoids the function call overhead of getStringLength for ASCII strings
      if (max >= 0 && min < 1) {
        const addError = schemaObj.createErrorHandler(max, 'maxLength');
        return function validateStringMaxLengthGrapheme(data, dataPath) {
          if (!isStringType(data)) return true;
          const len = getStringLength(data, true);
          return len <= max || addError(len, dataPath);
        };
      }

      if (min > 0 && max < 0) {
        const addError = schemaObj.createErrorHandler(min, 'minLength');
        return function validateStringMinLengthGrapheme(data, dataPath) {
          if (!isStringType(data)) return true;
          const len = getStringLength(data, true);
          return len >= min || addError(len, dataPath);
        };
      }
    }
  }

  // Fast path for pattern-only schemas (common in ecmascript-regex tests)
  // This eliminates the intermediate function call overhead
  if (hasPattern && max < 0 && min < 1) {
    const pattern = createRegExp(jsonSchema.pattern);
    if (pattern != null) {
      const addError = schemaObj.createErrorHandler(pattern, 'pattern');
      return function validateStringPatternOnly(data, dataPath) {
        if (!isStringType(data)) return true;
        return pattern.test(data) || addError(data, dataPath);
      };
    }
  }

  // Generic case
  return function validateStringBasic(data, dataPath) {
    return !isStringType(data)
      || intern(data, dataPath);
  };
}
