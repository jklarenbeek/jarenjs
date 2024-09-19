//@ts-check

import {
  fallbackFn,
} from '@jarenjs/core/function';

export function compileConditionSchema(schemaObj, jsonSchema) {
  const validateIf = schemaObj.createValidator(jsonSchema.if, 'if');
  const tmpThen = schemaObj.createValidator(jsonSchema.then, 'then');
  const tmpElse = schemaObj.createValidator(jsonSchema.else, 'else');

  if (validateIf == null) return undefined;
  if (tmpThen == null && tmpElse == null) return undefined;

  const validateThen = fallbackFn(tmpThen);
  const validateElse = fallbackFn(tmpElse);
  return function validateCondition(data, dataRoot) {
    if (validateIf(data))
      return validateThen(data, dataRoot);
    else
      return validateElse(data, dataRoot);
  };
}
