//@ts-check

import {
  isObjectType,
  isArrayClass,
} from '@jarenjs/core';

import {
  getBoolOrObjectClass,
  hasUnevaluatedPropertiesCoverage,
  hasUnevaluatedItemsCoverage,
  memberPath,
  extendsChildLocations,
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

  // In skipErrors mode reaching this final-stage check means every sibling
  // keyword passed; with a sibling additionalProperties every property was
  // then evaluated (and logged), so the check can never match and the
  // sibling already produced the annotations any outer check consumes.
  if (schemaObj.options.skipErrors && hasUnevaluatedPropertiesCoverage(jsonSchema))
    return undefined;

  const root = schemaObj.root;
  // A member's location is read by its errors (collecting mode) and by a
  // location reader in the member's schema; otherwise nobody looks, so it is
  // not built.
  const extendPaths = extendsChildLocations(schemaObj, jsonSchema, ['unevaluatedProperties']);
  const addError = schemaObj.createErrorHandler(uneval, 'unevaluatedProperties');

  // true: everything left over is valid, but counts as evaluated for
  // any unevaluatedProperties in an outer schema.
  // Recording output units, `true` applies as a subschema below, so its
  // annotation names the members it evaluated.
  if (uneval === true && root.recorder === null) {
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
      // Many members against a long log: one pass instead of a scan per member.
      const index = log.index(data, mark, keys.length);
      let valid = true;
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        if (index === null ? !log.hasKey(data, key, mark) : !index.has(key))
          valid = addError(key, dataPath) && valid;
      }
      return valid;
    };
  }

  const validator = schemaObj.createValidator(uneval, 'unevaluatedProperties');
  return function validateUnevaluatedProperties(data, dataPath, dataRoot, mark) {
    if (!isObjectType(data)) return true;
    const log = root.evalLog;
    const keys = Object.keys(data);
    const index = log.index(data, mark, keys.length);
    // A member that holds the instance itself can evaluate more of it while
    // it is validated here: those entries come after `end`.
    const end = log.mark();
    let valid = true;
    for (let i = 0; i < keys.length; ++i) {
      const key = keys[i];
      if (index === null ? log.hasKey(data, key, mark) : index.has(key) || log.hasKey(data, key, end)) continue;
      if (validator(data[key], extendPaths ? memberPath(dataPath, key) : dataPath, dataRoot, key) === true)
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

  // In skipErrors mode reaching this final-stage check means every sibling
  // keyword passed; with sibling coverage (uniform items, or tuple items
  // plus additionalItems) every item was then evaluated (and logged), so
  // the check can never match and the covering sibling already produced
  // the annotations any outer check consumes.
  if (schemaObj.options.skipErrors && hasUnevaluatedItemsCoverage(jsonSchema))
    return undefined;

  const root = schemaObj.root;
  // A member's location is read by its errors (collecting mode) and by a
  // location reader in the member's schema; otherwise nobody looks, so it is
  // not built.
  const extendPaths = extendsChildLocations(schemaObj, jsonSchema, ['unevaluatedItems']);
  const addError = schemaObj.createErrorHandler(uneval, 'unevaluatedItems');

  // Recording output units, `true` applies as a subschema below.
  if (uneval === true && root.recorder === null) {
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
      const index = log.index(data, mark, data.length);
      if (index !== null && index.has(-1)) return true;
      for (let i = 0; i < data.length; ++i) {
        if (index === null ? !log.hasItem(data, i, mark) : !index.has(i))
          return addError(i, dataPath);
      }
      return true;
    };
  }

  const validator = schemaObj.createValidator(uneval, 'unevaluatedItems');
  return function validateUnevaluatedItems(data, dataPath, dataRoot, mark) {
    if (!isArrayClass(data)) return true;
    const log = root.evalLog;
    const index = log.index(data, mark, data.length);
    if (index !== null && index.has(-1)) return true;
    const end = log.mark();
    let valid = true;
    for (let i = 0; i < data.length; ++i) {
      if (index === null ? log.hasItem(data, i, mark) : index.has(i) || log.hasItem(data, i, end)) continue;
      if (validator(data[i], extendPaths ? dataPath + '/' + i : dataPath, dataRoot, i) === true)
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
  // unevaluatedProperties/unevaluatedItems only exist since draft 2019-09; a
  // document that declares an older draft via $schema treats them as
  // unknown keywords.
  if (schemaObj.declaredDraft != null && schemaObj.declaredDraft < 2019) return validator;

  const unevalProps = compileUnevaluatedProperties(schemaObj, jsonSchema);
  const unevalItems = compileUnevaluatedItems(schemaObj, jsonSchema);
  if (unevalProps == null && unevalItems == null) return validator;

  const stopAtFirst = root.options.skipErrors;
  return function validateUnevaluatedSchema(data, dataPath, dataRoot, dataKey) {
    const log = root.evalLog;
    const mark = log.mark();
    // A failed sibling decides the answer. When errors are collected the
    // checks still run, so a member nothing evaluated is reported beside the
    // sibling's own fault: the siblings log every member they matched, pass
    // or fail, so a member they already reported is not named twice.
    // unevaluatedProperties and unevaluatedItems are independent of each
    // other.
    let valid = validator(data, dataPath, dataRoot, dataKey) !== false;
    if (stopAtFirst && !valid) return false;
    if (unevalProps != null && unevalProps(data, dataPath, dataRoot, mark) === false) valid = false;
    if (stopAtFirst && !valid) return false;
    if (unevalItems != null && unevalItems(data, dataPath, dataRoot, mark) === false) valid = false;
    return valid;
  };
}
