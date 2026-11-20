//@ts-check
/**
 * @file Layer 1 answers as the validator answers the same field schema.
 *
 * A form field's per-field check (`validateAllFields`) and a
 * `JarenValidator` compiled on the field's schema are two readings of one
 * schema, written apart. The field check used to judge by the field's
 * kind, so a field whose kind was inferred from its keywords asserted a
 * `type` its schema never declared (`{ minimum: 5 }` refused `'abc'`), a
 * field whose keywords inferred no kind checked nothing
 * (`{ exclusiveMinimum: 5 }` took `5`), a bigint was judged as the number
 * it converts to (`{ maximum: 2n ** 60n }` took `2n ** 60n + 1n`), and a
 * length was counted in graphemes whatever the host's validator counted.
 *
 * This file holds the two side by side over a fixed grid of single-field
 * schemas and values: the faults layer 1 reports (`pointer#keyword`) must
 * be the faults a collecting validator reports, compiled with the same
 * length unit, every format group registered and format assertion on (a
 * form asserts a format under every draft). The field is judged twice, as
 * the root field and as a required member of an object.
 *
 * Where the two differ by design, the difference is a named row of
 * {@link ROWS}: its reason, a predicate narrow enough to prove the case,
 * and a count, which must not stay zero. Any other difference fails.
 *
 * Kept out of the grid: `undefined`, NaN, class instances (and with them
 * the validator's type names for them, `set`, `map` and `regex`), Array
 * subclasses, wrapper objects, symbols, functions and non-enumerable
 * members.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, dateTimeFormats, numberFormats, jsonFormats, geoFormats } from '@jarenjs/formats';
import { buildFormModel, validateAllFields, FORM_FORMATS } from '@jarenjs/forms';

//#region values

const E_COMBINING = 'e\u{0301}'; // 2 UTF-16 units, 2 code points, 1 grapheme
const E_COMPOSED = '\u{00E9}'; // 1, 1, 1
const FACE = '\u{1F600}'; // 2, 1, 1
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'; // 8, 5, 1
const FLAG = '\u{1F1F3}\u{1F1F1}'; // 4, 2, 1
const TWO_MARKS = 'a\u{0300}\u{0301}'; // 3, 3, 1
const LONE_SURROGATE = '\u{D83D}'; // 1, 1, 1
const HANGUL_JAMO = '\u{1100}\u{1161}\u{11A8}'; // 3, 3, 1
const DEVANAGARI = '\u{0928}\u{092E}\u{0938}\u{094D}\u{0924}\u{0947}'; // 6 code points in fewer clusters

const STRINGS = ['', 'a', 'ab', 'abc', 'abcd', '7', '5', ' ', 'user@example.com', '2024-01-15',
  E_COMBINING, E_COMPOSED, FACE, FAMILY, FLAG, TWO_MARKS, LONE_SURROGATE, '\r\n', HANGUL_JAMO, DEVANAGARI];
const NUMBERS = [0, -0, 1, -1, 2, 3, 4, 5, 6, 7, 0.1, 0.3, 0.5, 1.5, 4.999999, 5.000001, 300, 1e21, 2 ** 53,
  Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, Infinity, -Infinity];
const BIGINTS = [0n, 1n, 3n, 4n, 5n, 6n, 21n, -5n, 2n ** 53n + 1n, 2n ** 60n, 2n ** 60n + 1n, -(2n ** 64n)];
const ARRAYS = [[], [1], [1, 1], [1, 2], [1, 2, 3], ['a'], [[1], [1]], [{ a: 1 }, { a: 1 }], [1, '1'], [null], [0, -0]];
const OBJECTS = [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: { b: 1 } }];
/** Every JSON kind and the bigints. */
const VALUES = [null, true, false, ...NUMBERS, ...STRINGS, ...ARRAYS, ...OBJECTS, ...BIGINTS];

const LONG_STRINGS = ['abcde', 'abcdefgh', 'abcdefghi', FAMILY + FAMILY, E_COMBINING + E_COMBINING + E_COMBINING, FLAG + 'a'];
const DECIMALS = [0.07, 0.30000000000000004, 7.5, -3, -4, 1e-7, 3e-7, 20000000, 20000001, 1234567890.1, 1e308];
const RANGES = [127, 128, -128, -129, 255, 256, 32767, 32768, 65535, 65536, 2 ** 31 - 1, 2 ** 31, -(2 ** 31) - 1, 2 ** 32,
  3.4e38, 3.5e38, '127', '128', '1e3', 'abc', [5], [1, 2], { a: 1 }];
