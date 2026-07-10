//@ts-check

import {
  isArrayClass,
  getObjectType,
} from '@jarenjs/core';

import {
  isUniqueDeepArray,
} from '@jarenjs/core/object';

import {
  getBoolishType,
  getIntishType,
} from '@jarenjs/core/number';

import {
  trueThat,
  falseThat,
} from '@jarenjs/core/function';

import {
  getBoolOrObjectClass,
  getArrayClassMinItems,
  isOfSchemaType,
} from './tools.js';

//#region Primitives
function compileMinItems(schemaObj, jsonSchema) {
  const min = getIntishType(jsonSchema.minItems) || 0;
  if (min < 1) return undefined;

  const addError = schemaObj.createErrorHandler(min, 'minItems');
  return function validateMinItems(len = 0, dataPath = '') {
    return len >= min || addError(len, dataPath);
  };
}

function compileMaxItems(schemaObj, jsonSchema) {
  const max = getIntishType(jsonSchema.maxItems) || -1;
  if (max < 0) return undefined;
  const min = getIntishType(jsonSchema.minItems) || 0;
  if (max < min) throw new Error('maxItems must be greater then minItems');

  const addError = schemaObj.createErrorHandler(max, 'maxItems');
  return function validateMaxItems(len = 0, dataPath = '') {
    return len <= max || addError(len, dataPath);
  };
}

function createBooleanValidator(schemaObj, jsonSchema, key, validationFn) {
  const value = getBoolishType(jsonSchema[key]);
  if (value !== true) return undefined;

  const addError = schemaObj.createErrorHandler(value, key);

  return function validateBooleanComparator(data, dataPath) {
    return validationFn(data) || addError(data, dataPath);
  };
}

const compileUniqueItems = (schemaObj, jsonSchema) =>
  createBooleanValidator(schemaObj, jsonSchema, 'uniqueItems', isUniqueDeepArray);
//#endregion

//#region Tuple

function compileTupleInternal(schemaObj, jsonSchema, itemsKey, additionalKey) {
  const tuple = getArrayClassMinItems(jsonSchema[itemsKey], 1);
  if (tuple == null)
    return undefined;

  // Pre-compile all validators upfront
  const validators = new Array(tuple.length);
  for (let i = 0; i < tuple.length; i++) {
    validators[i] = compileItemValidator(schemaObj, tuple[i], itemsKey, i);
  }
  const vlength = validators.length;

  const additional = getBoolOrObjectClass(jsonSchema[additionalKey], true);
  if (typeof additional === 'boolean') {
    if (additional === true) {
      return function validateTupleBoolTrue(data, dataPath, dataRoot, i) {
        if (i >= vlength) return true;
        return validators[i](data, dataPath, dataRoot);
      };
    }
    // additional === false
    return function validateTupleBoolFalse(data, dataPath, dataRoot, i) {
      if (i >= vlength) return false;
      return validators[i](data, dataPath, dataRoot);
    };
  }

  // For object additional schema, compile validator once
  const validateAdditional = schemaObj.createValidator(additional, additionalKey);
  return function validateTupleSchema(data, dataPath, dataRoot, i) {
    if (i < vlength) {
      return validators[i](data, dataPath, dataRoot);
    }
    return validateAdditional(data, dataPath, dataRoot);
  };
}

function compilePrefixItems(schemaObj, jsonSchema) {
  return compileTupleInternal(schemaObj, jsonSchema, 'prefixItems', 'items');
}

function compileTupleItems(schemaObj, jsonSchema) {
  return compileTupleInternal(schemaObj, jsonSchema, 'items', 'additionalItems');
}

//#endregion

//#region Contains
function compileArrayContains(schemaObj, jsonSchema) {
  const contains = getObjectType(jsonSchema.contains);
  if (contains == null) return undefined;

  return schemaObj.createValidator(contains, 'contains');
}

function compileContainsMinMax(schemaObj, jsonSchema) {
  const contains = getObjectType(jsonSchema.contains);
  if (contains == null) return undefined;

  const minContains = getIntishType(jsonSchema.minContains);
  const maxContains = getIntishType(jsonSchema.maxContains);

  const addNonError = schemaObj.createErrorHandler(0, 'contains');
  const addMinError = schemaObj.createErrorHandler(minContains, 'minContains');
  const addMaxError = schemaObj.createErrorHandler(maxContains, 'maxContains');

  if (minContains == null && maxContains == null) {
    return function validateContainsAtLeastOne(count, dataPath) {
      return count > 0 || addNonError(count, dataPath);
    };
  }

  if (maxContains == null) {
    return function validateMinContains(count, dataPath) {
      return count >= (minContains || 0)
        || addMinError(count, dataPath);
    };
  }

  if (minContains == null) {
    return function validateMaxContains(count, dataPath) {
      return count === 0
        ? addNonError(count, dataPath)
        : count <= maxContains
          || addMaxError(count, dataPath);
    };
  }

  return function validateMinMaxContains(count, dataPath) {
    return (count >= minContains || addMinError(count, dataPath))
      && (count <= maxContains || addMaxError(count, dataPath));
  };
}

