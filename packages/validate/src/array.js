//@ts-check

import {
  isArrayClass,
  getObjectType,
} from '@jaren/core';

import {
  getBoolishType,
  getIntishType,
} from '@jaren/core/number';

import {
  trueThat,
  falseThat,
} from '@jaren/core/function';

import {
  isUniqueArray,
} from '@jaren/core/array';

import {
  getBoolOrObjectClass,
  getArrayClassMinItems,
  isOfSchemaType,
} from './tools.js';

//#region Primitives
function createNumericValidator(schemaObj, jsonSchema, key, defaultValue, comparator) {
  const value = getIntishType(jsonSchema[key]) ?? defaultValue;
  if (value === defaultValue) return undefined;

  const addError = schemaObj.createErrorHandler(value, key);

  return function validateNumericComparator(len = 0, dataPath) {
    return comparator(len, value) || addError(len, dataPath);
  };
}

const compileMinItems = (schemaObj, jsonSchema) =>
  createNumericValidator(schemaObj, jsonSchema, 'minItems', 0, (len, min) => len >= min);

const compileMaxItems = (schemaObj, jsonSchema) =>
  createNumericValidator(schemaObj, jsonSchema, 'maxItems', -1, (len, max) => len <= max);

function createBooleanValidator(schemaObj, jsonSchema, key, validationFn) {
  const value = getBoolishType(jsonSchema[key]);
  if (value !== true) return undefined;

  const addError = schemaObj.createErrorHandler(value, key);

  return function validateBooleanComparator(data, dataPath) {
    return validationFn(data) || addError(data, dataPath);
  };
}

const compileUniqueItems = (schemaObj, jsonSchema) =>
  createBooleanValidator(schemaObj, jsonSchema, 'uniqueItems', isUniqueArray);
//#endregion

//#region Tuple

function compileTupleInternal(schemaObj, jsonSchema, itemsKey, additionalKey) {
  const tuple = getArrayClassMinItems(jsonSchema[itemsKey], 1);
  if (tuple == null)
    return undefined;

  const validators = tuple.map((item, i) => {
    if (item === true) return trueThat;
    if (item === false) return falseThat;
    return schemaObj.createValidator(item, itemsKey, i);
  });
  const vlength = validators.length;

  const additional = getBoolOrObjectClass(jsonSchema[additionalKey], true);
  if (typeof additional === 'boolean') {
    return function validateTupleBool(data, dataPath, dataRoot, i) {
      return i >= vlength
        ? additional
        : validators[i](data, dataPath, dataRoot);
    };
  }

  const validateAdditional = schemaObj.createValidator(additional, additionalKey);
  return function validateTupleSchema(data, dataPath, dataRoot, i) {
    return i < vlength
      ? validators[i](data, dataPath, dataRoot)
      : validateAdditional(data, dataPath, dataRoot);
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

function compileUnevaluatedItems(schemaObj, jsonSchema) {
  const unevaluatedItems = getObjectType(jsonSchema.unevaluatedItems);
  if (unevaluatedItems == null) return undefined;

  return schemaObj.createValidator(unevaluatedItems, 'unevaluatedItems');
}
//#endregion

//#region Main
export function compileArrayPrimitives(schemaObj, jsonSchema) {
  const minItems = compileMinItems(schemaObj, jsonSchema);
  const maxItems = compileMaxItems(schemaObj, jsonSchema);
  const uniqueItems = compileUniqueItems(schemaObj, jsonSchema);

  if ((minItems
    || maxItems
    || uniqueItems) == null)
    return undefined;

  const isMinItems = minItems || trueThat;
  const isMaxItems = maxItems || trueThat;
  const isUniqueItems = uniqueItems || trueThat;

  return function validateArrayPrimitives(data, dataPath) {
    const len = data.length;
    return isMinItems(len, dataPath)
      && isMaxItems(len, dataPath)
      && isUniqueItems(data, dataPath);
  };
}

function compileArrayChildren(schemaObj, jsonSchema) {
  const validateItem = compilePrefixItems(schemaObj, jsonSchema)
    || compileTupleItems(schemaObj, jsonSchema)
    || compileArrayItems(schemaObj, jsonSchema);

  const validateContains = compileArrayContains(schemaObj, jsonSchema);
  if ((validateItem || validateContains) == null)
    return undefined;

  const validateMinMax = compileContainsMinMax(schemaObj, jsonSchema) || trueThat;

  const maxItems = getIntishType(jsonSchema.maxItems) || 0;

  const resolveLength = len => (maxItems > 0
    ? Math.min(maxItems, len)
    : len);

  if (validateContains == null) {
    const addError = schemaObj.createErrorHandler(0, 'items');

    return function validateArrayItemsOnly(data, dataPath, dataRoot) {
      const len = resolveLength(data.length);

      let invalid = 0;
      for (let i = 0; i < len; ++i) {
        const obj = data[i];
        if (validateItem(obj, dataPath, dataRoot, i) === false) {
          invalid++;
        }
      }
      return invalid === 0
        || addError(invalid, dataPath);
    };
  }

  if (validateItem == null) {
    return function validateArrayContainsOnly(data, dataPath) {
      const len = resolveLength(data.length);

      let contains = 0;
      for (let i = 0; i < len; ++i) {
        const obj = data[i];
        if (validateContains(obj, dataPath) === true) {
          contains++;
        }
      }
      return validateMinMax(contains, dataPath);
    };
  }

  return function validateArrayChildren(data, dataPath, dataRoot) {
    const len = resolveLength(data.length);

    let invalid = 0;
    let contains = 0;
    for (let i = 0; i < len; ++i) {
      const obj = data[i];
      if (validateItem(obj, dataPath, dataRoot, i) !== true) {
        invalid++;
      }
      if (validateContains(obj, dataPath, dataRoot) === true) {
        contains++;
      }
    }
    return invalid === 0
      && validateMinMax(contains, dataPath);
  };
}

export function compileArraySchema(schemaObj, jsonSchema) {
  if (isOfSchemaType(jsonSchema, 'set'))
    return undefined;

  const arrayPrimitives = compileArrayPrimitives(schemaObj, jsonSchema);

  const itemsBoolean = compileArrayItemsBoolean(schemaObj, jsonSchema);
  const containsBoolean = compileArrayContainsBoolean(schemaObj, jsonSchema);
  const arrayChildren = compileArrayChildren(schemaObj, jsonSchema);

  if ((arrayPrimitives
    || itemsBoolean
    || containsBoolean
    || arrayChildren) === undefined)
    return undefined;

  const validatePrimitives = arrayPrimitives || trueThat;
  const hasBooleanItems = itemsBoolean || trueThat;
  const hasBooleanContains = containsBoolean || trueThat;
  const validateItems = arrayChildren || trueThat;

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
