//@ts-check

import {
  isObjectClass,
  isArrayClass,
  getObjectType,
} from '@jarenjs/core';

import {
  getIntishType,
} from '@jarenjs/core/number';

import {
  createRegExp,
} from '@jarenjs/core/string';

import {
  trueThat,
} from '@jarenjs/core/function';

import {
  isBoolOrObjectClass,
  getBoolOrObjectClass,
  getArrayClassMinItems,
  isOfSchemaType,
  ValidationResult,
} from './tools.js';

import {
  includesAll,
} from '@jarenjs/core/array';

//#region Primitives
function compileMinProperties(schemaObj, jsonSchema) {
  const min = getIntishType(jsonSchema.minProperties) || 0;
  if (min < 1) return undefined;

  const addError = schemaObj.createErrorHandler(min, 'minProperties');
  return function validateMinProperties(len = 0, dataPath = '') {
    return len >= min || addError(len, dataPath);
  };
}

function compileMaxProperties(schemaObj, jsonSchema) {
  const max = getIntishType(jsonSchema.maxProperties) || -1;
  if (max < 0) return undefined;
  const min = getIntishType(jsonSchema.minProperties) || 0;
  if (max < min) throw new Error('maxProperties must be greater then minProperties');

  const addError = schemaObj.createErrorHandler(max, 'maxProperties');
  return function validateMaxProperties(len = 0, dataPath = '') {
    return len <= max || addError(len, dataPath);
  };
}

function compileRequiredProperties(schemaObj, jsonSchema) {
  const required = getArrayClassMinItems(jsonSchema.required, 1);
  if (required == null) return undefined;

  const rlength = required.length;
  /** @type {function(string, string):boolean} */
  const addError = schemaObj.createErrorHandler(required, 'requiredProperties');
  return function validateRequiredProperties(dataKeys = [], dataPath = '') {
    let valid = true;
    for (let i = 0; i < rlength; ++i) {
      const key = required[i];
      const idx = dataKeys.indexOf(key);
      if (idx === -1)
        valid &&= addError(key, dataPath);
    }
    return valid;
  };
}
//#endregion

//#region Constraints
function compilePropertyNames(schemaObj, jsonSchema) {
  const propNames = getBoolOrObjectClass(jsonSchema.propertyNames);
  if (propNames == null) return undefined;

  return schemaObj.createValidator(propNames, 'propertyNames');
}

function compileProperties(schemaObj, jsonSchema) {
  const properties = getObjectType(jsonSchema.properties);
  if (properties == null) return undefined;

  const keys = Object.keys(properties);
  if (keys.length === 0) return undefined;

  const validators = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const schemas = properties[key];
    const validator = schemaObj.createValidator(schemas, 'properties', key);
    if (validator != null)
      validators[key] = validator;
  }
  if (Object.keys(validators).length === 0)
    return undefined;

  return function validatePropertyItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    const validator = validators[dataKey];
    if (validator == null)
      return result;
    else {
      return result.addMatch(
        validator(data[dataKey], dataPath, dataRoot, dataKey),
      );
    }
  };
}

function compilePatternProperties(schemaObj, jsonSchema) {
  const entries = getObjectType(jsonSchema.patternProperties);
  if (entries == null) return undefined;

  const entryKeys = Object.keys(entries);
  if (entryKeys.length === 0) return undefined;

  const patterns = {};
  for (let i = 0; i < entryKeys.length; ++i) {
    const key = entryKeys[i];
    const pattern = createRegExp(key);
    if (pattern != null)
      patterns[key] = pattern;
  }

  const patternKeys = Object.keys(patterns);
  if (patternKeys.length === 0) return undefined;

  const validators = {};
  for (let i = 0; i < patternKeys.length; ++i) {
    const key = patternKeys[i];
    const schema = entries[key];
    const validator = schemaObj.createValidator(schema, 'patternProperties', key);
    if (validator != null)
      validators[key] = validator;
  }

  const validatorKeys = Object.keys(validators);
  if (validatorKeys.length === 0) return undefined;

  return function validatePatternPropertiesItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    for (let i = 0; i < validatorKeys.length; ++i) {
      const key = validatorKeys[i];
      const pattern = patterns[key];
      if (pattern.test(dataKey)) {
        const validate = validators[key];
        result.addMatch(validate(data[dataKey], dataPath, dataRoot, dataKey));
      }
    }
    return result;
  };
}

