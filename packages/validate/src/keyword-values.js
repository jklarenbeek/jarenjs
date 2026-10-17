//@ts-check
/**
 * @file The admission of keyword values when a schema object compiles.
 * Every keyword the validator reads at a place must hold a value of the
 * shape its draft's meta-schema requires (`KEYWORD_SHAPES`, which
 * `test/validate/keyword-values-meta.test.js` derives from the meta-schemas
 * `@jarenjs/refs` ships); a value of another shape is refused `JK0013` at
 * the keyword, or at the member or item of it that is wrong, and a regular
 * expression that does not compile `JK0014`. Before, such a value was read
 * as no constraint (every value accepted) or crashed the compile uncoded.
 *
 * Admitted besides the meta-schema's shape, because the validator reads
 * them by design and they answered right: a `$data` reference where the
 * keyword takes one, a number written as a string (`"3"`, read as `3`), a
 * bigint bound, a negative `multipleOf` (its multiples are those of its
 * magnitude), a boolean `exclusiveMinimum`/`exclusiveMaximum` (the draft-04
 * form), a `RegExp` or a `/source/flags` literal as `pattern`,
 * `required: true` (the value must be present), the extended type names
 * (`bigint`, `set`, `map`, `tuple`, `regex`), a `null` or repeated member
 * of a `type` list, a repeated member name in `required`, and the empty
 * `allOf` and `prefixItems`. An `items` array under 2020-12 stays the
 * tuple it is read as.
 *
 * Not read here, as they decide no answer the validator gives or keep
 * their own rules: the annotations, the identifiers (`$id`, `$anchor`,
 * `$schema`, …), `$defs`/`definitions` (a reference into a malformed one
 * is refused `JK0009` where it is followed), `format` and the content
 * keywords (a value that names no format or encoding is an annotation, as
 * the specification reads an unknown one), and the extension keywords
 * (`$query`, `data`, `nullable`, `errorMessage`, `propertyDependencies`).
 * A keyword the place does not read is not admitted either: one its
 * declared draft does not define, a validation keyword under a dialect
 * that turns that vocabulary off, `then`/`else` without `if`,
 * `additionalItems` without an `items` array, and `minContains`/
 * `maxContains` without `contains`.
 */

import { isArrayClass } from '@jarenjs/core';
import { isRegExpType } from '@jarenjs/core/string';

import { SchemaCompileError } from './errors.js';
import { readsSince } from './schema-keywords.js';
import { admitsDynamicReference } from './dynamic-ref.js';
import { DOLLAR_KEYWORD_ORDER, isDollarDataRef } from './dollar-data.js';
import { createIsSchemaTypeHandler, isBoolOrObjectClass } from './tools.js';
import { createSchemaPatternTester } from './string.js';
import { compiledLocation, keywordLocation } from './traverse.js';

/**
 * A wrong value found in a keyword: the value, and the member names or
 * item indexes that lead to it from the keyword (none when it is the
 * keyword's own value), and for a regular expression the error compiling it.
 * @typedef {{ value: unknown, at: (string|number)[], error?: Error }} Fault
 */

/** @param {unknown} value @returns {Fault} */
const own = (value) => ({ value, at: [] });

/**
 * A number the validator reads as one: a number, a bigint, or a string
 * whose text is a number (`getNumbishType`).
 * @param {unknown} value
 * @returns {number|bigint|undefined}
 */
function readNumber(value) {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isNaN(number) ? undefined : number;
}

