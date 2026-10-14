//@ts-check

import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';

import {
  isBigIntType,
  isNullValue,
  isBooleanType,
  isIntegerType,
  isNumberType,
  isStringType,
  isObjectClass,
  isObjectType,
  isMapClass,
  isArrayClass,
  isSetClass,
} from '@jarenjs/core';

import {
  isRegExpType,
  isStringWhiteSpace,
  getStringLength,
} from '@jarenjs/core/string';

import {
  isArrayish,
} from '@jarenjs/core/array';

import {
  isJsonObject,
  equalsDeep,
} from '@jarenjs/core/object';

import {
  JSONPOINTER_NOTHING,
  compileDataRef,
} from '@jarenjs/json';

import {
  NUMERIC_CONSTRAINTS, STRING_CONSTRAINTS,
  ARRAY_CONSTRAINTS, OBJECT_CONSTRAINTS,
} from '@jarenjs/core/schema';

//#region Object
export function isBoolOrObjectClass(obj) {
  return isBooleanType(obj)
    || isObjectClass(obj);
}

/**
 * getBoolOrObjectClass
 * extract the data of first parameter if data is boolean or object type otherwise return default
 * @param {any} obj any data data has to be tested on boolean or object type
 * @param {boolean | object | undefined} def default return type if not boolean or object type
 * @returns {boolean | undefined} return value when boolean or object otherwise def
 */
export function getBoolOrObjectClass(obj, def = undefined) {
  return isBoolOrObjectClass(obj) ? obj : def;
}

export function getArrayClassMinItems(obj, len = 1, def = undefined) {
  return (isArrayClass(obj) && obj.length >= len && obj) || def;
}
//#endregion

//#region Schema Helpers
export function isOfSchemaType(schema, type) {
  const stype = schema.type;
  if (stype == null) return false;
  if (stype === type) return true;
  if (stype.constructor === Array) {
    return stype.includes(type);
  }
  if (stype.constructor === Set) {
    return stype.has(type);
  }
  return false;
}

/**
 * True when the schema is an object whose reference keyword is a string
 * with something in it.
 * @param {any} schema
 * @param {'$ref'|'$recursiveRef'|'$dynamicRef'} keyword
 * @returns {boolean}
 */
export function hasSchemaReference(schema, keyword) {
  return isObjectClass(schema)
    && isStringType(schema[keyword])
    && !isStringWhiteSpace(schema[keyword]);
}

/**
 * The keywords that assert something beside a `$ref`: the siblings draft
 * 2019-09+ applies alongside the reference and draft-07 ignores.
 * Membership-only (order-insensitive): the shared constraint groups plus
 * the applicators and extras. One list, read by the schema compiler (does
 * this `$ref` carry siblings to compile?) and by the reference resolver
 * (may this hop of a `$ref` chain be flattened away?).
 */
export const REF_SIBLING_KEYWORDS = Object.freeze(['type', 'const', 'enum',
  ...NUMERIC_CONSTRAINTS, ...STRING_CONSTRAINTS,
  ...ARRAY_CONSTRAINTS, 'maxContains', 'minContains',
  ...OBJECT_CONSTRAINTS, 'required',
  'dependentRequired', 'dependentSchemas', 'dependencies', 'nullable', '$dynamicRef',
  'properties', 'patternProperties', 'additionalProperties', 'items',
  'prefixItems', 'additionalItems', 'contains', 'allOf', 'anyOf', 'oneOf', 'not', 'if',
  'then', 'else', 'propertyNames', 'contentEncoding', 'contentMediaType',
  'unevaluatedProperties', 'unevaluatedItems', '$query', 'data']);

/**
 * The keywords whose values an object schema validates the members against:
 * the schemas that are handed a member's location. `propertyNames`,
 * `dependentSchemas`, `propertyDependencies` and the schema form of
 * `dependencies` apply to the object itself and receive the object's own
 * location.
 */
