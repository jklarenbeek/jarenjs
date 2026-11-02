//@ts-check

import {
  isArrayClass,
  getObjectType,
} from '@jarenjs/core';

import {
  isUniqueDeepArray,
} from '@jarenjs/core/object';

import {
  getBoolishType,
  getIntishType,
} from '@jarenjs/core/number';

import {
  trueThat,
  falseThat,
} from '@jarenjs/core/function';

import {
  getBoolOrObjectClass,
  isOfSchemaType,
  extendsChildLocations,
  annotatesFailedMembers,
  hasSchemaReference,
  schemaReference,
  ARRAY_CHILD_KEYWORDS,
  otherKind,
} from './tools.js';

import { readPrefixItems, readsSince } from './schema-keywords.js';

//#region Primitives
function compileMinItems(schemaObj, jsonSchema) {
  const min = getIntishType(jsonSchema.minItems) || 0;
  if (min < 1) return undefined;

  const addError = schemaObj.createErrorHandler(min, 'minItems');
  return function validateMinItems(len = 0, dataPath = '') {
    return len >= min || addError(len, dataPath);
  };
}

function compileMaxItems(schemaObj, jsonSchema) {
  const max = getIntishType(jsonSchema.maxItems) ?? -1;
  if (max < 0) return undefined;

  const addError = schemaObj.createErrorHandler(max, 'maxItems');
  return function validateMaxItems(len = 0, dataPath = '') {
    return len <= max || addError(len, dataPath);
  };
}

function createBooleanValidator(schemaObj, jsonSchema, key, validationFn) {
  const value = getBoolishType(jsonSchema[key]);
  if (value !== true) return undefined;

  const addError = schemaObj.createErrorHandler(value, key);

  return function validateBooleanComparator(data, dataPath) {
    return validationFn(data) || addError(data, dataPath);
  };
}

const compileUniqueItems = (schemaObj, jsonSchema) =>
  createBooleanValidator(schemaObj, jsonSchema, 'uniqueItems', isUniqueDeepArray);
//#endregion

//#region Tuple

// The position tests that read the element alone and record nothing, in
// the order isPurePosition switches on them: the constant answers (a boolean
// schema, or one asserting nothing) and the type-only tests of the
// first-failure mode.
const PURE_POSITIONS = [trueThat, falseThat, validateString, validateNumber, validateInteger,
  validateBoolean, validateArray, validateObject, validateNull];

/**
 * The answer of the position test at `code` (a PURE_POSITIONS index),
 * called by name: a walk testing a tuple through it calls no closure per
 * element.
 * @param {number} code
 * @param {unknown} data
 * @returns {boolean}
 */
function isPurePosition(code, data) {
  switch (code) {
    case 0: return trueThat(data);
    case 1: return falseThat(data);
    case 2: return validateString(data);
    case 3: return validateNumber(data);
    case 4: return validateInteger(data);
    case 5: return validateBoolean(data);
    case 6: return validateArray(data);
    case 7: return validateObject(data);
    default: return validateNull(data);
  }
}

// An empty tuple has no positions: every element lies past it, so the
// additional keyword applies to all of them. An empty prefixItems never gets
// here (readPrefixItems reads it as absent, and items then applies to all).
// A tuple is a validator per position and the one every element past them
// answers by (a constant where the additional keyword is a boolean); the
// element walks call them directly, a call per element fewer than a
// dispatching wrapper. `codes` holds each position's PURE_POSITIONS index
// when every position is one of those tests, else it is null.
function compileTupleInternal(schemaObj, jsonSchema, itemsKey, additionalKey) {
  const tuple = jsonSchema[itemsKey];

  // Pre-compile all validators upfront
  const positions = new Array(tuple.length);
  /** @type {number[] | null} */
  let codes = new Array(tuple.length);
  for (let i = 0; i < tuple.length; i++) {
    positions[i] = compileItemValidator(schemaObj, tuple[i], itemsKey, i);
    const code = PURE_POSITIONS.indexOf(positions[i]);
    if (code < 0) codes = null;
    else if (codes !== null) codes[i] = code;
  }

  const additional = getBoolOrObjectClass(jsonSchema[additionalKey], true);
  const rest = typeof additional === 'boolean'
    ? (additional ? trueThat : falseThat)
    : schemaObj.createValidator(additional, additionalKey);
  return { positions, rest, codes };
}

