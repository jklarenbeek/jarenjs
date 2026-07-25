//@ts-check

/**
 * @fileoverview Data keyword implementation for referencing instance data.
 *
 * This implements the "data" keyword from json-everything's data-2022 meta-schema,
 * allowing schema values to be sourced from the instance data at validation time.
 *
 * Example:
 * {
 *   "type": "object",
 *   "properties": {
 *     "A": { "type": "number" },
 *     "B": {
 *       "type": "number",
 *       "data": {
 *         "minimum": "/A"
 *       }
 *     }
 *   }
 * }
 *
 * Supports both absolute JSON Pointers (starting with /) and relative JSON Pointers.
 * @see https://docs.json-everything.net/schema/examples/data-ref/
 */

import {
  isObjectClass,
  isStringType,
  isNumberType,
} from '@jarenjs/core';

import {
  compileDataRef,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';

import {
  resolveNothing,
} from './tools.js';

function compileRefResolver(ref) {
  try {
    return compileDataRef(ref);
  }
  catch {
    return resolveNothing;
  }
}

/**
 * Compile minimum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMinimum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minimum');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const minValue = resolveRef(dataRoot, dataPath);
    if (minValue === JSONPOINTER_NOTHING || !isNumberType(minValue)) return true;

    return data >= minValue || addError(data, dataPath, minValue);
  };
}

/**
 * Compile maximum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMaximum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maximum');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const maxValue = resolveRef(dataRoot, dataPath);
    if (maxValue === JSONPOINTER_NOTHING || !isNumberType(maxValue)) return true;

    return data <= maxValue || addError(data, dataPath, maxValue);
  };
}

/**
 * Compile exclusiveMinimum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataExclusiveMinimum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'exclusiveMinimum');
  const resolveRef = compileRefResolver(ref);

  return function validateDataExclusiveMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const minValue = resolveRef(dataRoot, dataPath);
    if (minValue === JSONPOINTER_NOTHING || !isNumberType(minValue)) return true;

    return data > minValue || addError(data, dataPath, minValue);
  };
}

/**
 * Compile exclusiveMaximum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataExclusiveMaximum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'exclusiveMaximum');
  const resolveRef = compileRefResolver(ref);

  return function validateDataExclusiveMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const maxValue = resolveRef(dataRoot, dataPath);
    if (maxValue === JSONPOINTER_NOTHING || !isNumberType(maxValue)) return true;

    return data < maxValue || addError(data, dataPath, maxValue);
  };
}

/**
 * Compile enum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataEnum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'enum');
  const resolveRef = compileRefResolver(ref);

  return function validateDataEnum(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const enumValues = resolveRef(dataRoot, dataPath);
    if (enumValues === JSONPOINTER_NOTHING || !Array.isArray(enumValues)) return true;

    return enumValues.includes(data) || addError(data, dataPath, enumValues);
  };
}

/**
 * Compile const constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataConst(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'const');
  const resolveRef = compileRefResolver(ref);

  return function validateDataConst(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const constValue = resolveRef(dataRoot, dataPath);
    if (constValue === JSONPOINTER_NOTHING) return true;

    return data === constValue || addError(data, dataPath, constValue);
  };
}

/**
 * Compile minLength constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMinLength(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minLength');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMinLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const minLen = resolveRef(dataRoot, dataPath);
    if (minLen === JSONPOINTER_NOTHING || !isNumberType(minLen)) return true;

    return data.length >= minLen || addError(data, dataPath, minLen);
  };
}

/**
 * Compile maxLength constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMaxLength(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxLength');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMaxLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const maxLen = resolveRef(dataRoot, dataPath);
    if (maxLen === JSONPOINTER_NOTHING || !isNumberType(maxLen)) return true;

    return data.length <= maxLen || addError(data, dataPath, maxLen);
  };
}

/**
 * Compile minItems constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMinItems(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minItems');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMinItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const minItems = resolveRef(dataRoot, dataPath);
    if (minItems === JSONPOINTER_NOTHING || !isNumberType(minItems)) return true;

    return data.length >= minItems || addError(data, dataPath, minItems);
  };
}

/**
 * Compile maxItems constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMaxItems(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxItems');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMaxItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const maxItems = resolveRef(dataRoot, dataPath);
    if (maxItems === JSONPOINTER_NOTHING || !isNumberType(maxItems)) return true;

    return data.length <= maxItems || addError(data, dataPath, maxItems);
  };
}

/**
 * Compile minProperties constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMinProperties(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minProperties');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMinProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const minProps = resolveRef(dataRoot, dataPath);
    if (minProps === JSONPOINTER_NOTHING || !isNumberType(minProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount >= minProps || addError(data, dataPath, minProps);
  };
}

/**
 * Compile maxProperties constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMaxProperties(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxProperties');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMaxProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const maxProps = resolveRef(dataRoot, dataPath);
    if (maxProps === JSONPOINTER_NOTHING || !isNumberType(maxProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount <= maxProps || addError(data, dataPath, maxProps);
  };
}

/**
 * Compile multipleOf constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMultipleOf(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'multipleOf');
  const resolveRef = compileRefResolver(ref);

  return function validateDataMultipleOf(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const multipleOf = resolveRef(dataRoot, dataPath);
    if (multipleOf === JSONPOINTER_NOTHING || !isNumberType(multipleOf)) return true;

    const q = data / multipleOf;
    return Math.abs(q - Math.round(q)) < 1e-6 || addError(data, dataPath, multipleOf);
  };
}

/**
 * Compile pattern constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataPattern(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'pattern');
  const resolveRef = compileRefResolver(ref);

  return function validateDataPattern(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const pattern = resolveRef(dataRoot, dataPath);
    if (pattern === JSONPOINTER_NOTHING || !isStringType(pattern)) return true;

    const regex = new RegExp(pattern, 'u');
    return regex.test(data) || addError(data, dataPath, pattern);
  };
}

/**
 * Compile format constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataFormat(schemaObj, ref) {
  const formats = schemaObj.formats;
  if (!formats) return undefined;

  const addError = schemaObj.createErrorHandler(ref, 'format');
  const resolveRef = compileRefResolver(ref);

  // The registry holds format COMPILERS; compile (and cache) a validator
  // per referenced format name at validation time.
  const compiled = new Map();
  const mockSchemaObj = {
    createErrorHandler: () => () => false,
    options: { skipErrors: true },
  };

  return function validateDataFormat(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const formatName = resolveRef(dataRoot, dataPath);
    if (formatName === JSONPOINTER_NOTHING || !isStringType(formatName)) return true;

    let validator = compiled.get(formatName);
    if (validator === undefined) {
      const formatCompiler = formats[formatName];
      validator = null;
      if (formatCompiler) {
        try {
          const candidate = formatCompiler(mockSchemaObj, { format: formatName });
          if (typeof candidate === 'function') validator = candidate;
        } catch (_e) {
          // An uncompilable format asserts nothing
        }
      }
      compiled.set(formatName, validator);
    }
    if (validator === null) return true;

    return validator(data, dataPath) || addError(data, dataPath, formatName);
  };
}

/**
 * Compile the data keyword schema
 * @param {object} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing the data keyword
 * @returns {function|undefined} The compiled validator function or undefined
 */
export function compileDataSchema(schemaObj, jsonSchema) {
  const dataSchema = jsonSchema.data;
  if (!isObjectClass(dataSchema)) {
    return undefined;
  }

  const validators = [];

  // Compile each supported keyword within the data object
  for (const [keyword, ref] of Object.entries(dataSchema)) {
    if (!isStringType(ref)) {
      continue; // Skip non-string references
    }

    let validator;

    switch (keyword) {
      case 'minimum':
        validator = compileDataMinimum(schemaObj, ref);
        break;
      case 'maximum':
        validator = compileDataMaximum(schemaObj, ref);
        break;
      case 'exclusiveMinimum':
        validator = compileDataExclusiveMinimum(schemaObj, ref);
        break;
      case 'exclusiveMaximum':
        validator = compileDataExclusiveMaximum(schemaObj, ref);
        break;
      case 'enum':
        validator = compileDataEnum(schemaObj, ref);
        break;
      case 'const':
        validator = compileDataConst(schemaObj, ref);
        break;
      case 'minLength':
        validator = compileDataMinLength(schemaObj, ref);
        break;
      case 'maxLength':
        validator = compileDataMaxLength(schemaObj, ref);
        break;
      case 'minItems':
        validator = compileDataMinItems(schemaObj, ref);
        break;
      case 'maxItems':
        validator = compileDataMaxItems(schemaObj, ref);
        break;
      case 'minProperties':
        validator = compileDataMinProperties(schemaObj, ref);
        break;
      case 'maxProperties':
        validator = compileDataMaxProperties(schemaObj, ref);
        break;
      case 'multipleOf':
        validator = compileDataMultipleOf(schemaObj, ref);
        break;
      case 'pattern':
        validator = compileDataPattern(schemaObj, ref);
        break;
      case 'format':
        validator = compileDataFormat(schemaObj, ref);
        break;
      default:
        // Unknown keyword in data, skip
        break;
    }

    if (validator) {
      validators.push(validator);
    }
  }

  if (validators.length === 0) {
    return undefined;
  }

  if (validators.length === 1) {
    return validators[0];
  }

  return function validateDataSchema(data, dataPath, dataRoot) {
    for (let i = 0; i < validators.length; i++) {
      if (!validators[i](data, dataPath, dataRoot)) {
        return false;
      }
    }
    return true;
  };
}