const MEMBERS = [{ a: 'x' }, { a: 'xy', b: 3 }, { a: 5, b: 7 }, { a: {} }, { a: { b: 1.5 } }, { a: { b: 2 } }, { a: ['x', 'xy', 5] }, { a: true },
  { b: 1 }, ['a', 'abc', 5], [5, 3, true], ['x', 7, false], ['abc', 3, 1], [true]];

//#endregion

//#region schemas

/** A `type` in each spelling the validator reads: a name, a list, a `Set`; and none. */
const TYPES = [undefined, 'string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'bigint', 'tuple',
  ['string', 'null'], ['number', 'string'], ['number', 'bigint'], ['integer', 'null'], ['null'], ['array', 'object'],
  ['string', 'string'], [null, 'number'], new Set(['number']), new Set(['string', 'null'])];

/** @param {unknown} type @param {object} [rest] */
const typed = (type, rest = {}) => (type === undefined ? rest : { type, ...rest });

/** Every keyword layer 1 implements on the field itself, with the values it is tried at alone. */
const KEYWORDS = {
  minLength: [0, 1, 2, 3, '2', 2n], maxLength: [0, 1, 2, 3, '1'],
  pattern: ['^a', 'b$', '^.$', '/a/', '^\\p{L}+$', '^[0-9]{1,3}$', '/[\\p{L}--[a-z]]/v', /^A/i],
  format: ['email', 'date', 'uuid', 'int32', 'nope'],
  minimum: [5, 0, -0.5, '5', 5n, 2n ** 60n], maximum: [5, 0, '5', 5n, 2n ** 60n],
  exclusiveMinimum: [5, true, false, 5n], exclusiveMaximum: [5, true, false, 5n],
  multipleOf: [2, 0.1, 3, '5', -2, 2n, 3n, 1.5],
  minItems: [0, 1, 2, 3, '2'], maxItems: [0, 1, 2, 1n], uniqueItems: [true, false],
  minProperties: [0, 1, 2, '1'], maxProperties: [0, 1, 2, 1n],
  enum: [[1, 2, 3], ['a', 'b'], [null, 1], [[1], { a: 1 }], [], [5n]],
  const: [1, 'a', null, [1], { a: 1 }, 0, false, 5n],
  nullable: [true, false],
};

/** One asserting value per keyword, for the pairs. */
const PAIRED = {
  minLength: 2, maxLength: 2, pattern: '^a', format: 'email', minimum: 5, maximum: 5, exclusiveMinimum: 5, exclusiveMaximum: 5,
  multipleOf: 2, minItems: 2, maxItems: 1, uniqueItems: true, minProperties: 2, maxProperties: 1,
  enum: [1, 'a', null, [1], { a: 1 }, 5n, 6], const: 'a', nullable: true,
};
const PAIR_TYPES = [undefined, 'string', 'number', 'integer', 'array', 'object', ['string', 'null']];

/** Both sides, both exclusive spellings, number, number-string and bigint bounds, alone and together. */
const BOUNDS = [
  { minimum: 5, exclusiveMinimum: true }, { minimum: 5, exclusiveMinimum: false },
  { maximum: 5, exclusiveMaximum: true }, { maximum: 5, exclusiveMaximum: false },
  { exclusiveMinimum: true }, { exclusiveMaximum: false },
  { minimum: 3, exclusiveMinimum: 5 }, { maximum: 7, exclusiveMaximum: 5 }, { minimum: 3, exclusiveMinimum: 5, maximum: 7, exclusiveMaximum: 6 },
  { minimum: 5, maximum: 2 }, { minimum: 5, maximum: 2, multipleOf: 2 }, { minimum: 5, exclusiveMinimum: 7 }, { maximum: 5, exclusiveMaximum: 3 },
  { minimum: '5', exclusiveMinimum: true }, { minimum: -0.5, maximum: 0.5 }, { minimum: 0, maximum: 0 },
  { minimum: 5n, exclusiveMinimum: true }, { maximum: 5n, exclusiveMaximum: true }, { minimum: 5n, maximum: 5 },
  { minimum: 3n, exclusiveMinimum: 5n }, { minimum: 5n, maximum: 2n }, { minimum: 5n, maximum: 2n, multipleOf: 2n },
  { minimum: 2n ** 60n, maximum: 2n ** 60n }, { exclusiveMaximum: 2n ** 60n + 1n }, { minimum: 5, exclusiveMinimum: 5n },
  { minimum: 5n, exclusiveMinimum: 5 }, { multipleOf: 2, minimum: 5n }, { multipleOf: 2n, minimum: 5 },
];
const BOUND_TYPES = [undefined, 'number', 'integer', 'bigint', ['number', 'bigint'], ['integer', 'bigint', 'null'], new Set(['number'])];