function compilePrefixItems(schemaObj, jsonSchema) {
  return compileTupleInternal(schemaObj, jsonSchema, 'prefixItems', 'items');
}

function compileTupleItems(schemaObj, jsonSchema) {
  return compileTupleInternal(schemaObj, jsonSchema, 'items', 'additionalItems');
}

//#endregion

//#region Contains
function compileArrayContains(schemaObj, jsonSchema) {
  const contains = getObjectType(jsonSchema.contains);
  if (contains == null) return undefined;

  return schemaObj.createValidator(contains, 'contains');
}

function compileContainsMinMax(schemaObj, jsonSchema) {
  const contains = getBoolOrObjectClass(jsonSchema.contains);
  if (contains == null) return undefined;

  // minContains/maxContains belong to the validation vocabulary and exist
  // since draft 2019-09: without either, `contains` needs one match.
  const counted = schemaObj.options.vocabValidation !== false
    && readsSince('minContains', schemaObj.declaredDraft);
  const minContains = counted ? getIntishType(jsonSchema.minContains) : undefined;
  const maxContains = counted ? getIntishType(jsonSchema.maxContains) : undefined;

  const addNonError = schemaObj.createErrorHandler(0, 'contains');
  const addMinError = schemaObj.createErrorHandler(minContains, 'minContains');
  const addMaxError = schemaObj.createErrorHandler(maxContains, 'maxContains');

  if (minContains == null && maxContains == null) {
    return function validateContainsAtLeastOne(count, dataPath) {
      return count > 0 || addNonError(count, dataPath);
    };
  }

  if (maxContains == null) {
    return function validateMinContains(count, dataPath) {
      return count >= (minContains || 0)
        || addMinError(count, dataPath);
    };
  }

  if (minContains == null) {
    return function validateMaxContains(count, dataPath) {
      return count === 0
        ? addNonError(count, dataPath)
        : count <= maxContains
          || addMaxError(count, dataPath);
    };
  }

  return function validateMinMaxContains(count, dataPath) {
    return (count >= minContains || addMinError(count, dataPath))
      && (count <= maxContains || addMaxError(count, dataPath));
  };
}

function compileArrayContainsBoolean(schemaObj, jsonSchema) {
  const contains = getBoolishType(jsonSchema.contains);
  if (contains == null) return undefined;
  const validateCount = jsonSchema.minContains != null || jsonSchema.maxContains != null
    ? compileContainsMinMax(schemaObj, jsonSchema)
    : undefined;
  if (contains === true) {
    const addError = schemaObj.createErrorHandler(true, 'contains');
    const root = schemaObj.root;
    const trackContains = root.usesUnevaluated && (schemaObj.declaredDraft ?? schemaObj.options.draftVersion ?? 7) >= 2020;
    return function validateArrayContainsTrue(data, dataPath) {
      const valid = validateCount != null
        ? validateCount(data.length, dataPath)
        : data.length > 0 || addError(data, dataPath);
      if (valid && trackContains) root.evalLog.add(data, -1);
      return valid;
    };
  }
  if (contains === false) {
    const addError = schemaObj.createErrorHandler(false, 'contains');
    return function validateArrayContainsFalse(data, dataPath) {
      return validateCount != null
        ? validateCount(0, dataPath)
        : addError(data, dataPath);
    };
  }
  return undefined;
}
//#endregion

