//@ts-check

import { boundReference, SchemaCompileError } from './errors.js';
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
  markStep,
  createIsSchemaTypeHandler,
  hasSchemaReference,
  schemaReference,
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
import { compilePropertyDependencies } from './property-dependencies.js';
import { compileDollarDataSchema } from './dollar-data.js';
import { admitKeywordValues } from './keyword-values.js';
import { wrapUnevaluated } from './unevaluated.js';
import { compiledLocation, createJsonPointer, keywordLocation } from './traverse.js';
import { getDynamicAnchorName, admitsDynamicReference, appliesRefSiblings } from './dynamic-ref.js';

/**
 * Compile $recursiveRef (draft 2019-09) and $dynamicRef (draft 2020-12).
 * These keywords require runtime resolution based on dynamic scope.
 * 
 * $recursiveRef: References the outermost schema resource with $recursiveAnchor: true
 * $dynamicRef: References the outermost schema resource with matching $dynamicAnchor name
 * 
 * @param {ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema
 * @returns {Function|undefined} The compiled validator function
 */
function compileDynamicRef(schemaObj, jsonSchema) {
  // Check for $recursiveRef (draft 2019-09)
  if (readsDynamicReference(schemaObj, jsonSchema, '$recursiveRef')) {
    return markStep(schemaObj.root.recorder, ['$recursiveRef'], compileRecursiveRef(schemaObj, jsonSchema));
  }

  // Check for $dynamicRef (draft 2020-12)
  if (readsDynamicReference(schemaObj, jsonSchema, '$dynamicRef')) {
    return markStep(schemaObj.root.recorder, ['$dynamicRef'], compileDynamicAnchorRef(schemaObj, jsonSchema));
  }

  return undefined;
}

/**
 * Whether a schema object applies its dynamic reference: one is written,
 * and its document declares a draft that defines the keyword (or none).
 * @param {ValidationObject} schemaObj
 * @param {object} jsonSchema
 * @param {'$recursiveRef'|'$dynamicRef'} keyword
 * @returns {boolean}
 */
function readsDynamicReference(schemaObj, jsonSchema, keyword) {
  return hasSchemaReference(jsonSchema, keyword) && admitsDynamicReference(keyword, schemaObj.dynamicReferenceDraft);
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

  // 2019-09 defines $recursiveRef only for "#" (the current document root)
  // and lets another value be an error: read as 2019-09 it is refused
  // (`JK0011`, naming the `$ref` that applies the schema it names) by the
  // call that reaches it, instead of applying nothing. A draft that does not
  // define the keyword applies nothing for it, but one that names no schema
  // the validator holds is refused (`JK0009`), as an unresolvable
  // $dynamicRef is, instead of passing every instance.
  if (ref !== '#') {
    const place = compiledLocation(keywordLocation(schemaObj.path, '$recursiveRef'), root.origin);
    let refusal;
    if ((schemaObj.declaredDraft ?? schemaObj.options.draftVersion) === 2019) {
      refusal = new SchemaCompileError('JK0011',
        `$recursiveRef '${ref}' is defined only as "#"; to apply the schema it names, write $ref '${ref}'`, place);
    }
    else {
      try {
        const base = schemaObj.baseUri || schemaObj.path;
        createJsonPointer(ref, base, undefined, '$recursiveRef', place);
        root.heldSchema(ref, base);
      }
      catch (e) {
        refusal = e;
      }
    }
    return refusal === undefined ? undefined : function refuseRecursiveRef() {
      throw refusal;
    };
  }

  // Get the base URI for resolving the reference
  // This is the effective base URI of the schema containing $recursiveRef
  // (accounts for $id of containing schemas); a schema reached through a
  // pointer `$ref` resolved on first use has none of its own, and resolves
  // against its own location, as `compileValidator` does
  const baseUri = schemaObj.baseUri || schemaObj.path;
  
  // Resolve the reference to find the initial target URI
  // For "#", this resolves against the baseUri
  const { id: initialTargetUri } = createJsonPointer(ref, baseUri);
  root.refuseContested(initialTargetUri, schemaObj.path, jsonSchema);
  
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

  return boundReference(schemaObj.path, schemaObj.options.maxReferenceDepth, function validateRecursiveRef(data, dataPath, dataRoot) {
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
  });
}

