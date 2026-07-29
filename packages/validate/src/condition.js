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
        // A lone `if` asserts NOTHING, so it can never explain a failure and
        // its errors are always discarded. Only its annotations survive, and
        // only when it passed.
        const errors = root.errorMark();
        if (validateIf(data, dataPath, dataRoot, dataKey) === false)
          log.rollback(mark);
        root.rollbackErrors(errors);
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
      // `if` decides WHICH branch applies; the document was never required to
      // satisfy it, so its complaints are discarded either way. Only `then`
      // and `else` produce errors a caller should see.
      const errors = root.errorMark();
      const taken = validateIf(data, dataPath, dataRoot, dataKey);
      root.rollbackErrors(errors);
      if (taken) return validateThen(data, dataPath, dataRoot, dataKey);
      log.rollback(mark);
      return validateElse(data, dataPath, dataRoot, dataKey);
    };
  }

  // If neither then nor else has dynamic anchors, use simple validation
  if (!thenHasAnchor && !elseHasAnchor) {
    // Every call site passes (data, dataPath, dataRoot, dataKey). Declaring
    // fewer parameters does not drop the extra arguments, it MISBINDS them:
    // a two-parameter form named its second parameter `dataRoot` and was
    // handed the dataPath, so the branch validators ran with no root at all
    // and a `$data` reference inside `then` silently resolved to nothing —
    // a wrong verdict rather than an error.
    return function validateCondition(data, dataPath, dataRoot, dataKey) {
      const errors = root.errorMark();
      const taken = validateIf(data, dataPath, dataRoot, dataKey);
      root.rollbackErrors(errors);
      return taken
        ? validateThen(data, dataPath, dataRoot, dataKey)
        : validateElse(data, dataPath, dataRoot, dataKey);
    };
  }
  
  // If then or else has dynamic anchors, wrap validation to register them
  const track = root.usesUnevaluated;
  return function validateConditionWithDynamicAnchors(data, dataPath, dataRoot, dataKey) {
    const mark = track ? root.evalLog.mark() : 0;
    const conditionErrors = root.errorMark();
    const taken = validateIf(data, dataPath, dataRoot, dataKey);
    root.rollbackErrors(conditionErrors);
    if (taken) {
      // Validate then branch with dynamic anchor registration
      if (thenHasAnchor && tmpThen) {
        const anchorName = thenDynAnchorName || '';
        root.pushDynamicAnchorValidator(anchorName, tmpThen);
        try {
          return validateThen(data, dataPath, dataRoot, dataKey);
        } finally {
          root.popDynamicAnchorValidator(anchorName);
        }
      }
      return validateThen(data, dataPath, dataRoot, dataKey);
    } else {
      // Annotations from the failed 'if' must not leak to unevaluated*
      if (track) root.evalLog.rollback(mark);
      // Validate else branch with dynamic anchor registration
      if (elseHasAnchor && tmpElse) {
        const anchorName = elseDynAnchorName || '';
        root.pushDynamicAnchorValidator(anchorName, tmpElse);
        try {
          return validateElse(data, dataPath, dataRoot, dataKey);
        } finally {
          root.popDynamicAnchorValidator(anchorName);
        }
      }
      return validateElse(data, dataPath, dataRoot, dataKey);
    }
  };
}
