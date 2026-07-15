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
  isArrayClass,
  isObjectType,
} from '@jarenjs/core';

import {
  equalsDeep,
} from '@jarenjs/core/object';

import {
  resolveRelativePointer,
} from '@jarenjs/json';

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

  return function validateDollarDataMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: minValue, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minValue)) return true;

    return data >= minValue || addError(minValue, data, dataPath);
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

  return function validateDollarDataMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: maxValue, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxValue)) return true;

    return data <= maxValue || addError(maxValue, data, dataPath);
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

  return function validateDollarDataExclusiveMinimum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: minValue, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minValue)) return true;

    return data > minValue || addError(minValue, data, dataPath);
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

  return function validateDollarDataExclusiveMaximum(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: maxValue, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxValue)) return true;

    return data < maxValue || addError(maxValue, data, dataPath);
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

  return function validateDollarDataMultipleOf(data, dataPath, dataRoot) {
    if (!isNumberType(data)) return true;

    const { value: multipleOf, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(multipleOf)) return true;

    const q = data / multipleOf;
    return Math.abs(q - Math.round(q)) < 1e-6 || addError(multipleOf, data, dataPath);
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

  return function validateDollarDataMinLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: minLen, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minLen)) return true;

    return data.length >= minLen || addError(minLen, data, dataPath);
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

  return function validateDollarDataMaxLength(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: maxLen, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxLen)) return true;

    return data.length <= maxLen || addError(maxLen, data, dataPath);
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

  return function validateDollarDataPattern(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: pattern, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isStringType(pattern)) return true;

    const regex = new RegExp(pattern, 'u');
    return regex.test(data) || addError(pattern, data, dataPath);
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

  return function validateDollarDataFormat(data, dataPath, dataRoot) {
    if (typeof data !== 'string') return true;

    const { value: formatName, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isStringType(formatName)) return true;

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

      return validator(data, dataPath) || addError(formatName, data, dataPath);
    } catch (e) {
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

  return function validateDollarDataMinItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const { value: minItems, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minItems)) return true;

    return data.length >= minItems || addError(minItems, data, dataPath);
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

  return function validateDollarDataMaxItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const { value: maxItems, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxItems)) return true;

    return data.length <= maxItems || addError(maxItems, data, dataPath);
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

  return function validateDollarDataUniqueItems(data, dataPath, dataRoot) {
    if (!Array.isArray(data)) return true;

    const { value: shouldBeUnique, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !shouldBeUnique) return true;

    // Check for duplicates using deep equality
    for (let i = 0; i < data.length; i++) {
      for (let j = i + 1; j < data.length; j++) {
        if (equalsDeep(data[i], data[j])) {
          return addError(true, data, dataPath);
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

  return function validateDollarDataMinProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const { value: minProps, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(minProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount >= minProps || addError(minProps, data, dataPath);
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

  return function validateDollarDataMaxProperties(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const { value: maxProps, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !isNumberType(maxProps)) return true;

    const propCount = Object.keys(data).length;
    return propCount <= maxProps || addError(maxProps, data, dataPath);
  };
}

/**
 * Compile $data reference for required constraint
 * @param {object} schemaObj - The validation object
 * @param {string} ref - The $data reference (relative JSON Pointer)
 * @returns {function|undefined} The compiled validator function
 */
function compileDollarDataRequired(schemaObj, ref) {
  const addError = schemaObj.createErrorHandler(ref, 'required');

  return function validateDollarDataRequired(data, dataPath, dataRoot) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;

    const { value: requiredProps, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !Array.isArray(requiredProps)) return true;

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

  return function validateDollarDataEnum(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const { value: enumValues, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found || !Array.isArray(enumValues)) return true;

    return enumValues.includes(data) || addError(enumValues, data, dataPath);
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

  return function validateDollarDataConst(data, dataPath, dataRoot) {
    if (data === undefined) return true;

    const { value: constValue, found } = resolveRelativePointer(dataRoot, dataPath, ref);
    if (!found) return true;

    return data === constValue || addError(constValue, data, dataPath);
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

/**
 * Check if the schema has any $data references
 * This is used to determine if we should use the $data-aware compilation path
 * or the standard static compilation path.
 *
 * @param {object} jsonSchema - The JSON schema to check
 * @returns {boolean} True if the schema has any $data references
 */
export function hasDollarDataReferences(jsonSchema) {
  if (!isObjectType(jsonSchema)) return false;

  // Keywords that can have $data values
  const keywords = [
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'format',
    'minItems', 'maxItems', 'uniqueItems',
    'minProperties', 'maxProperties', 'required',
    'enum', 'const'
  ];

  for (const keyword of keywords) {
    if (isDollarDataRef(jsonSchema[keyword])) {
      return true;
    }
  }

  return false;
}

export function isDollarDataReference(jsonSchema) {
  return (jsonSchema !== null && (isObjectType(jsonSchema) && jsonSchema.$data));
}
//#endregion