/**
 * Compile $dynamicRef which references the outermost matching $dynamicAnchor.
 * 
 * Per JSON Schema 2020-12 spec:
 * 1. The initial target is determined by resolving the reference as a URI reference
 *    against the current base URI (like $ref)
 * 2. If the initial target has $dynamicAnchor with matching name, look up the dynamic scope
 *    for the outermost $dynamicAnchor with that name and use that schema instead
 * 3. Otherwise, use the initial target (like a normal $ref)
 * 
 * @param {ValidationObject} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing $dynamicRef
 * @returns {Function} The compiled validator function
 */
function compileDynamicAnchorRef(schemaObj, jsonSchema) {
  const root = schemaObj.root;
  const ref = schemaReference(jsonSchema, '$dynamicRef');

  // a schema reached through a pointer `$ref` resolved on first use has no
  // base URI of its own: it resolves against its own location, as
  // `compileValidator` does
  const baseUri = schemaObj.baseUri || schemaObj.path;
  const { id: initialTargetUri, fragment: anchorName } = createJsonPointer(ref, baseUri, undefined, '$dynamicRef', compiledLocation(keywordLocation(schemaObj.path, '$dynamicRef'), root.origin));
  // What the reference resolves through when it reads its initial target.
  const holder = { $ref: initialTargetUri };
  root.refuseContested(initialTargetUri, schemaObj.path, holder);

  // Pointer fragments resolve statically, regardless of whether the reference
  // also names a resource. Plain-name fragments use the same dynamic lookup
  // for relative, absolute and fragment-only references. A target nothing
  // resolves is refused (`JK0009`) by the call that reaches it, never
  // answered: under `not` a `false` would read as success.
  if (anchorName?.startsWith('/')) {
    return boundReference(schemaObj.path, schemaObj.options.maxReferenceDepth, function validateDynamicRefPointer(data, dataPath, dataRoot) {
      return root.resolveObject(initialTargetUri, baseUri, holder).validate(data, dataPath, dataRoot);
    });
  }

  // Look up the initial target schema by its URI
  let initialTargetSchema = root.getSchemaByUri(initialTargetUri);
  if (!initialTargetSchema && initialTargetUri.endsWith('#')) {
    initialTargetSchema = root.getSchemaByUri(initialTargetUri.slice(0, -1));
  }
  
  // Check if the initial target has matching $dynamicAnchor
  // If it does, we need to use the dynamic scope; otherwise, treat like normal $ref
  // (both spelled as the URI spells the fragment: `#a b` is `#a%20b`)
  const hasDynamicAnchor = isObjectClass(initialTargetSchema) && getDynamicAnchorName(initialTargetSchema) === anchorName;

  return boundReference(schemaObj.path, schemaObj.options.maxReferenceDepth, function validateDynamicRef(data, dataPath, dataRoot) {
    if (hasDynamicAnchor) {
      // The initial target has matching $dynamicAnchor
      // Look up the dynamic scope for the outermost $dynamicAnchor with this name
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

    // What the map holds under no such key (a `false` target, an anchor the
    // `$ref` resolver finds under another spelling) is resolved as a `$ref`
    // is; what nothing resolves is refused.
    return root.resolveObject(initialTargetUri, baseUri, holder).validate(data, dataPath, dataRoot);
  });
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

  // a name the validator does not know is refused before this compiles
  const isDataType = createIsSchemaTypeHandler(type);
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

  // collect all testable data types (an empty list, and a name the
  // validator does not know, are refused before this compiles)
  const types = [];
  const names = [];
  for (let i = 0; i < schemaTypes.length; ++i) {
    const type = schemaTypes[i];
    types.push(createIsSchemaTypeHandler(type));
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
  if (hasSchemaReference(jsonSchema, '$ref') && !readsDynamicReference(schemaObj, jsonSchema, '$recursiveRef')) {
    // Check if there are any validation-related sibling keywords
    // (REF_SIBLING_KEYWORDS — the one list the reference resolver reads
    // too). In draft 2019-09+, if there are validation siblings, we
    // process them together.
    const hasValidationSiblings = hasRefSiblings(jsonSchema, schemaObj.options.propertyDependencies === true);
    // In draft 7 and earlier, $ref always overrides siblings regardless
    // In draft 2019-09+, $ref can have validation siblings
    if (!hasValidationSiblings || !appliesRefSiblings(draftVersion)) {
      return undefined;
    }
    // Otherwise, continue to process siblings alongside $ref (2019-09+ only)
    refWithSiblings = true;
  }

  // Every keyword read below holds a value of the shape its draft defines.
  admitKeywordValues(schemaObj, jsonSchema, keys);

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
    // every entry is a member name: another entry is refused above
    if (Array.isArray(required) && required.length > 0) {
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
  addFunctionToArray(validators, compilePropertyDependencies(schemaObj, jsonSchema));
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
