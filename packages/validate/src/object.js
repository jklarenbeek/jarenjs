//@ts-check

import {
  // isObjectClass, // to specific
  isObjectType, // slowerc
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
  const max = getIntishType(jsonSchema.maxProperties);
  if (max == null || max < 0) return undefined;
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
  /** @type {function(string, any, string):boolean} */
  // Use array key to get keyed error handler: addKeyedError(dataKey, data, ...meta)
  const addError = schemaObj.createErrorHandler(required, ['required']);
  return function validateRequiredProperties(data = {}, dataKeys = [], dataPath = '') {
    if (!(dataKeys.length > 0))
      return false;

    let valid = true;
    for (let i = 0; i < rlength; ++i) {
      const key = required[i];
      const idx = dataKeys.indexOf(key);
      if (idx === -1)
        valid &&= addError(key, data, dataPath);
    }
    return valid;
  };
}
//#endregion

//#region Constraints
function compilePropertyNames(schemaObj, jsonSchema) {
  const propNames = getBoolOrObjectClass(jsonSchema.propertyNames);
  if (propNames == null) return undefined;

  const propertyNamesValidator = schemaObj.createValidator(propNames, 'propertyNames');
  return function validatePropertyNames(dataKey) {
    return propertyNamesValidator(dataKey);
  }
}

