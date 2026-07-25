//@ts-check

/**
 * @fileoverview Ajv $data keyword implementation for referencing instance data.
 *
 * This implements the Ajv-style "$data" keyword, allowing constraint keyword values
 * to be sourced from instance data at validation time using Relative JSON Pointers.
 *
 * Example:
 * {
 *   "type": "object",
 *   "properties": {
 *     "smaller": {
 *       "type": "number",
 *       "maximum": { "$data": "1/larger" }
 *     },
 *     "larger": {
 *       "type": "number"
 *     }
 *   }
 * }
 *
 * The "$data" value is a Relative JSON Pointer that resolves from the current data location.
 * Format: <non-negative-integer>("#" | <json-pointer>)
 * - "0" - The current value itself
 * - "0#" - The property name/index of the current value
 * - "0/foo" - The "foo" property of the current value
 * - "1" - The parent value
 * - "1/foo" - The "foo" property of the parent value
 * - "2/bar" - Go up 2 levels, then look for "bar"
 *
 * @see https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data
 * @see https://datatracker.ietf.org/doc/html/draft-luff-relative-json-pointer-00
 */

import {
  isObjectClass,
  isStringType,
  isNumberType,
  isObjectType,
} from '@jarenjs/core';

import {
  equalsDeep,
} from '@jarenjs/core/object';

