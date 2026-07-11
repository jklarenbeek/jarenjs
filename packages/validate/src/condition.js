//@ts-check

import {
  fallbackFn,
} from '@jarenjs/core/function';

import {
  isObjectClass,
} from '@jarenjs/core';

import {
  hasRecursiveAnchor,
  getDynamicAnchorName,
} from './dynamic-ref.js';

export function compileConditionSchema(schemaObj, jsonSchema) {
  const root = schemaObj.root;
  const validateIf = schemaObj.createValidator(jsonSchema.if, 'if');
  const tmpThen = schemaObj.createValidator(jsonSchema.then, 'then');
  const tmpElse = schemaObj.createValidator(jsonSchema.else, 'else');

  if (validateIf == null) return undefined;
  if (tmpThen == null && tmpElse == null) {
    // A lone 'if' asserts nothing, but with annotation tracking its
    // annotations (when it passes) must stay visible to unevaluated*.
    if (root.usesUnevaluated) {
      return function validateLoneIf(data, dataPath, dataRoot, dataKey) {
        const log = root.evalLog;
        const mark = log.mark();
        if (validateIf(data, dataPath, dataRoot, dataKey) === false)
          log.rollback(mark);
        return true;
      };
    }
    return undefined;
  }

  // Check if then/else schemas have dynamic anchors
  const thenSchema = jsonSchema.then;
  const elseSchema = jsonSchema.else;
  
  const thenHasRecAnchor = isObjectClass(thenSchema) && hasRecursiveAnchor(thenSchema);
  const thenDynAnchorName = isObjectClass(thenSchema) ? getDynamicAnchorName(thenSchema) : null;
  const elseHasRecAnchor = isObjectClass(elseSchema) && hasRecursiveAnchor(elseSchema);
  const elseDynAnchorName = isObjectClass(elseSchema) ? getDynamicAnchorName(elseSchema) : null;
  
  const thenHasAnchor = thenHasRecAnchor || thenDynAnchorName;
  const elseHasAnchor = elseHasRecAnchor || elseDynAnchorName;

  const validateThen = fallbackFn(tmpThen);
  const validateElse = fallbackFn(tmpElse);

  // With annotation tracking, annotations produced by a failing 'if' are
  // rolled back; annotations from a passing 'if' are kept for unevaluated*.
  if (root.usesUnevaluated && !thenHasAnchor && !elseHasAnchor) {
    return function validateConditionTracked(data, dataPath, dataRoot, dataKey) {
      const log = root.evalLog;
      const mark = log.mark();
      if (validateIf(data, dataPath, dataRoot, dataKey)) {
        return validateThen(data, dataPath, dataRoot, dataKey);
      }
      log.rollback(mark);
      return validateElse(data, dataPath, dataRoot, dataKey);
    };
  }

  // If neither then nor else has dynamic anchors, use simple validation
  if (!thenHasAnchor && !elseHasAnchor) {
    return function validateCondition(data, dataRoot) {
      if (validateIf(data))
        return validateThen(data, dataRoot);
      else
        return validateElse(data, dataRoot);
    };
  }
  
  // If then or else has dynamic anchors, wrap validation to register them
  const track = root.usesUnevaluated;
  return function validateConditionWithDynamicAnchors(data, dataPath, dataRoot) {
    const mark = track ? root.evalLog.mark() : 0;
    if (validateIf(data)) {
      // Validate then branch with dynamic anchor registration
      if (thenHasAnchor && tmpThen) {
        const anchorName = thenDynAnchorName || '';
        root.pushDynamicAnchorValidator(anchorName, tmpThen);
        try {
          return validateThen(data, dataRoot);
        } finally {
          root.popDynamicAnchorValidator(anchorName);
        }
      }
      return validateThen(data, dataRoot);
    } else {
      // Annotations from the failed 'if' must not leak to unevaluated*
      if (track) root.evalLog.rollback(mark);
      // Validate else branch with dynamic anchor registration
      if (elseHasAnchor && tmpElse) {
        const anchorName = elseDynAnchorName || '';
        root.pushDynamicAnchorValidator(anchorName, tmpElse);
        try {
          return validateElse(data, dataRoot);
        } finally {
          root.popDynamicAnchorValidator(anchorName);
        }
      }
      return validateElse(data, dataRoot);
    }
  };
}