export const OBJECT_CHILD_KEYWORDS = Object.freeze(['properties', 'patternProperties',
  'additionalProperties']);

/** The keywords whose values an array schema validates the items against. */
export const ARRAY_CHILD_KEYWORDS = Object.freeze(['items', 'prefixItems', 'additionalItems', 'contains']);

/**
 * Whether the validator compiled for `jsonSchema` extends the location it is
 * given when it hands it to the subschemas under `keywords`: always while
 * errors are collected (they report it), otherwise only where something below
 * reads one (see `ValidationRoot.childLocationsNeeded`).
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {object} jsonSchema - The schema object holding the keywords
 * @param {readonly string[]} keywords
 * @returns {boolean}
 */
export function extendsChildLocations(schemaObj, jsonSchema, keywords) {
  return !schemaObj.options.skipErrors || schemaObj.root.childLocationsNeeded(jsonSchema, keywords);
}

/**
 * Whether a schema carrying a `$ref` also carries a keyword of
 * {@link REF_SIBLING_KEYWORDS}, or, when `propertyDependencies` is on, a
 * `propertyDependencies` keyword.
 * @param {object} schema
 * @param {boolean} [propertyDependencies=false] - Whether the `propertyDependencies` keyword is on
 * @returns {boolean}
 */
export function hasRefSiblings(schema, propertyDependencies = false) {
  if (propertyDependencies && schema.propertyDependencies !== undefined) return true;
  const keys = Object.keys(schema);
  for (let i = 0; i < keys.length; i++) {
    if (REF_SIBLING_KEYWORDS.includes(keys[i])) return true;
  }
  return false;
}

/**
 * Whether a sibling keyword of unevaluatedProperties already evaluates every
 * property of the instance. additionalProperties (boolean or schema) applies
 * to each property not matched by properties/patternProperties, so once it
 * has passed no property is left unevaluated.
 * @param {object} schema - The schema holding the unevaluatedProperties keyword
 * @returns {boolean} True when the unevaluatedProperties check can never match
 */
export function hasUnevaluatedPropertiesCoverage(schema) {
  return isBoolOrObjectClass(schema.additionalProperties);
}

/**
 * Whether a sibling keyword of unevaluatedItems already evaluates every item
 * of the instance: a uniform items schema (boolean or object) covers all
 * items beyond any prefixItems, and a tuple-form items with additionalItems
 * covers the items beyond the tuple.
 * @param {object} schema - The schema holding the unevaluatedItems keyword
 * @returns {boolean} True when the unevaluatedItems check can never match
 */
export function hasUnevaluatedItemsCoverage(schema) {
  const items = schema.items;
  if (isBoolOrObjectClass(items)) return true;
  return isArrayClass(items) && isBoolOrObjectClass(schema.additionalItems);
}

export function createIsSchemaTypeHandler(type, isStrict = false) {
  switch (type) {
    case 'null': return isNullValue;
    case 'boolean': return isBooleanType;
    case 'integer': return isIntegerType;
    case 'bigint': return isBigIntType;
    case 'number': return isNumberType;
    case 'string': return isStringType;
    case 'object': return isStrict
      ? isObjectClass
      : isObjectType;
    case 'array': return isStrict
      ? isArrayish
      : isArrayClass;
    case 'set': return isSetClass;
    case 'map': return isMapClass;
    case 'tuple': return isArrayClass;
    case 'regex': return isRegExpType;
    default: break;
  }

  if (type === null)
    return isNullValue;

  if (typeof type === 'function')
    throw new Error('This is interesting!');

  return undefined;
}

//#endregion

//#region Data references

const isDefined = (data) => data !== undefined;
const isJsonString = (data) => typeof data === 'string';
const isAnyValue = () => true;

/**
 * The options `compileDataRef` takes from a validation object: the Relative
 * JSON Pointer grammar the validator was configured with.
 * @param {{ options: { relativePointerDialect?: 'handrews-01'|'bhutton-00' } }} schemaObj
 * @returns {{ dialect: 'handrews-01'|'bhutton-00'|undefined }}
 */