/** Two keywords of one group a value can fail together. */
const TOGETHER = [{ minLength: 3, maxLength: 1 }, { minLength: 3, maxLength: 1, pattern: '^b' }, { minItems: 3, maxItems: 1 },
  { minItems: 3, maxItems: 1, uniqueItems: true }, { minProperties: 3, maxProperties: 1 }];

/** The drafts a schema may declare: the form model reads none, the validator reads these keywords under each. */
const DRAFTS = ['http://json-schema.org/draft-04/schema#', 'http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'];

/** `multipleOf` with decimals, number strings, a negative step and bigint steps. */
const STEPS = [0.1, 0.01, 0.5, 1e-7, 2.5, '0.1', 10000000, -3, 3n, -3n];

/** The options that set the length unit, as the validator takes them. */
const UNITS = [{ lengthUnit: 'grapheme' }, { lengthUnit: 'codepoint' }, { lengthUnit: 'utf16' },
  { useGrapheme: false }, { useGrapheme: true }, { useGrapheme: false, lengthUnit: 'codepoint' }];
const LENGTHS = [
  ...[1, 2, 3, 4, 5, 6, 8, 9].flatMap((n) => [{ minLength: n }, { maxLength: n }]),
  { minLength: 1, maxLength: 1 }, { minLength: 2, maxLength: 5 }, { minLength: 5, maxLength: 8 }, { maxLength: 0 },
];

/** Members, items and tuple slots: the faults of the fields below a field. */
const NESTED = [
  { properties: { a: { type: 'string', minLength: 2 }, b: { minimum: 5 } }, required: ['a'] },
  { type: 'object', properties: { a: { type: 'integer' } }, required: ['a', 'b'] },
  { type: 'object', properties: { a: { type: 'boolean' } }, required: ['a'] },
  { properties: { a: { properties: { b: { type: 'integer' } }, required: ['b'] } } },
  { properties: { a: { items: { minLength: 2 } } } },
  { properties: { a: { type: 'string' } }, minimum: 0 },
  { items: { type: 'string', maxLength: 2 } },
  { type: 'array', items: { minimum: 5 }, minItems: 1 },
  { prefixItems: [{ type: 'string' }, { minimum: 5 }], items: { type: 'boolean' } },
  { items: [{ type: 'string' }], additionalItems: { type: 'number' } },
  { items: [{ type: 'string' }], additionalItems: false },
];

/** A length unit reaches the fields below the root: a member, an item, a tuple slot. */
const NESTED_LENGTHS = { properties: { s: { type: 'string', maxLength: 1 }, list: { items: { minLength: 2 } }, pair: { prefixItems: [{ maxLength: 1 }] } } };
const NESTED_STRINGS = [E_COMBINING, FACE, FAMILY, 'a', 'ab'].map((s) => ({ s, list: [s], pair: [s] }));

/**
 * A union the form model reads as something else: a two-branch union with
 * a null branch as its other branch (nullable), the `oneOf` const/title
 * idiom as an `enum`. `[schema, what layer 1 reads it as]`.
 */
