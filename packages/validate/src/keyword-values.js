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
 * of a `type` list (or `Set`), a repeated member name in `required`, and
 * the empty `allOf` and `prefixItems`. An `items` array under 2020-12 stays
 * the tuple it is read as.
 *
 * Not read here, as they decide no answer the validator gives or keep
 * their own rules: the annotations, the identifiers (`$id`, `$anchor`,
 * `$schema`, …), `$defs`/`definitions` (a reference into a malformed one
 * is refused `JK0009` where it is followed), `format` and the content
 * keywords (a value that names no format or encoding is an annotation, as
 * the specification reads an unknown one; under `unknownFormats: 'error'`
 * format.js refuses an asserting one `JK0015`), and the extension keywords
 * (`$query`, `data`, `nullable`, `errorMessage`, `propertyDependencies`).
 * A keyword the place does not read is not admitted either: one its
 * declared draft does not define, a validation keyword under a dialect
 * that turns that vocabulary off, `then`/`else` without `if`,
 * `additionalItems` without an `items` array, and `minContains`/
 * `maxContains` without `contains`.
 *
 * A shape is written once, as a short descriptor that both checks a value
 * and words the refusal (see {@link SHAPES}), so a keyword's rule and its
 * message cannot drift apart.
 */

import { isArrayClass } from '@jarenjs/core';
import { isRegExpType } from '@jarenjs/core/string';

import { describeValue, SchemaCompileError } from './errors.js';
import { isDollarDataRef, readsSince } from './schema-keywords.js';
import { admitsDynamicReference } from './dynamic-ref.js';
import { DOLLAR_KEYWORD_ORDER } from './dollar-data.js';
import { createIsSchemaTypeHandler, isBoolOrObjectClass } from './tools.js';
import { createSchemaPatternTester } from './string.js';
import { compiledLocation, keywordLocation } from './traverse.js';

/**
 * A wrong value found in a keyword: the member names or item indexes that
 * lead to it from the keyword (none when it is the keyword's own value),
 * the value, and for a regular expression the error compiling it.
 * @typedef {[(string|number)[], unknown, Error?]} Fault
 */

/** @param {unknown} value @returns {value is string} */
const isString = (value) => typeof value === 'string';

/**
 * A number the validator reads as one: a number, a bigint, or a string
 * whose text is a number (`getNumbishType`).
 * @param {unknown} value
 * @returns {number|bigint|undefined}
 */
function readNumber(value) {
  const number = typeof value === 'bigint' ? value
    : typeof value === 'number' || (isString(value) && value.trim() !== '') ? Number(value) : Number.NaN;
  return Number.isNaN(number) ? undefined : number;
}

/** @param {unknown} value @returns {boolean} */
const isTypeName = (value) => isString(value) && createIsSchemaTypeHandler(value) !== undefined;

/**
 * Whether a value is an object of members as the compile reads one (a
 * plain object, or one without a prototype).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMembers(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/**
 * A regular expression that does not compile, as `pattern` and the
 * `patternProperties` names read one.
 * @param {string} source
 * @returns {Fault|undefined}
 */
function regularExpression(source) {
  try {
    createSchemaPatternTester(source);
  }
  catch (error) {
    return [[], source, /** @type {Error} */ (error)];
  }
  return undefined;
}

/**
 * A letter of a shape descriptor: whether a value is one, what a refusal
 * calls one (`a`/`an` before it, `s` after it for several), and for a
 * container whose members the rest of the descriptor shapes, how it holds
 * them (`1` items, `2` named members).
 * @typedef {[(value: any) => boolean, string, (1|2)?]} Letter
 */

/** @type {Letter} A non-empty array, as `+` and `*` read one. */
const NON_EMPTY = [(value) => isArrayClass(value) && !(value.length < 1), 'non-empty array', 1];
/** @type {Letter} An object of members, as `{` and `/` read one. */
const OBJECT = [isMembers, 'object', 2];

