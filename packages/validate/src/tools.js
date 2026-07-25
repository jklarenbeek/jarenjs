//@ts-check

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
} from '@jarenjs/core/string';

import {
  isArrayish,
} from '@jarenjs/core/array';

import {
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';

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

export function hasSchemaRef(schema) {
  return isObjectClass(schema)
    && isStringType(schema.$ref)
    && !isStringWhiteSpace(schema.$ref);
}

export function hasSchemaRecursiveRef(schema) {
  return isObjectClass(schema)
    && isStringType(schema.$recursiveRef)
    && !isStringWhiteSpace(schema.$recursiveRef);
}

export function hasSchemaDynamicRef(schema) {
  return isObjectClass(schema)
    && isStringType(schema.$dynamicRef)
    && !isStringWhiteSpace(schema.$dynamicRef);
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

/**
 * The fallback resolver of the data-reference keywords (`data`, `$data`):
 * a ref that fails the strict compile keeps the lax keyword semantics, so
 * it resolves as not-found and the keyword asserts nothing.
 * @returns {any} the JSON Pointer not-found sentinel
 */
export const resolveNothing = () => JSONPOINTER_NOTHING;

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