function compileArrayContainsBoolean(schemaObj, jsonSchema) {
  const contains = getBoolishType(jsonSchema.contains);
  if (contains === true) {
    const addError = schemaObj.createErrorHandler(true, 'contains');
    return function validateArrayContainsTrue(data, dataPath) {
      return data.length > 0
        || addError(data, dataPath);
    };
  }
  if (contains === false) {
    const addError = schemaObj.createErrorHandler(false, 'contains');
    return function validateArrayContainsFalse(data, dataPath) {
      return addError(data, dataPath);
    };
  }
  return undefined;
}
//#endregion

//#region Items
function compileArrayItemsBoolean(schemaObj, jsonSchema) {
  const items = getBoolishType(jsonSchema.items);
  if (items === true) return trueThat;
  if (items !== false) return undefined;

  const addError = schemaObj.createErrorHandler(false, 'items');
  return function validateArrayItemsFalse(data, dataPath) {
    return data.length === 0
      || addError(data, dataPath);
  };
}

function compileArrayItems(schemaObj, jsonSchema) {
  const items = getObjectType(jsonSchema.items);
  if (items == null) return undefined;

  return schemaObj.createValidator(items, 'items');
}

/**
 * Compile item schema directly without intermediate wrapper
 * This flattens the call stack by avoiding nested validator function calls
 * @param {Object} schemaObj - The schema object
 * @param {Object} itemSchema - Schema for individual items
 * @param {string} key - Key for error reporting
 * @param {number} index - Index for tuple items
 * @returns {Function} Direct validator function
 */
function compileItemValidator(schemaObj, itemSchema, key, index) {
  if (itemSchema === true) return trueThat;
  if (itemSchema === false) return falseThat;

  // For simple type schemas, use inline validation
  if (typeof itemSchema === 'object' && itemSchema !== null) {
    // Fast path: $ref-only schema - check property directly before calling Object.keys
    // This avoids the overhead of Object.keys for the most common case
    if (itemSchema.$ref !== undefined) {
      const keys = Object.keys(itemSchema);
      if (keys.length === 1) {
        // Use the root to resolve the ref directly to the target validator
        // This avoids the overhead of creating an intermediate ValidationObject
        const root = schemaObj.root;
        if (root && root.resolveObject) {
          try {
            const targetObj = root.resolveObject(itemSchema.$ref, schemaObj.path, itemSchema);
            if (targetObj && targetObj.validate) {
              return targetObj.validate;
            }
          } catch (e) {
            // Fall through to default handling
          }
        }
      }
    }

    // Fast path: type-only schema (most common case) - check property directly first
    if (itemSchema.type !== undefined && Object.keys(itemSchema).length === 1) {
      return compileTypeOnlyValidator(itemSchema.type);
    }

    // Fast path: required-only schema - check property directly first
    if (itemSchema.required !== undefined && Object.keys(itemSchema).length === 1) {
      const required = itemSchema.required;
      return function validateRequiredOnly(data, dataPath, dataRoot) {
        if (typeof data !== 'object' || data === null) return false;
        for (let i = 0; i < required.length; i++) {
          if (!(required[i] in data)) return false;
        }
        return true;
      };
    }
  }

  // Fall back to full schema compilation for complex cases
  return schemaObj.createValidator(itemSchema, key, index);
}

/**
 * Compile a validator for simple type-only schemas
 * @param {string} type - The type to validate
 * @returns {Function} Type validator function
 */
function compileTypeOnlyValidator(type) {
  switch (type) {
    case 'string':
      return function validateString(data) {
        return typeof data === 'string';
      };
    case 'number':
      return function validateNumber(data) {
        return typeof data === 'number' && !isNaN(data);
      };
    case 'integer':
      return function validateInteger(data) {
        return typeof data === 'number' && Number.isInteger(data);
      };
    case 'boolean':
      return function validateBoolean(data) {
        return typeof data === 'boolean';
      };
    case 'array':
      return function validateArray(data) {
        return Array.isArray(data);
      };
    case 'object':
      return function validateObject(data) {
        return typeof data === 'object' && data !== null && !Array.isArray(data);
      };
    case 'null':
      return function validateNull(data) {
        return data === null;
      };
    default:
      return trueThat;
  }
}
//#endregion