/** @param {unknown} value @returns {Fault|undefined} */
function count(value) {
  const number = readNumber(value);
  return number !== undefined && (typeof number === 'bigint' || Number.isInteger(number)) && number >= 0
    ? undefined
    : own(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function number(value) {
  return readNumber(value) === undefined ? own(value) : undefined;
}

/** @param {unknown} value @returns {Fault|undefined} */
function bound(value) {
  return typeof value === 'boolean' ? undefined : number(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function divisor(value) {
  const read = readNumber(value);
  return read === undefined || read === 0 || read === 0n ? own(value) : undefined;
}

/** @param {unknown} value @returns {Fault|undefined} */
function boolean(value) {
  return typeof value === 'boolean' ? undefined : own(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function string(value) {
  return typeof value === 'string' ? undefined : own(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function array(value) {
  return isArrayClass(value) ? undefined : own(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function schema(value) {
  return isBoolOrObjectClass(value) ? undefined : own(value);
}

/**
 * Whether a value is an object of members as the compile reads one (a
 * plain object, or one without a prototype).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMembers(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The fault of a list, by its items.
 * @param {unknown} value
 * @param {(item: unknown) => boolean} admits
 * @param {number} [least] - The fewest items the list takes
 * @returns {Fault|undefined}
 */
function listOf(value, admits, least = 0) {
  if (!isArrayClass(value) || value.length < least) return own(value);
  for (let i = 0; i < value.length; i++)
    if (!admits(value[i])) return { value: value[i], at: [i] };
  return undefined;
}

/**
 * The fault of an object of members, by its members.
 * @param {unknown} value
 * @param {(member: unknown) => Fault|undefined} fault
 * @returns {Fault|undefined}
 */
function membersOf(value, fault) {
  if (!isMembers(value)) return own(value);
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    const found = fault(value[name]);
    if (found !== undefined) return { value: found.value, at: [name, ...found.at] };
  }
  return undefined;
}

/** @param {unknown} value @returns {boolean} */
const isString = (value) => typeof value === 'string';

/** @param {unknown} value @returns {Fault|undefined} */
const names = (value) => listOf(value, isString);

/**
 * A member of a `type` list: a type name the validator knows, or `null`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isTypeMember(value) {
  return value === null || (typeof value === 'string' && createIsSchemaTypeHandler(value) !== undefined);
}

/** @param {unknown} value @returns {Fault|undefined} */
function type(value) {
  if (typeof value === 'string') return isTypeMember(value) ? undefined : own(value);
  return listOf(value instanceof Set ? Array.from(value) : value, isTypeMember, 1);
}

/** @param {unknown} value @returns {Fault|undefined} */
function required(value) {
  return typeof value === 'boolean' ? undefined : names(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function schemaOrSchemas(value) {
  return isArrayClass(value) ? listOf(value, isBoolOrObjectClass) : schema(value);
}

/** @param {unknown} value @returns {Fault|undefined} */
function pattern(value) {
  if (isRegExpType(value)) return undefined;
  if (typeof value !== 'string') return own(value);
  return regularExpression(value, []);
}

/**
 * A regular expression that does not compile, as `pattern` and the
 * `patternProperties` names read one.
 * @param {string} source
 * @param {(string|number)[]} at
 * @returns {Fault|undefined}
 */
function regularExpression(source, at) {
  try {
    createSchemaPatternTester(source);
  }
  catch (error) {
    return { value: source, at, error: /** @type {Error} */ (error) };
  }
  return undefined;
}

/** @param {unknown} value @returns {Fault|undefined} */
function patternSchemas(value) {
  const found = membersOf(value, schema);
  if (found !== undefined) return found;
  for (const name of Object.keys(/** @type {object} */ (value))) {
    const invalid = regularExpression(name, [name]);
    if (invalid !== undefined) return invalid;
  }
  return undefined;
}

/**
 * Each shape a keyword value takes: its name in the meta-schema
 * derivation, what a refusal says it takes, and the check.
 * @type {Record<string, { expected: string, fault: (value: unknown) => Fault|undefined }>}
 */
const SHAPES = {
  'schema': { expected: 'a schema (an object or a boolean)', fault: schema },
  'schemaArray': { expected: 'an array of schemas (objects or booleans)', fault: (value) => listOf(value, isBoolOrObjectClass) },
  'schemaArray+': { expected: 'a non-empty array of schemas (objects or booleans)', fault: (value) => listOf(value, isBoolOrObjectClass, 1) },
  'schema|schemaArray': { expected: 'a schema (an object or a boolean) or an array of schemas', fault: schemaOrSchemas },
  'map<schema>': { expected: 'an object whose members are schemas (objects or booleans)', fault: (value) => membersOf(value, schema) },
  'map<schema>/regex': { expected: 'an object whose members are schemas (objects or booleans), named by regular expressions', fault: patternSchemas },
  'map<schema|stringArray>': { expected: 'an object whose members are schemas (objects or booleans) or arrays of member names', fault: (value) => membersOf(value, (member) => isArrayClass(member) ? names(member) : schema(member)) },
  'map<stringArray>': { expected: 'an object whose members are arrays of member names', fault: (value) => membersOf(value, names) },
  'stringArray': { expected: 'an array of member names', fault: required },
  'type': { expected: 'a type name (array, boolean, integer, null, number, object, string) or a non-empty array of type names', fault: type },
  'array': { expected: 'an array', fault: array },
  'count': { expected: 'a non-negative integer', fault: count },
  'number': { expected: 'a number', fault: number },
  'number|boolean': { expected: 'a number', fault: bound },
  'positive': { expected: 'a number greater than 0', fault: divisor },
  'boolean': { expected: 'a boolean', fault: boolean },
  'regex': { expected: 'a regular expression (a string)', fault: pattern },
  'string': { expected: 'a string', fault: string },
};

/**
 * The shape each keyword the validator reads takes, by the name of the
 * meta-schema derivation (`map<schema>`: an object of schemas, `+`: a
 * non-empty list). The test that derives it from the meta-schemas names
 * each place this table reads more widely than the meta-schema.
 */
export const KEYWORD_SHAPES = Object.freeze({
  __proto__: null,
  $ref: 'string', $dynamicRef: 'string', $recursiveRef: 'string',
  type: 'type', enum: 'array', required: 'stringArray',
  minLength: 'count', maxLength: 'count', minItems: 'count', maxItems: 'count',
  minProperties: 'count', maxProperties: 'count', minContains: 'count', maxContains: 'count',
  minimum: 'number', maximum: 'number', exclusiveMinimum: 'number|boolean', exclusiveMaximum: 'number|boolean',
  multipleOf: 'positive', uniqueItems: 'boolean', pattern: 'regex',
  properties: 'map<schema>', patternProperties: 'map<schema>/regex', dependentSchemas: 'map<schema>',
  dependencies: 'map<schema|stringArray>', dependentRequired: 'map<stringArray>',
  additionalProperties: 'schema', propertyNames: 'schema', unevaluatedProperties: 'schema',
  items: 'schema|schemaArray', prefixItems: 'schemaArray', additionalItems: 'schema', contains: 'schema',
  unevaluatedItems: 'schema',
  allOf: 'schemaArray', anyOf: 'schemaArray+', oneOf: 'schemaArray+', not: 'schema',
  if: 'schema', then: 'schema', else: 'schema',
});

/** Each keyword's shape, looked up once per keyword a schema object holds. */
const RULES = /* @__PURE__ */ Object.freeze(Object.fromEntries(
  Object.entries(KEYWORD_SHAPES).map(([keyword, shape]) => [keyword, SHAPES[shape]])));

/** The validation-vocabulary keywords of {@link KEYWORD_SHAPES}: read only while a dialect keeps that vocabulary on. */
export const VALIDATION_KEYWORDS = /* @__PURE__ */ new Set([
  'type', 'enum', 'required', 'dependentRequired', 'multipleOf', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties',
]);

/** The keywords a `$data` reference may stand for. */
const DATA_REFERENCE_KEYWORDS = /* @__PURE__ */ new Set(DOLLAR_KEYWORD_ORDER);

/**
 * Whether the validator reads a keyword of {@link KEYWORD_SHAPES} at a
 * schema object: one its declared draft defines, under the vocabularies
 * its dialect keeps on, beside the keyword it depends on.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {Record<string, any>} jsonSchema
 * @param {string} keyword
 * @returns {boolean}
 */
function reads(schemaObj, jsonSchema, keyword) {
  if (schemaObj.options.vocabValidation === false && VALIDATION_KEYWORDS.has(keyword)) return false;
  if (!readsSince(keyword, schemaObj.declaredDraft)) return false;
  switch (keyword) {
    case '$dynamicRef':
    case '$recursiveRef': return admitsDynamicReference(keyword, schemaObj.dynamicReferenceDraft);
    case 'then':
    case 'else': return jsonSchema.if !== undefined;
    case 'additionalItems': return isArrayClass(jsonSchema.items);
    case 'minContains':
    case 'maxContains': return jsonSchema.contains !== undefined;
    default: return true;
  }
}

/**
 * Name a refused value: a string quoted (as the other option and keyword
 * refusals quote one), a number, boolean or null as written, anything else
 * by its kind.
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (typeof value === 'string') return `'${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'an empty array' : 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Refuse a keyword of a schema object whose value is not of the shape the
 * validator reads it in, before any of it compiles.
 * @param {import('./index.js').ValidationObject} schemaObj - The schema object compiling
 * @param {Record<string, any>} jsonSchema - Its schema
 * @param {string[]} keys - Its keywords
 * @throws {SchemaCompileError} `JK0013` for a value of the wrong shape,
 *   `JK0014` for a regular expression that does not compile
 */
export function admitKeywordValues(schemaObj, jsonSchema, keys) {
  for (let i = 0; i < keys.length; i++) {
    const keyword = keys[i];
    const rule = Object.hasOwn(RULES, keyword) ? RULES[keyword] : undefined;
    if (rule === undefined) continue;
    const value = jsonSchema[keyword];
    const found = rule.fault(value);
    if (found === undefined
      || (DATA_REFERENCE_KEYWORDS.has(keyword) && isDollarDataRef(value))
      || !reads(schemaObj, jsonSchema, keyword)) continue;
    const place = compiledLocation(keywordLocation(schemaObj.path, keyword, ...found.at), schemaObj.root.origin);
    const error = found.error;
    if (error !== undefined) {
      const holder = found.at.length === 0 ? `'${keyword}' holds` : `'${keyword}' names a member`;
      throw new SchemaCompileError('JK0014',
        `${holder} ${describeValue(found.value)}, which is no regular expression (${error.message})`, place, { cause: error });
    }
    const member = found.at.length === 0 ? '' : ` for ${found.at.map((step) => typeof step === 'number' ? `item ${step}` : `member '${step}'`).join(' ')}`;
    throw new SchemaCompileError('JK0013',
      `'${keyword}' takes ${rule.expected}, got ${describeValue(found.value)}${member}; a value of another shape is no constraint the validator reads`, place);
  }
}
