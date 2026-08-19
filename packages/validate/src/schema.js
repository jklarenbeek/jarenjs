//@ts-check

import {
  isObjectType,
  getStringType,
  isObjectClass,
} from '@jarenjs/core';

import {
  getUniqueArray,
} from '@jarenjs/core/array';

import {
  getBoolishType,
} from '@jarenjs/core/number';

import {
  trueThat,
  addFunctionToArray,
} from '@jarenjs/core/function';

import {
  combineIndependent,
  createIsSchemaTypeHandler,
  hasSchemaRef,
  hasSchemaRecursiveRef,
  hasSchemaDynamicRef,
  hasRefSiblings,
} from './tools.js';

import {
  getStringLength,
} from '@jarenjs/core/string';

import { compileErrorMessageSpec } from './messages.js';
import { compileFormatBasic } from './format.js';
import { compileEnumBasic } from './enum.js';
import { compileNumberBasic } from './number.js';
import { compileBigIntBasic } from './bigint.js';
import { compileStringBasic } from './string.js';
import { compileContentSchema } from './content.js';
import { compileObjectSchema } from './object.js';
import { compileArraySchema } from './array.js';
import { compileCombineSchema } from './combine.js';
import { compileConditionSchema } from './condition.js';
import { compileDataSchema } from './data.js';
import { compileQuerySchema } from './query-keyword.js';
import { compileDollarDataSchema } from './dollar-data.js';
import { wrapUnevaluated } from './unevaluated.js';
import { createJsonPointer } from './traverse.js';

/**
 * Compile $recursiveRef (draft 2019-09) and $dynamicRef (draft 2020-12).
 * These keywords require runtime resolution based on dynamic scope.
 * 
 * $recursiveRef: References the nearest parent schema with $recursiveAnchor: true
 * $dynamicRef: References the nearest parent schema with matching $dynamicAnchor name
 * 
 * @param {ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema
 * @returns {Function|undefined} The compiled validator function
 */
function compileDynamicRef(schemaObj, jsonSchema) {
  // Check for $recursiveRef (draft 2019-09)
  if (hasSchemaRecursiveRef(jsonSchema)) {
    return compileRecursiveRef(schemaObj, jsonSchema);
  }

  // Check for $dynamicRef (draft 2020-12)
  if (hasSchemaDynamicRef(jsonSchema)) {
    return compileDynamicAnchorRef(schemaObj, jsonSchema);
  }

  return undefined;
}

/**
 * Compile $recursiveRef which references the outermost $recursiveAnchor: true.
 * 
 * Per JSON Schema 2019-09 spec:
 * 1. The initial target is determined by resolving the reference as a URI reference
 *    against the current base URI (like $ref)
 * 2. If the initial target has $recursiveAnchor: true, look up the dynamic scope
 *    for the outermost $recursiveAnchor and use that schema instead
 * 3. Otherwise, use the initial target (like a normal $ref)
 * 
 * @param {ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing $recursiveRef
 * @returns {Function} The compiled validator function
 */
function compileRecursiveRef(schemaObj, jsonSchema) {
  const root = schemaObj.root;
  const ref = jsonSchema.$recursiveRef;
  const addError = schemaObj.createErrorHandler(ref, '$recursiveRef');

  // $recursiveRef only supports "#" (the current document root)
  if (ref !== '#') {
    // For non-# refs, fall back to normal $ref behavior
    return undefined;
  }

  // Get the base URI for resolving the reference
  // This is the effective base URI of the schema containing $recursiveRef
  // (accounts for $id of containing schemas)
  const baseUri = schemaObj.baseUri;
  
  // Resolve the reference to find the initial target URI
  // For "#", this resolves against the baseUri
  const { id: initialTargetUri } = createJsonPointer(ref, baseUri);
  
  // Look up the initial target schema by its URI
  // We do a direct lookup in the schemas map to avoid triggering compilation
  // The initialTargetUri might have a trailing '#' which we need to handle
  let initialTargetSchema = root.getSchemaByUri(initialTargetUri);
  if (!initialTargetSchema && initialTargetUri.endsWith('#')) {
    initialTargetSchema = root.getSchemaByUri(initialTargetUri.slice(0, -1));
  }
  
  // Check if the initial target has $recursiveAnchor: true
  // If it does, we need to use the dynamic scope; otherwise, treat like normal $ref
  const useDynamicScope = isObjectClass(initialTargetSchema) && initialTargetSchema.$recursiveAnchor === true;

  return function validateRecursiveRef(data, dataPath, dataRoot) {
    if (useDynamicScope) {
      // The initial target has $recursiveAnchor: true
      // Look up the dynamic scope for the outermost $recursiveAnchor
      const outermostValidator = root.getOutermostDynamicAnchorValidator('');
      
      if (outermostValidator) {
        // Found an outermost $recursiveAnchor - use that validator
        return outermostValidator(data, dataPath, dataRoot);
      }
    }

    // Either no $recursiveAnchor on initial target, or no dynamic scope available
    // Fall back to normal resolution like $ref
    const targetObj = root.resolveObject(initialTargetUri, baseUri, jsonSchema);
    if (targetObj) {
      return targetObj.validate(data, dataPath, dataRoot);
    }

    return addError(data, dataPath);
  };
}

