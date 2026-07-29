//@ts-check

import {
  isFn,
} from '@jarenjs/core';

import {
  falseThat,
  trueThat,
} from '@jarenjs/core/function';

import {
  combineIndependent,
  getBoolOrObjectClass,
  getArrayClassMinItems,
} from './tools.js';

function compileAllOf(schemaObj, jsonSchema) {
  const allOf = getArrayClassMinItems(jsonSchema.allOf, 1);
  if (allOf == null) return undefined;

  const validators = [];
  for (let i = 0; i < allOf.length; ++i) {
    const child = allOf[i];
    if (child === true)
      validators.push(trueThat);
    else if (child === false)
      validators.push(falseThat);
    else {
      const validator = schemaObj.createValidator(child, 'allOf', i);
      validators.push(validator);
    }
  }
  if (validators.length === 0) return undefined;

  const addError = schemaObj.createErrorHandler(allOf, 'allOf');

  const stopAtFirst = schemaObj.options.skipErrors;
  return function validateAllOf(data, dataPath, dataRoot, dataKey) {
    if (data !== undefined) {
      // EVERY allOf branch applies, so every branch's faults are real. Only
      // the boolean answer may stop at the first failing branch.
      let valid = true;
      for (let i = 0; i < validators.length; ++i) {
        const validator = validators[i];
        if (validator(data, dataPath, dataRoot, dataKey) === false) {
          valid = addError(data, dataPath);
          if (stopAtFirst) return valid;
        }
      }
      return valid;
    }
    return true;
  };
}

function compileAnyOf(schemaObj, jsonSchema) {
  const anyOf = getArrayClassMinItems(jsonSchema.anyOf, 1);
  if (anyOf == null) return undefined;

  const validators = [];
  for (let i = 0; i < anyOf.length; ++i) {
    const child = anyOf[i];
    if (child === true)
      validators.push(trueThat);
    else if (child === false)
      validators.push(falseThat);
    else {
      const validator = schemaObj.createValidator(child, 'anyOf', i);
      validators.push(validator);
    }
  }
  if (validators.length === 0) return undefined;

  const addError = schemaObj.createErrorHandler(anyOf, 'anyOf');

  // With annotation tracking every branch must run (annotations from ALL
  // successful branches count for unevaluated*), and annotations from
  // failed branches are rolled back.
  const root = schemaObj.root;
  if (root.usesUnevaluated) {
    return function validateAnyOfTracked(data, dataPath, dataRoot, dataKey) {
      if (data === undefined) return true;
      const log = root.evalLog;
      const errors = root.errorMark();
      let found = false;
      for (let i = 0; i < validators.length; ++i) {
        const mark = log.mark();
        if (validators[i](data, dataPath, dataRoot, dataKey) === true)
          found = true;
        else
          log.rollback(mark);
      }
      // Annotation tracking runs every branch, so a match leaves the failed
      // branches' errors behind unless they are rolled back here too.
      if (found) root.rollbackErrors(errors);
      return found || addError(data, dataPath);
    };
  }

  return function validateAnyOf(data, dataPath, dataRoot, dataKey) {
    if (data !== undefined) {
      // Every branch tried before a match is a SPECULATIVE probe: the document
      // was never required to satisfy it. Its errors are kept only if no
      // branch matched at all, where they are the explanation.
      const mark = root.errorMark();
      for (let i = 0; i < validators.length; ++i) {
        if (validators[i](data, dataPath, dataRoot, dataKey) === true) {
          root.rollbackErrors(mark);
          return true;
        }
      }
      return addError(data, dataPath);
    }
    return true;
  };
}