//#region Items
function compileArrayItemsBoolean(schemaObj, jsonSchema) {
  const items = getBoolishType(jsonSchema.items);
  if (items === true) return trueThat;
  if (items !== false) return undefined;

  // With prefixItems (draft 2020-12), items:false only forbids items beyond
  // the prefix; that is enforced by the tuple validator, not here.
  if (readPrefixItems(schemaObj, jsonSchema) != null)
    return undefined;

  const addError = schemaObj.createErrorHandler(false, 'items');
  const root = schemaObj.root;
  const logFailed = root.usesUnevaluated && annotatesFailedMembers(schemaObj);
  return function validateArrayItemsFalse(data, dataPath) {
    if (data.length === 0) return true;
    if (logFailed) root.evalLog.add(data, -1);
    return addError(data, dataPath);
  };
}

/**
 * Compile item schema directly without intermediate wrapper
 * This flattens the call stack by avoiding nested validator function calls
 * @param {Object} schemaObj - The schema object
 * @param {Object} itemSchema - Schema for individual items
 * @param {string} key - Key for error reporting
 * @param {number} index - Index for tuple items
 * @returns {Function} Direct validator function
 */
function compileItemValidator(schemaObj, itemSchema, key, index) {
  if (itemSchema === true) return trueThat;
  if (itemSchema === false) return falseThat;

  // For simple type schemas, use inline validation
  if (typeof itemSchema === 'object' && itemSchema !== null) {
    // Fast path: $ref-only schema - check property directly before calling Object.keys
    // This avoids the overhead of Object.keys for the most common case
    // Recording output units, the item's own subschema is one: no shortcut.
    if (hasSchemaReference(itemSchema, '$ref') && schemaObj.root.recorder === null) {
      const keys = Object.keys(itemSchema);
      if (keys.length === 1) {
        // Use the root to resolve the ref directly to the target validator
        // This avoids the overhead of creating an intermediate ValidationObject
        const root = schemaObj.root;
        if (root && root.resolveObject) {
          try {
            const targetObj = root.resolveObject(schemaReference(itemSchema, '$ref'), schemaObj.path, itemSchema, true);
            if (targetObj && targetObj.validate) {
              return targetObj.validate;
            }
          } catch (_e) {
            // Fall through to default handling
          }
        }
      }
    }

    // The two fast paths below return bare predicates with no error handler,
    // so a failing item reports nothing of its own and the caller can only
    // aggregate one error at the array path. When errors are recorded, fall
    // through to full compilation so each failing item yields its own error
    // at its own instancePath, matching the multi-keyword path. Both assert
    // validation-vocabulary keywords, so they apply only while the
    // meta-schema keeps that vocabulary on.
    const bare = schemaObj.root.options.skipErrors
      && schemaObj.options.vocabValidation !== false;

    // Fast path: type-only schema (most common case) - check property directly first
    if (bare && itemSchema.type !== undefined && Object.keys(itemSchema).length === 1) {
      const typeOnly = compileTypeOnlyValidator(itemSchema.type);
      if (typeOnly !== undefined) return typeOnly;
    }

    // Fast path: required-only schema - check property directly first. A
    // list naming anything but strings takes the full compile, which refuses it.
    if (bare && Array.isArray(itemSchema.required) && Object.keys(itemSchema).length === 1
      && itemSchema.required.every((name) => typeof name === 'string')) {
      const required = itemSchema.required;
      // `in` also answers for the names every object inherits (`toString`);
      // a list naming one of those takes the own-member probe, any other list
      // keeps the cheap test.
      const inherited = required.some((name) => name in Object.prototype);
      const count = required.length;
      return function validateRequiredOnly(data, _dataPath, _dataRoot) {
        // Required properties only apply to objects, not arrays or other types
        if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;
        if (inherited) {
          for (let i = 0; i < count; i++) {
            if (!Object.hasOwn(data, required[i])) return false;
          }
          return true;
        }
        for (let i = 0; i < count; i++) {
          if (!(required[i] in data)) return false;
        }
        return true;
      };
    }
  }

  // Fall back to full schema compilation for complex cases
  return schemaObj.createValidator(itemSchema, key, index);
}