/**
 * The letters of the shape descriptors ({@link checker} reads them).
 * @type {Record<string, Letter>}
 */
const LETTERS = {
  '[': [isArrayClass, 'array', 1],
  '+': NON_EMPTY,
  '*': NON_EMPTY,
  '{': OBJECT,
  '/': OBJECT,
  s: [isBoolOrObjectClass, 'schema'],
  m: [isString, 'member name'],
  g: [isString, 'string'],
  n: [isTypeName, 'type name (array, boolean, integer, null, number, object, string)'],
  y: [(value) => value === null || isTypeName(value), 'type name'],
  a: [isArrayClass, 'array'],
  c: [(value) => {
    const number = readNumber(value);
    return /** @type {number} */ (number) >= 0 && (typeof number === 'bigint' || Number.isInteger(number));
  }, 'non-negative integer'],
  u: [(value) => readNumber(value) !== undefined, 'number'],
  p: [(value) => Boolean(readNumber(value)), 'number greater than 0'],
  b: [(value) => typeof value === 'boolean', 'boolean'],
  r: [isString, 'regular expression'],
};

/**
 * A fault found in a member or an item, located from its container.
 * @param {Fault} found
 * @param {string|number} key - The member name or item index
 * @returns {Fault}
 */
function within(found, key) {
  found[0].unshift(key);
  return found;
}

/**
 * The check of a shape descriptor, built once per descriptor: it answers a
 * value's fault, or undefined when the value is of the shape. A descriptor
 * is a letter of {@link LETTERS} (`r`: a string that compiles as a regular
 * expression, or a `RegExp`); a container letter followed by the
 * descriptor of its members — `[` an array, `+` a non-empty one, `*` a
 * non-empty one or a `Set`, `{` an object, `/` an object whose member names
 * are regular expressions; `?` before a descriptor, which admits a boolean
 * too; or `one|many`, read as `many` for an array (or a `Set`) and as `one`
 * otherwise. The first wrong member or item is the fault, in the order the
 * value holds them; for `/` every member's value before any name.
 * @param {string} shape
 * @returns {(value: any) => Fault|undefined}
 */
function checker(shape) {
  const head = shape[0];
  if (head === '?') {
    const next = checker(shape.slice(1));
    return (value) => typeof value === 'boolean' ? undefined : next(value);
  }
  const [admits, , holds] = LETTERS[head];
  if (holds === undefined && shape.length > 1) {
    const bar = shape.indexOf('|');
    const one = checker(shape.slice(0, bar));
    const many = checker(shape.slice(bar + 1));
    return (value) => (isArrayClass(value) || value instanceof Set ? many : one)(value);
  }
  if (head === 'r') return (value) => isRegExpType(value) ? undefined : admits(value) ? regularExpression(value) : [[], value];
  if (holds === undefined) return (value) => admits(value) ? undefined : [[], value];
  const member = checker(shape.slice(1));
  return (value) => {
    if (head === '*' && value instanceof Set) value = [...value];
    if (!admits(value)) return [[], value];
    if (holds === 1) {
      for (let i = 0; i < value.length; i++) {
        const found = member(value[i]);
        if (found !== undefined) return within(found, i);
      }
      return undefined;
    }
    for (const key in value) {
      const found = Object.hasOwn(value, key) ? member(value[key]) : undefined;
      if (found !== undefined) return within(found, key);
    }
    if (head === '/') {
      for (const key of Object.keys(value)) {
        const found = regularExpression(key);
        if (found !== undefined) return within(found, key);
      }
    }
    return undefined;
  };
}

/**
 * What a refusal says a shape descriptor takes, read as {@link checker}
 * reads it (the boolean `?` admits is a reading, not named).
 * @param {string} shape
 * @param {boolean} [several] - Worded as the members of a container
 * @returns {string}
 */
