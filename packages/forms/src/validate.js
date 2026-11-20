//@ts-check

/**
 * Preemptive per-field validation.
 *
 * These checks run synchronously on every keystroke, powered directly by
 * @jarenjs/core primitives (string length in the validator's units, deep
 * equality, the reading of the exclusive bounds the validator shares), the
 * format testers, the validator's own `pattern` reading
 * (`createSchemaPatternTester`) and its own `multipleOf` test
 * (`multipleOfTester`). They give the user immediate feedback per
 * field BEFORE the complete compiled schema validation runs - which
 * remains authoritative for cross-field rules (required combinations,
 * dependencies, unevaluatedProperties, ...). Cross-field feedback per
 * keystroke is rules.js territory (the `x-form` annotation).
 *
 * A field is judged as the validator judges its schema: keyword by
 * keyword, each keyword on the values of its own type and on no other.
 * The field's kind chooses its control and never an answer, so a field
 * whose kind was inferred from its keywords asserts no `type`, and a
 * field with a `json` control is judged by every keyword it holds.
 *
 * Every failure is structured: a stable `msgid`
 * (`form/<keyword>`) plus raw `params`, with `message` rendered eagerly -
 * failure-only, cheap - through a catalog (messages.js), so consumers can
 * re-render in another locale from `msgid` + `params`.
 */

import {
  getInclusiveExclusiveBounds,
  isArrayClass,
  isMapClass,
  isScalarType,
  isSetClass,
} from '@jarenjs/core';
import {
  countCodePoints,
  getStringLength,
  isRegExpType,
} from '@jarenjs/core/string';
import { multipleOfTester } from '@jarenjs/core/math';
import { createSchemaPatternTester } from '@jarenjs/validate/references';

import {
  equalsDeep,
  isJsonObject,
  isUniqueDeepArray,
} from '@jarenjs/core/object';
import { createBoundedCache } from '@jarenjs/core/cache';

import {
  encodeJSONPointerSegment,
} from '@jarenjs/json/pointer';

import {
  passesFormat,
} from './formats.js';

import {
  assertionsOf,
  countOfKeyword,
  declaredTypes,
  numberOfKeyword,
} from './model.js';

import {
  renderFormsMessage,
} from './messages.js';

/**
 * @typedef {object} FieldError
 * @property {string} keyword - The JSON Schema keyword that failed
 * @property {object} params - Structured, keyword-specific parameters
 * @property {string} msgid - Stable message key (`form/<keyword>` or `x-form/assert`)
 * @property {string} message - Human readable message (rendered through a catalog)
 */

// Bounded LRU (`@jarenjs/core/cache`) of pattern testers, compiled as the
// validator compiles `pattern` (an ECMA-262 source in Unicode mode); `null`
// is the cached "invalid pattern" verdict (the cache's miss sentinel is
// `undefined`, so a negative result is a real entry).
const patternCache = createBoundedCache(500);
function getPatternTester(source) {
  return patternCache.getOrCreate(source, (src) => {
    try {
      return createSchemaPatternTester(src) ?? null;
    }
    catch (_e) {
      return null;
    }
  });
}

/**
 * A bound as the field check compares a number with it: as the schema
 * writes it, which JavaScript compares by value (a number string as its
 * number), where the validator reads it as one; none otherwise, a bigint
 * among them (a bigint bounds no number, as to the validator).
 * @param {unknown} bound
 * @returns {any}
 */
const numberBound = (bound) => (numberOfKeyword(bound) === undefined ? undefined : bound);

/**
 * A bound as the field check compares a bigint with it: a bigint, as
 * the validator's bigint keywords read it (a number bounds no bigint).
 * @param {unknown} bound
 * @returns {any}
 */
const bigintBound = (bound) => (typeof bound === 'bigint' ? bound : undefined);

// Bounded LRU of `multipleOf` testers, one per step: the validator's own
// test, on the decimals the value and the step spell.
const multipleOfCache = createBoundedCache(500);

/**
 * Whether a number or a bigint is a multiple of a field's `multipleOf`,
 * as the validator judges it: a number by a step that is a number or a
 * number string, on their decimals (`multipleOfTester`); a bigint by a
 * bigint step, exactly. A step of the other kind does not apply to the
 * value, and zero or a step of another shape is refused when the schema
 * compiles, so neither asserts anything.
 * @param {unknown} multipleOf - The keyword's value
 * @param {number | bigint} value
 * @returns {boolean}
 */
