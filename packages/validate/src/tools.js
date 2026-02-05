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

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function isUniqueDeepArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return true;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (deepEqual(arr[i], arr[j])) return false;
    }
  }
  return true;
}
//#endregion

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

  isValid() {
    return this.errors === 0;
  }
}