function says(shape, several = false) {
  const head = shape[0];
  const bar = shape.indexOf('|');
  if (head === '?') return says(shape.slice(1), several);
  const [, word, holds] = LETTERS[head];
  if (holds === undefined && bar > 0) return `${says(shape.slice(0, bar), several)} or ${says(shape.slice(bar + 1), several)}`;
  const named = several ? `${word}s` : `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
  return holds === undefined ? named : `${named} of ${says(shape.slice(1), true)}${head === '/' ? ' named by regular expressions' : ''}`;
}

/**
 * The shape each keyword the validator reads takes, as descriptor and
 * keywords: the validation vocabulary's keywords before the `;` (read
 * only while a dialect keeps that vocabulary on), the rest after it. A
 * keyword read only beside another names it after a `:` (`additionalItems`
 * beside an `items` array; `$` for a dynamic reference, read only under
 * the drafts that define it).
 */
const SHAPES = 'n|*y type,a enum,?[m required,{[m dependentRequired,'
  + 'c minLength maxLength minItems maxItems minProperties maxProperties minContains:contains maxContains:contains,'
  + 'u minimum maximum,?u exclusiveMinimum exclusiveMaximum,p multipleOf,b uniqueItems,r pattern;'
  + 'g $ref $dynamicRef:$ $recursiveRef:$,{s properties dependentSchemas,/s patternProperties,{s|[m dependencies,'
  + 's additionalProperties propertyNames unevaluatedProperties additionalItems:items contains unevaluatedItems not if then:if else:if,'
  + 's|[s items,[s prefixItems allOf,+s anyOf oneOf';

/**
 * Each keyword of {@link SHAPES}: its descriptor, whether it is a
 * validation-vocabulary keyword, the keyword it is read beside, and the
 * descriptor's check. The test that derives the shapes from the
 * meta-schemas names each place a descriptor reads more widely than the
 * meta-schema.
 * @type {Record<string, [string, boolean, string|undefined, (value: any) => Fault|undefined]>}
 */
export const KEYWORD_SHAPES = { __proto__: null };
SHAPES.split(';').forEach((keywords, applicator) => {
  for (const group of keywords.split(',')) {
    const [shape, ...names] = group.split(' ');
    const check = checker(shape);
    for (const name of names) {
      const [keyword, beside] = name.split(':');
      KEYWORD_SHAPES[keyword] = [shape, !applicator, beside, check];
    }
  }
});

/**
 * Whether the validator reads a keyword of {@link KEYWORD_SHAPES} at a
 * schema object: one its declared draft defines, under the vocabularies
 * its dialect keeps on, beside the keyword it depends on.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {Record<string, any>} jsonSchema
 * @param {string} keyword
 * @param {[string, boolean, string|undefined, unknown]} rule - Its entry in {@link KEYWORD_SHAPES}
 * @returns {boolean}
 */
function reads(schemaObj, jsonSchema, keyword, [, validation, beside]) {
  return !(validation && schemaObj.options.vocabValidation === false)
    && readsSince(keyword, schemaObj.declaredDraft)
    && (beside === undefined
      || (beside === '$' ? admitsDynamicReference(keyword, schemaObj.dynamicReferenceDraft)
        : beside === 'items' ? isArrayClass(jsonSchema.items) : jsonSchema[beside] !== undefined));
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
  for (const keyword of keys) {
    const rule = KEYWORD_SHAPES[keyword];
    if (rule === undefined) continue;
    const value = jsonSchema[keyword];
    const found = rule[3](value);
    if (found === undefined
      || (DOLLAR_KEYWORD_ORDER.includes(keyword) && isDollarDataRef(value))
      || !reads(schemaObj, jsonSchema, keyword, rule)) continue;
    const [at, wrong, error] = found;
    throw new SchemaCompileError(error === undefined ? 'JK0013' : 'JK0014',
      `'${keyword}' takes ${says(rule[0])}, got ${describeValue(wrong)}${error === undefined ? '; a value of another shape is no constraint the validator reads' : `, which does not compile (${error.message})`}`,
      compiledLocation(keywordLocation(schemaObj.path, keyword, ...at), schemaObj.root.origin), error && { cause: error });
  }
}
