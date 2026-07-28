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
} from '@jarenjs/core';

import {
  compileDataRef,
} from '@jarenjs/json';

import {
  resolveNothing,
  createDataRefCompilers,
} from './tools.js';

function compileRefResolver(ref) {
  try {
    return compileDataRef(ref);
  }
  catch {
    return resolveNothing;
  }
}

// The fifteen keyword validators are shared with the `$data` keyword;
// only `compileRefResolver` above differs (see tools.js).
const KEYWORD_COMPILERS = createDataRefCompilers(compileRefResolver);

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

    const compileKeyword = KEYWORD_COMPILERS[keyword];
    if (compileKeyword === undefined) {
      continue; // Unknown keyword in data, skip
    }

    const validator = compileKeyword(schemaObj, ref);
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