const UNIONS = [
  [{ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }, { type: 'string', format: 'date' }],
  [{ oneOf: [{ type: 'integer', minimum: 5 }, { type: 'null' }], title: 'Due' }, { type: 'integer', minimum: 5 }],
  [{ anyOf: [{ type: 'null' }, { type: 'array', maxItems: 1 }] }, { type: 'array', maxItems: 1 }],
  [{ oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, { enum: ['a', 'b'] }],
  [{ oneOf: [{ const: 1 }, { const: null, title: 'None' }] }, { enum: [1, null] }],
];

/** Keyword values the validator refuses when the schema compiles: layer 1 asserts nothing for them. */
const REFUSED = [
  { multipleOf: 0 }, { multipleOf: 0n }, { multipleOf: null }, { multipleOf: true }, { multipleOf: [5] }, { multipleOf: ' ' },
  { minLength: -1 }, { minLength: 1.5 }, { minLength: null }, { maxLength: 'x' }, { maxLength: true },
  { minItems: [] }, { maxItems: ' ' }, { minProperties: -2 }, { maxProperties: {} },
  { minimum: null }, { minimum: 'abc' }, { minimum: true }, { maximum: ' ' }, { exclusiveMinimum: 'x' }, { exclusiveMaximum: null },
  { pattern: '(' }, { uniqueItems: 'yes' }, { enum: 5 }, { type: 'nope' }, { type: ['string', 'nope'] }, { type: 5 },
];

//#endregion

//#region the intended differences

/**
 * Keywords layer 1 does not implement: the submit layer's. A fault the
 * validator raises at one, or in a subschema one holds, is no fault of
 * layer 1. Each is tried by a schema and a value it refuses.
 * @type {Record<string, [object, unknown]>}
 */
const SUBMIT_LAYER = {
  anyOf: [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1.5],
  oneOf: [{ oneOf: [{ type: 'string' }, { minLength: 2 }] }, 'abc'],
  not: [{ not: { type: 'string' } }, 'a'],
  then: [{ if: { type: 'string' }, then: { minLength: 3 } }, 'a'],
  else: [{ if: { type: 'string' }, else: { minimum: 5 } }, 1],
  contains: [{ contains: { type: 'string' } }, [1]],
  minContains: [{ contains: { type: 'number' }, minContains: 2 }, [1]],
  maxContains: [{ contains: { type: 'number' }, maxContains: 1 }, [1, 2]],
  propertyNames: [{ propertyNames: { maxLength: 1 } }, { ab: 1 }],
  patternProperties: [{ patternProperties: { '^a': { type: 'string' } } }, { ab: 1 }],
  additionalProperties: [{ additionalProperties: false }, { ab: 1 }],
  dependentRequired: [{ dependentRequired: { a: ['b'] } }, { a: 1 }],
  dependentSchemas: [{ dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }],
  dependencies: [{ dependencies: { a: ['b'] } }, { a: 1 }],
  unevaluatedProperties: [{ unevaluatedProperties: false }, { a: 1 }],
  unevaluatedItems: [{ unevaluatedItems: false }, [1]],
  contentEncoding: [{ contentEncoding: 'base64' }, '!!'],
  contentMediaType: [{ contentMediaType: 'application/json' }, '{'],
  formatMinimum: [{ format: 'date', formatMinimum: '2024-01-01' }, '2023-01-01'],
  formatMaximum: [{ format: 'date', formatMaximum: '2024-01-01' }, '2025-01-01'],
  formatExclusiveMinimum: [{ format: 'date', formatExclusiveMinimum: '2024-01-01' }, '2024-01-01'],
  formatExclusiveMaximum: [{ format: 'date', formatExclusiveMaximum: '2024-01-01' }, '2024-01-01'],
  nullable: [{ nullable: false }, null],
};

/**
 * The other intended differences, each with its reason. The predicates
 * that admit a case under a row are in `explain` below.
 */
const ROWS = {
  'required at the member': 'a missing required member is reported on the member\'s own field (/a#required), where the validator reports it on the object with the member\'s name',
  'required, undeclared member': 'a required member the schema declares no property for has no field: the submit layer reports it',
  'required, absent checkbox': 'an absent required boolean is not reported: a checkbox shows unchecked, and createInitialData starts it as false',
  'applicator named too': 'the validator also names the applicator (items, allOf) on the field above the one that failed; layer 1 names the fault on the field that failed',
  'item no schema admits': 'an item past the tuple that items: false or additionalItems: false forbids has no field: the submit layer reports it',
  'first failing bound': 'where two bounds fail together the collecting validator reports the first (maximum before minimum, an inclusive bound before the exclusive one beside it, minProperties before maxProperties); layer 1 reports each, and the validator compiled on that bound alone refuses the value',
  'empty text and format': 'an empty string is what a cleared text control holds (an array element always, a member where clearing writes it): layer 1 does not call it malformed per keystroke, the submit layer refuses it',
  'geojson as text': 'a geojson field holds the text of the object: layer 1 parses the text and judges the object, where the validator judges an object and takes every string',
  'required null under a json control': 'a required field with a json control holding a null no keyword of its own refuses reports required: null is what the control writes for half-typed input',
  'union read as its branch': 'a two-branch union with a null branch is read as its other branch, and the oneOf const/title idiom as an enum: layer 1 names the branch\'s keyword (or enum), compared here with the validator on that reading, and the verdict with the validator on the union',
};

/** @type {Record<string, number>} */
const used = Object.fromEntries([...Object.keys(SUBMIT_LAYER).map((keyword) => `submit layer: ${keyword}`), ...Object.keys(ROWS)].map((row) => [row, 0]));

//#endregion

//#region the two readings

/** @param {unknown} value */
const show = (value) => JSON.stringify(value, (key, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Set ? `Set(${[...x]})`
  : Object.is(x, -0) ? '-0' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : x));

const FORMAT_GROUPS = [stringFormats, dateTimeFormats, numberFormats, jsonFormats, geoFormats];

/**
 * The validator of a field schema, first-failure and collecting, or the
 * error that refused the schema.
 * @param {object} schema @param {object} options
 */
function validatorsOf(schema, options) {
  const compile = (/** @type {boolean} */ collectErrors) => {
    const jaren = new JarenValidator({ ...options, collectErrors, formatAssertion: true });
    for (const group of FORMAT_GROUPS) jaren.addFormats(group);
    return jaren.compile(schema);
  };
  try {
    return { first: compile(false), collect: compile(true), refusal: null };
  }
  catch (refusal) {
    return { first: null, collect: null, refusal: /** @type {any} */ (refusal) };
  }
}

/**
 * The faults layer 1 reports, as `pointer#keyword`, sorted.
 * @param {any} model @param {unknown} data @param {string} [below] - A pointer prefix to leave off
 */
function fieldFaults(model, data, below = '') {
  /** @type {string[]} */
  const faults = [];
  for (const [pointer, errors] of Object.entries(validateAllFields(model, data))) {
    for (const error of errors) faults.push(`${pointer.slice(below.length)}#${error.keyword}`);
  }
  return [...new Set(faults)].sort();
}

/** The field a model holds at a data pointer, or null. @param {any} model @param {string} pointer */
function fieldAt(model, pointer) {
  let field = model;
  for (const segment of pointer.split('/').slice(1)) {
    const member = field.children?.find((/** @type {any} */ child) => child.key === segment);
    const element = /^\d+$/.test(segment) ? (field.tuple?.[Number(segment)] ?? field.item) : undefined;
    field = member ?? element ?? null;
    if (field === null) return null;
  }
  return field;
}

/** The value at a data pointer of this file's plain member names. @param {any} data @param {string} pointer */
function valueAt(data, pointer) {
  let value = data;
  for (const segment of pointer.split('/').slice(1)) value = value?.[segment];
  return value;
}

/** The schema keywords from the document root to a validator error. @param {{ schemaPath: string }} error */
const placeOf = (error) => error.schemaPath.slice(error.schemaPath.indexOf('#') + 1).split('/').slice(1).map(decodeURIComponent);

/**
 * The validator's faults in layer 1's vocabulary: those of the submit
 * layer left out, a missing member moved to the member's field, an
 * applicator named beside its own fault left out. Counts the rows used.
 * @param {any[]} errors - The collecting validator's errors
 * @param {any} model - The form model of the same schema
 */
function validatorFaults(errors, model) {
  /** @type {string[]} */
  const faults = [];
  const places = errors.map(placeOf);
  errors.forEach((error, index) => {
    const place = places[index];
    const submit = Object.hasOwn(SUBMIT_LAYER, error.keyword) ? error.keyword : place.find((segment) => Object.hasOwn(SUBMIT_LAYER, segment));
    if (submit !== undefined) {
      used[`submit layer: ${submit}`]++;
      return;
    }
    if (error.keyword === 'required' && error.params?.missingProperty !== undefined) {
      const member = fieldAt(model, `${error.instancePath}/${error.params.missingProperty}`);
      if (member === null) used['required, undeclared member']++;
      else if (member.kind === 'boolean') used['required, absent checkbox']++;
      else {
        used['required at the member']++;
        faults.push(`${error.instancePath}/${error.params.missingProperty}#required`);
      }
      return;
    }
    if (error.keyword === 'items' || error.keyword === 'allOf') {
      const below = places.some((other, at) => at !== index && other.length > place.length && other[place.length] !== undefined
        && place.every((segment, i) => other[i] === segment) && ['items', 'prefixItems', 'additionalItems', 'allOf'].includes(other[place.length]));
      used[below ? 'applicator named too' : 'item no schema admits']++;
      return;
    }
    faults.push(`${error.instancePath}#${error.keyword}`);
  });
  return [...new Set(faults)].sort();
}

/** The keywords of one side of a range, or of one size, that the collecting validator reports one of. */
const BOUND_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];