function compileAdditionalProperties(schemaObj, jsonSchema) {
  const additional = getBoolOrObjectClass(jsonSchema.additionalProperties);
  if (additional == null) return undefined;

  if (additional === false) {
    const addError = schemaObj.createErrorHandler(false, 'additionalProperties');

    return function validateNoAdditionalProperties(data, dataPath, dataRoot, dataKey) {
      return addError(dataKey, data);
    };
  }

  const validator = schemaObj.createValidator(additional, 'additionalProperties');

  return function validateAdditionalPropertyItem(data, dataPath, dataRoot, dataKey) {
    return validator(data[dataKey], dataPath, dataRoot, dataKey);
  };
}

function compileUnevaluatedProperties(schemaObj, jsonSchema) {
  const unevaluatedProperties = getBoolOrObjectClass(jsonSchema.unevaluatedProperties);
  if (unevaluatedProperties == null) return undefined;
  
  if (unevaluatedProperties === false) {
    const addError = schemaObj.createErrorHandler(false, 'unevaluatedProperties');
    return (data, dataPath, dataRoot, dataKey) => addError(dataKey, data);
  }

  return schemaObj.createValidator(unevaluatedProperties, 'unevaluatedProperties');
}
//#endregion

//#region Dependencies
function compileDependentRequired(schemaObj, jsonSchema) {
  const dependentRequired = getObjectType(jsonSchema.dependentRequired);
  if (dependentRequired == null)
    return undefined;

  if (Object.keys(dependentRequired).length === 0)
    return undefined;

  const addError = schemaObj.createErrorHandler(false, 'dependentRequired');

  return function validateDependentRequiredItem(data, dataPath, dataRoot, dataKey) {
    if (dataKey in dependentRequired) {
      const required = dependentRequired[dataKey];
      return includesAll(Object.keys(data), required)
        || addError(data, dataKey, dataPath);
    }
    return true;
  };
}

function compileDependentSchemas(schemaObj, jsonSchema) {
  const dependentSchemas = getObjectType(jsonSchema.dependentSchemas);
  if (dependentSchemas == null) return undefined;

  const validators = {};
  for (const key in dependentSchemas) {
    if (key in dependentSchemas) {
      const schema = dependentSchemas[key];
      if (!isBoolOrObjectClass(schema) && !schemaObj.options.skipErrors)
        throw new Error(`Expected Schema at '${schemaObj.path}/${key}'`);

      const validator = schemaObj.createValidator(schema, 'dependentSchemas', key);
      if (validator != null)
        validators[key] = validator;
      else
        throw new Error(`Expected Validator at '${schemaObj.path}/${key}'`);
    }
  }

  if (Object.keys(validators).length === 0)
    return undefined;

  return function validateDependentSchemasItem(data, dataPath, dataRoot, dataKey) {
    if (dataKey in validators) {
      const validator = validators[dataKey];
      return validator(data, dataPath, dataRoot, dataKey);
    }
    return true;
  };
}

function compileDependencies(schemaObj, jsonSchema) {
  const dependencies = getObjectType(jsonSchema.dependencies);
  if (dependencies == null)
    return undefined;

  const validators = {};
  for (const key in dependencies) {
    if (key in dependencies) {
      const right = dependencies[key];
      if (isBoolOrObjectClass(right)) {
        const validator = schemaObj.createValidator(right, 'dependencies', key);
        if (validator != null)
          validators[key] = validator;
        else
          throw new Error(`Expected Validator at '${schemaObj.path}/${key}'`);
      }
      else if (isArrayClass(right)) {
        const addError = schemaObj.createErrorHandler(right, ['dependencies', key]);
        validators[key] = function validateRequiredDependency(data, dataPath, dataRoot, dataKey) {
          return includesAll(Object.keys(data), right)
            || addError(data, dataKey, dataPath);
        };
      }
      else if (!schemaObj.options.skipErrors)
        throw new Error(`Expected Schema or Array at '${schemaObj.path}/${key}'`);
    }
  }

  if (Object.keys(validators).length === 0)
    return undefined;

  return function validateDependenciesItem(data, dataPath, dataRoot, dataKey) {
    if (dataKey in validators) {
      const validator = validators[dataKey];
      return validator(data, dataPath, dataRoot, dataKey);
    }
    return true;
  };
}
//#endregion

