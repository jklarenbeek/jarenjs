//@ts-check

import { isArrayClass } from '@jarenjs/core';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

/** Reference walks accept legacy additionalItems, but do not register contentSchema. */
const REFERENCE_VALUES = /* @__PURE__ */ SCHEMA_VALUE_KEYWORDS.filter((key) => key !== 'contentSchema');
export const TRAVERSE_SCHEMA_OBJECTS = /* @__PURE__ */ REFERENCE_VALUES.concat(SCHEMA_LIST_KEYWORDS, ['additionalItems']);

/** Reference registration also visits definitions and its compatibility containers. */
export const TRAVERSE_SCHEMA_MAPS = /* @__PURE__ */ SCHEMA_MAP_KEYWORDS
  .concat(['dependencies', 'dependentRequired', 'definitions', '$defs', 'components']);

/**
 * Keywords whose value is a map of maps: the outer names are member names of
 * the instance, the inner names are member values, and the innermost values are
 * the subschemas. Neither level holds keywords.
 */
export const TRAVERSE_SCHEMA_MAP_MAPS = /* @__PURE__ */ Object.freeze(['propertyDependencies']);

/**
 * Detects the JSON Schema draft version from the schema's $schema property.
 * The draft-next dialect, the one that defines `propertyDependencies`, is read
 * as the newest draft this package implements (2020-12); any other
 * unrecognised `$schema` is read as draft-07.
 * @param {object} schema - The JSON schema
 * @returns {number} - The draft version (6, 7, 2019, or 2020)
 */
export function detectSchemaDraft(schema) {
  if (!schema || typeof schema !== 'object') return 7; // default to draft7
  const schemaUrl = schema.$schema || '';
  if (schemaUrl.includes('2020-12') || schemaUrl.includes('draft/next')) return 2020;
  if (schemaUrl.includes('2019-09')) return 2019;
  if (schemaUrl.includes('draft-07') || schemaUrl.includes('draft/07')) return 7;
  if (schemaUrl.includes('draft-06') || schemaUrl.includes('draft/06')) return 6;
  return 7; // default to draft7 behavior
}

/**
 * Whether `propertyDependencies` is a keyword at a schema location: the
 * `propertyDependencies` option is on and the location's document does not
 * declare a draft older than 2020-12. Everywhere else it is an unknown
 * keyword, whose value is not walked, registered or compiled.
 * @param {boolean|null|undefined} enabled - The `propertyDependencies` option
 * @param {number|null} declaredDraft - The draft the document declares, or null when it declares none
 * @returns {boolean}
 */
export function admitsPropertyDependencies(enabled, declaredDraft) {
  return enabled === true && (declaredDraft == null || declaredDraft >= 2020);
}

/**
 * The `prefixItems` array a schema applies, or `undefined`. A document that
 * declares a draft before 2020-12 via `$schema` treats `prefixItems` as an
 * unknown keyword; a document that declares none reads it. The validator's
 * item keywords and the normalizer read it through this one predicate.
 * @param {{ declaredDraft: number|null }} schemaObj - The compiled object, or anything carrying its declared draft
 * @param {any} jsonSchema
 * @returns {unknown[] | undefined}
 */
export function readPrefixItems(schemaObj, jsonSchema) {
  const prefixItems = jsonSchema.prefixItems;
  return (schemaObj.declaredDraft != null && schemaObj.declaredDraft < 2020) || !(isArrayClass(prefixItems) && prefixItems.length >= 1)
    ? undefined
    : prefixItems;
}
