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
  isArrayClass,
  isObjectType,
} from '@jarenjs/core';

import {
  getNumbishType,
} from '@jarenjs/core/number';

/**
 * Parse a JSON Pointer and return the path segments
 * @param {string} pointer - The JSON Pointer string (e.g., "/A/B")
 * @returns {string[]} Array of decoded path segments
 */
function parseJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    return [];
  }

  // JSON Pointer must start with /
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: '${pointer}' - must start with '/'`);
  }

  // Split by / and decode each segment
  // ~0 is decoded to ~ and ~1 is decoded to /
  return pointer.slice(1).split('/').map(segment =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  );
}

/**
 * Parse a relative JSON Pointer
 * Format: <non-negative-integer>("#"|<json-pointer>)
 * @param {string} pointer - The relative JSON Pointer (e.g., "0/A", "1/B", "0#")
 * @returns {{ levels: number, pointer: string, hash: boolean }} Parsed result
 */
function parseRelativeJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    throw new Error('Invalid relative JSON Pointer: empty string');
  }

  // Extract the number at the beginning
  const match = pointer.match(/^(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid relative JSON Pointer: '${pointer}' - must start with a number`);
  }

  const levels = parseInt(match[1], 10);
  const rest = match[2];

  // Check if it ends with # (reference to property name)
  if (rest === '#') {
    return { levels, pointer: '', hash: true };
  }

  // Otherwise it should be a JSON Pointer starting with /
  if (rest === '' || rest.startsWith('/')) {
    return { levels, pointer: rest, hash: false };
  }

  throw new Error(`Invalid relative JSON Pointer: '${pointer}'`);
}

/**
 * Get a value from data using a JSON Pointer path
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path (for relative pointer resolution)
 * @param {string} pointer - The JSON Pointer
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
function getValueByJsonPointer(dataRoot, dataPath, pointer) {
  try {
    const segments = parseJsonPointer(pointer);
    let current = dataRoot;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return { value: undefined, found: false };
      }

      if (isArrayClass(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object') {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }

    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

/**
 * Get a value from data using a relative JSON Pointer
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path (JSON Pointer to current location)
 * @param {string} relativePointer - The relative JSON Pointer
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
function getValueByRelativePointer(dataRoot, dataPath, relativePointer) {
  try {
    const parsed = parseRelativeJsonPointer(relativePointer);

    // Parse the current data path to get our position in the hierarchy
    const currentSegments = parseJsonPointer(dataPath || '');

    // Go up the specified number of levels
    if (parsed.levels > currentSegments.length) {
      return { value: undefined, found: false };
    }

    const targetSegments = currentSegments.slice(0, currentSegments.length - parsed.levels);

    // If hash is true, return the property name (last segment of the target)
    if (parsed.hash) {
      if (targetSegments.length === 0) {
        // We're at the root, return empty string or special marker
        return { value: '', found: true };
      }
      return { value: targetSegments[targetSegments.length - 1], found: true };
    }

    // Navigate to the target location
    let current = dataRoot;
    for (const segment of targetSegments) {
      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object' && current !== null) {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }

    // Now apply the JSON pointer part
    if (parsed.pointer) {
      const innerResult = getValueByJsonPointer(current, '', parsed.pointer);
      return innerResult;
    }

    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

/**
 * Resolve a data reference (either JSON Pointer or relative JSON Pointer)
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path
 * @param {string} ref - The reference string
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
function resolveDataRef(dataRoot, dataPath, ref) {
  if (!isStringType(ref)) {
    return { value: undefined, found: false };
  }

  // Check if it's a relative JSON Pointer (starts with a digit)
  if (/^\d/.test(ref)) {
    return getValueByRelativePointer(dataRoot, dataPath, ref);
  }

  // Otherwise treat as absolute JSON Pointer (starts with /)
  if (ref.startsWith('/')) {
    return getValueByJsonPointer(dataRoot, dataPath, ref);
  }

  // Empty string or invalid format - treat as reference to root
  if (ref === '') {
    return { value: dataRoot, found: true };
  }

  return { value: undefined, found: false };
}

/**
 * Compile minimum constraint from data reference
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The data reference
 * @returns {function|undefined} The compiled validator function
 */
function compileDataMinimum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minimum');

  return function validateDataMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: minValue, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minValue)) return true;

    return data >= minValue || addError(minValue, data, dataPath);
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

  return function validateDataMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: maxValue, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxValue)) return true;

    return data <= maxValue || addError(maxValue, data, dataPath);
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

  return function validateDataExclusiveMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: minValue, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minValue)) return true;

    return data > minValue || addError(minValue, data, dataPath);
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

  return function validateDataExclusiveMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: maxValue, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxValue)) return true;

    return data < maxValue || addError(maxValue, data, dataPath);
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

  return function validateDataEnum(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const { value: enumValues, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !Array.isArray(enumValues)) return true;

    return enumValues.includes(data) || addError(enumValues, data, dataPath);
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

  return function validateDataConst(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const { value: constValue, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found) return true;

    return data === constValue || addError(constValue, data, dataPath);
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

  return function validateDataMinLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: minLen, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minLen)) return true;

    return data.length >= minLen || addError(minLen, data, dataPath);
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

  return function validateDataMaxLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: maxLen, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxLen)) return true;

    return data.length <= maxLen || addError(maxLen, data, dataPath);
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

  return function validateDataMinItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const { value: minItems, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minItems)) return true;

    return data.length >= minItems || addError(minItems, data, dataPath);
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

  return function validateDataMaxItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const { value: maxItems, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxItems)) return true;

    return data.length <= maxItems || addError(maxItems, data, dataPath);
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

  return function validateDataMinProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const { value: minProps, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount >= minProps || addError(minProps, data, dataPath);
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

  return function validateDataMaxProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const { value: maxProps, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount <= maxProps || addError(maxProps, data, dataPath);
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

  return function validateDataMultipleOf(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: multipleOf, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isNumberType(multipleOf)) return true;

    const q = data / multipleOf;
    return Math.abs(q - Math.round(q)) < 1e-6 || addError(multipleOf, data, dataPath);
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

  return function validateDataPattern(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: pattern, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isStringType(pattern)) return true;

    const regex = new RegExp(pattern, 'u');
    return regex.test(data) || addError(pattern, data, dataPath);
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

  return function validateDataFormat(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: formatName, found } = resolveDataRef(dataRoot, dataPath, ref);
    if (!found || !isStringType(formatName)) return true;

    const formatValidator = formats[formatName];
    if (!formatValidator) return true;

    return formatValidator(data) || addError(formatName, data, dataPath);
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

/**
 * Check if the schema has a data keyword
 * @param {object} jsonSchema - The JSON schema to check
 * @returns {boolean} True if the schema has a data keyword
 */
export function hasDataKeyword(jsonSchema) {
  return isObjectType(jsonSchema) && isObjectType(jsonSchema.data);
}
