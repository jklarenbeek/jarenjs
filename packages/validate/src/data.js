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
 * Supports both absolute JSON Pointers (starting with /) and relative JSON Pointers;
 * the `relativePointerDialect` validator option selects the relative grammar.
 * @see https://docs.json-everything.net/schema/examples/data-ref/
 */

import {
  isObjectClass,
  isStringType,
} from '@jarenjs/core';

import {
  createDataRefCompilers,
  allValidatorsPass,
} from './tools.js';

// The fifteen keyword validators are shared with the `$data` keyword (see
// tools.js). A reference that cannot be compiled is a compile-time error, as
// it is for `$data`: a constraint that never asserts lets a document that
// should fail pass.
const KEYWORD_COMPILERS = createDataRefCompilers();

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

  return allValidatorsPass(validators);
}
