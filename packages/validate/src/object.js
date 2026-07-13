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

function buildPropertyValidators(schemaObj, jsonSchema) {
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

  return validators;
}

function compileProperties(schemaObj, jsonSchema) {
  const validators = buildPropertyValidators(schemaObj, jsonSchema);
  if (validators == null) return undefined;

  const root = schemaObj.root;
  const track = root.usesUnevaluated;

  return function validatePropertyItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    const validator = validators.get(dataKey);
    if (validator == null)
      return result;
    else {
      const valid = validator(data[dataKey], dataPath, dataRoot, dataKey);
      if (track && valid === true) root.evalLog.add(data, dataKey);
      return result.addMatch(valid);
    }
  };
}

function buildPatternValidators(schemaObj, jsonSchema) {
  const entries = getObjectType(jsonSchema.patternProperties);
  if (entries == null) return undefined;

  // Use Object.getOwnPropertyNames to handle __proto__ correctly
  const entryKeys = Object.getOwnPropertyNames(entries);
  if (entryKeys.length === 0) return undefined;

  const list = [];
  for (let i = 0; i < entryKeys.length; ++i) {
    const key = entryKeys[i];
    const pattern = createRegExp(key);
    if (pattern == null) continue;

    const validator = schemaObj.createValidator(entries[key], 'patternProperties', key);
    if (validator != null)
      list.push({ pattern, validator });
  }

  if (list.length === 0) return undefined;

  return list;
}