function compileOneOf(schemaObj, jsonSchema) {
  const oneOf = getArrayClassMinItems(jsonSchema.oneOf, 1);
  if (oneOf == null)
    return undefined;

  const validators = [];
  for (let i = 0; i < oneOf.length; ++i) {
    const child = oneOf[i];
    if (child === true)
      validators.push(trueThat);
    else if (child === false)
      validators.push(falseThat);
    else {
      const validator = schemaObj.createValidator(child, 'oneOf', i);
      validators.push(validator);
    }
  }
  if (validators.length === 0)
    return undefined;

  const addError = schemaObj.createErrorHandler(oneOf, 'oneOf');

  // With annotation tracking, annotations from failed branches are rolled back.
  const root = schemaObj.root;
  if (root.usesUnevaluated) {
    return function validateOneOfTracked(data, dataPath, dataRoot, dataKey) {
      const log = root.evalLog;
      const errors = root.errorMark();
      let found = false;
      for (let i = 0; i < validators.length; ++i) {
        const mark = log.mark();
        if (validators[i](data, dataPath, dataRoot, dataKey) === true) {
          if (found === true) {
            root.rollbackErrors(errors);
            return addError(data, dataPath);
          }
          found = true;
        }
        else {
          log.rollback(mark);
        }
      }
      // Non-matching branches were speculative; their complaints survive only
      // when nothing matched and they are the explanation.
      if (found) root.rollbackErrors(errors);
      return found || addError(data, dataPath);
    };
  }

  return function validateOneOf(data, dataPath, dataRoot, dataKey) {
    const errors = root.errorMark();
    let found = false;
    for (let i = 0; i < validators.length; ++i) {
      if (validators[i](data, dataPath, dataRoot, dataKey) === true) {
        if (found === true) {
          // Matching twice is the failure; the branches' own errors explain
          // nothing about it.
          root.rollbackErrors(errors);
          return addError(data, dataPath);
        }
        found = true;
      }
    }
    if (found) root.rollbackErrors(errors);
    return found || addError(data, dataPath);
  };
}

function compileNotOf(schemaObj, jsonSchema) {
  const notOf = getBoolOrObjectClass(jsonSchema.not);
  if (notOf == null) return undefined;
  if (notOf === false) return trueThat;

  const addError = schemaObj.createErrorHandler(notOf, 'not');

  // `not: true` rejects every instance. It still has to SAY so: returning a
  // bare false made the only schema that can fail without explanation, and a
  // collector that reports "invalid" with an empty error list is unusable by
  // a caller trying to render why.
  if (notOf === true)
    return function validateNotOfTrue(data, dataPath) {
      return data === undefined ? true : addError(data, dataPath);
    };

  const validate = schemaObj.createValidator(notOf, 'not');

  // Annotations produced inside a 'not' are never kept, whatever the outcome.
  const root = schemaObj.root;
  if (root.usesUnevaluated) {
    return function validateNotOfTracked(data, dataPath, dataRoot, dataKey) {
      if (data === undefined) return true;
      const log = root.evalLog;
      const mark = log.mark();
      const errors = root.errorMark();
      const valid = validate(data, dataPath, dataRoot, dataKey);
      log.rollback(mark);
      // A `not` whose subschema FAILS is a `not` that passed, so the
      // subschema's complaints are never the caller's business either way.
      root.rollbackErrors(errors);
      return valid === false
        ? true
        : addError(data, dataPath);
    };
  }

  return function validateNotOf(data, dataPath, dataRoot, dataKey) {
    if (data === undefined) return true;
    // The subschema is a probe: its failure is what makes `not` succeed, so
    // its errors are discarded whichever way the probe went.
    const errors = root.errorMark();
    const valid = validate(data, dataPath, dataRoot, dataKey);
    root.rollbackErrors(errors);
    return valid === false
      ? true
      : addError(data, dataPath);
  };
}

export function compileCombineSchema(schemaObj, jsonSchema) {
  const validators = [];
  function addValidator(compiler) {
    if (isFn(compiler))
      validators.push(compiler);
  }

  addValidator(compileAllOf(schemaObj, jsonSchema));
  addValidator(compileAnyOf(schemaObj, jsonSchema));
  addValidator(compileOneOf(schemaObj, jsonSchema));
  addValidator(compileNotOf(schemaObj, jsonSchema));

  if (validators.length === 0)
    return undefined;
  if (validators.length === 1)
    return validators[0];
  // allOf/anyOf/oneOf/not are independent applicator groups: a failing
  // `oneOf` says nothing about whether `not` also failed.
  if (!schemaObj.options.skipErrors)
    return combineIndependent(validators);

  if (validators.length === 2) {
    const first = validators[0];
    const second = validators[1];
    return function validateCombinaSchemaPair(data, dataPath, dataRoot, dataKey) {
      return first(data, dataPath, dataRoot, dataKey)
        && second(data, dataPath, dataRoot, dataKey);
    };
  }
  else {
    return function validateCombineSchema(data, dataPath, dataRoot, dataKey) {
      for (let i = 0; i < validators.length; ++i) {
        const validator = validators[i];
        if (validator(data, dataPath, dataRoot, dataKey) === false)
          return false;
      }
      return true;
    };
  }
}