function isMultipleOf(multipleOf, value) {
  if (typeof value === 'bigint')
    return typeof multipleOf !== 'bigint' || multipleOf === 0n || value % multipleOf === 0n;
  const step = numberOfKeyword(multipleOf);
  return step === undefined || step === 0 || multipleOfCache.getOrCreate(step, multipleOfTester)(value);
}

/**
 * The test of each type name, as the validator's `type` reads a value:
 * a number is no NaN, an integer is what `Number.isInteger` takes (no
 * bigint), an object is any non-null `typeof` 'object' value that is no
 * array; `bigint` and the validator's own kinds (`set`, `map`, `tuple`,
 * `regex`) are its extended names.
 * @type {Record<string, (value: unknown) => boolean>}
 */
const TYPE_TESTS = {
  // no prototype: a `type` named like an Object.prototype member is an unknown name
  __proto__: null,
  null: (value) => value === null,
  boolean: (value) => value === true || value === false,
  integer: (value) => Number.isInteger(value),
  bigint: (value) => typeof value === 'bigint',
  number: (value) => typeof value === 'number' && !Number.isNaN(value),
  string: (value) => typeof value === 'string',
  object: isJsonObject,
  array: Array.isArray,
  set: isSetClass,
  map: isMapClass,
  tuple: isArrayClass,
  regex: isRegExpType,
};

/**
 * The type name a field's declared `type` refuses a value under, or
 * `undefined` when it takes the value, as the validator's `type` does: a
 * value passes when one declared name takes it (a name, a list or a
 * `Set` of names), and `null` passes under OpenAPI's `nullable: true`.
 * A schema that declares no `type` asserts none, whatever kind its
 * keywords gave the field; a name the validator does not know refuses
 * the schema when it compiles, so it asserts nothing either.
 *
 * The name returned is the one the `form/type` message shows: the first
 * declared name that is not `null`, an `integer` field saying `number`
 * for a value that is no number at all.
 * @param {{ type?: unknown, nullable?: unknown }} schema - The field's schema
 * @param {unknown} value
 * @returns {string | undefined}
 */
function refusingType(schema, value) {
  const names = declaredTypes(schema.type);
  if (names === null || names.length === 0) return undefined;
  if (value === null && schema.nullable === true) return undefined;
  let refused = true;
  for (const name of names) {
    const test = typeof name === 'string' ? TYPE_TESTS[name] : undefined;
    if (test === undefined) return undefined;
    if (test(value)) refused = false;
  }
  if (!refused) return undefined;
  const shown = /** @type {string} */ (names.find((name) => name !== 'null') ?? 'null');
  return shown === 'integer' && typeof value !== 'number' ? 'number' : shown;
}

/**
 * Whether a value is one of a field's options, as the validator's `enum`
 * compares: a scalar or `null` by identity, anything else deeply.
 * @param {unknown[]} options
 * @param {unknown} value
 * @returns {boolean}
 */
function isOption(options, value) {
  if (value === null || typeof value !== 'object') return options.includes(value);
  return options.some((option) => equalsDeep(option, value));
}

/**
 * A string's length in a field's unit: code points, UTF-16 code units,
 * or grapheme clusters (the default, and what a field without a unit
 * counts).
 * @param {unknown} unit - The field's `lengthUnit`
 * @param {string} value
 * @returns {number}
 */
function lengthIn(unit, value) {
  if (unit === 'codepoint') return countCodePoints(value);
  return getStringLength(value, unit !== 'utf16');
}

/**
 * Push one structured field error, rendering its message through the
 * catalog (built-in English fallback). Failure-only path.
 * @param {FieldError[]} errors - The output array
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - Compiled catalog or undefined for English
 * @param {string} keyword - The failed keyword
 * @param {object} params - The structured params
 */
function pushError(errors, catalog, keyword, params) {
  const msgid = `form/${keyword}`;
  const message = renderFormsMessage(catalog, msgid, params);
  // two places of a schema may assert one thing (a `$ref` reached twice): it is said once
  if (errors.some((error) => error.msgid === msgid && error.message === message)) return;
  errors.push({ keyword, params, msgid, message });
}