/**
 * Compile $dynamicRef which references the nearest matching $dynamicAnchor.
 * 
 * Per JSON Schema 2020-12 spec:
 * 1. The initial target is determined by resolving the reference as a URI reference
 *    against the current base URI (like $ref)
 * 2. If the initial target has $dynamicAnchor with matching name, look up the dynamic scope
 *    for the nearest $dynamicAnchor with that name and use that schema instead
 * 3. Otherwise, use the initial target (like a normal $ref)
 * 
 * @param {ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing $dynamicRef
 * @returns {Function} The compiled validator function
 */
function compileDynamicAnchorRef(schemaObj, jsonSchema) {
  const root = schemaObj.root;
  const ref = jsonSchema.$dynamicRef;
  const addError = schemaObj.createErrorHandler(ref, '$dynamicRef');

  // A $dynamicRef whose fragment is a JSON POINTER (not a plain-name anchor)
  // behaves identically to $ref: no dynamic resolution takes place.
  if (ref.startsWith('#') && ref.charAt(1) === '/') {
    const baseUri = schemaObj.baseUri;
    const { id: resolvedRef } = createJsonPointer(ref, baseUri);
    return function validateDynamicRefPointer(data, dataPath, dataRoot) {
      let targetObj;
      try {
        targetObj = root.resolveObject(resolvedRef, baseUri, { $ref: resolvedRef });
      } catch (_e) {
        return addError(data, dataPath);
      }
      if (targetObj) {
        return targetObj.validate(data, dataPath, dataRoot);
      }
      return addError(data, dataPath);
    };
  }

  // $dynamicRef is typically a fragment reference like "#name"
  // For non-hash references, fall back to normal $ref behavior
  // BUT we must defer resolution to validation time to avoid infinite recursion
  // when the target schema also has $dynamicRef
  if (!ref.startsWith('#')) {
    // Non-fragment $dynamicRef - defer resolution to validation time
    const baseUri = schemaObj.baseUri;
    const resolvedPointer = createJsonPointer(ref, baseUri);
    const resolvedRef = resolvedPointer.id;
    
    // Look up the target schema at compile time
    let targetSchema = root.getSchemaByUri(resolvedRef);
    if (!targetSchema && resolvedRef.includes('#')) {
      // Try without fragment
      const [baseRef] = resolvedRef.split('#');
      targetSchema = root.getSchemaByUri(baseRef);
    }
    
    if (targetSchema) {
      // Return a validator that creates the target object at validation time
      // This avoids infinite recursion during compilation
      return function validateDynamicRefAsRef(data, dataPath, dataRoot) {
        let targetObj = root.unresolvedObject(resolvedRef);
        if (targetObj === null) {
          targetObj = root.createObject(resolvedRef, targetSchema, baseUri);
        }
        if (targetObj) {
          return targetObj.validate(data, dataPath, dataRoot);
        }
        return addError(data, dataPath);
      };
    }
    return addError;
  }

  const anchorName = ref.slice(1); // Remove the "#" prefix
  
  // Get the base URI for resolving the reference
  const baseUri = schemaObj.baseUri;
  
  // Resolve the reference to find the initial target URI
  const { id: initialTargetUri } = createJsonPointer(ref, baseUri);
  
  // Look up the initial target schema by its URI
  let initialTargetSchema = root.getSchemaByUri(initialTargetUri);
  if (!initialTargetSchema && initialTargetUri.endsWith('#')) {
    initialTargetSchema = root.getSchemaByUri(initialTargetUri.slice(0, -1));
  }
  
  // Check if the initial target has matching $dynamicAnchor
  // If it does, we need to use the dynamic scope; otherwise, treat like normal $ref
  const hasDynamicAnchor = isObjectClass(initialTargetSchema) && initialTargetSchema.$dynamicAnchor === anchorName;

  return function validateDynamicRef(data, dataPath, dataRoot) {
    if (hasDynamicAnchor) {
      // The initial target has matching $dynamicAnchor
      // Look up the dynamic scope for the nearest $dynamicAnchor with this name
      const dynamicValidator = root.getDynamicAnchorValidator(anchorName);
      
      if (dynamicValidator) {
        // Found a matching $dynamicAnchor in scope - use that validator
        return dynamicValidator(data, dataPath, dataRoot);
      }
      
      // No dynamic scope available - use the initial target directly
      // The initial target schema was already found at compile time (initialTargetSchema)
      // Check if already compiled, otherwise create the validation object
      let targetObj = root.unresolvedObject(initialTargetUri);
      if (targetObj === null) {
        // Not compiled yet - create it using the initial target schema we found at compile time
        targetObj = root.createObject(initialTargetUri, initialTargetSchema, baseUri);
      }
      if (targetObj) {
        const targetValidator = targetObj.validate;
        // Register this schema's dynamic anchor for the duration of the validation
        // This allows nested $dynamicRef to find this anchor
        root.pushDynamicAnchorValidator(anchorName, targetValidator);
        try {
          return targetValidator(data, dataPath, dataRoot);
        } finally {
          root.popDynamicAnchorValidator(anchorName);
        }
      }
    }

    // Either no $dynamicAnchor on initial target, or no dynamic scope available
    // Fall back to normal resolution like $ref
    // For this case, we look up the schema directly and create a validation object
    const targetSchema = initialTargetSchema || root.getSchemaByUri(initialTargetUri);
    if (targetSchema) {
      let targetObj = root.unresolvedObject(initialTargetUri);
      if (targetObj === null) {
        targetObj = root.createObject(initialTargetUri, targetSchema, baseUri);
      }
      if (targetObj) {
        return targetObj.validate(data, dataPath, dataRoot);
      }
    }

    return addError(data, dataPath);
  };
}