// The tests of the type-only item schemas, one per type name, shared by
// every schema naming it (a tuple tells them apart by identity).
function validateString(data) {
  return typeof data === 'string';
}
function validateNumber(data) {
  return typeof data === 'number' && !isNaN(data);
}
function validateInteger(data) {
  return typeof data === 'number' && Number.isInteger(data);
}
function validateBoolean(data) {
  return typeof data === 'boolean';
}
function validateArray(data) {
  return Array.isArray(data);
}
function validateObject(data) {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}
function validateNull(data) {
  return data === null;
}

/**
 * Compile a validator for simple type-only schemas
 * @param {unknown} type - The `type` keyword value
 * @returns {Function | undefined} Type validator function, or `undefined` when `type` is not a single known type name
 */
function compileTypeOnlyValidator(type) {
  switch (type) {
    case 'string': return validateString;
    case 'number': return validateNumber;
    case 'integer': return validateInteger;
    case 'boolean': return validateBoolean;
    case 'array': return validateArray;
    case 'object': return validateObject;
    case 'null': return validateNull;
    default:
      // not a single type name (a union array, an unknown word): the
      // caller compiles the full schema instead
      return undefined;
  }
}
//#endregion

//#region Main
export function compileArrayPrimitives(schemaObj, jsonSchema) {
  // minItems/maxItems/uniqueItems belong to the validation vocabulary;
  // assert nothing when the metaschema disables it.
  if (schemaObj.options.vocabValidation === false)
    return undefined;

  const minItems = compileMinItems(schemaObj, jsonSchema);
  const maxItems = compileMaxItems(schemaObj, jsonSchema);
  const uniqueItems = compileUniqueItems(schemaObj, jsonSchema);

  if ((minItems
    || maxItems
    || uniqueItems) == null)
    return undefined;

  // Single-constraint schemas are the common case; skip the trueThat chain.
  if (minItems == null && maxItems == null)
    return uniqueItems;

  if (uniqueItems == null) {
    if (maxItems == null) {
      return function validateArrayMinItems(data, dataPath) {
        return minItems(data.length, dataPath);
      };
    }
    if (minItems == null) {
      return function validateArrayMaxItems(data, dataPath) {
        return maxItems(data.length, dataPath);
      };
    }
    return function validateArrayMinMaxItems(data, dataPath) {
      const len = data.length;
      return minItems(len, dataPath)
        && maxItems(len, dataPath);
    };
  }

  const isMinItems = minItems || trueThat;
  const isMaxItems = maxItems || trueThat;

  if (schemaObj.options.skipErrors) {
    return function validateArrayPrimitives(data, dataPath) {
      const len = data.length;
      return isMinItems(len, dataPath)
        && isMaxItems(len, dataPath)
        && uniqueItems(data, dataPath);
    };
  }

  // Length and uniqueness are independent: a short array can also contain
  // duplicates, and a caller fixing one wants to hear about the other.
  return function validateArrayPrimitivesAll(data, dataPath) {
    const len = data.length;
    let valid = isMinItems(len, dataPath);
    valid = isMaxItems(len, dataPath) && valid;
    return uniqueItems(data, dataPath) && valid;
  };
}