/**
 * Judge a value by the keywords one place of a field's schema asserts,
 * as the validator judges them: each keyword on a value of its own type
 * and on no other.
 * @param {FieldError[]} errors - The output array
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog
 * @param {Record<string, any>} c - The keywords the place asserts (see `assertionsOf` in model.js)
 * @param {any} value - A value that is not `undefined`
 * @param {unknown} lengthUnit - The field's length unit
 */
function judge(errors, catalog, c, value, lengthUnit) {
  const type = refusingType(c, value);
  if (type !== undefined) pushError(errors, catalog, 'type', { type });

  const constant = c.const;
  if (constant !== undefined
    && !(constant === null || isScalarType(constant) ? constant === value : equalsDeep(constant, value))) {
    pushError(errors, catalog, 'const', { constValue: constant });
  }
  // the options of an `enum`, or of the oneOf const/title idiom the model reads as one
  if (c.enum !== undefined && !isOption(c.enum, value)) {
    pushError(errors, catalog, 'enum', { enumValues: c.enum });
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    // the bounds as the validator reads them, under every draft: a
    // number `exclusiveMinimum` is a bound of its own beside `minimum`,
    // and the draft-04 boolean makes `minimum` exclusive (`true`) or
    // leaves it inclusive (`false`); `exclusiveMaximum` alike. A number
    // is compared with the number bounds and a bigint with the bigint
    // ones, each exactly, by the validator's own comparisons (a value
    // passes a bound it satisfies). An error names the bound as written.
    const read = typeof value === 'bigint' ? bigintBound : numberBound;
    const [minimum, exclusiveMinimum] = getInclusiveExclusiveBounds(read, c.minimum, c.exclusiveMinimum);
    const [maximum, exclusiveMaximum] = getInclusiveExclusiveBounds(read, c.maximum, c.exclusiveMaximum);
    if (minimum !== undefined && !(value >= minimum)) {
      pushError(errors, catalog, 'minimum', { limit: minimum });
    }
    if (maximum !== undefined && !(value <= maximum)) {
      pushError(errors, catalog, 'maximum', { limit: maximum });
    }
    if (exclusiveMinimum !== undefined && !(value > exclusiveMinimum)) {
      pushError(errors, catalog, 'exclusiveMinimum', { limit: exclusiveMinimum });
    }
    if (exclusiveMaximum !== undefined && !(value < exclusiveMaximum)) {
      pushError(errors, catalog, 'exclusiveMaximum', { limit: exclusiveMaximum });
    }
    if (c.multipleOf !== undefined && !isMultipleOf(c.multipleOf, value)) {
      pushError(errors, catalog, 'multipleOf', { multipleOf: c.multipleOf });
    }
  }
  else if (typeof value === 'string') {
    const minLength = countOfKeyword(c.minLength);
    const maxLength = countOfKeyword(c.maxLength);
    if (minLength !== undefined || maxLength !== undefined) {
      const len = lengthIn(lengthUnit, value);
      if (minLength !== undefined && len < minLength) {
        pushError(errors, catalog, 'minLength', { limit: c.minLength, len });
      }
      if (maxLength !== undefined && len > maxLength) {
        pushError(errors, catalog, 'maxLength', { limit: c.maxLength, len });
      }
    }
    if (c.pattern !== undefined) {
      const matches = getPatternTester(c.pattern);
      if (matches != null && !matches(value)) {
        pushError(errors, catalog, 'pattern', { pattern: c.pattern });
      }
    }
  }

  // a format judges the values its own compiler judges: a string format
  // strings, a number format every value as the number it converts to
  if (c.format !== undefined && !passesFormat(c.format, value)) {
    pushError(errors, catalog, 'format', { format: c.format });
  }

  if (Array.isArray(value)) {
    const minItems = countOfKeyword(c.minItems);
    const maxItems = countOfKeyword(c.maxItems);
    if (minItems !== undefined && value.length < minItems) {
      pushError(errors, catalog, 'minItems', { limit: c.minItems });
    }
    if (maxItems !== undefined && value.length > maxItems) {
      pushError(errors, catalog, 'maxItems', { limit: c.maxItems });
    }
    if (c.uniqueItems === true && !isUniqueDeepArray(value)) {
      pushError(errors, catalog, 'uniqueItems', {});
    }
  }
  else if (isJsonObject(value)) {
    const minProperties = countOfKeyword(c.minProperties);
    const maxProperties = countOfKeyword(c.maxProperties);
    if (minProperties !== undefined || maxProperties !== undefined) {
      const size = Object.keys(value).length;
      if (minProperties !== undefined && size < minProperties) {
        pushError(errors, catalog, 'minProperties', { limit: c.minProperties });
      }
      if (maxProperties !== undefined && size > maxProperties) {
        pushError(errors, catalog, 'maxProperties', { limit: c.maxProperties });
      }
    }
  }
}

