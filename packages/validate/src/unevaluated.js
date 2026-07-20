//@ts-check

import {
  isObjectType,
  isArrayClass,
} from '@jarenjs/core';

import {
  getBoolOrObjectClass,
} from './tools.js';

/**
 * Compile the unevaluatedProperties keyword as a final-stage validator.
 * Receives the evaluation-log mark taken before the containing schema
 * (including a sibling $ref) started, and checks every property of the
 * instance that was not recorded as evaluated since that mark.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {object} jsonSchema
 * @returns {function|undefined} validator(data, dataPath, dataRoot, mark)
 */
function compileUnevaluatedProperties(schemaObj, jsonSchema) {
  const uneval = getBoolOrObjectClass(jsonSchema.unevaluatedProperties);
  if (uneval == null) return undefined;

  const root = schemaObj.root;
  const addError = schemaObj.createErrorHandler(uneval, 'unevaluatedProperties');

  // true: everything left over is valid, but counts as evaluated for
  // any unevaluatedProperties in an outer schema.
  if (uneval === true) {
    return function validateUnevaluatedPropertiesTrue(data, _dataPath, _dataRoot, _mark) {
      if (!isObjectType(data)) return true;
      const log = root.evalLog;
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; ++i) {
        log.add(data, keys[i]);
      }
      return true;
    };
  }

  if (uneval === false) {
    return function validateUnevaluatedPropertiesFalse(data, dataPath, dataRoot, mark) {
      if (!isObjectType(data)) return true;
      const log = root.evalLog;
      const keys = Object.keys(data);
      let valid = true;
      for (let i = 0; i < keys.length; ++i) {
        if (!log.hasKey(data, keys[i], mark))
          valid = addError(keys[i], dataPath) && valid;
      }
      return valid;
    };
  }

  const validator = schemaObj.createValidator(uneval, 'unevaluatedProperties');
  return function validateUnevaluatedProperties(data, dataPath, dataRoot, mark) {
    if (!isObjectType(data)) return true;
    const log = root.evalLog;
    const keys = Object.keys(data);
    let valid = true;
    for (let i = 0; i < keys.length; ++i) {
      const key = keys[i];
      if (log.hasKey(data, key, mark)) continue;
      if (validator(data[key], dataPath, dataRoot, key) === true)
        log.add(data, key);
      else
        valid = addError(key, dataPath) && valid;
    }
    return valid;
  };
}

/**
 * Compile the unevaluatedItems keyword as a final-stage validator.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {object} jsonSchema
 * @returns {function|undefined} validator(data, dataPath, dataRoot, mark)
 */
function compileUnevaluatedItems(schemaObj, jsonSchema) {
  const uneval = getBoolOrObjectClass(jsonSchema.unevaluatedItems);
  if (uneval == null) return undefined;

  const root = schemaObj.root;
  const addError = schemaObj.createErrorHandler(uneval, 'unevaluatedItems');

  if (uneval === true) {
    return function validateUnevaluatedItemsTrue(data, _dataPath, _dataRoot, _mark) {
      if (!isArrayClass(data)) return true;
      root.evalLog.add(data, -1);
      return true;
    };
  }

  if (uneval === false) {
    return function validateUnevaluatedItemsFalse(data, dataPath, dataRoot, mark) {
      if (!isArrayClass(data)) return true;
      const log = root.evalLog;
      for (let i = 0; i < data.length; ++i) {
        if (!log.hasItem(data, i, mark))
          return addError(i, dataPath);
      }
      return true;
    };
  }

  const validator = schemaObj.createValidator(uneval, 'unevaluatedItems');
  return function validateUnevaluatedItems(data, dataPath, dataRoot, mark) {
    if (!isArrayClass(data)) return true;
    const log = root.evalLog;
    let valid = true;
    for (let i = 0; i < data.length; ++i) {
      if (log.hasItem(data, i, mark)) continue;
      if (validator(data[i], dataPath, dataRoot, i) === true)
        log.add(data, i);
      else
        valid = addError(i, dataPath) && valid;
    }
    return valid;
  };
}

/**
 * Wraps a compiled schema validator so unevaluatedProperties/unevaluatedItems
 * run last, seeing every annotation produced on this instance by the schema's
 * own keywords and its in-place applicators (allOf/anyOf/oneOf/if/$ref/...).
 * Returns the validator unchanged when evaluation tracking is off or the
 * schema has no unevaluated* keywords.
 * @param {import('./index.js').ValidationObject} schemaObj
 * @param {object} jsonSchema
 * @param {function} validator - The compiled validator for all other keywords
 * @returns {function} The wrapped (or original) validator
 */
export function wrapUnevaluated(schemaObj, jsonSchema, validator) {
  const root = schemaObj.root;
  if (!root.usesUnevaluated) return validator;
  if (jsonSchema == null || typeof jsonSchema !== 'object') return validator;

  const unevalProps = compileUnevaluatedProperties(schemaObj, jsonSchema);
  const unevalItems = compileUnevaluatedItems(schemaObj, jsonSchema);
  if (unevalProps == null && unevalItems == null) return validator;

  return function validateUnevaluatedSchema(data, dataPath, dataRoot, dataKey) {
    const log = root.evalLog;
    const mark = log.mark();
    if (validator(data, dataPath, dataRoot, dataKey) === false) return false;
    if (unevalProps != null && unevalProps(data, dataPath, dataRoot, mark) === false) return false;
    if (unevalItems != null && unevalItems(data, dataPath, dataRoot, mark) === false) return false;
    return true;
  };
}
