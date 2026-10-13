//@ts-check

//#region 'propertyDependencies' - select a subschema by a member's string value
// The proposal keyword (json-schema-spec, specs/proposals/propertyDependencies.md):
// an object instance that holds the member named by an outer key with a STRING
// value equal to an inner key must validate, as a whole, against the subschema
// stored there. `{ propertyDependencies: { foo: { aaa: S } } }` is
// `{ if: { properties: { foo: { const: 'aaa' } }, required: ['foo'] }, then: S }`
// without compiling or evaluating the `if`. Like `dependentSchemas`, the
// subschema applies in place: it is handed the object's own location and its
// annotations (evaluated members) stay visible to an enclosing
// `unevaluatedProperties`.
//
// The keyword is a proposal, not part of 2020-12, so it asserts only when the
// `propertyDependencies` validation option is on and the document is not
// declared as an older draft; otherwise it is an unknown keyword.

import {
  isObjectClass,
  isObjectType,
} from '@jarenjs/core';

import {
  isBoolOrObjectClass,
} from './tools.js';

import { admitsPropertyDependencies } from './schema-keywords.js';

/**
 * Compile the 'propertyDependencies' keyword of a schema into a validator.
 *
 * Both lookups are exact and own-property only: the instance member is read
 * with `Object.hasOwn` and its value is looked up in a `Map`, so a value named
 * like an `Object.prototype` member selects nothing.
 *
 * @param {import('./index.js').ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing the keyword
 * @returns {function|undefined} The compiled validator, or undefined when the
 *   keyword is off, not applicable to the document's draft, absent or empty
 */
export function compilePropertyDependencies(schemaObj, jsonSchema) {
  // Proposed for the 2020-12 vocabulary: off, or in a document that declares an
  // older draft, it is an unknown keyword (as `dependentSchemas` is before 2019).
  if (!admitsPropertyDependencies(schemaObj.options.propertyDependencies, schemaObj.declaredDraft))
    return undefined;

  const propertyDependencies = jsonSchema.propertyDependencies;
  if (!isObjectClass(propertyDependencies))
    return undefined;

  /** @type {{ key: string, byValue: Map<string, function> }[]} */
  const entries = [];
  for (const key of Object.keys(propertyDependencies)) {
    const inner = propertyDependencies[key];
    if (!isObjectClass(inner))
      throw new Error(`Expected Object at '${schemaObj.path}/propertyDependencies/${key}'`);

    const byValue = new Map();
    for (const value of Object.keys(inner)) {
      const schema = inner[value];
      if (!isBoolOrObjectClass(schema))
        throw new Error(`Expected Schema at '${schemaObj.path}/propertyDependencies/${key}/${value}'`);
      byValue.set(value, schemaObj.createValidator(schema, 'propertyDependencies', key, value));
    }
    if (byValue.size > 0)
      entries.push({ key, byValue });
  }

  if (entries.length === 0)
    return undefined;

  const stopAtFirst = schemaObj.options.skipErrors === true;
  const count = entries.length;

  return function validatePropertyDependencies(data, dataPath, dataRoot, dataKey) {
    if (!isObjectType(data)) return true;
    let valid = true;
    for (let i = 0; i < count; ++i) {
      const entry = entries[i];
      if (!Object.hasOwn(data, entry.key)) continue;
      // A Map holds only string keys here, so a member that is not a string
      // selects nothing.
      const validator = entry.byValue.get(data[entry.key]);
      if (validator === undefined) continue;
      if (validator(data, dataPath, dataRoot, dataKey) === false) {
        if (stopAtFirst) return false;
        valid = false;
      }
    }
    return valid;
  };
}

//#endregion