export function dataRefOptions(schemaObj) {
  return { dialect: schemaObj.options.relativePointerDialect };
}

/**
 * Refuse a `relativePointerDialect` that names no grammar. Without this a
 * misspelling is silent on every schema that has no `data` keyword and no
 * `relative-json-pointer` format, and the author who meant `'bhutton-00'`
 * keeps the grammar they opted out of.
 * @param {unknown} dialect - The configured value; `undefined` is the default
 * @throws {TypeError} When `dialect` is neither `'handrews-01'` nor `'bhutton-00'`
 */
export function assertRelativePointerDialect(dialect) {
  if (dialect !== undefined && dialect !== 'handrews-01' && dialect !== 'bhutton-00')
    throw new TypeError(
      `relativePointerDialect must be 'handrews-01' or 'bhutton-00', got ${JSON.stringify(dialect)}`);
}

/**
 * Build the keyword validators the two data-reference keywords share
 * verbatim. The `data` keyword (json-everything) and the Ajv-style `$data`
 * keyword both resolve a ref with `compileDataRef`: empty for the root, an
 * absolute JSON Pointer or a Relative JSON Pointer. The validator's
 * `relativePointerDialect` travels in as its options (`{ dialect }`), so a
 * schema that opted into the `bhutton-00` grammar resolves `1+1/n` where the
 * default refuses it at compile time.
 *
 * A ref that cannot be compiled throws when the schema is compiled. Every
 * validator then follows one lax contract: a data instance outside the
 * keyword's type, a ref that finds no value, or a resolved constraint of
 * the wrong type asserts nothing.
 *
 * @returns {Record<string, (schemaObj: object, ref: string) => ((data: any, dataPath: string, dataRoot: any) => boolean) | undefined>}
 */