function compileRequired(schemaObj, jsonSchema) {
  // if required is not true, we have nothing.
  const required = getBoolishType(jsonSchema.required);
  if (required !== true) return undefined;

  const addError = schemaObj.createErrorHandler(required, 'required');

  // the compiled named function.
  return function validateRequiredType(data, dataPath) {
    return data === undefined
      ? addError(data, dataPath)
      : true;
  };
}

function compileTypeSimple(schemaObj, jsonSchema) {
  const type = getStringType(jsonSchema.type);
  if (type == null) return undefined;

  const isDataType = createIsSchemaTypeHandler(type);
  if (!isDataType) throw new Error(`The explicit schema type '${type}' is unknown. (TODO: add trace)`);

  const addError = schemaObj.createErrorHandler(type, 'type');

  return function validateTypeSimple(data, dataPath) {
    return isDataType(data)
      ? true
      : addError(data, dataPath);
  };
}

function compileTypeArray(schemaObj, jsonSchema) {
  const schemaTypes = getUniqueArray(jsonSchema.type);
  if (schemaTypes == null) return undefined;
  if (schemaTypes.length === 0)
    throw new Error('The schema type property can not be an empty array.');

  // collect all testable data types
  const types = [];
  const names = [];
  for (let i = 0; i < schemaTypes.length; ++i) {
    const type = schemaTypes[i];
    const callback = createIsSchemaTypeHandler(type);
    if (!callback)
      throw new Error(`The explicit schema type '${type}' of '${types} is unknown. (TODO: add trace)`);

    types.push(callback);
    names.push(type);
  }

  const addError = schemaObj.createErrorHandler(names, 'type');

  // if one has been found create a validator
  if (types.length === 1) {
    const one = types[0];
    return function validateSingleType(data, dataPath) {
      return one(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else if (types.length === 2) {
    const one = types[0];
    const two = types[1];
    return function validateDoubleTypes(data, dataPath) {
      return one(data) || two(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else if (types.length === 3) {
    const one = types[0];
    const two = types[1];
    const three = types[2];
    return function validateTripleTypes(data, dataPath) {
      return one(data) || two(data) || three(data)
        ? true
        : addError(data, dataPath);
    };
  }
  else {
    return function validateAllTypes(data, dataPath) {
      for (let i = 0; i < types.length; ++i) {
        if (types[i](data) === true) return true;
      }
      return addError(data, dataPath);
    };
  }
}

function compileTypeBasic(schemaObj, jsonSchema) {
  const validator = compileTypeSimple(schemaObj, jsonSchema)
    || compileTypeArray(schemaObj, jsonSchema);

  const nullable = getBoolishType(jsonSchema.nullable);
  if (validator == null) {
    if (nullable !== false) return undefined;

    const addError = schemaObj.createErrorHandler(nullable, 'nullable');

    return function validateNotIsNull(data, dataPath) {
      return data === undefined
        || data !== null
        || addError(data, dataPath);
    };
  }

  if (nullable === true) {
    return function validateNullableType(data, dataPath) {
      return data === undefined
        || data === null
        || validator(data, dataPath);
    };
  }

  return function validateType(data, dataPath) {
    return data === undefined
      || validator(data, dataPath);
  };
}

export function compileSchemaObject(schemaObj, jsonSchema) {
  if (jsonSchema === true) return trueThat;
  if (jsonSchema === false) {
    const addError = schemaObj.createErrorHandler(false, 'false schema');
    return function validateFalseSchema(data, dataPath) {
      return addError(data, dataPath);
    };
  }
  if (!isObjectType(jsonSchema))
    throw new Error('JSON Schema MUST be a boolean or Object Type');

  const keys = Object.keys(jsonSchema);

  // 'errorMessage' is report-time metadata: compile its spec once and
  // register it on the root - NO validator closure is emitted (the keyword
  // contributes zero validation-time work), and the key is excluded from
  // the single-keyword counts so it cannot knock a node off the fast
  // paths below.
  let keyCount = keys.length;
  if (jsonSchema.errorMessage !== undefined) {
    schemaObj.root.registerErrorMessage(
      schemaObj.path,
      compileErrorMessageSpec(jsonSchema.errorMessage, schemaObj.path));
    keyCount -= 1;
  }

  if (keys.length === 0)
    return trueThat;

  // In draft 7 and earlier, $ref completely replaces the schema
  // and all sibling keywords must be ignored. In draft 2019-09+,
  // $ref is just another keyword that can have siblings.
  // We need to check the actual behavior based on schema context.
  // If schema has ONLY $ref (and meta keywords), use the ref-only path.
  // If schema has $ref with validation siblings, process them together (2019-09+ only).
  // The resource's own declared draft decides $ref-sibling behavior; see the
  // note in ValidationObject.compileValidator.
  const draftVersion = schemaObj.declaredDraft ?? schemaObj.options.draftVersion ?? 7;
  // When compiling the sibling keywords of a $ref schema, the unevaluated*
  // wrapper is applied by ValidationObject.compileValidator around the
  // combined (ref + siblings) validator instead of here, so that the
  // $ref target's annotations are visible to the unevaluated* check.
  let refWithSiblings = false;
  if (hasSchemaRef(jsonSchema) && !hasSchemaRecursiveRef(jsonSchema)) {
    // Check if there are any validation-related sibling keywords
    // (REF_SIBLING_KEYWORDS — the one list the reference resolver reads
    // too). In draft 2019-09+, if there are validation siblings, we
    // process them together.
    const hasValidationSiblings = hasRefSiblings(jsonSchema);
    // In draft 7 and earlier, $ref always overrides siblings regardless
    // In draft 2019-09+, $ref can have validation siblings
    if (!hasValidationSiblings || draftVersion < 2019) {
      return undefined;
    }
    // Otherwise, continue to process siblings alongside $ref (2019-09+ only)
    refWithSiblings = true;
  }

  // When the metaschema's $vocabulary omits the validation vocabulary,
  // keywords like type/enum/minimum/minLength assert nothing.
  const vocabValidation = schemaObj.options.vocabValidation !== false;

  // Fast paths for common simple schema patterns
  // These inline the validation to reduce function call overhead

  // Fast path: type-only schema (most common case: {"type": "string"})
  if (vocabValidation && keyCount === 1 && jsonSchema.type !== undefined) {
    const type = jsonSchema.type;
    // Only handle single type strings here (not arrays of types)
    if (typeof type === 'string') {
      const addError = schemaObj.createErrorHandler(type, 'type');

      switch (type) {
        case 'string':
          return function validateTypeStringOnly(data, dataPath) {
            return data === undefined || typeof data === 'string' || addError(data, dataPath);
          };
        case 'number':
          return function validateTypeNumberOnly(data, dataPath) {
            return data === undefined || (typeof data === 'number' && !isNaN(data)) || addError(data, dataPath);
          };
        case 'integer':
          return function validateTypeIntegerOnly(data, dataPath) {
            return data === undefined || Number.isInteger(data) || addError(data, dataPath);
          };
        case 'boolean':
          return function validateTypeBooleanOnly(data, dataPath) {
            return data === undefined || typeof data === 'boolean' || addError(data, dataPath);
          };
        case 'array':
          return function validateTypeArrayOnly(data, dataPath) {
            return data === undefined || Array.isArray(data) || addError(data, dataPath);
          };
        case 'object':
          return function validateTypeObjectOnly(data, dataPath) {
            return data === undefined || (typeof data === 'object' && data !== null && !Array.isArray(data))
              || addError(data, dataPath);
          };
        case 'null':
          return function validateTypeNullOnly(data, dataPath) {
            return data === undefined || data === null || addError(data, dataPath);
          };
      }
    }
  }

  // Fast path: required-only schema (common case: {"required": ["foo", "bar"]})
  if (vocabValidation && keyCount === 1 && jsonSchema.required !== undefined) {
    const required = jsonSchema.required;
    // Non-string entries (invalid schemas) can never match a data key;
    // they stay on the generic Object.keys path.
    if (Array.isArray(required) && required.length > 0
      && required.every(key => typeof key === 'string')) {
      const addError = schemaObj.createErrorHandler(required, ['required']);
      const rlen = required.length;

      if (schemaObj.options.skipErrors) {
        return function validateRequiredOnly(data, dataPath) {
          // Required only applies to objects, not arrays or primitives
          if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;
          for (let i = 0; i < rlen; i++) {
            if (!Object.hasOwn(data, required[i])) {
              return addError(required[i], data, dataPath);
            }
          }
          return true;
        };
      }

      // Every absent property is its own fault to report; the fast path must
      // not be the reason a caller only learns about the first one.
      return function validateRequiredOnlyAll(data, dataPath) {
        if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;
        let valid = true;
        for (let i = 0; i < rlen; i++) {
          if (!Object.hasOwn(data, required[i]))
            valid = addError(required[i], data, dataPath) && valid;
        }
        return valid;
      };
    }
  }

  // Fast path: minLength-only schema (common case: {"minLength": 2})
  // This avoids the overhead of compileStringBasic for simple cases
  if (vocabValidation && keyCount === 1 && jsonSchema.minLength !== undefined) {
    const min = jsonSchema.minLength;
    if (typeof min === 'number' && min > 0 && Number.isFinite(min)) {
      const addError = schemaObj.createErrorHandler(min, 'minLength');
      const useGrapheme = schemaObj.options.useGrapheme;

      if (!useGrapheme) {
        // Simple byte counting
        return function validateMinLengthOnly(data, dataPath) {
          if (typeof data !== 'string') return true;
          return data.length >= min || addError(data.length, dataPath);
        };
      } else {
        // Grapheme counting - use getStringLength
        return function validateMinLengthGrapheme(data, dataPath) {
          if (typeof data !== 'string') return true;
          const len = getStringLength(data, true);
          return len >= min || addError(len, dataPath);
        };
      }
    }
  }

  // Fast path: maxLength-only schema (common case: {"maxLength": 10})
  if (vocabValidation && keyCount === 1 && jsonSchema.maxLength !== undefined) {
    const max = jsonSchema.maxLength;
    if (typeof max === 'number' && max >= 0 && Number.isFinite(max)) {
      const addError = schemaObj.createErrorHandler(max, 'maxLength');
      const useGrapheme = schemaObj.options.useGrapheme;

      if (!useGrapheme) {
        return function validateMaxLengthOnly(data, dataPath) {
          if (typeof data !== 'string') return true;
          return data.length <= max || addError(data.length, dataPath);
        };
      } else {
        // Grapheme counting - use getStringLength
        return function validateMaxLengthGrapheme(data, dataPath) {
          if (typeof data !== 'string') return true;
          const len = getStringLength(data, true);
          return len <= max || addError(len, dataPath);
        };
      }
    }
  }

  const validators = [];
  if (vocabValidation) {
    addFunctionToArray(validators, compileRequired(schemaObj, jsonSchema));
    addFunctionToArray(validators, compileTypeBasic(schemaObj, jsonSchema));
    addFunctionToArray(validators, compileEnumBasic(schemaObj, jsonSchema));

    // Compile $data-aware validators for keywords with $data references
    // This handles cases like: { "maximum": { "$data": "1/larger" } }
    const dollarDataValidator = compileDollarDataSchema(schemaObj, jsonSchema);
    addFunctionToArray(validators, dollarDataValidator);

    addFunctionToArray(validators, compileNumberBasic(schemaObj, jsonSchema));
    addFunctionToArray(validators, compileBigIntBasic(schemaObj, jsonSchema));
    addFunctionToArray(validators, compileStringBasic(schemaObj, jsonSchema));
  }
  addFunctionToArray(validators, compileFormatBasic(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileContentSchema(schemaObj, jsonSchema));

  addFunctionToArray(validators, compileArraySchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileObjectSchema(schemaObj, jsonSchema));

  addFunctionToArray(validators, compileCombineSchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileConditionSchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileDataSchema(schemaObj, jsonSchema));
  addFunctionToArray(validators, compileQuerySchema(schemaObj, jsonSchema));

  // Compile $recursiveRef (draft 2019-09) and $dynamicRef (draft 2020-12)
  addFunctionToArray(validators, compileDynamicRef(schemaObj, jsonSchema));

  // The unevaluated* keywords run last, after every other keyword and
  // in-place applicator has produced its annotations. For $ref siblings
  // the wrapper is applied by the caller (see refWithSiblings above).
  const finalize = refWithSiblings
    ? (validator) => validator
    : (validator) => wrapUnevaluated(schemaObj, jsonSchema, validator);

  // same as empty schema
  if (validators.length === 0)
    return finalize(trueThat);

  if (validators.length === 1)
    return finalize(validators[0]);

  // These are the node's KEYWORD GROUPS (type, string, number, object,
  // array, combine, ...) and they are independent of one another: each
  // re-guards the data type it applies to, so continuing past a failed group
  // is safe. Short-circuiting them is a boolean-mode optimization; when
  // errors are recorded it lets one group's failure hide every other group's.
  if (!schemaObj.options.skipErrors)
    return finalize(combineIndependent(validators));

  if (validators.length === 2) {
    const first = validators[0];
    const second = validators[1];
    return finalize(function validateDoubleSchemaObject(data, dataPath, dataRoot) {
      return first(data, dataPath, dataRoot)
        && second(data, dataPath, dataRoot);
    });
  }

  if (validators.length === 3) {
    const first = validators[0];
    const second = validators[1];
    const thirth = validators[2];
    return finalize(function validateTripleSchemaObject(data, dataPath, dataRoot) {
      return first(data, dataPath, dataRoot)
        && second(data, dataPath, dataRoot)
        && thirth(data, dataPath, dataRoot);
    });
  }

  return finalize(function validateAllSchemaObject(data, dataPath, dataRoot) {
    for (let i = 0; i < validators.length; ++i) {
      const validator = validators[i];
      if (validator(data, dataPath, dataRoot) === false) {
        return false;
      }
    }
    return true;
  });
}