//#region Main
export function compileObjectPrimitives(schemaObj, jsonSchema) {
  const minProperties = compileMinProperties(schemaObj, jsonSchema);
  const maxProperties = compileMaxProperties(schemaObj, jsonSchema);
  const requiredProperties = compileRequiredProperties(schemaObj, jsonSchema);

  if ((minProperties
    || maxProperties
    || requiredProperties) == null)
    return undefined;

  const isMinProperties = minProperties || trueThat;
  const isMaxProperties = maxProperties || trueThat;

  const hasRequiredProperties = requiredProperties || trueThat;

  return function validateObjectPrimitives(data, dataPath, dataRoot, dataKeys) {
    const keys = dataKeys || Object.keys(data);
    const len = keys.length;
    return isMinProperties(len, dataPath)
      && isMaxProperties(len, dataPath)
      && hasRequiredProperties(keys, dataPath);
  };
}

function compileObjectProperty(schemaObj, jsonSchema) {
  const namesValidator = compilePropertyNames(schemaObj, jsonSchema);
  const propertyValidator = compileProperties(schemaObj, jsonSchema);
  const patternValidator = compilePatternProperties(schemaObj, jsonSchema);
  const additionalValidator = compileAdditionalProperties(schemaObj, jsonSchema);
  const depSchemasValidator = compileDependentSchemas(schemaObj, jsonSchema);
  const dependencyValidator = compileDependencies(schemaObj, jsonSchema);
  const depRequiredValidator = compileDependentRequired(schemaObj, jsonSchema);
  const unevaluatedValidator = compileUnevaluatedProperties(schemaObj, jsonSchema);

  if ((patternValidator
    || namesValidator
    || propertyValidator
    || depRequiredValidator
    || depSchemasValidator
    || dependencyValidator
    || additionalValidator
    || unevaluatedValidator) == null)
    return undefined;

  const validateName = namesValidator || trueThat;
  const validateProperty = propertyValidator || ValidationResult.undefThat;
  const validatePattern = patternValidator || ValidationResult.undefThat;

  const validateDepRequired = depRequiredValidator || trueThat;
  const validateDepSchemas = depSchemasValidator || trueThat;
  const validateDependency = dependencyValidator || trueThat;

  return function validateObjectProperty(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();

    result.addValid(validateName(dataKey))
      .addResult(validateProperty(data, dataPath, dataRoot, dataKey))
      .addResult(validatePattern(data, dataPath, dataRoot, dataKey))
      .addValid(validateDepRequired(data, dataPath, dataRoot, dataKey))
      .addValid(validateDepSchemas(data, dataPath, dataRoot, dataKey))
      .addValid(validateDependency(data, dataPath, dataRoot, dataKey));

    if (additionalValidator)
      return !result.match
        ? result.addMatch(additionalValidator(data, dataPath, dataRoot, dataKey))
        : result;

    if (unevaluatedValidator)
      // @ts-ignore
      result.addValid(unevaluatedValidator(data, dataPath, dataRoot, dataKey));

    return result;
  };
}

export function compileObjectChildren(schemaObj, jsonSchema) {
  const propertyValidator = compileObjectProperty(schemaObj, jsonSchema);
  if (propertyValidator == null)
    return undefined;

  return function validateObjectChildren(data, dataPath, dataRoot, dataKeys) {
    const result = new ValidationResult();
    for (let i = 0; i < dataKeys.length; ++i) {
      const dataKey = dataKeys[i];

      result.addResult(propertyValidator(data, dataPath, dataRoot, dataKey));
    }
    return result.isValid();
  };
}


export function compileObjectSchema(schemaObj, jsonSchema) {
  if (isOfSchemaType(jsonSchema, 'map'))
    return undefined;

  const objectPrimitives = compileObjectPrimitives(schemaObj, jsonSchema);
  const objectChildren = compileObjectChildren(schemaObj, jsonSchema);

  if ((objectPrimitives
    || objectChildren) == null)
    return undefined;

  const validatePrimitives = objectPrimitives || trueThat;
  const validateChildren = objectChildren || trueThat;

  return function validateObjectSchema(data, dataPath, dataRoot) {
    if (isObjectClass(data)) {
      const dataKeys = Object.keys(data);
      return validatePrimitives(data, dataPath, dataRoot, dataKeys)
        && validateChildren(data, dataPath, dataRoot, dataKeys);
    }
    return true;
  };
}
//#endregion