function compilePatternProperties(schemaObj, jsonSchema) {
  const list = buildPatternValidators(schemaObj, jsonSchema);
  if (list == null) return undefined;

  const root = schemaObj.root;
  const track = root.usesUnevaluated;

  return function validatePatternPropertiesItem(data, dataPath, dataRoot, dataKey) {
    const result = new ValidationResult();
    for (let i = 0; i < list.length; ++i) {
      const { pattern, validator } = list[i];
      if (pattern.test(dataKey)) {
        const valid = validator(data[dataKey], dataPath, dataRoot, dataKey);
        if (track && valid === true) root.evalLog.add(data, dataKey);
        result.addMatch(valid);
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

  const root = schemaObj.root;
  const track = root.usesUnevaluated;
  const validator = schemaObj.createValidator(additional, 'additionalProperties');

  return function validateAdditionalPropertyItem(data, dataPath, dataRoot, dataKey) {
    const valid = validator(data[dataKey], dataPath, dataRoot, dataKey);
    if (track && valid === true) root.evalLog.add(data, dataKey);
    return valid;
  };
}
//#endregion

//#region Dependencies
function compileDependentRequired(schemaObj, jsonSchema) {
  // TODO: before we go to release remove this check, since it doesn't help anyone.
  // dependentRequired only exists since draft 2019-09; a document that
  // declares an older draft via $schema treats it as an unknown keyword.
  if (schemaObj.declaredDraft != null && schemaObj.declaredDraft < 2019)
    return undefined;

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
  // TODO: before we go to release remove this check, since it doesn't help anyone.
  // dependentSchemas only exists since draft 2019-09; a document that
  // declares an older draft via $schema treats it as an unknown keyword.
  if (schemaObj.declaredDraft != null && schemaObj.declaredDraft < 2019)
    return undefined;

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

  // Collect dependency entries into arrays for faster access
  const depKeys = Object.keys(dependencies);
  if (depKeys.length === 0)
    return undefined;

  // Separate schema dependencies from required dependencies for optimization
  const schemaDeps = [];
  const requiredDeps = [];

  for (let i = 0; i < depKeys.length; i++) {
    const key = depKeys[i];
    const right = dependencies[key];
    if (isBoolOrObjectClass(right)) {
      const validator = schemaObj.createValidator(right, 'dependencies', key);
      if (validator != null)
        schemaDeps.push({ key, validator });
      else if (!schemaObj.options.skipErrors)
        throw new Error(`Expected Validator at '${schemaObj.path}/${key}'`);
    }
    else if (isArrayClass(right)) {
      const addError = schemaObj.createErrorHandler(right, ['dependencies', key]);
      requiredDeps.push({ key, required: right, addError });
    }
    else if (!schemaObj.options.skipErrors)
      throw new Error(`Expected Schema or Array at '${schemaObj.path}/${key}'`);
  }

  if (schemaDeps.length === 0 && requiredDeps.length === 0)
    return undefined;

  // Single schema dependency - most common case
  if (schemaDeps.length === 1 && requiredDeps.length === 0) {
    const { key, validator } = schemaDeps[0];
    return function validateSingleSchemaDep(data, dataPath, dataRoot, dataKey) {
      if (dataKey === key) {
        return validator(data, dataPath, dataRoot, dataKey);
      }
      return true;
    };
  }

  // Single required dependency - common case
  if (requiredDeps.length === 1 && schemaDeps.length === 0) {
    const { key, required, addError } = requiredDeps[0];
    const rlen = required.length;
    return function validateSingleRequiredDep(data, dataPath, dataRoot, dataKey) {
      if (dataKey === key) {
        const dataKeys = Object.keys(data);
        for (let i = 0; i < rlen; i++) {
          if (!dataKeys.includes(required[i])) {
            return addError(data, dataKey, dataPath);
          }
        }
      }
      return true;
    };
  }

  // Multiple dependencies - generic case
  // Create lookup maps for faster access
  const schemaDepMap = new Map();
  for (let i = 0; i < schemaDeps.length; i++) {
    schemaDepMap.set(schemaDeps[i].key, schemaDeps[i].validator);
  }
  const requiredDepMap = new Map();
  for (let i = 0; i < requiredDeps.length; i++) {
    requiredDepMap.set(requiredDeps[i].key, requiredDeps[i]);
  }

  return function validateDependenciesItem(data, dataPath, dataRoot, dataKey) {
    // Check schema dependencies first
    const schemaValidator = schemaDepMap.get(dataKey);
    if (schemaValidator != null) {
      return schemaValidator(data, dataPath, dataRoot, dataKey);
    }
    // Check required dependencies
    const reqDep = requiredDepMap.get(dataKey);
    if (reqDep != null) {
      const { required, addError } = reqDep;
      return includesAll(Object.keys(data), required)
        || addError(data, dataKey, dataPath);
    }
    return true;
  };
}
//#endregion

//#region Main
export function compileObjectPrimitives(schemaObj, jsonSchema) {
  // TODO: figure out if we need such a check for real!
  // minProperties/maxProperties/required belong to the validation
  // vocabulary; assert nothing when the metaschema disables it.
  if (schemaObj.options.vocabValidation === false)
    return undefined;

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

  if ((patternValidator
    || namesValidator
    || propertyValidator
    || depRequiredValidator
    || depSchemasValidator
    || dependencyValidator
    || additionalValidator) == null)
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

    return result;
  };
}

/**
 * Fused per-key validation loop for the default skipErrors mode.
 * Avoids the per-key ValidationResult allocations and eagerly built child
 * paths of the generic path; returns on the first failing property.
 * Child paths are still built (lazily) because $data validators resolve
 * relative JSON pointers against them at validation time.
 */
function compileObjectChildrenFast(schemaObj, jsonSchema) {
  const namesValidator = compilePropertyNames(schemaObj, jsonSchema);
  const propsMap = buildPropertyValidators(schemaObj, jsonSchema) || null;
  const patternList = buildPatternValidators(schemaObj, jsonSchema) || null;
  const depSchemasValidator = compileDependentSchemas(schemaObj, jsonSchema) || null;
  const dependencyValidator = compileDependencies(schemaObj, jsonSchema) || null;
  const depRequiredValidator = compileDependentRequired(schemaObj, jsonSchema) || null;

  const root = schemaObj.root;
  const track = root.usesUnevaluated;

  const additional = getBoolOrObjectClass(jsonSchema.additionalProperties);
  const additionalFalse = additional === false;
  const additionalValidator = (additional != null && additional !== false && additional !== true)
    ? schemaObj.createValidator(additional, 'additionalProperties')
    : null;
  // additionalProperties: true evaluates every leftover property, which
  // matters when annotations are tracked for unevaluatedProperties.
  const additionalTrue = additional === true && track;
  const hasAdditional = additionalFalse || additionalTrue || additionalValidator != null;

  if (namesValidator == null
    && propsMap == null
    && patternList == null
    && depSchemasValidator == null
    && dependencyValidator == null
    && depRequiredValidator == null
    && !hasAdditional)
    return undefined;

  const validateName = namesValidator || null;

  // Child paths are only consumed by $data relative-pointer resolution
  // in skipErrors mode; skip the per-property string concat otherwise.
  const extendPaths = root.usesDollarData;

  return function validateObjectChildrenFast(data, dataPath, dataRoot, dataKeys) {
    const len = dataKeys.length;
    for (let i = 0; i < len; ++i) {
      const dataKey = dataKeys[i];
      if (validateName != null && validateName(dataKey) === false)
        return false;

      let matched = false;
      let childPath = null;

      if (propsMap != null) {
        const propValidator = propsMap.get(dataKey);
        if (propValidator != null) {
          matched = true;
          childPath = extendPaths ? dataPath + '/' + dataKey : dataPath;
          if (propValidator(data[dataKey], childPath, dataRoot, dataKey) === false)
            return false;
          if (track) root.evalLog.add(data, dataKey);
        }
      }

      if (patternList != null) {
        for (let j = 0; j < patternList.length; ++j) {
          const entry = patternList[j];
          if (entry.pattern.test(dataKey)) {
            matched = true;
            if (childPath === null) childPath = extendPaths ? dataPath + '/' + dataKey : dataPath;
            if (entry.validator(data[dataKey], childPath, dataRoot, dataKey) === false)
              return false;
            if (track) root.evalLog.add(data, dataKey);
          }
        }
      }

      if (matched === false && hasAdditional) {
        if (additionalFalse)
          return false;
        if (additionalValidator != null) {
          if (childPath === null) childPath = extendPaths ? dataPath + '/' + dataKey : dataPath;
          if (additionalValidator(data[dataKey], childPath, dataRoot, dataKey) === false)
            return false;
        }
        if (track) root.evalLog.add(data, dataKey);
      }

      if (depRequiredValidator != null || depSchemasValidator != null || dependencyValidator != null) {
        if (childPath === null) childPath = extendPaths ? dataPath + '/' + dataKey : dataPath;
        if (depRequiredValidator != null && depRequiredValidator(data, childPath, dataRoot, dataKey) === false)
          return false;
        if (depSchemasValidator != null && depSchemasValidator(data, childPath, dataRoot, dataKey) === false)
          return false;
        if (dependencyValidator != null && dependencyValidator(data, childPath, dataRoot, dataKey) === false)
          return false;
      }
    }
    return true;
  };
}

export function compileObjectChildren(schemaObj, jsonSchema) {
  // Fast path: when errors are skipped (default) we can bail on the first
  // failure and avoid per-key result bookkeeping entirely.
  // (unevaluatedProperties runs separately as a final-stage validator,
  // see unevaluated.js)
  if (schemaObj.options.skipErrors)
    return compileObjectChildrenFast(schemaObj, jsonSchema);

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

  // Fast path: properties-only schema in skipErrors mode. Iterate the
  // (fixed) schema keys with direct property access instead of allocating
  // Object.keys(data) and doing a map lookup per data key.
  if (schemaObj.options.skipErrors
    && jsonSchema.patternProperties == null
    && jsonSchema.additionalProperties == null
    && jsonSchema.propertyNames == null
    && jsonSchema.dependencies == null
    && jsonSchema.dependentSchemas == null
    && jsonSchema.dependentRequired == null
    && jsonSchema.minProperties == null
    && jsonSchema.maxProperties == null
    && jsonSchema.required == null
    && getObjectType(jsonSchema.properties) != null) {
    const propsMap = buildPropertyValidators(schemaObj, jsonSchema);
    if (propsMap == null)
      return undefined;

    const propKeys = Array.from(propsMap.keys());
    const propValidators = Array.from(propsMap.values());
    const propCount = propKeys.length;

    const root = schemaObj.root;
    const track = root.usesUnevaluated;

    // Child paths are only consumed by $data relative-pointer resolution
    // in skipErrors mode; skip the per-property string concat otherwise.
    if (root.usesDollarData || track) {
      const extendPaths = root.usesDollarData;
      return function validateObjectPropertiesOnlyTracked(data, dataPath, dataRoot) {
        if (!isObjectType(data)) return true;
        for (let i = 0; i < propCount; ++i) {
          const key = propKeys[i];
          // Object.hasOwn: avoid picking up inherited members like toString
          if (Object.hasOwn(data, key)) {
            const childPath = extendPaths ? dataPath + '/' + key : dataPath;
            if (propValidators[i](data[key], childPath, dataRoot, key) === false)
              return false;
            if (track) root.evalLog.add(data, key);
          }
        }
        return true;
      };
    }

    return function validateObjectPropertiesOnly(data, dataPath, dataRoot) {
      if (!isObjectType(data)) return true;
      for (let i = 0; i < propCount; ++i) {
        const key = propKeys[i];
        // Object.hasOwn: avoid picking up inherited members like toString
        if (Object.hasOwn(data, key)
          && propValidators[i](data[key], dataPath, dataRoot, key) === false)
          return false;
      }
      return true;
    };
  }

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
