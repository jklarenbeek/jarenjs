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
  isObjectType,
} from '@jarenjs/core';

import {
  equalsDeep,
} from '@jarenjs/core/object';

import {
  compileDataRef,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';

import {
  createDataRefCompilers,
} from './tools.js';

/**
 * Resolve a `$data` reference.
 *
 * Ajv's `$data` takes the same three forms the `data` keyword does — empty for
 * the root, a Relative JSON Pointer, or an absolute JSON Pointer — and this
 * used to compile only the relative form. An absolute `$data: '/limit'` threw,
 * was swallowed by the catch, and became `resolveNothing`: the constraint
 * silently never asserted, so a document that should have failed passed. A
 * disabled constraint is worse than a rejected schema, which is why an
 * uncompilable reference is now a compile-time error.
 * @param {string} ref
 * @returns {(dataRoot: any, dataPath: string) => any}
 */
function compileRefResolver(ref) {
  return compileDataRef(ref);
}

/**
 * Check if a value is a $data reference object
 * @param {*} value - The value to check
 * @returns {boolean} True if the value is a $data reference object
 */
function isDollarDataRef(value) {
  return isObjectClass(value) && isStringType(value.$data);
}

// The fifteen keyword validators are shared with the `data` keyword;
// only `compileRefResolver` above differs (see tools.js). uniqueItems
// and required below are $data-only and stay local.
const KEYWORD_COMPILERS = createDataRefCompilers(compileRefResolver);

//#region $data-only Validators

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

//#region Main Compilation

/** Application order of the $data-capable keywords (error order is part
 * of the observable behavior, so this list preserves the historical
 * per-keyword dispatch sequence). */
const DOLLAR_KEYWORD_ORDER = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'required',
  'enum', 'const',
];

const DOLLAR_ONLY_COMPILERS = {
  __proto__: null,
  uniqueItems: compileDollarDataUniqueItems,
  required: compileDollarDataRequired,
};

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

  for (const keyword of DOLLAR_KEYWORD_ORDER) {
    const value = jsonSchema[keyword];
    if (!isDollarDataRef(value)) continue;

    const compileKeyword = KEYWORD_COMPILERS[keyword] ?? DOLLAR_ONLY_COMPILERS[keyword];
    const validator = compileKeyword(schemaObj, value.$data);
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