/**
 * The schema holding one bound keyword alone, with the `minimum` or
 * `maximum` a draft-04 boolean beside it modifies.
 * @param {Record<string, any>} schema @param {string} keyword
 */
function boundAlone(schema, keyword) {
  const inclusive = keyword === 'exclusiveMinimum' ? 'minimum' : keyword === 'exclusiveMaximum' ? 'maximum' : null;
  if (inclusive !== null && typeof schema[keyword] === 'boolean') return { [inclusive]: schema[inclusive], [keyword]: schema[keyword] };
  return { [keyword]: schema[keyword] };
}

/**
 * Whether the rows explain a difference between layer 1's faults and the
 * validator's (already in layer 1's vocabulary) for one field schema.
 * @param {Record<string, any>} schema @param {object} options @param {any} model @param {unknown} value
 * @param {string[]} form @param {string[]} validator
 * @returns {boolean}
 */
function explain(schema, options, model, value, form, validator) {
  const extra = form.filter((fault) => !validator.includes(fault));
  const missing = validator.filter((fault) => !form.includes(fault));
  for (const fault of extra) {
    const [pointer, keyword] = fault.split('#');
    if (pointer === '' && BOUND_KEYWORDS.includes(keyword) && validator.some((other) => other.startsWith('#') && BOUND_KEYWORDS.includes(other.slice(1)))) {
      const alone = validatorsOf(boundAlone(schema, keyword), options).collect;
      if (alone === null || !alone(value).errors.some((/** @type {any} */ error) => error.keyword === keyword)) return false;
      used['first failing bound']++;
    }
    else if (keyword === 'format' && typeof valueAt(value, pointer) === 'string' && fieldAt(model, pointer)?.constraints.format === 'geojson') used['geojson as text']++;
    else return false;
  }
  for (const fault of missing) {
    const [pointer, keyword] = fault.split('#');
    if (keyword === 'format' && valueAt(value, pointer) === '') used['empty text and format']++;
    else return false;
  }
  return true;
}