//#region Main
export function compileArrayPrimitives(schemaObj, jsonSchema) {
  // minItems/maxItems/uniqueItems belong to the validation vocabulary;
  // assert nothing when the metaschema disables it.
  if (schemaObj.options.vocabValidation === false)
    return undefined;

  const minItems = compileMinItems(schemaObj, jsonSchema);
  const maxItems = compileMaxItems(schemaObj, jsonSchema);
  const uniqueItems = compileUniqueItems(schemaObj, jsonSchema);

  if ((minItems
    || maxItems
    || uniqueItems) == null)
    return undefined;

  // Single-constraint schemas are the common case; skip the trueThat chain.
  if (minItems == null && maxItems == null)
    return uniqueItems;

  if (uniqueItems == null) {
    if (maxItems == null) {
      return function validateArrayMinItems(data, dataPath) {
        return minItems(data.length, dataPath);
      };
    }
    if (minItems == null) {
      return function validateArrayMaxItems(data, dataPath) {
        return maxItems(data.length, dataPath);
      };
    }
    return function validateArrayMinMaxItems(data, dataPath) {
      const len = data.length;
      return minItems(len, dataPath)
        && maxItems(len, dataPath);
    };
  }

  const isMinItems = minItems || trueThat;
  const isMaxItems = maxItems || trueThat;

  return function validateArrayPrimitives(data, dataPath) {
    const len = data.length;
    return isMinItems(len, dataPath)
      && isMaxItems(len, dataPath)
      && uniqueItems(data, dataPath);
  };
}

function compileArrayChildren(schemaObj, jsonSchema) {
  // Check for prefixItems (draft 2020-12+) first, then items.
  // A document that declares an older draft via $schema treats
  // prefixItems as an unknown keyword.
  const prefixItems = (schemaObj.declaredDraft != null && schemaObj.declaredDraft < 2020)
    ? undefined
    : getArrayClassMinItems(jsonSchema.prefixItems, 1);
  const items = jsonSchema.items;
  const isTuple = getArrayClassMinItems(items, 1) != null;

  const root = schemaObj.root;
  const track = root.usesUnevaluated;
  // In draft 2020-12 contains produces item annotations; in 2019-09 it doesn't.
  const trackContains = track && (schemaObj.options.draftVersion || 7) >= 2020;

  // Indexes below this limit count as evaluated (for unevaluatedItems) when
  // their item validation succeeds. Extra tuple items beyond the tuple length
  // pass validation when additionalItems/items is ABSENT, but are then not
  // evaluated and must remain visible to unevaluatedItems.
  let evalLimit = Infinity;
  if (track) {
    if (prefixItems != null) {
      if (items === undefined) evalLimit = prefixItems.length;
    } else if (isTuple) {
      if (jsonSchema.additionalItems === undefined) evalLimit = items.length;
    }
  }

  let validateItem;

  if (prefixItems != null) {
    // Draft 2020-12+ style prefixItems
    validateItem = compilePrefixItems(schemaObj, jsonSchema);
  } else if (isTuple) {
    // Draft 7 style tuple items
    validateItem = compileTupleItems(schemaObj, jsonSchema);
  } else if (items !== undefined) {
    // Single schema for all items
    const itemsSchema = getObjectType(items);
    if (itemsSchema != null) {
      // Use direct validator compilation for items
      validateItem = compileItemValidator(schemaObj, itemsSchema, 'items', undefined);

      // Wrap single-item validator with index loop
      const itemValidator = validateItem;
      validateItem = function validateSingleItemSchema(data, dataPath, dataRoot, i) {
        return itemValidator(data, dataPath, dataRoot);
      };
    } else if (items === false) {
      const addError = schemaObj.createErrorHandler(false, 'items');
      validateItem = function validateItemsFalse(data, dataPath, dataRoot, i) {
        return addError(data, dataPath);
      };
    } else if (items === true) {
      validateItem = trueThat;
    }
  }

  const validateContains = compileArrayContains(schemaObj, jsonSchema);
  if ((validateItem || validateContains) == null)
    return undefined;

  const validateMinMax = compileContainsMinMax(schemaObj, jsonSchema) || trueThat;

  const maxItems = getIntishType(jsonSchema.maxItems) || 0;

  const resolveLength = len => (maxItems > 0
    ? Math.min(maxItems, len)
    : len);

  // Fast path: items only, no contains
  if (validateContains == null && validateItem != null) {
    // if validateItem is trueThat, just check length
    if (validateItem === trueThat) {
      // items: true evaluates every item, which matters when annotations
      // are tracked for unevaluatedItems.
      if (track) {
        return function validateArrayItemsTrue(data, dataPath, dataRoot) {
          root.evalLog.add(data, -1);
          return true;
        };
      }
      return undefined; // No actual validation needed
    }

    const addError = schemaObj.createErrorHandler(0, 'items');
    const validator = validateItem;

    return function validateArrayItemsOnly(data, dataPath, dataRoot) {
      const len = resolveLength(data.length);
      const arr = data;

      let invalid = 0;
      for (let i = 0; i < len; ++i) {
        // Direct validator call, no intermediate wrappers
        if (validator(arr[i], dataPath, dataRoot, i) !== true) {
          invalid++;
        }
        else if (track && i < evalLimit) {
          root.evalLog.add(data, i);
        }
      }
      return invalid === 0
        || addError(invalid, dataPath);
    };
  }

  // Fast path: contains only, no items
  if (validateItem == null && validateContains != null) {
    const validator = validateContains;

    return function validateArrayContainsOnly(data, dataPath) {
      const len = resolveLength(data.length);
      const arr = data;

      let contains = 0;
      for (let i = 0; i < len; ++i) {
        if (validator(arr[i], dataPath) === true) {
          contains++;
          if (trackContains) root.evalLog.add(data, i);
        }
      }
      return validateMinMax(contains, dataPath);
    };
  }

  // Combined: both items and contains
  const itemValidator = validateItem;
  const containsValidator = validateContains;

  return function validateArrayChildren(data, dataPath, dataRoot) {
    const len = resolveLength(data.length);
    const arr = data;

    let invalid = 0;
    let contains = 0;
    for (let i = 0; i < len; ++i) {
      const obj = arr[i];
      // Direct validator calls without intermediate wrappers
      if (itemValidator(obj, dataPath, dataRoot, i) !== true) {
        invalid++;
      }
      else if (track && i < evalLimit) {
        root.evalLog.add(data, i);
      }
      if (containsValidator(obj, dataPath, dataRoot) === true) {
        contains++;
        if (trackContains) root.evalLog.add(data, i);
      }
    }
    return invalid === 0
      && validateMinMax(contains, dataPath);
  };
}