function compileProperties(schemaObj, jsonSchema) {
  const properties = getObjectType(jsonSchema.properties);
  if (properties == null) return undefined;

  // Use Object.getOwnPropertyNames to handle __proto__ correctly
  // Object.keys() doesn't return __proto__ when defined via { __proto__: value }
  const keys = Object.getOwnPropertyNames(properties);
  if (keys.length === 0) return undefined;

  const validators = new Map();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const schemas = properties[key];
    const validator = schemaObj.createValidator(schemas, 'properties', key);
    if (validator != null)
      validators.set(key, validator);
  }
  if (validators.size === 0)
    return undefined;

  return function validatePropertyItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    const validator = validators.get(dataKey);
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

  // Use Object.getOwnPropertyNames to handle __proto__ correctly
  const entryKeys = Object.getOwnPropertyNames(entries);
  if (entryKeys.length === 0) return undefined;

  const patterns = new Map();
  for (let i = 0; i < entryKeys.length; ++i) {
    const key = entryKeys[i];
    const pattern = createRegExp(key);
    if (pattern != null)
      patterns.set(key, pattern);
  }

  if (patterns.size === 0) return undefined;

  const validators = new Map();
  for (const [key] of patterns) {
    const schema = entries[key];
    const validator = schemaObj.createValidator(schema, 'patternProperties', key);
    if (validator != null)
      validators.set(key, validator);
  }

  if (validators.size === 0) return undefined;

  return function validatePatternPropertiesItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    for (const [key, validate] of validators) {
      const pattern = patterns.get(key);
      if (pattern.test(dataKey)) {
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
    const addError = schemaObj.createErrorHandler(false, ['additionalProperties']);

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

  const validators = new Map();
  for (const key in dependentSchemas) {
    if (Object.prototype.hasOwnProperty.call(dependentSchemas, key)) {
      const schema = dependentSchemas[key];
      if (!isBoolOrObjectClass(schema) && !schemaObj.options.skipErrors)
        throw new Error(`Expected Schema at '${schemaObj.path}/${key}'`);

      const validator = schemaObj.createValidator(schema, 'dependentSchemas', key);
      if (validator != null)
        validators.set(key, validator);
      else
        throw new Error(`Expected Validator at '${schemaObj.path}/${key}'`);
    }
  }

  if (validators.size === 0)
    return undefined;

  return function validateDependentSchemasItem(data, dataPath, dataRoot, dataKey) {
    if (validators.has(dataKey)) {
      const validator = validators.get(dataKey);
      return validator(data, dataPath, dataRoot, dataKey);
    }
    return true;
  };
}

function compileDependencies(schemaObj, jsonSchema) {
  const dependencies = getObjectType(jsonSchema.dependencies);
  if (dependencies == null)
    return undefined;

  const validators = new Map();
  for (const key in dependencies) {
    if (Object.prototype.hasOwnProperty.call(dependencies, key)) {
      const right = dependencies[key];
      if (isBoolOrObjectClass(right)) {
        const validator = schemaObj.createValidator(right, 'dependencies', key);
        if (validator != null)
          validators.set(key, validator);
        else
          throw new Error(`Expected Validator at '${schemaObj.path}/${key}'`);
      }
      else if (isArrayClass(right)) {
        const addError = schemaObj.createErrorHandler(right, ['dependencies', key]);
        validators.set(key, function validateRequiredDependency(data, dataPath, dataRoot, dataKey) {
          return includesAll(Object.keys(data), right)
            || addError(data, dataKey, dataPath);
        });
      }
      else if (!schemaObj.options.skipErrors)
        throw new Error(`Expected Schema or Array at '${schemaObj.path}/${key}'`);
    }
  }

  if (validators.size === 0)
    return undefined;

  return function validateDependenciesItem(data, dataPath, dataRoot, dataKey) {
    if (validators.has(dataKey)) {
      const validator = validators.get(dataKey);
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

  // Inline the validation to reduce function call overhead
  const min = getIntishType(jsonSchema.minProperties) || 0;
  const max = getIntishType(jsonSchema.maxProperties);
  const required = getArrayClassMinItems(jsonSchema.required, 1);

  const hasMin = min > 0;
  const hasMax = max != null && max >= 0;
  const hasRequired = required != null && required.length > 0;

  // Pre-bind error handlers outside the returned function
  if (hasMin && !hasMax && !hasRequired) {
    const addError = schemaObj.createErrorHandler(min, 'minProperties');
    return function validateMinPropertiesOnly(data, dataPath, dataRoot, dataKeys) {
      const len = dataKeys ? dataKeys.length : Object.keys(data).length;
      return len >= min || addError(len, dataPath);
    };
  }

  if (!hasMin && hasMax && !hasRequired) {
    const addError = schemaObj.createErrorHandler(max, 'maxProperties');
    return function validateMaxPropertiesOnly(data, dataPath, dataRoot, dataKeys) {
      const len = dataKeys ? dataKeys.length : Object.keys(data).length;
      return len <= max || addError(len, dataPath);
    };
  }

  if (hasMin && hasMax && !hasRequired) {
    const addMinError = schemaObj.createErrorHandler(min, 'minProperties');
    const addMaxError = schemaObj.createErrorHandler(max, 'maxProperties');
    return function validateMinMaxProperties(data, dataPath, dataRoot, dataKeys) {
      const len = dataKeys ? dataKeys.length : Object.keys(data).length;
      return (len >= min || addMinError(len, dataPath))
          && (len <= max || addMaxError(len, dataPath));
    };
  }

  // Specialized paths for required properties
  if (!hasMin && !hasMax && hasRequired) {
    const rlength = required.length;
    const addError = schemaObj.createErrorHandler(required, ['required']);
    return function validateRequiredOnly(data, dataPath, dataRoot, dataKeys) {
      // Required properties only apply to objects, not arrays or other types
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return true;
      }
      const keys = dataKeys || Object.keys(data);
      let valid = true;
      for (let i = 0; i < rlength; ++i) {
        const key = required[i];
        if (keys.indexOf(key) === -1)
          valid &&= addError(key, data, dataPath);
      }
      return valid;
    };
  }

  if (hasMin && !hasMax && hasRequired) {
    const addMinError = schemaObj.createErrorHandler(min, 'minProperties');
    const rlength = required.length;
    const addReqError = schemaObj.createErrorHandler(required, ['required']);
    return function validateMinAndRequired(data, dataPath, dataRoot, dataKeys) {
      // Required/minProperties only apply to objects, not arrays or other types
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return true;
      }
      const keys = dataKeys || Object.keys(data);
      const len = keys.length;
      if (len < min && !addMinError(len, dataPath))
        return false;
      let valid = true;
      for (let i = 0; i < rlength; ++i) {
        const key = required[i];
        if (keys.indexOf(key) === -1)
          valid &&= addReqError(key, data, dataPath);
      }
      return valid;
    };
  }

  if (!hasMin && hasMax && hasRequired) {
    const addMaxError = schemaObj.createErrorHandler(max, 'maxProperties');
    const rlength = required.length;
    const addReqError = schemaObj.createErrorHandler(required, ['required']);
    return function validateMaxAndRequired(data, dataPath, dataRoot, dataKeys) {
      // Required/maxProperties only apply to objects, not arrays or other types
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return true;
      }
      const keys = dataKeys || Object.keys(data);
      const len = keys.length;
      if (len > max && !addMaxError(len, dataPath))
        return false;
      let valid = true;
      for (let i = 0; i < rlength; ++i) {
        const key = required[i];
        if (keys.indexOf(key) === -1)
          valid &&= addReqError(key, data, dataPath);
      }
      return valid;
    };
  }

  // Generic case with all checks
  const isMinProperties = minProperties || trueThat;
  const isMaxProperties = maxProperties || trueThat;
  const hasRequiredProperties = requiredProperties || trueThat;

  return function validateObjectPrimitives(data, dataPath, dataRoot, dataKeys) {
    const keys = dataKeys || Object.keys(data);
    const len = keys.length;
    return isMinProperties(len, dataPath)
      && isMaxProperties(len, dataPath)
      && hasRequiredProperties(data, keys, dataPath);
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
    // Build the child dataPath by appending the property key
    const newPath = dataPath ? `${dataPath}/${dataKey}` : `/${dataKey}`;

    result.addValid(validateName(dataKey))
      .addResult(validateProperty(data, newPath, dataRoot, dataKey))
      .addResult(validatePattern(data, newPath, dataRoot, dataKey))
      .addValid(validateDepRequired(data, newPath, dataRoot, dataKey))
      .addValid(validateDepSchemas(data, newPath, dataRoot, dataKey))
      .addValid(validateDependency(data, newPath, dataRoot, dataKey));

    if (additionalValidator)
      return !result.match
        ? result.addMatch(additionalValidator(data, newPath, dataRoot, dataKey))
        : result;

    if (unevaluatedValidator)
      // @ts-ignore
      result.addValid(unevaluatedValidator(data, newPath, dataRoot, dataKey));

    return result;
  };
}

export function compileObjectChildren(schemaObj, jsonSchema) {
  const propertyValidator = compileObjectProperty(schemaObj, jsonSchema);
  if (propertyValidator == null)
    return undefined;

  // Inline ValidationResult operations to reduce object allocations
  return function validateObjectChildren(data, dataPath, dataRoot, dataKeys) {
    let totalErrors = 0;
    const len = dataKeys.length;
    for (let i = 0; i < len; ++i) {
      const result = propertyValidator(data, dataPath, dataRoot, dataKeys[i]);
      if (result !== true) {
        // result can be false or a ValidationResult-like object
        if (result === false) {
          totalErrors++;
        } else {
          totalErrors += result.errors || 0;
        }
      }
    }
    return totalErrors === 0;
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
    if (isObjectType(data)) {
      const dataKeys = Object.keys(data);
      return validatePrimitives(data, dataPath, dataRoot, dataKeys)
        && validateChildren(data, dataPath, dataRoot, dataKeys);
    }
    return true;
  };
}
//#endregion