//#endregion

/**
 * Every case of the grid: a field schema, the options both readings take,
 * the values it is judged on, and for a union what layer 1 reads it as.
 * @returns {Generator<{ schema: Record<string, any>, options: object, values: unknown[], reading?: object }>}
 */
function* grid() {
  const names = Object.keys(KEYWORDS);
  // each type and no type; every keyword alone
  for (const type of TYPES) {
    yield { schema: typed(type), options: {}, values: VALUES };
    for (const name of names) {
      for (const value of /** @type {Record<string, unknown[]>} */ (KEYWORDS)[name]) yield { schema: typed(type, { [name]: value }), options: {}, values: VALUES };
    }
  }
  // every keyword beside every other
  for (const type of PAIR_TYPES) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        yield { schema: typed(type, { [names[i]]: /** @type {any} */ (PAIRED)[names[i]], [names[j]]: /** @type {any} */ (PAIRED)[names[j]] }), options: {}, values: VALUES };
      }
    }
  }
  // the bounds, at and around every limit
  for (const type of BOUND_TYPES) {
    for (const bounds of BOUNDS) yield { schema: typed(type, bounds), options: {}, values: VALUES };
  }
  for (const together of TOGETHER) yield { schema: together, options: {}, values: [...VALUES, 'bb', 'ccc'] };
  // every keyword under each draft a schema may declare
  for (const $schema of DRAFTS) {
    for (const name of names) yield { schema: { $schema, [name]: /** @type {any} */ (PAIRED)[name] }, options: {}, values: VALUES };
    for (const bounds of BOUNDS.slice(0, 9)) yield { schema: { $schema, ...bounds }, options: {}, values: VALUES };
  }
  // multipleOf with decimals
  for (const type of [undefined, 'number', 'integer', 'bigint']) {
    for (const multipleOf of STEPS) yield { schema: typed(type, { multipleOf }), options: {}, values: [...VALUES, ...DECIMALS] };
  }
  // the lengths, in every unit
  for (const options of [{}, ...UNITS]) {
    for (const type of [undefined, 'string']) {
      for (const lengths of LENGTHS) yield { schema: typed(type, lengths), options, values: [null, 5, 5n, [], {}, ...STRINGS, ...LONG_STRINGS] };
    }
    yield { schema: NESTED_LENGTHS, options, values: NESTED_STRINGS };
  }
  // every format the form registers, on its own example and on every other format's
  const examples = Object.values(FORM_FORMATS).map((info) => info.placeholder).filter((text) => typeof text === 'string');
  for (const format of Object.keys(FORM_FORMATS)) {
    for (const type of [undefined, 'string', 'number', 'integer']) {
      yield { schema: typed(type, { format }), options: {}, values: [...VALUES, ...examples, ...RANGES, { type: 'Point', coordinates: [4.9, 52.4] }, { type: 'Nope' }] };
    }
  }
  // members, items and tuple slots
  for (const schema of NESTED) yield { schema, options: {}, values: [...VALUES, ...MEMBERS] };
  // the keywords of the submit layer
  for (const [schema, value] of Object.values(SUBMIT_LAYER)) yield { schema, options: {}, values: [value, ...VALUES] };
  // the unions the model reads
  for (const [schema, reading] of UNIONS) yield { schema, options: {}, values: VALUES, reading };
}