export function compileArraySchema(schemaObj, jsonSchema) {
  if (isOfSchemaType(jsonSchema, 'set'))
    return undefined;

  const compiledPrimitives = compileArrayPrimitives(schemaObj, jsonSchema);
  const compiledItemsBoolean = compileArrayItemsBoolean(schemaObj, jsonSchema);
  const compiledContainsBoolean = compileArrayContainsBoolean(schemaObj, jsonSchema);
  const compiledArrayChildren = compileArrayChildren(schemaObj, jsonSchema);

  if ((compiledPrimitives
    || compiledItemsBoolean
    || compiledContainsBoolean
    || compiledArrayChildren) === undefined)
    return undefined;

  // Single-validator schemas are the common case; skip the trueThat chain.
  const parts = [];
  if (compiledPrimitives) parts.push(compiledPrimitives);
  if (compiledItemsBoolean && compiledItemsBoolean !== trueThat) parts.push(compiledItemsBoolean);
  if (compiledContainsBoolean) parts.push(compiledContainsBoolean);
  if (compiledArrayChildren) parts.push(compiledArrayChildren);

  if (parts.length === 0)
    return undefined;

  if (parts.length === 1) {
    const single = parts[0];
    return function validateArraySchemaSingle(data, dataPath, dataRoot) {
      return isArrayClass(data)
        ? single(data, dataPath, dataRoot)
        : true;
    };
  }

  if (parts.length === 2) {
    const first = parts[0];
    const second = parts[1];
    return function validateArraySchemaDouble(data, dataPath, dataRoot) {
      if (isArrayClass(data)) {
        return first(data, dataPath, dataRoot)
          && second(data, dataPath, dataRoot);
      }
      return true;
    };
  }

  const validatePrimitives = compiledPrimitives || trueThat;
  const hasBooleanItems = compiledItemsBoolean || trueThat;
  const hasBooleanContains = compiledContainsBoolean || trueThat;
  const validateItems = compiledArrayChildren || trueThat;

  return function validateArraySchema(data, dataPath, dataRoot) {
    if (isArrayClass(data)) {
      return validatePrimitives(data, dataPath)
        && hasBooleanItems(data, dataPath, dataRoot)
        && hasBooleanContains(data, dataPath, dataRoot)
        && validateItems(data, dataPath, dataRoot);
    }
    return true;
  };
}
//#endregion