import {
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';

import {
  resolveNothing,
} from './tools.js';

function compileRefResolver(ref) {
  try {
    return compileRelativeJSONPointer(ref);
  }
  catch {
    return resolveNothing;
  }
}

/**
 * Check if a value is a $data reference object
 * @param {*} value - The value to check
 * @returns {boolean} True if the value is a $data reference object
 */
function isDollarDataRef(value) {
  return isObjectClass(value) && isStringType(value.$data);
}


//#region Number Validators

/**
 * Compile $data reference for minimum constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMinimum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minimum');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const minValue = resolveRef(dataRoot, dataPath);
    if (minValue === JSONPOINTER_NOTHING || !isNumberType(minValue)) return true;

    return data >= minValue || addError(data, dataPath, minValue);
  };
}

/**
 * Compile $data reference for maximum constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMaximum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maximum');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const maxValue = resolveRef(dataRoot, dataPath);
    if (maxValue === JSONPOINTER_NOTHING || !isNumberType(maxValue)) return true;

    return data <= maxValue || addError(data, dataPath, maxValue);
  };
}

/**
 * Compile $data reference for exclusiveMinimum constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataExclusiveMinimum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'exclusiveMinimum');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataExclusiveMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const minValue = resolveRef(dataRoot, dataPath);
    if (minValue === JSONPOINTER_NOTHING || !isNumberType(minValue)) return true;

    return data > minValue || addError(data, dataPath, minValue);
  };
}

/**
 * Compile $data reference for exclusiveMaximum constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataExclusiveMaximum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'exclusiveMaximum');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataExclusiveMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const maxValue = resolveRef(dataRoot, dataPath);
    if (maxValue === JSONPOINTER_NOTHING || !isNumberType(maxValue)) return true;

    return data < maxValue || addError(data, dataPath, maxValue);
  };
}

/**
 * Compile $data reference for multipleOf constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMultipleOf(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'multipleOf');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMultipleOf(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const multipleOf = resolveRef(dataRoot, dataPath);
    if (multipleOf === JSONPOINTER_NOTHING || !isNumberType(multipleOf)) return true;

    const q = data / multipleOf;
    return Math.abs(q - Math.round(q)) < 1e-6 || addError(data, dataPath, multipleOf);
  };
}

//#endregion

//#region String Validators

/**
 * Compile $data reference for minLength constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMinLength(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minLength');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMinLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const minLen = resolveRef(dataRoot, dataPath);
    if (minLen === JSONPOINTER_NOTHING || !isNumberType(minLen)) return true;

    return data.length >= minLen || addError(data, dataPath, minLen);
  };
}

/**
 * Compile $data reference for maxLength constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMaxLength(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxLength');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMaxLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const maxLen = resolveRef(dataRoot, dataPath);
    if (maxLen === JSONPOINTER_NOTHING || !isNumberType(maxLen)) return true;

    return data.length <= maxLen || addError(data, dataPath, maxLen);
  };
}

/**
 * Compile $data reference for pattern constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataPattern(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'pattern');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataPattern(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const pattern = resolveRef(dataRoot, dataPath);
    if (pattern === JSONPOINTER_NOTHING || !isStringType(pattern)) return true;

    const regex = new RegExp(pattern, 'u');
    return regex.test(data) || addError(data, dataPath, pattern);
  };
}

/**
 * Compile $data reference for format constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataFormat(schemaObj, ref) {
  const formats = schemaObj.formats;
  if (!formats) return undefined;

  const addError = schemaObj.createErrorHandler(ref, 'format');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataFormat(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const formatName = resolveRef(dataRoot, dataPath);
    if (formatName === JSONPOINTER_NOTHING || !isStringType(formatName)) return true;

    const formatCompiler = formats[formatName];
    if (!formatCompiler) return true;

    // The format compiler needs to be called to create the validator
    // We pass a mock schemaObj that only has createErrorHandler
    const mockSchemaObj = {
      createErrorHandler: () => () => false,
      options: { skipErrors: true }
    };

    try {
      // Get the validator function from the compiler
      const validator = formatCompiler(mockSchemaObj, { format: formatName });
      if (typeof validator !== 'function') return true;

      return validator(data, dataPath) || addError(data, dataPath, formatName);
    } catch (_e) {
      // If compilation fails, skip validation
      return true;
    }
  };
}

//#endregion

//#region Array Validators

/**
 * Compile $data reference for minItems constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMinItems(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minItems');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMinItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const minItems = resolveRef(dataRoot, dataPath);
    if (minItems === JSONPOINTER_NOTHING || !isNumberType(minItems)) return true;

    return data.length >= minItems || addError(data, dataPath, minItems);
  };
}

/**
 * Compile $data reference for maxItems constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMaxItems(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxItems');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMaxItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const maxItems = resolveRef(dataRoot, dataPath);
    if (maxItems === JSONPOINTER_NOTHING || !isNumberType(maxItems)) return true;

    return data.length <= maxItems || addError(data, dataPath, maxItems);
  };
}

/**
 * Compile $data reference for uniqueItems constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataUniqueItems(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'uniqueItems');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataUniqueItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const shouldBeUnique = resolveRef(dataRoot, dataPath);
    if (shouldBeUnique === JSONPOINTER_NOTHING || !shouldBeUnique) return true;

    // Check for duplicates using deep equality
    for (let i = 0; i < data.length; i++) {
      for (let j = i + 1; j < data.length; j++) {
        if (equalsDeep(data[i], data[j])) {
          return addError(data, dataPath);
        }
      }
    }
    return true;
  };
}

//#endregion

//#region Object Validators

/**
 * Compile $data reference for minProperties constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMinProperties(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'minProperties');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMinProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const minProps = resolveRef(dataRoot, dataPath);
    if (minProps === JSONPOINTER_NOTHING || !isNumberType(minProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount >= minProps || addError(data, dataPath, minProps);
  };
}

/**
 * Compile $data reference for maxProperties constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataMaxProperties(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'maxProperties');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataMaxProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const maxProps = resolveRef(dataRoot, dataPath);
    if (maxProps === JSONPOINTER_NOTHING || !isNumberType(maxProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount <= maxProps || addError(data, dataPath, maxProps);
  };
}

/**
 * Compile $data reference for required constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataRequired(schemaObj, ref) {
  // Keyed handler: the missing property name travels as the dataKey, so
  // error conversion extracts params.missingProperty like static required.
  const addError = schemaObj.createErrorHandler(ref, ['required']);
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataRequired(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const requiredProps = resolveRef(dataRoot, dataPath);
    if (requiredProps === JSONPOINTER_NOTHING || !Array.isArray(requiredProps)) return true;

    for (const prop of requiredProps) {
      if (!(prop in data)) {
        return addError(prop, data, dataPath);
      }
    }
    return true;
  };
}

//#endregion

//#region Enum/Const Validators

/**
 * Compile $data reference for enum constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataEnum(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'enum');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataEnum(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const enumValues = resolveRef(dataRoot, dataPath);
    if (enumValues === JSONPOINTER_NOTHING || !Array.isArray(enumValues)) return true;

    return enumValues.includes(data) || addError(data, dataPath, enumValues);
  };
}

/**
 * Compile $data reference for const constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataConst(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'const');
  const resolveRef = compileRefResolver(ref);

  return function validateDollarDataConst(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const constValue = resolveRef(dataRoot, dataPath);
    if (constValue === JSONPOINTER_NOTHING) return true;

    return data === constValue || addError(data, dataPath, constValue);
  };
}

//#endregion

//#region Main Compilation

/**
 * Compile $data keyword validators for a schema object
 * This detects when keyword values are { $data: "..." } objects and creates
 * dynamic validators that resolve the reference at validation time.
 *
 * @param {object} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema to compile
 * @returns {function|undefined} The compiled validator function or undefined
 */
export function compileDollarDataSchema(schemaObj, jsonSchema) {
  const validators = [];

  // Number constraints
  if (isDollarDataRef(jsonSchema.minimum)) {
    const validator = compileDollarDataMinimum(schemaObj, jsonSchema.minimum.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.maximum)) {
    const validator = compileDollarDataMaximum(schemaObj, jsonSchema.maximum.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.exclusiveMinimum)) {
    const validator = compileDollarDataExclusiveMinimum(schemaObj, jsonSchema.exclusiveMinimum.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.exclusiveMaximum)) {
    const validator = compileDollarDataExclusiveMaximum(schemaObj, jsonSchema.exclusiveMaximum.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.multipleOf)) {
    const validator = compileDollarDataMultipleOf(schemaObj, jsonSchema.multipleOf.$data);
    if (validator) validators.push(validator);
  }

  // String constraints
  if (isDollarDataRef(jsonSchema.minLength)) {
    const validator = compileDollarDataMinLength(schemaObj, jsonSchema.minLength.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.maxLength)) {
    const validator = compileDollarDataMaxLength(schemaObj, jsonSchema.maxLength.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.pattern)) {
    const validator = compileDollarDataPattern(schemaObj, jsonSchema.pattern.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.format)) {
    const validator = compileDollarDataFormat(schemaObj, jsonSchema.format.$data);
    if (validator) validators.push(validator);
  }

  // Array constraints
  if (isDollarDataRef(jsonSchema.minItems)) {
    const validator = compileDollarDataMinItems(schemaObj, jsonSchema.minItems.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.maxItems)) {
    const validator = compileDollarDataMaxItems(schemaObj, jsonSchema.maxItems.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.uniqueItems)) {
    const validator = compileDollarDataUniqueItems(schemaObj, jsonSchema.uniqueItems.$data);
    if (validator) validators.push(validator);
  }

  // Object constraints
  if (isDollarDataRef(jsonSchema.minProperties)) {
    const validator = compileDollarDataMinProperties(schemaObj, jsonSchema.minProperties.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.maxProperties)) {
    const validator = compileDollarDataMaxProperties(schemaObj, jsonSchema.maxProperties.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.required)) {
    const validator = compileDollarDataRequired(schemaObj, jsonSchema.required.$data);
    if (validator) validators.push(validator);
  }

  // Enum/Const constraints
  if (isDollarDataRef(jsonSchema.enum)) {
    const validator = compileDollarDataEnum(schemaObj, jsonSchema.enum.$data);
    if (validator) validators.push(validator);
  }

  if (isDollarDataRef(jsonSchema.const)) {
    const validator = compileDollarDataConst(schemaObj, jsonSchema.const.$data);
    if (validator) validators.push(validator);
  }

  if (validators.length === 0) {
    return undefined;
  }

  if (validators.length === 1) {
    return validators[0];
  }

  return function validateDollarDataSchema(data, dataPath, dataRoot) {
    for (let i = 0; i < validators.length; i++) {
      if (!validators[i](data, dataPath, dataRoot)) {
        return false;
      }
    }
    return true;
  };
}

export function isDollarDataReference(jsonSchema) {
  return (jsonSchema !== null && (isObjectType(jsonSchema) && jsonSchema.$data));
}
//#endregion
