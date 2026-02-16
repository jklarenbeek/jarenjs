//@ts-check

import {
  fallbackFn,
} from '@jarenjs/core/function';

import {
  isObjectClass,
} from '@jarenjs/core';

import {
  hasRecursiveAnchor,
  hasDynamicAnchor,
  getDynamicAnchorName,
} from './dynamic-ref.js';

export function compileConditionSchema(schemaObj, jsonSchema) {
  const root = schemaObj.root;
  const validateIf = schemaObj.createValidator(jsonSchema.if, 'if');
  const tmpThen = schemaObj.createValidator(jsonSchema.then, 'then');
  const tmpElse = schemaObj.createValidator(jsonSchema.else, 'else');

  if (validateIf == null) return undefined;
  if (tmpThen == null && tmpElse == null) return undefined;

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
  return function validateConditionWithDynamicAnchors(data, dataPath, dataRoot) {
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