/**
 * The answers that differed before the two readings were held together:
 * `[schema, value, the keywords both report]`.
 * @type {[object, unknown, string[]][]}
 */
const DIFFERED = [
  // a keyword that inferred no kind checked nothing
  [{ exclusiveMinimum: 5 }, 5, ['exclusiveMinimum']],
  [{ exclusiveMaximum: 5 }, 5, ['exclusiveMaximum']],
  [{ exclusiveMinimum: 5n }, 5n, ['exclusiveMinimum']],
  [{ minItems: 2 }, [1], ['minItems']],
  [{ maxProperties: 0 }, { a: 1 }, ['maxProperties']],
  [{ uniqueItems: true }, [1, 1], ['uniqueItems']],
  // an inferred kind asserted a type the schema does not declare
  ...['abc', [1], true, {}, '7'].map((value) => /** @type {[object, unknown, string[]]} */ ([{ minimum: 5 }, value, []])),
  [{ maximum: 5 }, 'abc', []],
  [{ multipleOf: 2 }, 'abc', []],
  [{ minLength: 2 }, 5, []],
  [{ pattern: '^a' }, 5, []],
  [{ format: 'email' }, 5, []],
  [{ items: { type: 'string' } }, 'abc', []],
  [{ properties: { a: {} } }, 'abc', []],
  [{ additionalProperties: false }, [1], []],
  [{ minimum: 5 }, 4, ['minimum']],
  // a bigint was judged as the number it converts to
  [{ minimum: 5 }, 1n, []],
  [{ maximum: 5 }, 21n, []],
  [{ multipleOf: 2 }, 3n, []],
  [{ type: 'bigint', minimum: 5 }, 1n, []],
  [{ type: ['number', 'bigint'], minimum: 5 }, 1n, []],
  [{ multipleOf: 2n }, 3n, ['multipleOf']],
  [{ type: 'bigint', multipleOf: 2n }, 3n, ['multipleOf']],
  [{ maximum: 2n ** 60n }, 2n ** 60n + 1n, ['maximum']],
  [{ maximum: 2n ** 60n }, 2n ** 60n, []],
  [{ type: new Set(['number']), minimum: 0 }, 21n, ['type']],
  [{ type: new Set(['number']), minimum: 0 }, 21, []],
  [{ type: new Set(['bigint']), minimum: 0 }, 21n, []],
  [{ minimum: 5n }, 1n, ['minimum']],
];