export function createDataRefCompilers() {
  /**
   * @param {string} keyword
   * @param {(data: any) => boolean} accepts - Instance types the keyword constrains
   * @param {(constraint: any) => boolean} expects - Resolved constraint types that assert
   * @param {(data: any, constraint: any, useGrapheme: boolean) => boolean} isValid
   */
  const constraint = (keyword, accepts, expects, isValid) =>
    (schemaObj, ref) => {
      const addError = schemaObj.createErrorHandler(ref, keyword);
      const resolveRef = compileDataRef(ref, dataRefOptions(schemaObj));
      const useGrapheme = schemaObj.options.useGrapheme;

      return function validateDataRefConstraint(data, dataPath, dataRoot) {
        if (!accepts(data)) return true;

        const value = resolveRef(dataRoot, dataPath);
        if (value === JSONPOINTER_NOTHING || !expects(value)) return true;

        return isValid(data, value, useGrapheme) || addError(data, dataPath, value);
      };
    };

  const compileFormat = (schemaObj, ref) => {
    const formats = schemaObj.formats;
    if (!formats) return undefined;

    const addError = schemaObj.createErrorHandler(ref, 'format');
    const resolveRef = compileDataRef(ref, dataRefOptions(schemaObj));

    // The registry holds format COMPILERS; compile (and cache) a validator
    // per referenced format name at validation time. The stand-in carries the
    // validator's pointer dialect, so a referenced `relative-json-pointer`
    // speaks the grammar the schema chose.
    const compiled = new Map();
    const mockSchemaObj = {
      createErrorHandler: () => () => false,
      options: {
        skipErrors: true,
        relativePointerDialect: schemaObj.options.relativePointerDialect,
      },
    };

    return function validateDataRefFormat(data, dataPath, dataRoot) {
      if (typeof data !== 'string') return true;

      const formatName = resolveRef(dataRoot, dataPath);
      if (formatName === JSONPOINTER_NOTHING || !isStringType(formatName)) return true;

      let validator = compiled.get(formatName);
      if (validator === undefined) {
        const formatCompiler = formats[formatName];
        validator = null;
        if (formatCompiler) {
          try {
            const candidate = formatCompiler(mockSchemaObj, { format: formatName });
            if (typeof candidate === 'function') validator = candidate;
          } catch (_e) {
            // An uncompilable format asserts nothing
          }
        }
        compiled.set(formatName, validator);
      }
      if (validator === null) return true;

      return validator(data, dataPath) || addError(data, dataPath, formatName);
    };
  };

  return {
    __proto__: null,
    minimum: constraint('minimum', isNumberType, isNumberType,
      (data, min) => data >= min),
    maximum: constraint('maximum', isNumberType, isNumberType,
      (data, max) => data <= max),
    exclusiveMinimum: constraint('exclusiveMinimum', isNumberType, isNumberType,
      (data, min) => data > min),
    exclusiveMaximum: constraint('exclusiveMaximum', isNumberType, isNumberType,
      (data, max) => data < max),
    multipleOf: constraint('multipleOf', isNumberType, isNumberType,
      (data, multipleOf) => {
        const q = data / multipleOf;
        return Math.abs(q - Math.round(q)) < 1e-6;
      }),
    minLength: constraint('minLength', isJsonString, isNumberType,
      (data, min, useGrapheme) => getStringLength(data, useGrapheme) >= min),
    maxLength: constraint('maxLength', isJsonString, isNumberType,
      (data, max, useGrapheme) => getStringLength(data, useGrapheme) <= max),
    pattern: constraint('pattern', isJsonString, isStringType,
      (data, pattern) => new RegExp(pattern, 'u').test(data)),
    minItems: constraint('minItems', Array.isArray, isNumberType,
      (data, min) => data.length >= min),
    maxItems: constraint('maxItems', Array.isArray, isNumberType,
      (data, max) => data.length <= max),
    minProperties: constraint('minProperties', isJsonObject, isNumberType,
      (data, min) => Object.keys(data).length >= min),
    maxProperties: constraint('maxProperties', isJsonObject, isNumberType,
      (data, max) => Object.keys(data).length <= max),
    enum: constraint('enum', isDefined, Array.isArray,
      (data, values) => values.includes(data)
        || (data !== null && typeof data === 'object' && values.some((value) => equalsDeep(value, data)))),
    const: constraint('const', isDefined, isAnyValue,
      (data, value) => value !== null && typeof value === 'object' ? equalsDeep(value, data) : data === value),
    format: compileFormat,
  };
}

//#endregion

/**
 * Records which properties (string keys) and items (numeric indexes) of a
 * data instance were successfully evaluated during validation, so that
 * unevaluatedProperties/unevaluatedItems can be checked afterwards.
 *
 * Entries are (data reference, key) pairs appended in application order.
 * Applicators that discard annotations (failed anyOf/oneOf branches, not,
 * failed if) take a mark() before running and rollback(mark) afterwards.
 * The numeric key -1 means "all items of this array were evaluated".
 */
export class EvalLog {
  #data = [];
  #keys = [];
  #len = 0;

  /** Clears the log; called at the start of each root validation. */
  reset() {
    this.#data.length = 0;
    this.#keys.length = 0;
    this.#len = 0;
  }

  /** @returns {number} The current log position */
  mark() {
    return this.#len;
  }

  /** Discards all entries recorded after the given mark. */
  rollback(mark) {
    this.#len = mark;
  }

  /** Records that `key` of instance `data` was evaluated. */
  add(data, key) {
    this.#data[this.#len] = data;
    this.#keys[this.#len] = key;
    this.#len++;
  }

  /** @returns {boolean} True when property `key` of `data` was evaluated at or after `from` */
  hasKey(data, key, from) {
    const len = this.#len;
    const datas = this.#data;
    const keys = this.#keys;
    for (let i = from; i < len; ++i) {
      if (datas[i] === data && keys[i] === key) return true;
    }
    return false;
  }