// `alone`: no other array keyword group compiles beside the element walk,
// which then tests the array class itself, a call per validation fewer
// than a guarding wrapper. `typed`: a leading `type: 'array'` the walk may
// test with that class test (compileArraySchema); the homogeneous items
// walk does, and sets `typed.taken`.
function compileArrayChildren(schemaObj, jsonSchema, alone, typed) {
  // Check for prefixItems (draft 2020-12+) first, then items.
  const prefixItems = readPrefixItems(schemaObj, jsonSchema);
  const items = jsonSchema.items;
  const isTuple = isArrayClass(items);

  const root = schemaObj.root;
  const track = root.usesUnevaluated;
  const logFailed = annotatesFailedMembers(schemaObj);
  // In draft 2020-12 contains produces item annotations; in 2019-09 it
  // doesn't. The draft is the one the schema's own document declares.
  const trackContains = track && (schemaObj.declaredDraft ?? schemaObj.options.draftVersion ?? 7) >= 2020;
  // Item paths are consumed by error reporting and by location readers
  // (`$data`, `data`, `$query`) below the items only.
  const extendPaths = extendsChildLocations(schemaObj, jsonSchema, ARRAY_CHILD_KEYWORDS);

  // Indexes below this limit count as evaluated (for unevaluatedItems) when
  // their item validation succeeds. Extra tuple items beyond the tuple length
  // pass validation when additionalItems/items is ABSENT, but are then not
  // evaluated and must remain visible to unevaluatedItems.
  let evalLimit = Infinity;
  if (track) {
    if (prefixItems != null) {
      if (items === undefined) evalLimit = prefixItems.length;
    } else if (isTuple) {
      if (jsonSchema.additionalItems === undefined) evalLimit = items.length;
    }
  }

  // An element at a tuple position is validated by that position's
  // validator, every other one by `rest`.
  let positions = [];
  let rest = null;
  /** @type {number[] | null} */
  let codes = null;
  let itemsTrue = false;

  if (prefixItems != null) {
    // Draft 2020-12+ style prefixItems
    ({ positions, rest, codes } = compilePrefixItems(schemaObj, jsonSchema));
  } else if (isTuple) {
    // Draft 7 style tuple items
    ({ positions, rest, codes } = compileTupleItems(schemaObj, jsonSchema));
  } else if (items !== undefined) {
    // Single schema for all items
    const itemsSchema = getObjectType(items);
    if (itemsSchema != null) {
      // Use direct validator compilation for items
      rest = compileItemValidator(schemaObj, itemsSchema, 'items', undefined);
    } else if (items === true) {
      rest = trueThat;
      itemsTrue = true;
    }
    // items === false is fully handled by compileArrayItemsBoolean: only an
    // empty array can pass, so a per-item validator would never be invoked.
  }
  const count = positions.length;

  const validateContains = compileArrayContains(schemaObj, jsonSchema);
  if ((rest || validateContains) == null)
    return undefined;

  const validateMinMax = compileContainsMinMax(schemaObj, jsonSchema) || trueThat;

  // Fast path: items only, no contains
  if (validateContains == null && rest != null) {
    // items: true only needs the evaluation recorded
    if (itemsTrue) {
      // items: true evaluates every item, which matters when annotations
      // are tracked for unevaluatedItems.
      if (track) {
        return function validateArrayItemsTrue(data, _dataPath, _dataRoot) {
          if (alone && !isArrayClass(data)) return true;
          root.evalLog.add(data, -1);
          return true;
        };
      }
      return undefined; // No actual validation needed
    }

    const addError = schemaObj.createErrorHandler(0, 'items');

    // A tuple of pure positions with a constant past them, where a fault
    // records nothing and no annotation is kept: the positions are tested
    // by code, and the elements past them by their count alone. An array
    // whose constructor is Array answers the class test by a read of its
    // own, which meets only arrays; any other value by isArrayClass.
    if (codes !== null && !track && root.options.skipErrors && (rest === trueThat || rest === falseThat)) {
      const closed = rest === falseThat;
      return function validatePureTuple(data) {
        if (alone && !((Array.isArray(data) && data.constructor === Array) || isArrayClass(data))) return true;
        const len = data.length;
        if (closed && len > count) return false;
        const end = count < len ? count : len;
        for (let i = 0; i < end; ++i) {
          if (!isPurePosition(codes[i], data[i])) return false;
        }
        return true;
      };
    }

    // A homogeneous items walk tests a leading `type: 'array'` too.
    const typeError = typed !== null && count === 0 ? typed.error : null;
    if (typeError !== null) typed.taken = true;

    // Items of one pure test (a type-only schema, one asserting nothing)
    // where a fault records nothing, no annotation is kept and no item
    // location is built: each element is tested by code (isPurePosition),
    // every one read, as the walk below reads them.
    const restCode = count === 0 && !track && !extendPaths && root.options.skipErrors
      ? PURE_POSITIONS.indexOf(rest)
      : -1;
    if (restCode >= 0) {
      return function validatePureItems(data, dataPath) {
        if (alone && !isArrayClass(data)) return otherKind(typeError, data, dataPath);
        const len = data.length;
        let invalid = 0;
        for (let i = 0; i < len; ++i) {
          if (!isPurePosition(restCode, data[i])) invalid++;
        }
        return invalid === 0
          || addError(invalid, dataPath);
      };
    }

    return function validateArrayItemsOnly(data, dataPath, dataRoot) {
      if (alone && !isArrayClass(data)) return otherKind(typeError, data, dataPath);
      const len = data.length;
      const arr = data;

      let invalid = 0;
      for (let i = 0; i < len; ++i) {
        const itemPath = extendPaths ? dataPath + '/' + i : dataPath;
        const ok = (i < count
          ? positions[i](arr[i], itemPath, dataRoot)
          : rest(arr[i], itemPath, dataRoot)) === true;
        if (!ok) invalid++;
        if (track && i < evalLimit && (ok || logFailed)) root.evalLog.add(data, i);
      }
      return invalid === 0
        || addError(invalid, dataPath);
    };
  }

  // Fast path: contains only, no items
  if (rest == null && validateContains != null) {
    const validator = validateContains;

    return function validateArrayContainsOnly(data, dataPath, dataRoot) {
      if (alone && !isArrayClass(data)) return true;
      const len = data.length;
      const arr = data;
      // Each element is a CANDIDATE probe: the array only has to contain a
      // match, so an element that is not one has done nothing wrong.
      const errors = root.errorMark();
      let contains = 0;
      for (let i = 0; i < len; ++i) {
        const itemPath = extendPaths ? dataPath + '/' + i : dataPath;
        if (validator(arr[i], itemPath, dataRoot) === true) {
          contains++;
          if (trackContains) root.evalLog.add(data, i);
        }
      }
      root.rollbackErrors(errors);
      return validateMinMax(contains, dataPath);
    };
  }

  // Combined: both items and contains
  const containsValidator = validateContains;

  const stopAtFirstContains = schemaObj.options.skipErrors;
  return function validateArrayChildren(data, dataPath, dataRoot) {
    if (alone && !isArrayClass(data)) return true;
    const len = data.length;
    const arr = data;

    let invalid = 0;
    let contains = 0;
    for (let i = 0; i < len; ++i) {
      const obj = arr[i];
      const itemPath = extendPaths ? dataPath + '/' + i : dataPath;
      const ok = (i < count
        ? positions[i](obj, itemPath, dataRoot)
        : rest(obj, itemPath, dataRoot)) === true;
      if (!ok) invalid++;
      if (track && i < evalLimit && (ok || logFailed)) root.evalLog.add(data, i);
      // A contains candidate is a probe: not matching is not a fault.
      const containsMark = root.errorMark();
      if (containsValidator(obj, itemPath, dataRoot) === true) {
        contains++;
        if (trackContains) root.evalLog.add(data, i);
      }
      root.rollbackErrors(containsMark);
    }
    // Failing items and the contains count are independent tallies.
    const itemsOk = invalid === 0;
    if (stopAtFirstContains && !itemsOk) return false;
    return validateMinMax(contains, dataPath) && itemsOk;
  };
}