describe('layer 1 answers as the validator answers the same field schema', () => {
  it('reports the validator\'s faults for every field schema and value of the grid, or a named difference', () => {
    /** The differences no row explains, by what each reading reported: a count and the first case. @type {Map<string, [number, string]>} */
    const classes = new Map();
    let cases = 0;
    let schemas = 0;
    const differs = (/** @type {string} */ what, /** @type {string[]} */ form, /** @type {string[]} */ validator, /** @type {string} */ label) => {
      const key = `${what}: layer 1 [${form.join(' ')}] validator [${validator.join(' ')}]`;
      const known = classes.get(key);
      if (known === undefined) classes.set(key, [1, label]);
      else known[0]++;
    };
    for (const { schema, options, values, reading } of grid()) {
      schemas++;
      const { first, collect, refusal } = validatorsOf(schema, options);
      assert.equal(refusal, null, `the validator refuses ${show(schema)}: ${refusal?.message}`);
      const read = reading === undefined ? null : validatorsOf(reading, options).collect;
      const root = buildFormModel(schema, options);
      const parent = buildFormModel({ type: 'object', properties: { n: schema }, required: ['n'] }, options);
      for (const value of values) {
        cases++;
        const label = `${show(schema)}${Object.keys(options).length > 0 ? ` under ${show(options)}` : ''} on ${show(value)}`;
        const result = collect(value);
        assert.equal(first(value), result.valid, `the validator's two modes differ: ${label}`);
        const form = fieldFaults(root, value);
        // as a required member: the same faults, but for the null a json control wrote
        const member = fieldFaults(parent, { n: value }, '/n');
        if (show(member) !== show(form)) {
          if (value === null && parent.children[0].control === 'json' && !result.valid && show(member) === show([...form, '#required'].sort())) used['required null under a json control']++;
          else differs('as a member', member, form, label);
        }
        if (read !== null) {
          // a union: null by the union's own verdict, any other value by the validator on what the model reads the union as
          used['union read as its branch']++;
          const reads = read(value);
          if (value === null ? (form.length === 0) !== result.valid : reads.valid !== result.valid) differs('verdict', form, result.valid ? [] : ['(refused)'], label);
          const faults = value === null ? form : validatorFaults(reads.errors, root);
          if (show(form) !== show(faults) && !explain(reading, options, root, value, form, faults)) differs('as read', form, faults, label);
          continue;
        }
        const faults = validatorFaults(result.errors, root);
        if (show(form) !== show(faults) && !explain(schema, options, root, value, form, faults)) differs('field', form, faults, label);
      }
    }
    const differing = [...classes.values()].reduce((sum, [count]) => sum + count, 0);
    const summary = [...classes].sort((a, b) => b[1][0] - a[1][0]).slice(0, 80).map(([key, [count, label]]) => `${count} x ${key}, first ${label}`);
    assert.equal(differing, 0, `${differing} of ${cases} cases differ in ${classes.size} classes\n${summary.join('\n')}`);
    assert.ok(schemas > 3000 && cases > 150000, `the grid holds ${schemas} schemas and ${cases} cases`);
    assert.deepEqual(Object.entries(used).filter(([, count]) => count === 0).map(([row]) => row), [], 'a row no case uses explains nothing');
  });

  it('answers the values the two readings differed on as the validator does, as a member and as the root field', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const [schema, value, keywords] of DIFFERED) {
      const { first, collect } = validatorsOf(schema, {});
      const reported = [...new Set(collect(value).errors.map((/** @type {any} */ error) => error.keyword))].sort();
      const root = fieldFaults(buildFormModel(schema), value).map((fault) => fault.slice(1));
      const member = fieldFaults(buildFormModel({ type: 'object', properties: { n: schema } }), { n: value }, '/n').map((fault) => fault.slice(1));
      if (first(value) !== (keywords.length === 0) || show(reported) !== show(keywords) || show(root) !== show(keywords) || show(member) !== show(keywords))
        wrong.push(`${show(schema)} on ${show(value)}: validator ${first(value)} [${reported}], root field [${root}], member [${member}], expected [${keywords}]`);
    }
    assert.deepEqual(wrong, []);
  });

  it('counts a length in the unit the model was built with, as a validator with that unit does', () => {
    const fields = { max: { type: 'string', maxLength: 1 }, min: { type: 'string', minLength: 2 } };
    const schema = { type: 'object', properties: fields };
    /** @type {[object, string, Record<string, string[]>][]} */
    const expected = [
      [{}, E_COMBINING, { '/min': ['minLength'] }],
      [{ lengthUnit: 'grapheme' }, FAMILY, { '/min': ['minLength'] }],
      [{ lengthUnit: 'codepoint' }, E_COMBINING, { '/max': ['maxLength'] }],
      [{ lengthUnit: 'codepoint' }, FAMILY, { '/max': ['maxLength'] }],
      [{ lengthUnit: 'utf16' }, FACE, { '/max': ['maxLength'] }],
      [{ lengthUnit: 'codepoint' }, FACE, { '/min': ['minLength'] }],
      [{ useGrapheme: false }, E_COMBINING, { '/max': ['maxLength'] }],
      [{ useGrapheme: false, lengthUnit: 'grapheme' }, E_COMBINING, { '/min': ['minLength'] }],
    ];
    for (const [options, text, faults] of expected) {
      const data = { max: text, min: text };
      const form = Object.fromEntries(Object.entries(validateAllFields(buildFormModel(schema, options), data)).map(([pointer, errors]) => [pointer, errors.map((error) => error.keyword)]));
      assert.deepEqual(form, faults, `${show(options)} on ${show(text)}`);
      const result = new JarenValidator({ ...options, collectErrors: true }).compile(schema)(data);
      assert.deepEqual(Object.fromEntries(result.errors.map((/** @type {any} */ error) => [error.instancePath, [error.keyword]])), faults, `the validator under ${show(options)} on ${show(text)}`);
    }
  });

  it('asserts nothing for a keyword value the validator refuses when the schema compiles', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const schema of REFUSED) {
      const { refusal } = validatorsOf(schema, {});
      if (!['JK0013', 'JK0014'].includes(refusal?.code)) wrong.push(`${show(schema)}: the validator ${refusal === null ? 'compiles it' : `refuses it ${refusal.code}`}`);
      const root = buildFormModel(schema);
      const parent = buildFormModel({ type: 'object', properties: { n: schema } });
      for (const value of VALUES) {
        const faults = [...fieldFaults(root, value), ...fieldFaults(parent, { n: value }, '/n')];
        if (faults.length > 0) wrong.push(`${show(schema)} on ${show(value)}: ${faults.join(' ')}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});