  /** @returns {boolean} True when item `index` of `data` was evaluated at or after `from` (-1 entries cover all items) */
  hasItem(data, index, from) {
    const len = this.#len;
    const datas = this.#data;
    const keys = this.#keys;
    for (let i = from; i < len; ++i) {
      if (datas[i] === data) {
        const k = keys[i];
        if (k === index || k === -1) return true;
      }
    }
    return false;
  }
}

/**
 * Combine INDEPENDENT keyword validators without short-circuiting.
 *
 * `a(...) && b(...)` is the right composition in boolean mode: the answer is
 * known at the first failure and nothing is gained by continuing. When errors
 * are recorded it is wrong, because each validator is the only thing that can
 * report its own fault, so the first failure hides every sibling's. This runs
 * all of them and ANDs the results — the boolean answer is identical, the
 * error list is complete.
 *
 * Only use it where the validators genuinely are independent. A precondition
 * (a type guard before a length check) must keep its short-circuit: running
 * past it is meaningless at best and throws at worst.
 * @param {Function[]} validators - Independent validators, in report order
 * @returns {Function} A validator that runs every one of them
 */
export function combineIndependent(validators) {
  return function validateIndependent(data, dataPath, dataRoot, dataKey) {
    let valid = true;
    for (let i = 0; i < validators.length; ++i) {
      if (validators[i](data, dataPath, dataRoot, dataKey) === false)
        valid = false;
    }
    return valid;
  };
}

/**
 * Compose validators that must all pass, stopping at the first that does
 * not: `undefined` when there are none, the one validator itself when
 * there is one, so the common single-keyword case adds no wrapper.
 * @param {Function[]} validators - The validators, in evaluation order
 * @returns {Function|undefined} The composed validator, or undefined
 */
export function allValidatorsPass(validators) {
  if (validators.length === 0) {
    return undefined;
  }
  if (validators.length === 1) {
    return validators[0];
  }
  return function validateAll(data, dataPath, dataRoot) {
    for (let i = 0; i < validators.length; i++) {
      if (!validators[i](data, dataPath, dataRoot)) {
        return false;
      }
    }
    return true;
  };
}

export class ValidationResult {
  static undefThat() {
    return new ValidationResult();
  }

  constructor(match = false, errors = 0) {
    this.match = match;
    this.errors = Number(errors);
  }

  addValid(valid = true) {
    if (valid === false)// this.errors += valid|0
      this.errors++;
    return this;
  }

  addMatch(valid = true) {
    this.match = true;
    if (valid === false)// this.errors += valid|0
      this.errors++;
    return this;
  }

  addResult(result = new ValidationResult()) {
    this.match = this.match || result.match;
    this.errors += result.errors;
    return this;
  }
}

// Escaped member names, by name. Property names repeat from one instance to
// the next, so the escape test runs once per distinct name; the table is
// bounded and only short names enter it, so hostile names cannot grow it.
const MEMBER_TOKENS = new Map();
const MEMBER_TOKENS_MAX = 1024;
const MEMBER_TOKEN_LENGTH_MAX = 64;

/**
 * The location of a member of the instance at `dataPath`: the member name is
 * one pointer token, so `/` and `~` inside it are escaped.
 * @param {string} dataPath - The parent's location
 * @param {string} key - The member name
 * @returns {string} The member's location
 */
export function memberPath(dataPath, key) {
  let token = MEMBER_TOKENS.get(key);
  if (token === undefined) {
    token = encodeJSONPointerSegment(key);
    if (key.length <= MEMBER_TOKEN_LENGTH_MAX) {
      if (MEMBER_TOKENS.size >= MEMBER_TOKENS_MAX)
        MEMBER_TOKENS.clear();
      MEMBER_TOKENS.set(key, token);
    }
  }
  return dataPath + '/' + token;
}