/**
 * The validator of a schema's array keywords, or undefined when it holds
 * none that asserts anything.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {object} jsonSchema
 * @param {{ error: (data: unknown, dataPath: string) => boolean, taken: boolean } | null} [typed] -
 *   A leading `type: 'array'` no other keyword group precedes, in the
 *   first-failure mode: a lone homogeneous items walk then tests it too,
 *   failing through `typed.error`, and sets `typed.taken`
 * @returns {Function | undefined}
 */
export function compileArraySchema(schemaObj, jsonSchema, typed = null) {
  if (isOfSchemaType(jsonSchema, 'set'))
    return undefined;

  const compiledPrimitives = compileArrayPrimitives(schemaObj, jsonSchema);
  const compiledItemsBoolean = compileArrayItemsBoolean(schemaObj, jsonSchema);
  const compiledContainsBoolean = compileArrayContainsBoolean(schemaObj, jsonSchema);
  const alone = !compiledPrimitives && !compiledContainsBoolean
    && (!compiledItemsBoolean || compiledItemsBoolean === trueThat);
  const compiledArrayChildren = compileArrayChildren(schemaObj, jsonSchema, alone, alone ? typed : null);

  if ((compiledPrimitives
    || compiledItemsBoolean
    || compiledContainsBoolean
    || compiledArrayChildren) === undefined)
    return undefined;

  // Single-validator schemas are the common case; skip the trueThat chain.
  const parts = [];
  if (compiledPrimitives) parts.push(compiledPrimitives);
  if (compiledItemsBoolean && compiledItemsBoolean !== trueThat) parts.push(compiledItemsBoolean);
  if (compiledContainsBoolean) parts.push(compiledContainsBoolean);
  if (compiledArrayChildren) parts.push(compiledArrayChildren);

  if (parts.length === 0)
    return undefined;

  if (parts.length === 1) {
    const single = parts[0];
    if (alone) return single;
    return function validateArraySchemaSingle(data, dataPath, dataRoot) {
      return isArrayClass(data)
        ? single(data, dataPath, dataRoot)
        : true;
    };
  }

  if (parts.length === 2) {
    const first = parts[0];
    const second = parts[1];
    if (schemaObj.options.skipErrors) {
      return function validateArraySchemaDouble(data, dataPath, dataRoot) {
        if (isArrayClass(data)) {
          return first(data, dataPath, dataRoot)
            && second(data, dataPath, dataRoot);
        }
        return true;
      };
    }
    // The two parts are independent array keyword groups (length/uniqueness
    // versus the item walk); the array-class guard stays a precondition.
    return function validateArraySchemaDoubleAll(data, dataPath, dataRoot) {
      if (!isArrayClass(data)) return true;
      const firstOk = first(data, dataPath, dataRoot);
      return second(data, dataPath, dataRoot) && firstOk;
    };
  }

  const validatePrimitives = compiledPrimitives || trueThat;
  const hasBooleanItems = compiledItemsBoolean || trueThat;
  const hasBooleanContains = compiledContainsBoolean || trueThat;
  const validateItems = compiledArrayChildren || trueThat;
  const stopAtFirstSchema = schemaObj.options.skipErrors;

  return function validateArraySchema(data, dataPath, dataRoot) {
    if (isArrayClass(data)) {
      if (stopAtFirstSchema) {
        return validatePrimitives(data, dataPath)
          && hasBooleanItems(data, dataPath, dataRoot)
          && hasBooleanContains(data, dataPath, dataRoot)
          && validateItems(data, dataPath, dataRoot);
      }
      // Length/uniqueness, the boolean items/contains forms and the item
      // walk are independent; a length failure must not hide item faults.
      let valid = validatePrimitives(data, dataPath);
      valid = hasBooleanItems(data, dataPath, dataRoot) && valid;
      valid = hasBooleanContains(data, dataPath, dataRoot) && valid;
      return validateItems(data, dataPath, dataRoot) && valid;
    }
    return true;
  };
}
//#endregion