/**
 * Validate a single field value against its own constraints, as the
 * validator judges the field's schema: every keyword the field check
 * implements applies to a value of that keyword's type, whatever the
 * field's kind, and to no other value. Every place of the schema that
 * asserts is judged on its own (`field.asserted`: the node, the schema
 * its `$ref` names, each `allOf` branch), so a keyword two places hold is
 * judged twice; one fault is reported once.
 *
 * - `type`: only where the schema declares one (see {@link refusingType});
 *   `const` and `enum` on every value.
 * - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` and
 *   `multipleOf`: a number by the number bounds and steps, a bigint by
 *   the bigint ones alone, exactly; a bound of the other kind does not
 *   apply.
 * - `minLength`, `maxLength` (in the field's `lengthUnit`) and `pattern`:
 *   a string; `format`: the values its format judges.
 * - `minItems`, `maxItems`, `uniqueItems`: an array; `minProperties`,
 *   `maxProperties`: an object.
 *
 * @param {import('./model.js').FormField} field - Field from buildFormModel
 * @param {any} value - The TYPED value (see parseFieldInput); undefined = absent
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog (see messages.js), default English
 * @returns {FieldError[]} Empty when the value passes every per-field check
 * @example
 * const errors = validateField(emailField, 'not-an-email');
 * // [{ keyword: 'format', params: { format: 'email' },
 * //    msgid: 'form/format', message: 'Must be a valid email' }]
 */
export function validateField(field, value, catalog = undefined) {
  /** @type {FieldError[]} */
  const errors = [];
  if (field == null) return errors;

  // Absent value: only `required` applies. `null` is a value, as it is
  // to the validator: a nullable field accepts it, and every other field
  // judges it below like any value.
  if (value === undefined) {
    if (field.required && field.kind !== 'boolean') {
      pushError(errors, catalog, 'required', {});
    }
    return errors;
  }
  if (value === null && field.nullable) return errors;

  // every place of the schema that asserts is judged on its own: the node,
  // the schema its `$ref` names and each `allOf` branch, as the validator
  // applies each
  for (const asserted of field.asserted ?? [assertionsOf(field.schema ?? {}) ?? {}]) {
    judge(errors, catalog, asserted, value, field.lengthUnit);
  }

  // a json control writes null for half-typed input: where no keyword
  // above refuses that null (a union without a null branch does, at
  // submit), a required field says so here, as it does for an absent value
  if (value === null && errors.length === 0 && field.kind === 'unknown' && field.required) {
    pushError(errors, catalog, 'required', {});
  }
  return errors;
}

/**
 * Validate every field of a model against the current data's own JSON members.
 * Returns a map of data-pointer -> FieldError[] for fields that fail.
 * @param {import('./model.js').FormField} model - Root field from buildFormModel
 * @param {any} data - Current form data
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog, default English
 * @returns {Record<string, FieldError[]>}
 */
export function validateAllFields(model, data, catalog = undefined) {
  /** @type {Record<string, FieldError[]>} */
  const result = {};
  walkFields(model, data, '', result, catalog);
  return result;
}

function walkFields(field, value, pointer, result, catalog) {
  const errors = validateField(field, value, catalog);
  if (errors.length > 0) result[pointer] = errors;

  // members are judged where the value is an object, as `properties` judges them
  if (field.kind === 'object' && field.children && isJsonObject(value)) {
    for (const child of field.children) {
      // RFC 6901-encoded, the walk convention shared with the model
      // and rule pointers — a member name containing '/' or '~' stays
      // addressable and never collides with a nested path
      const childValue = Object.hasOwn(value, child.key) ? value[child.key] : undefined;
      walkFields(child, childValue, `${pointer}/${encodeJSONPointerSegment(child.key)}`, result, catalog);
    }
  }
  else if (field.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemField = field.tuple?.[i] ?? field.item;
      if (itemField) walkFields(itemField, value[i], `${pointer}/${i}`, result, catalog);
    }
  }
}
