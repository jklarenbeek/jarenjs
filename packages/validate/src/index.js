//@ts-check

import {
  isObjectClass,
  isStringType,
} from '@jarenjs/core';

import {
  compileSchemaObject,
} from './schema.js';

import {
  storeSchemaIdsInMap,
  restoreSchemaRefsInMap,
  resolveRefSchemaDeep,
  encodeJsonPointerPath,
  TraverseOptions,
  createJsonPointer,
} from './traverse.js';

import {
  isBoolOrObjectClass,
  hasSchemaRef,
  hasUnevaluatedPropertiesCoverage,
  hasUnevaluatedItemsCoverage,
  EvalLog,
} from './tools.js';
import { wrapUnevaluated } from './unevaluated.js';
import { registerFormatCompiler, registerFormatCompilers } from './format.js';
import { mergeMap } from '@jarenjs/core/object';
import { hasRecursiveAnchor, getDynamicAnchorName, collectDynamicAnchors, collectDynamicAnchorsDeep } from './dynamic-ref.js';

export {
  registerFormatCompilers
} from './format.js';

import {
  convertInternalErrors,
} from './messages.js';

export {
  ValidationError,
  messagesEn,
  compileMessageTemplate,
  compileMessageCatalog,
  renderErrorMessage,
  localizeErrors,
} from './messages.js';


export { TraverseOptions };

/**
 * Ajv-style $data reference object.
 * The value is a Relative JSON Pointer that resolves from the current data location.
 * Format: `<non-negative-integer>("#"|<json-pointer>)`
 * - "0" - The current value itself
 * - "0#" - The property name/index of the current value
 * - "0/foo" - The "foo" property of the current value
 * - "1" - The parent value
 * - "1/foo" - The "foo" property of the parent value
 * @see https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data
 * @typedef {Object} DollarDataRef
 * @property {string} $data - Relative JSON Pointer resolved from the current data location
 */

/**
 * Data keyword schema for referencing instance data (json-everything style).
 * Allows constraints to reference values from other parts of the instance;
 * every property value is a (relative) JSON Pointer to the constraint's value.
 * @see https://docs.json-everything.net/schema/examples/data-ref/
 * @typedef {Object} DataKeywordSchema
 * @property {string} [minimum] - JSON Pointer to the minimum value
 * @property {string} [maximum] - JSON Pointer to the maximum value
 * @property {string} [exclusiveMinimum] - JSON Pointer to the exclusive minimum value
 * @property {string} [exclusiveMaximum] - JSON Pointer to the exclusive maximum value
 * @property {string} [multipleOf] - JSON Pointer to the multipleOf value
 * @property {string} [minLength] - JSON Pointer to the minLength value
 * @property {string} [maxLength] - JSON Pointer to the maxLength value
 * @property {string} [pattern] - JSON Pointer to the pattern string
 * @property {string} [format] - JSON Pointer to the format name
 * @property {string} [enum] - JSON Pointer to an array of valid values
 * @property {string} [const] - JSON Pointer to the constant value
 * @property {string} [minItems] - JSON Pointer to the minItems value
 * @property {string} [maxItems] - JSON Pointer to the maxItems value
 * @property {string} [minProperties] - JSON Pointer to the minProperties value
 * @property {string} [maxProperties] - JSON Pointer to the maxProperties value
 */

/**
 * The standard JSON Schema keywords understood by Jaren
 * (draft-06 through draft 2020-12). See {@link JSONSchema} for the full
 * schema object type that also permits custom keywords.
 * @typedef {Object} JSONSchemaKeywords
 * @property {string} [$id] - Schema resource identifier (URI)
 * @property {string} [$schema] - Meta-schema URI declaring the draft dialect
 * @property {string} [$ref] - Reference to another schema (URI reference)
 * @property {string} [$anchor] - Plain-name fragment identifier (2019-09+)
 * @property {string} [$dynamicRef] - Dynamic reference (2020-12)
 * @property {string} [$dynamicAnchor] - Dynamic anchor (2020-12)
 * @property {Record<string, boolean>} [$vocabulary] - Vocabulary declarations of a meta-schema
 * @property {string} [$comment] - Comment for schema maintainers; not used in validation
 * @property {Record<string, JSONSchema>} [$defs] - Reusable subschema definitions (2019-09+)
 * @property {Record<string, JSONSchema>} [definitions] - Reusable subschema definitions (draft-07 and earlier)
 * @property {string | string[]} [type] - Expected JSON type(s): 'null', 'boolean', 'object', 'array', 'number', 'string' or 'integer'
 * @property {unknown[] | DollarDataRef} [enum] - Exhaustive list of valid values
 * @property {unknown | DollarDataRef} [const] - Single valid value
 * @property {number | DollarDataRef} [minLength] - Minimum string length (in graphemes by default)
 * @property {number | DollarDataRef} [maxLength] - Maximum string length (in graphemes by default)
 * @property {string | DollarDataRef} [pattern] - ECMA-262 regular expression the string must match
 * @property {string} [contentEncoding] - Encoding of a string-embedded document (e.g. 'base64')
 * @property {string} [contentMediaType] - Media type of a string-embedded document
 * @property {JSONSchema} [contentSchema] - Schema for the decoded string-embedded document
 * @property {number | DollarDataRef} [multipleOf] - Number must be a multiple of this value
 * @property {number | DollarDataRef} [minimum] - Inclusive lower bound
 * @property {number | DollarDataRef} [maximum] - Inclusive upper bound
 * @property {number | boolean | DollarDataRef} [exclusiveMinimum] - Exclusive lower bound (boolean form in draft-04 style schemas)
 * @property {number | boolean | DollarDataRef} [exclusiveMaximum] - Exclusive upper bound (boolean form in draft-04 style schemas)
 * @property {Record<string, JSONSchema>} [properties] - Schemas for named object members
 * @property {Record<string, JSONSchema>} [patternProperties] - Schemas for members whose name matches a regular expression
 * @property {boolean | JSONSchema} [additionalProperties] - Schema for members not matched by properties/patternProperties
 * @property {boolean | JSONSchema} [unevaluatedProperties] - Schema for members not evaluated by any subschema (2019-09+)
 * @property {string[] | DollarDataRef} [required] - Member names that must be present
 * @property {JSONSchema} [propertyNames] - Schema every member name must validate against
 * @property {number | DollarDataRef} [minProperties] - Minimum number of members
 * @property {number | DollarDataRef} [maxProperties] - Maximum number of members
 * @property {JSONSchema | JSONSchema[]} [items] - Schema for array elements (array form is the draft-07 tuple syntax)
 * @property {JSONSchema[]} [prefixItems] - Tuple element schemas (2020-12)
 * @property {boolean | JSONSchema} [additionalItems] - Schema for elements beyond the tuple prefix (draft-07 and earlier)
 * @property {boolean | JSONSchema} [unevaluatedItems] - Schema for elements not evaluated by any subschema (2019-09+)
 * @property {JSONSchema} [contains] - At least one element must validate against this schema
 * @property {number | DollarDataRef} [minItems] - Minimum number of elements
 * @property {number | DollarDataRef} [maxItems] - Maximum number of elements
 * @property {boolean | DollarDataRef} [uniqueItems] - Whether all elements must be unique
 * @property {number} [minContains] - Minimum number of elements matching 'contains' (2019-09+)
 * @property {number} [maxContains] - Maximum number of elements matching 'contains' (2019-09+)
 * @property {JSONSchema[]} [allOf] - Value must validate against all of these schemas
 * @property {JSONSchema[]} [anyOf] - Value must validate against at least one of these schemas
 * @property {JSONSchema[]} [oneOf] - Value must validate against exactly one of these schemas
 * @property {JSONSchema} [not] - Value must NOT validate against this schema
 * @property {JSONSchema} [if] - Condition schema selecting between 'then' and 'else'
 * @property {JSONSchema} [then] - Applied when 'if' validates
 * @property {JSONSchema} [else] - Applied when 'if' does not validate
 * @property {Record<string, JSONSchema>} [dependentSchemas] - Schemas applied when a member is present (2019-09+)
 * @property {Record<string, string[]>} [dependentRequired] - Members required when a member is present (2019-09+)
 * @property {string} [title] - Short descriptive title
 * @property {string} [description] - Explanation of the schema's purpose
 * @property {unknown} [default] - Default value annotation
 * @property {unknown[]} [examples] - Example values annotation
 * @property {boolean} [readOnly] - Value is managed by the receiving authority
 * @property {boolean} [writeOnly] - Value is never returned by the receiving authority
 * @property {boolean} [deprecated] - Value is deprecated
 * @property {string | DollarDataRef} [format] - Named semantic format (e.g. 'email', 'uri', 'date-time')
 * @property {string} [formatMinimum] - Format-aware inclusive lower bound (non-standard, Ajv-style)
 * @property {string} [formatMaximum] - Format-aware inclusive upper bound (non-standard, Ajv-style)
 * @property {string} [formatExclusiveMinimum] - Format-aware exclusive lower bound (non-standard, Ajv-style)
 * @property {string} [formatExclusiveMaximum] - Format-aware exclusive upper bound (non-standard, Ajv-style)
 * @property {DataKeywordSchema} [data] - Data keyword referencing instance data (json-everything style)
 */

/**
 * Represents a JSON Schema object.
 * Covers the standard keywords of drafts 06, 07, 2019-09 and 2020-12
 * (see {@link JSONSchemaKeywords}) while remaining open for custom
 * keywords: any property outside the standard set is permitted.
 * Note that a complete schema is `JSONSchema | boolean` - the boolean
 * forms accept everything (`true`) or nothing (`false`).
 * @typedef {JSONSchemaKeywords & Record<string, unknown>} JSONSchema
 */

/**
 * A format compiler function.
 * Called once per schema location at compile time with the compiling
 * ValidationObject and the schema that declares the format; returns the
 * format validator that is invoked for each instance value, or undefined
 * when the format does not apply to the schema location. Compilers are
 * only invoked for schemas whose `format` member is a plain string.
 * @typedef {(schemaObj: ValidationObject, jsonSchema: JSONSchema & {format?: string}) => ((data: unknown, dataPath?: string) => boolean) | undefined} FormatCompiler
 */

export const DEFAULT_SCHEMA_DRAFT = 'http://json-schema.org/draft-06/schema#'

/**
 * Detects the JSON Schema draft version from the schema's $schema property
 * @param {object} schema - The JSON schema
 * @returns {number} - The draft version (6, 7, 2019, or 2020)
 */
export function detectSchemaDraft(schema) {
  if (!schema || typeof schema !== 'object') return 7; // default to draft7
  const schemaUrl = schema.$schema || '';
  if (schemaUrl.includes('2020-12')) return 2020;
  if (schemaUrl.includes('2019-09')) return 2019;
  if (schemaUrl.includes('draft-07') || schemaUrl.includes('draft/07')) return 7;
  if (schemaUrl.includes('draft-06') || schemaUrl.includes('draft/06')) return 6;
  return 7; // default to draft7 behavior
}

const isBrowser = typeof window !== 'undefined';

const performance = (() => isBrowser
  // eslint-disable-next-line no-undef
  ? window.performance
  : {
    now: function performanceNow(start) {
      // @ts-ignore
      const ps = process;
      if (!start) return ps.hrtime();
      const end = ps.hrtime(start);
      return Math.round((end[0] * 1000) + (end[1] / 1000000));
    },
  })();

class InternalValidationError {
  constructor(obj, key, expected, dataKey, value, rest) {
    this.timeStamp = performance.now();
    this.object = obj;
    this.key = key;
    this.expected = expected;
    this.dataKey = dataKey;
    this.value = value;
    this.rest = rest;
  }
}

/**
 * ValidationOptions configures the behavior of the validation process.
 * @class
 */
export class ValidationOptions {
  /**
   * Creates validation options.
   * @param {boolean} [skipErrors=true] - Whether to stop at first error or continue
   * @param {boolean} [useGrapheme=true] - Whether to use grapheme cluster counting for strings
   * @param {boolean} [collectErrors=false] - Whether to collect all errors or just return boolean
   * @param {boolean|null} [contentValidation=null] - Whether to validate contentEncoding/contentMediaType (null = auto based on draft)
   * @param {number} [draftVersion=7] - The JSON Schema draft version (6, 7, 2019, or 2020)
   * @param {boolean} [vocabValidation=true] - Whether the validation vocabulary is enabled (false when the schema's metaschema omits it via $vocabulary)
   * @param {boolean|null} [formatAssertion=null] - Whether format asserts (null = auto: asserts below draft 2020-12, annotation-only from 2020-12 on)
   * @param {boolean} [messages=true] - Whether collected errors carry rendered message text; false skips rendering (message: '', params/msgid still set)
   */
  constructor(
    skipErrors = true,
    useGrapheme = true,
    collectErrors = false,
    contentValidation = null,
    draftVersion = 7,
    vocabValidation = true,
    formatAssertion = null,
    messages = true
  ) {
    /** @type {boolean} Whether to stop at first error or continue */
    this.skipErrors = skipErrors;
    /** @type {boolean} Whether to use grapheme cluster counting for string length */
    this.useGrapheme = useGrapheme;
    /** @type {boolean} Whether to collect and return detailed errors */
    this.collectErrors = collectErrors;
    /** @type {boolean|null} Whether to validate contentEncoding/contentMediaType (null = auto based on draft) */
    this.contentValidation = contentValidation;
    /** @type {number} The JSON Schema draft version (6, 7, 2019, or 2020) */
    this.draftVersion = draftVersion;
    /** @type {boolean} Whether validation vocabulary keywords (type, minimum, ...) are asserted */
    this.vocabValidation = vocabValidation;
    /** @type {boolean|null} Whether the format keyword asserts (null = auto by draft) */
    this.formatAssertion = formatAssertion;
    /** @type {boolean} Whether collected errors carry rendered message text */
    this.messages = messages;
  }
}

/**
 * ValidationRoot manages the compilation and validation context for a schema.
 * It holds references to all schemas, formats, options, and compiled ValidationObjects.
 * @class
 */
export class ValidationRoot {
  /**
   * Creates a ValidationObject and stores it in the root's object map.
   * @param {ValidationRoot} self - The ValidationRoot instance
   * @param {string} path - The URI path for this schema object
   * @param {object|boolean} schema - The JSON schema
   * @param {string} baseUri - The base URI for resolving relative refs
   * @returns {ValidationObject} The created ValidationObject
   */
  static #createObject(self, path, schema, baseUri, parentDeclaredDraft = null) {
    const objects = self.#objects;
    if (objects.has(path)) {
      const p = objects.get(path);
      if (p != null)
        throw new Error(`Object at '${path}' is already created`);
    }

    const obj = new ValidationObject(self, path, schema, baseUri, parentDeclaredDraft);
    objects.set(path, obj);
    return obj;
  }

  /** @type {string|null} The root schema origin/URI */
  #rootOrigin = null;
  /** @type {Map|null} Map of schema paths to schema objects */
  #schemas = null;
  /** @type {object|null} Registered format validators */
  #formats = null;
  /** @type {ValidationOptions|null} Validation options */
  #options = null;
  /** @type {TraverseOptions|null} Schema traversal options */
  #traverse = null;
  /** @type {Map|null} Map of paths to ValidationObjects */
  #objects = null;
  /** @type {Array} Array of validation errors */
  #errors = null;
  /** @type {ValidationObject|null} The root schema's ValidationObject */
  #firstSchema = null;
  /** @type {Map<string, Function[]>} Map of anchor names to stacks of validator functions */
  #dynamicAnchors = null;
  /** @type {string|null} Anchor name to register for the root schema on each validation, or null when not needed */
  #rootAnchorName = null;
  /** @type {function|null} Cached compiled validator of the root schema */
  #rootValidator = null;
  /** @type {Array<{name: string, schema: object, validator: (function|null)}>} $dynamicAnchors of the root resource (excluding the root's own), registered on each validation */
  #rootDynamicAnchors = [];
  /** @type {boolean} Whether any schema in this compilation contains a $data reference */
  #usesDollarData = false;
  /** @type {boolean} Whether any schema in this compilation contains unevaluatedProperties/unevaluatedItems */
  #usesUnevaluated = false;
  /** @type {EvalLog} Log of evaluated properties/items for unevaluated* support */
  #evalLog = new EvalLog();
  /** @type {object|null} The JarenValidator instance this compilation belongs to, or null when constructed standalone */
  #owner = null;
  /** @type {Map<string, object>|null} Compiled 'errorMessage' specs by schema path; null when the schema set has none */
  #errorMessages = null;

  /** Keywords whose value is a map of arbitrary names to schemas; those
   * names must not be mistaken for keywords (e.g. a metaschema declaring
   * a property named 'unevaluatedProperties'). */
  static #SCAN_MAP_KEYWORDS = new Set([
    'properties', 'patternProperties', 'dependentSchemas',
    '$defs', 'definitions',
  ]);

  /**
   * Whether an unevaluatedProperties/unevaluatedItems occurrence can force
   * runtime annotation tracking. Two shapes never can (in skipErrors mode):
   * the literal `true` form asserts nothing and only produces annotations,
   * which matter only when a checking occurrence elsewhere consumes them;
   * and a check whose sibling keywords already evaluate every property/item
   * (see hasUnevaluatedPropertiesCoverage/hasUnevaluatedItemsCoverage) is
   * unreachable, because reaching it means those siblings passed. When no
   * occurrence forces tracking, the evaluation log has no consumers and
   * annotation logging is skipped entirely.
   * @param {object} node - The schema object holding the keyword
   * @param {string} key - 'unevaluatedProperties' or 'unevaluatedItems'
   * @returns {boolean} True when this occurrence requires annotation tracking
   */
  static #unevaluatedForcesTracking(node, key) {
    if (node[key] === true) return false;
    return key === 'unevaluatedProperties'
      ? !hasUnevaluatedPropertiesCoverage(node)
      : !hasUnevaluatedItemsCoverage(node);
  }

  /**
   * Recursively scans a schema (sub)tree for keys that require special
   * runtime support: '$data' references and 'unevaluatedProperties'/
   * 'unevaluatedItems'. Keys inside name->schema maps (properties, $defs,
   * ...) are property/definition names and are not treated as keywords.
   * @param {any} node - The schema node to scan
   * @param {Set<object>} seen - Cycle guard
   * @param {{dollarData: boolean, unevaluated: boolean}} flags - Output flags
   * @param {boolean} [isSchema=true] - Whether node's keys are schema keywords
   */
  static #scanSchemaFeatures(node, seen, flags, isSchema = true) {
    if (node == null || typeof node !== 'object') return;
    if (flags.dollarData && flags.unevaluated) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; ++i) {
        ValidationRoot.#scanSchemaFeatures(node[i], seen, flags, isSchema);
      }
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; ++i) {
      const key = keys[i];
      if (isSchema) {
        // The json-everything 'data' keyword resolves relative pointers
        // against the data path at validation time, just like '$data'.
        if (key === '$data'
          || (key === 'data' && node[key] !== null && typeof node[key] === 'object')) flags.dollarData = true;
        else if (key === '$query') {
          // The '$query' keyword binds the instance path to its 'path'
          // external at validation time, so it consumes data paths like
          // '$data'. Its value is a query document, not a schema - the
          // keys inside (operators, embedded schema literals) must not
          // register as keywords of this compilation.
          flags.dollarData = true;
          continue;
        }
        else if (key === 'errorMessage') {
          // 'errorMessage' is report-time metadata; its value is a message
          // spec whose map form may spell keys like '$query' that must not
          // register as keywords of this compilation.
          continue;
        }
        else if (key === 'unevaluatedProperties' || key === 'unevaluatedItems') {
          if (!flags.canElide || ValidationRoot.#unevaluatedForcesTracking(node, key))
            flags.unevaluated = true;
        }
        if (ValidationRoot.#SCAN_MAP_KEYWORDS.has(key)) {
          // The value is a name->schema map: its keys are names, its values schemas.
          ValidationRoot.#scanSchemaFeatures(node[key], seen, flags, false);
          continue;
        }
      }
      ValidationRoot.#scanSchemaFeatures(node[key], seen, flags, true);
    }
  }

  /**
   * Creates a new ValidationRoot.
   * @param {string} origin - The root schema origin/URI
   * @param {Map} schemas - Map of schema paths to schema objects
   * @param {Record<string, FormatCompiler>} formats - Registered format validators
   * @param {ValidationOptions} [opts] - Validation options
   * @param {TraverseOptions} [traverse] - Schema traversal options
   * @param {object|null} [owner] - The owning JarenValidator instance; extension
   *   keywords ('$query') compile embedded schema literals against it so their
   *   `$ref`s resolve to the owner's `addSchema` registrations
   */
  constructor(origin, schemas, formats, opts = new ValidationOptions(), traverse = new TraverseOptions, owner = null) {
    const schema = schemas.get(origin);
    this.#rootOrigin = origin;
    this.#schemas = schemas;
    this.#formats = formats;

    this.#options = opts;
    this.#traverse = traverse;
    this.#owner = owner;

    this.#objects = new Map();
    this.#errors = [];
    this.#dynamicAnchors = new Map();

    // Detect $data references and unevaluated* keywords once, so fast paths
    // can skip path building / annotation logging when nothing consumes them.
    // Must run before validators are compiled below.
    // Elision of unreachable unevaluated* checks relies on validators
    // short-circuiting at the first failure, so it only holds in
    // skipErrors mode (see #unevaluatedForcesTracking).
    const flags = { dollarData: false, unevaluated: false, canElide: opts.skipErrors === true };
    const seen = new Set();
    for (const value of schemas.values()) {
      ValidationRoot.#scanSchemaFeatures(value, seen, flags);
      if (flags.dollarData && flags.unevaluated) break;
    }
    this.#usesDollarData = flags.dollarData;
    this.#usesUnevaluated = flags.unevaluated;

    // For the root schema, baseUri is the origin
    this.#firstSchema = ValidationRoot.#createObject(this, origin, schema, origin);

    // Precompute per-validation constants so validate() stays allocation-free.
    // The root schema never changes after compilation.
    const rootSchema = this.#firstSchema.schema;
    const hasRecAnchor = isObjectClass(rootSchema) && hasRecursiveAnchor(rootSchema);
    const dynAnchorName = isObjectClass(rootSchema) ? getDynamicAnchorName(rootSchema) : null;
    this.#rootAnchorName = (hasRecAnchor || dynAnchorName) ? (dynAnchorName || '') : null;
    this.#rootValidator = this.#firstSchema.validate;

    // Entering the root resource brings ALL of its $dynamicAnchors into the
    // dynamic scope (the root's own anchor is handled via #rootAnchorName).
    this.#rootDynamicAnchors = collectDynamicAnchorsDeep(rootSchema)
      .filter(anchor => anchor.schema !== rootSchema);
  }

  /** @returns {TraverseOptions} Schema traversal options */
  get traverse() { return this.#traverse; }

  /** @returns {ValidationOptions} Validation options */
  get options() { return this.#options; }

  /** @returns {object} Registered format validators */
  get formats() { return this.#formats; }

  /** @returns {Array} Array of validation errors */
  get errors() { return this.#errors; }

  /** @returns {boolean} Whether any schema in this compilation contains a $data reference */
  get usesDollarData() { return this.#usesDollarData; }

  /** @returns {boolean} Whether any schema in this compilation contains unevaluatedProperties/unevaluatedItems */
  get usesUnevaluated() { return this.#usesUnevaluated; }

  /** @returns {EvalLog} The evaluation log for unevaluated* annotation tracking */
  get evalLog() { return this.#evalLog; }

  /** @returns {object|null} The owning JarenValidator instance, or null when constructed standalone */
  get owner() { return this.#owner; }

  /** @returns {Map<string, object>|null} Compiled 'errorMessage' specs by schema path, or null when the schema set has none */
  get errorMessages() { return this.#errorMessages; }

  /**
   * Register a compiled 'errorMessage' spec for a schema location.
   * Called at schema compile time (see compileSchemaObject); the registry
   * is only consulted at report time, over the already-failed set.
   * @param {string} path - The schema path (ValidationObject.path)
   * @param {object} spec - The compiled spec (see messages.js compileErrorMessageSpec)
   */
  registerErrorMessage(path, spec) {
    if (this.#errorMessages === null) this.#errorMessages = new Map();
    this.#errorMessages.set(path, spec);
  }

  /**
   * Creates a new ValidationObject for the given path and schema.
   * @param {string} path - The URI path for this schema object
   * @param {object|boolean} schema - The JSON schema
   * @param {string} baseUri - The base URI for resolving relative refs
   * @returns {ValidationObject} The created ValidationObject
   */
  createObject(path, schema, baseUri, parentDeclaredDraft = null) {
    return ValidationRoot.#createObject(this, path, schema, baseUri, parentDeclaredDraft);
  }

  /**
   * Checks if an object exists at the given path without creating it.
   * @param {string} path - The URI path to check
   * @returns {ValidationObject|null|undefined} The existing object, null if marked unresolved, or undefined if not known
   */
  unresolvedObject(path) {
    const objects = this.#objects;
    if (objects.has(path))
      return objects.get(path);

    objects.set(path, null);
    return null;
  }

  /**
   * Gets the raw schema object by its URI/ID directly from the schemas map.
   * This performs a direct lookup without following references.
   * @param {string} uri - The schema URI to look up
   * @returns {object|undefined} The raw schema object or undefined
   */
  getSchemaByUri(uri) {
    return this.#schemas.get(uri);
  }

  /**
   * Resolves a $ref to a ValidationObject, creating it if necessary.
   * @param {string} ref - The reference URI to resolve
   * @param {string} path - The current path (for error messages)
   * @param {object} schema - The schema containing the $ref
   * @returns {ValidationObject} The resolved ValidationObject
   */
  resolveObject(ref, path, schema) {
    // Fast path - check if already compiled first
    const objects = this.#objects;
    const cached = objects.get(ref);
    if (cached != null) return cached;

    // Resolve ref chain and check final ID cache
    const schemas = this.#schemas;
    const traverse = this.#traverse;
    const { id, schema: root } = resolveRefSchemaDeep(schemas, path, schema, traverse);

    // Check if final ID is already compiled
    const finalCached = objects.get(id);
    if (finalCached != null) return finalCached;

    // Create and cache the validation object
    return ValidationRoot.#createObject(this, id, root);
  }

  /**
   * Adds an error to the validation errors list.
   * @param {InternalValidationError} error - The error to add
   * @returns {boolean} Always returns false for convenience in validators
   */
  addError(error /*:InternalValidationError*/) {
    this.#errors.push(error);
    return false;
  }

  /**
   * A checkpoint in the collected-error list.
   *
   * A SPECULATIVE applicator - an `anyOf` branch, an `if` condition, the
   * subschema of a `not`, a `contains` candidate - runs a validator whose
   * failure may be entirely expected. Those failures still call `addError`,
   * so without a checkpoint they leak into the caller's issue list and blame
   * a document for not matching a branch it was never required to match.
   * Marking before the probe and rolling back after is the same discipline
   * `EvalLog` already uses for annotations.
   * @returns {number} The mark to pass to {@link rollbackErrors}
   */
  errorMark() {
    return this.#errors.length;
  }

  /**
   * Discard every error collected since `mark`.
   * @param {number} mark - A value from {@link errorMark}
   */
  rollbackErrors(mark) {
    if (this.#errors.length > mark) this.#errors.length = mark;
  }

  /**
   * Validates data against the root schema.
   * @param {unknown} data - The data to validate
   * @returns {boolean} True if valid, false otherwise
   */
  validate(data /*:unknown*/) {
    // only clear errors array when we need to collect errors
    // When skipErrors=true (default), we don't use the errors array
    if (!this.#options.skipErrors) {
      this.#errors = [];
    }
    // Push/pop pairs are balanced (try/finally), so the anchors map is
    // normally empty here already; clear defensively without reallocating.
    if (this.#dynamicAnchors.size !== 0) {
      this.#dynamicAnchors.clear();
    }
    // Clear evaluation annotations from the previous validation
    if (this.#usesUnevaluated) {
      this.#evalLog.reset();
    }

    const rootValidator = this.#rootValidator;
    const anchorName = this.#rootAnchorName;
    const rootAnchors = this.#rootDynamicAnchors;
    if (anchorName !== null || rootAnchors.length !== 0) {
      if (anchorName !== null)
        this.pushDynamicAnchorValidator(anchorName, rootValidator);
      for (let i = 0; i < rootAnchors.length; ++i) {
        const anchor = rootAnchors[i];
        if (anchor.validator === null)
          anchor.validator = this.getOrCreateValidator(anchor.schema, this.#rootOrigin, this.#rootOrigin);
        this.pushDynamicAnchorValidator(anchor.name, anchor.validator);
      }
      try {
        // call compiled validator with dataRoot as third argument
        return rootValidator(data, '', data);
      } finally {
        for (let i = rootAnchors.length - 1; i >= 0; --i) {
          this.popDynamicAnchorValidator(rootAnchors[i].name);
        }
        if (anchorName !== null)
          this.popDynamicAnchorValidator(anchorName);
      }
    }

    // call compiled validator
    // Pass dataRoot as the third argument for data keyword support
    return rootValidator(data, '', data);
  }

  /**
   * Returns the fastest repeated-validation entry point for this root.
   * Error collection and root-level dynamic anchors need the per-call
   * bookkeeping of validate(); without them the compiled root validator
   * only needs the annotation log cleared (when tracking is on) and can
   * otherwise be invoked directly. Dynamic anchors pushed during
   * validation are balanced by try/finally, so the anchor map needs no
   * per-call clearing here.
   * @returns {(data: unknown) => boolean} The validation entry point
   */
  createValidateFn() {
    if (!this.#options.skipErrors || this.#options.collectErrors
      || this.#rootAnchorName !== null
      || this.#rootDynamicAnchors.length !== 0) {
      return (data) => this.validate(data);
    }

    const rootValidator = this.#rootValidator;
    if (this.#usesUnevaluated) {
      const evalLog = this.#evalLog;
      return function validateRootTracked(data) {
        evalLog.reset();
        return rootValidator(data, '', data);
      };
    }
    return function validateRoot(data) {
      return rootValidator(data, '', data);
    };
  }

  /**
   * Get the stored validator for a dynamic anchor.
   * Used by $dynamicRef for runtime resolution.
   * Per draft 2020-12, $dynamicRef resolves to the FIRST (outermost)
   * resource in the dynamic scope that defines the anchor.
   * @param {string} anchorName - The anchor name
   * @returns {Function|null} The validator function or null if not set
   */
  getDynamicAnchorValidator(anchorName) {
    const stack = this.#dynamicAnchors.get(anchorName);
    if (!stack || stack.length === 0) return null;
    return stack[0];
  }

  /**
   * Get the outermost validator for a recursive anchor.
   * Used by $recursiveRef for runtime resolution.
   * Returns the bottom of the stack (first/outermost registered validator).
   * @param {string} anchorName - The anchor name (empty string for $recursiveRef)
   * @returns {Function|null} The validator function or null if not set
   */
  getOutermostDynamicAnchorValidator(anchorName) {
    const stack = this.#dynamicAnchors.get(anchorName);
    if (!stack || stack.length === 0) return null;
    return stack[0];
  }

  /**
   * Push a validator onto the stack for a dynamic anchor.
   * Called when entering a schema with $recursiveAnchor or $dynamicAnchor.
   * @param {string} anchorName - The anchor name
   * @param {Function} validator - The validator function
   */
  pushDynamicAnchorValidator(anchorName, validator) {
    if (!this.#dynamicAnchors.has(anchorName)) {
      this.#dynamicAnchors.set(anchorName, []);
    }
    this.#dynamicAnchors.get(anchorName).push(validator);
  }

  /**
   * Pop a validator from the stack for a dynamic anchor.
   * Called when exiting a schema with $recursiveAnchor or $dynamicAnchor.
   * @param {string} anchorName - The anchor name
   */
  popDynamicAnchorValidator(anchorName) {
    const stack = this.#dynamicAnchors.get(anchorName);
    if (stack && stack.length > 0) {
      stack.pop();
    }
  }

  /**
   * Get or create a validator for a given schema.
   * This is used when we need a validator for a schema at validation time
   * (e.g., for dynamic anchors collected from $defs).
   * @param {object} schema - The schema to create a validator for
   * @param {string} basePath - The base path for the schema
   * @param {string} baseUri - The base URI for the schema
   * @returns {Function} The validator function
   */
  getOrCreateValidator(schema, basePath, baseUri) {
    // Create a unique path for this schema based on its content
    // We use a simple JSON stringify for now, but this could be improved
    const path = basePath + '/$def-anchor/' + JSON.stringify(schema).slice(0, 50);
    
    // Check if we already have an object for this path
    let obj = this.#objects.get(path);
    if (obj != null) {
      return obj.validate;
    }
    
    // Create a new validation object for this schema
    obj = ValidationRoot.#createObject(this, path, schema, baseUri);
    return obj.validate;
  }
}

/**
 * ValidationObject represents a single schema location with its compiled validator.
 * It handles the compilation of schema validation logic and provides methods for
 * creating child validators and error handlers.
 * @class
 */
export class ValidationObject {
  /**
   * Compiles a validator function for the given schema.
   * This is the main entry point for schema compilation. It handles:
   * - Simple schemas (type-only, required-only) via fast paths
   * - Schemas with $ref by resolving to target validators
   * - Complex schemas by delegating to compileSchemaObject
   * @param {ValidationObject} self - The validation object that is compiling this validator
   * @param {string} path - The path to this schema object (its URI identifier)
   * @param {any} schema - The schema object to compile
   * @param {string} baseUri - The base URI for resolving $ref (parent's base, before any sibling $id)
   * @returns {function(any, any):boolean} A function that validates data against the compiled schema and returns a boolean.
   */
  static compileValidator(self, path, schema, baseUri) {
    if (!hasSchemaRef(schema))
      return compileSchemaObject(self, schema);

    const root = self.#root;

    // In draft 2019-09+, $ref can have sibling keywords that are applied together.
    // In draft 7 and earlier, $ref overrides siblings.
    //
    // The draft that decides this is the one declared by the schema RESOURCE
    // holding the `$ref`, not the one the root document happens to use. A
    // 2020-12 resource embedded in a draft-07 document has to assert its
    // siblings, and a draft-07 resource inside a 2020-12 document must not —
    // reading the root's draft got both backwards.
    const draftVersion = self.declaredDraft ?? root.options.draftVersion ?? 7;

    // Base URI for resolving $ref:
    // - Draft 7 and earlier: $ref replaces the schema entirely, so a sibling
    //   $id does not change the base URI - resolve against the parent's base.
    // - Draft 2019-09+: $id establishes the base URI for the schema object it
    //   appears in, INCLUDING a sibling $ref (self.baseUri accounts for $id).
    const refBase = draftVersion >= 2019
      ? (self.baseUri || baseUri || path)
      : (baseUri || path);
    const { id: ref } = createJsonPointer(schema.$ref, refBase, root.traverse);
    // Only check for sibling validators in draft 2019-09+
    const siblingValidator = draftVersion >= 2019 ? compileSchemaObject(self, schema) : null;

    // Collect dynamic anchors from the current schema's $defs/definitions.
    // When following a $ref, dynamic anchors defined in the source schema's $defs
    // should be in scope for $dynamicRef in the target schema.
    // This handles cases like: root has $defs.foo with $dynamicAnchor, root.$ref points to list,
    // and list.items has $dynamicRef that should resolve to root.$defs.foo's anchor.
    const sourceDynamicAnchors = draftVersion >= 2020 ? collectDynamicAnchors(schema) : [];

    // Since refs are now pre-compiled at compile time,
    // we should always find the target immediately
    const resolved = root.unresolvedObject(ref);
    if (resolved != null) {
      const refValidator = resolved.validate;
      const resolvedSchema = resolved.schema;
      
      // Check if the target schema has a dynamic anchor ($recursiveAnchor or $dynamicAnchor)
      // If so, we need to wrap the call to register the anchor at validation time
      const hasRecAnchor = isObjectClass(resolvedSchema) && hasRecursiveAnchor(resolvedSchema);
      const dynAnchorName = isObjectClass(resolvedSchema) ? getDynamicAnchorName(resolvedSchema) : null;

      // Entering the target resource brings ALL of its $dynamicAnchors into
      // the dynamic scope (the target root's own anchor is pushed separately
      // as refValidator below). Source $defs anchors are kept for schemas
      // whose resource entry point is the $ref itself.
      const enterAnchors = sourceDynamicAnchors.slice();
      const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema);
      for (let i = 0; i < targetDeepAnchors.length; i++) {
        const anchor = targetDeepAnchors[i];
        if (anchor.schema === resolvedSchema) continue;
        anchor.base = resolved.baseUri;
        enterAnchors.push(anchor);
      }

      if (hasRecAnchor || dynAnchorName || enterAnchors.length > 0) {
        const anchorName = dynAnchorName || ''; // empty string for $recursiveAnchor

        // Wrap the ref validator to register dynamic anchor at call time (validation time)
        if (siblingValidator) {
          // unevaluated* keywords must see annotations produced by the $ref
          // target, so the wrapper goes around the combined validator.
          return wrapUnevaluated(self, schema, function validateRefWithDynamicAnchorAndSiblings(data, dataPath, dataRoot) {
            // Register the entered resource's dynamic anchors first
            for (let i = 0; i < enterAnchors.length; i++) {
              const anchor = enterAnchors[i];
              if (anchor.validator == null)
                anchor.validator = root.getOrCreateValidator(anchor.schema, path, anchor.base || baseUri);
              root.pushDynamicAnchorValidator(anchor.name, anchor.validator);
            }
            // Then register target's dynamic anchor if any
            if (hasRecAnchor || dynAnchorName) {
              root.pushDynamicAnchorValidator(anchorName, refValidator);
            }
            try {
              return combineRefAndSiblings(refValidator, siblingValidator, self.options.skipErrors,
              data, dataPath, dataRoot);
            } finally {
              // Pop in reverse order
              if (hasRecAnchor || dynAnchorName) {
                root.popDynamicAnchorValidator(anchorName);
              }
              for (let i = enterAnchors.length - 1; i >= 0; i--) {
                root.popDynamicAnchorValidator(enterAnchors[i].name);
              }
            }
          });
        } else {
          return function validateRefWithDynamicAnchor(data, dataPath, dataRoot) {
            // Register the entered resource's dynamic anchors first
            for (let i = 0; i < enterAnchors.length; i++) {
              const anchor = enterAnchors[i];
              if (anchor.validator == null)
                anchor.validator = root.getOrCreateValidator(anchor.schema, path, anchor.base || baseUri);
              root.pushDynamicAnchorValidator(anchor.name, anchor.validator);
            }
            // Then register target's dynamic anchor if any
            if (hasRecAnchor || dynAnchorName) {
              root.pushDynamicAnchorValidator(anchorName, refValidator);
            }
            try {
              return refValidator(data, dataPath, dataRoot);
            } finally {
              // Pop in reverse order
              if (hasRecAnchor || dynAnchorName) {
                root.popDynamicAnchorValidator(anchorName);
              }
              for (let i = enterAnchors.length - 1; i >= 0; i--) {
                root.popDynamicAnchorValidator(enterAnchors[i].name);
              }
            }
          };
        }
      }
      
      // If there are sibling validators (draft 2019-09+), combine them with the ref validator
      if (siblingValidator) {
        // unevaluated* keywords must see annotations produced by the $ref
        // target, so the wrapper goes around the combined validator.
        return wrapUnevaluated(self, schema, function validateRefWithSiblings(data, dataPath, dataRoot) {
          return combineRefAndSiblings(refValidator, siblingValidator, self.options.skipErrors,
              data, dataPath, dataRoot);
        });
      }
      
      self.#validator = refValidator;
      return refValidator;
    }

    // Fallback for edge cases (e.g., recursive refs that weren't pre-compiled)
    // Pre-bind values to avoid closure overhead in hot path
    const rootRef = root;
    const boundRef = ref;
    const boundRefBase = refBase;
    const boundSchema = schema;
    const boundSiblingValidator = siblingValidator;
    const boundSourceAnchors = sourceDynamicAnchors;

    // Memoized state of the first resolution - the target never changes.
    let resolvedState = null;

    return wrapUnevaluated(self, schema, function resolveSchemaCompiler(data, dataPath, dataRoot) {
      if (resolvedState === null) {
        const obj = rootRef.resolveObject(boundRef, boundRefBase, boundSchema);
        const resolvedSchema = obj.schema;

        // Entering the target resource brings ALL of its $dynamicAnchors into
        // the dynamic scope, exactly like the pre-compiled path above.
        const enterAnchors = boundSourceAnchors.slice();
        const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema);
        for (let i = 0; i < targetDeepAnchors.length; i++) {
          const anchor = targetDeepAnchors[i];
          if (anchor.schema === resolvedSchema) continue;
          anchor.base = obj.baseUri;
          enterAnchors.push(anchor);
        }

        resolvedState = {
          refValidator: obj.validate,
          enterAnchors,
          hasRecAnchor: isObjectClass(resolvedSchema) && hasRecursiveAnchor(resolvedSchema),
          dynAnchorName: isObjectClass(resolvedSchema) ? getDynamicAnchorName(resolvedSchema) : null,
        };
      }
      const { refValidator, enterAnchors, hasRecAnchor, dynAnchorName } = resolvedState;

      for (let i = 0; i < enterAnchors.length; i++) {
        const anchor = enterAnchors[i];
        if (anchor.validator == null)
          anchor.validator = rootRef.getOrCreateValidator(anchor.schema, path, anchor.base || baseUri);
        rootRef.pushDynamicAnchorValidator(anchor.name, anchor.validator);
      }

      try {
        if (hasRecAnchor || dynAnchorName) {
          const anchorName = dynAnchorName || '';
          rootRef.pushDynamicAnchorValidator(anchorName, refValidator);
          try {
            // If there are sibling validators (draft 2019-09+), combine them with the ref validator
            if (boundSiblingValidator) {
              return combineRefAndSiblings(refValidator, boundSiblingValidator,
                self.options.skipErrors, data, dataPath, dataRoot);
            }
            return refValidator(data, dataPath, dataRoot);
          } finally {
            rootRef.popDynamicAnchorValidator(anchorName);
          }
        }

        // If there are sibling validators (draft 2019-09+), combine them with the ref validator
        if (boundSiblingValidator) {
          return combineRefAndSiblings(refValidator, boundSiblingValidator,
                self.options.skipErrors, data, dataPath, dataRoot);
        }

        // Cache the validator directly (skipping this resolver) only when
        // this ref registers no dynamic anchors - otherwise later calls
        // would lose the registrations.
        if (enterAnchors.length === 0) {
          self.#validator = refValidator;
        }
        return refValidator(data, dataPath, dataRoot);
      } finally {
        // Pop anchors in reverse order
        for (let i = enterAnchors.length - 1; i >= 0; i--) {
          rootRef.popDynamicAnchorValidator(enterAnchors[i].name);
        }
      }
    });
  }

  /** @type {ValidationRoot} The root validation context */
  #root = null;
  /** @type {string} The URI path identifying this schema object */
  #path = null;
  /** @type {ValidationObject[]} Child validation objects created by this object */
  #members = null;
  /** @type {any} The schema object being validated */
  #schema = null;
  /** @type {function|null} The compiled validator function */
  #validator = null;
  /** @type {string} The effective base URI for child $ref resolution */
  #effectiveBaseUri = null;
  /** @type {number|null} Draft version declared by this schema's document ($schema), inherited by subschemas; null when never declared */
  #declaredDraft = null;

  /**
   * Creates a new ValidationObject.
   * @param {ValidationRoot} root - The root validation context
   * @param {string} path - The URI path identifying this schema object
   * @param {any} schema - The schema object to compile
   * @param {string} baseUri - The base URI for resolving $ref
   * @param {number|null} [parentDeclaredDraft] - The declared draft inherited from the parent schema object
   */
  constructor(root, path, schema, baseUri, parentDeclaredDraft = null) {
    this.#root = root;
    this.#path = path;
    this.#members = [];
    this.#schema = schema;
    this.#validator = null;

    // A document that declares its own $schema is processed per that draft
    // (cross-draft references); subschemas inherit the document's draft.
    this.#declaredDraft = (isObjectClass(schema) && isStringType(schema.$schema))
      ? detectSchemaDraft(schema)
      : parentDeclaredDraft;

    // Calculate the effective base URI for this schema.
    // The effective base is what children should use for resolving relative $refs.
    // If this schema has an $id, it becomes the new base for children.
    if (isObjectClass(schema) && schema.$id) {
      // This schema has its own $id - resolve it against the parent's baseUri
      // to get the absolute base for children
      const { id: resolvedId } = createJsonPointer(schema.$id, baseUri);
      this.#effectiveBaseUri = resolvedId.endsWith('#') ? resolvedId.slice(0, -1) : resolvedId;
    } else {
      // No $id - inherit parent's base
      this.#effectiveBaseUri = baseUri;
    }

    this.#validator = ValidationObject.compileValidator(this, path, schema, baseUri);
  }

  /** @returns {string} The URI path identifying this schema object */
  get path() {
    return this.#path;
  }

  /** @returns {string} The effective base URI for resolving relative $refs */
  get baseUri() {
    return this.#effectiveBaseUri;
  }

  /** @returns {function} The compiled validator function */
  get validate() {
    return this.#validator;
  }

  /** @returns {ValidationOptions} The validation options */
  get options() {
    return this.#root.options;
  }

  /** @returns {object} The registered format validators */
  get formats() {
    return this.#root.formats;
  }

  /** @returns {ValidationRoot} The root validation context */
  get root() {
    return this.#root;
  }

  /** @returns {object} The schema object */
  get schema() {
    return this.#schema;
  }

  /** @returns {number|null} Draft version declared by this schema's document via $schema, or null when never declared */
  get declaredDraft() {
    return this.#declaredDraft;
  }

/**
   * Creates an error handler function for validation failures.
   * @param {any} expected - The expected value that failed validation
   * @param {string | string[]} key - The keyword or keywords that failed
   * @returns {(data: unknown, ...meta: any[]) => boolean} A function that adds an error and returns false
   */
  createErrorHandler(expected, key) {
    const self = this;

    // when skipErrors is true, we don't need to create error objects
    // Just return false immediately to avoid the overhead of error creation
    if (self.#root.options.skipErrors) {
      if (!Array.isArray(key)) {
        return function addNormalErrorFast(_data, ..._meta) {
          // Just return false without creating error object
          return false;
        };
      }
      else {
        return function addKeyedErrorFast(_dataKey, _data, ..._meta) {
          // Just return false without creating error object
          return false;
        };
      }
    }

    if (!Array.isArray(key)) {
      return function addNormalError(data, ...meta) {
        const error = new InternalValidationError(self, key, expected, null, data, meta);
        return self.#root.addError(error);
      };
    }
    else {
      return function addKeyedError(dataKey, data, ...meta) {
        const error = new InternalValidationError(self, key, expected, dataKey, data, meta);
        return self.#root.addError(error);
      };
    }
  }

  /**
   * Creates a validator function for a child schema.
   * This is used when compiling nested schemas (e.g., array items, object properties).
   * @param {JSONSchema | boolean} schema - The child schema to compile
   * @param {string} key - The property key where the schema is located
   * @param {number} [index] - Optional array index for tuple items
   * @returns {function|undefined} The compiled validator function, or undefined if schema is invalid
   */
  createValidator(schema, key, index) {
    if (!isBoolOrObjectClass(schema))
      return undefined;

    const root = this.#root;
    // Use the effective base URI for resolving relative $refs
    // This is either: (a) the resolved $id of this schema, or (b) the inherited base from parent
    let basePath = this.#effectiveBaseUri;
    // Strip trailing '#' for URL resolution - a base URL ending with '#' breaks relative ref resolution
    if (basePath && basePath.endsWith('#')) {
      basePath = basePath.slice(0, -1);
    }

    // Check if schema has $id - this affects how we calculate the path
    const hasId = isObjectClass(schema) && schema.$id;

    // If schema has $id, resolve it against basePath to get the new base URI
    // Otherwise, use the current path
    const id = hasId
      ? createJsonPointer(schema.$id, basePath || this.#path).id
      : this.#path;

    // If schema has $id, use the resolved ID as the path (it defines the schema's location)
    // Otherwise, append key/index to create a JSON pointer path
    const path = hasId
      ? id
      : index == null
        ? encodeJsonPointerPath(id, key)
        : encodeJsonPointerPath(id, key, String(index));



    // Pass basePath as the baseUri for the child object.
    // This ensures that $ref in the child will be resolved against basePath,
    // not against any sibling $id that the child might have.
    // The child inherits this document's declared draft version.
    const child = root.createObject(path, schema, basePath, this.#declaredDraft);
    this.#members.push(child);

    return child.#validator;
  }
}

/**
 * Run a `$ref` and its sibling keywords, which are INDEPENDENT of each other:
 * a document can fail the referenced schema and its siblings for unrelated
 * reasons, and reporting only the first is the same short-circuit that used to
 * hide half of every issue list. Boolean mode keeps the early exit.
 * @param {Function} refValidator
 * @param {Function} siblingValidator
 * @param {boolean} stopAtFirst
 * @param {any} data
 * @param {string} dataPath
 * @param {any} dataRoot
 * @returns {boolean}
 */
function combineRefAndSiblings(refValidator, siblingValidator, stopAtFirst, data, dataPath, dataRoot) {
  if (stopAtFirst)
    return refValidator(data, dataPath, dataRoot) && siblingValidator(data, dataPath, dataRoot);
  const target = refValidator(data, dataPath, dataRoot);
  return siblingValidator(data, dataPath, dataRoot) && target;
}

/**
 * ValidatorOptions configures the JarenValidator instance.
 * Can be created with positional arguments or an options object.
 * @class
 * @example
 * // Positional arguments
 * const options = new ValidatorOptions(formats, schemas, validation, traverse);
 *
 * // Options object (recommended)
 * const options = new ValidatorOptions({
 *   formats: { custom: validator },
 *   collectErrors: true,
 *   useGrapheme: false
 * });
 */
export class ValidatorOptions {
  /**
   * Creates validator options.
   * @param {object|object[]} [formats={}] - Format validators or options object
   * @param {object[]} [schemas=[]] - Initial schemas to register
   * @param {ValidationOptions} [validation] - Validation behavior options
   * @param {TraverseOptions} [traverse] - Schema traversal options
   */
  constructor(
    formats = {},
    schemas = [],
    validation = new ValidationOptions(),
    traverse = new TraverseOptions(),
  ) {
    // Support object destructuring: new ValidatorOptions({ collectErrors: true })
    if (formats && typeof formats === 'object' && !Array.isArray(formats) &&
        !(formats instanceof Map)) {
      const opts = formats;
      /** @type {object} Registered format validators */
      this.formats = opts.formats || {};
      /** @type {object[]} Initial schemas to register */
      this.schemas = opts.schemas || [];
      // If collectErrors is passed directly, create ValidationOptions with it
      if (opts.collectErrors != null || opts.skipErrors != null || opts.useGrapheme != null || opts.contentValidation != null || opts.draftVersion != null || opts.formatAssertion != null || opts.messages != null) {
        const collectErrors = opts.collectErrors ?? false;
        this.validation = new ValidationOptions(
          // collecting errors implies actually recording them
          opts.skipErrors ?? !collectErrors,
          opts.useGrapheme ?? true,
          collectErrors,
          // null, not false: an unset option must stay unset so `compile`
          // can apply the per-draft default. Coercing it here would make
          // any options object silently disable content assertion.
          opts.contentValidation ?? null,
          opts.draftVersion ?? 7,
          true,
          opts.formatAssertion ?? null,
          opts.messages ?? true
        );
      } else {
        /** @type {ValidationOptions} Validation behavior options */
        this.validation = opts.validation || new ValidationOptions();
      }
      /** @type {TraverseOptions} Schema traversal options */
      this.traverse = opts.traverse || new TraverseOptions();
    } else {
      this.formats = formats;
      this.schemas = schemas;
      this.validation = validation;
      this.traverse = traverse;
    }
  }
}

/**
 * The object a compiled validator returns when `collectErrors` is enabled.
 * @typedef {{ valid: boolean, errors: import("./messages.js").ValidationError[] }} ValidationResultObject
 */

/**
 * A compiled validator in the default boolean mode. It is a type guard, so
 * `T` is whatever the caller asserts the schema describes; with no `T` it
 * behaves as an ordinary boolean predicate.
 * @template T
 * @typedef {(data: unknown) => data is T} CompiledPredicate
 */

/**
 * A compiled validator in collect-errors mode.
 * @typedef {(data: unknown) => ValidationResultObject} CompiledCollector
 */

/**
 * The plain-object form accepted by the JarenValidator constructor, mixing
 * validator-level settings with the ValidationOptions fields.
 * @template {boolean} [TCollect=false]
 * @typedef {object} ValidatorInit
 * @property {Record<string, FormatCompiler>} [formats] - Format compilers to register
 * @property {(JSONSchema | boolean)[]} [schemas] - Schemas to register
 * @property {ValidationOptions} [validation] - Validation behavior options
 * @property {TraverseOptions} [traverse] - Schema traversal options
 * @property {TCollect} [collectErrors] - Return `{ valid, errors }` instead of a boolean
 * @property {boolean} [skipErrors] - Stop at the first failure (defaults to `!collectErrors`)
 * @property {boolean} [useGrapheme] - Count grapheme clusters for string length
 * @property {boolean} [contentValidation] - Assert contentEncoding/contentMediaType
 * @property {number} [draftVersion] - The JSON Schema draft version
 * @property {boolean} [formatAssertion] - Assert the format keyword
 * @property {boolean} [messages] - Render English message text on collected errors
 */

/**
 * JarenValidator is the main entry point for JSON Schema validation.
 * It manages schema registration, format registration, and compilation.
 *
 * The `collectErrors` option decides what a compiled validator returns, and
 * it is carried in the type parameter so the two shapes never have to be
 * distinguished at runtime.
 * @template {boolean} [TCollect=false]
 * @class
 * @example
 * const validator = new JarenValidator();
 * validator.addSchema({ $id: 'http://example.com/schema', type: 'object' });
 * const validate = validator.compile({ $ref: 'http://example.com/schema' });
 * const valid = validate({ foo: 'bar' }); // true
 */
export class JarenValidator {
  /** @type {object} Registered format validators */
  #formats = {}
  /** @type {Map} Map of schema URIs to schema objects */
  #schemas = new Map();
  /** @type {Map} Map of meta-schema URIs to compiled validators */
  #metaSchemas = new Map();
  /** @type {ValidatorOptions} Validator options */
  #options = new ValidatorOptions();

  /**
   * Creates a new JarenValidator instance.
   * @param {ValidatorOptions | ValidatorInit<TCollect>} [options] - Validator options including formats, schemas, validation options, and traverse options
   */
  constructor(options = new ValidatorOptions()) {
    // Accept a plain options object ({ skipErrors, collectErrors, ... })
    // as well as a ValidatorOptions instance.
    if (!(options instanceof ValidatorOptions)) {
      options = new ValidatorOptions(options);
    }
    this.#formats = options.formats || {};
    this.#schemas = new Map();
    this.#metaSchemas = new Map();
    this.#options = options;
  }

  /**
   * Adds a format validator.
   * @param {string} name - The format name (e.g., 'email', 'uri', 'date-time')
   * @param {FormatCompiler} formatCompiler - A function that compiles format validators
   * @returns {this} This validator instance for chaining (the polymorphic `this` keeps the collectErrors type parameter across a chain)
   * @example
   * validator.addFormat('custom', (schemaObj, schema) => {
   *   return (data) => data.startsWith('custom:');
   * });
   */
  addFormat(name, formatCompiler) {
    registerFormatCompiler(
      this.#formats,
      name,
      formatCompiler);
    return this;
  }

  /**
   * Adds multiple format validators at once.
   * @param {Record<string, FormatCompiler>} formatCompilers - Object mapping format names to compiler functions
   * @returns {this} This validator instance for chaining (the polymorphic `this` keeps the collectErrors type parameter across a chain)
   */
  addFormats(formatCompilers) {
    registerFormatCompilers(
      this.#formats,
      formatCompilers);
    return this;
  }

  /**
   *
   * @param {boolean | object} schema
   * @param {object[] | undefined} schemas
   * @param {TraverseOptions} opts
   * @returns {{origin:string, map: Map}}
   */
  static #traverseSchema(schema, schemas = undefined, fromMap = undefined, opts = new TraverseOptions()) {
    // initialize schema map for all ids and refs
    const schemaMap = new Map(fromMap);
    const origin = storeSchemaIdsInMap(
      schemaMap,
      opts.origin,
      schema,
      opts);

    // Then add the other reference schemas
    if (Array.isArray(schemas) && schemas.length > 0) {
      schemas.forEach(ref => storeSchemaIdsInMap(
        schemaMap,
        origin,
        ref,
        opts));
    }

    // make sure all schemas are connected
    restoreSchemaRefsInMap(schemaMap, opts);

    return { origin: origin, map: schemaMap };
  }

  /**
   * Adds schema(s) to the validator instance.
   * This method does not compile schemas - it only registers them for reference.
   * Dependencies can be added in any order, and circular dependencies are supported.
   * @param {JSONSchema | boolean | (JSONSchema | boolean)[]} schema - The schema(s) to add
   * @param {string} [key] - Optional key/URI to register the schema under
   * @returns {this} This validator instance for chaining (the polymorphic `this` keeps the collectErrors type parameter across a chain)
   * @example
   * // Add a single schema
   * validator.addSchema({ $id: 'http://example.com/user', type: 'object' });
   *
   * // Add multiple schemas
   * validator.addSchema([schema1, schema2]);
   *
   * // Add with explicit key
   * validator.addSchema({ type: 'string' }, 'http://example.com/name');
   */
  addSchema(schema, key = undefined) {
    if (Array.isArray(schema)) {
      schema.forEach((s, index) => this.addSchema(s, key ? `${key}[${index}]` : undefined));
    }
    else if (typeof schema === 'object') {
      const schemaKey = key || schema.$id;
      if (schemaKey) {
        this.#schemas.set(schemaKey, schema);
        // CHECK: Also store with alternate key (with/without #) for absolute URIs
        if (!schemaKey.startsWith('#')) {
          const altKey = schemaKey.endsWith('#') ? schemaKey.slice(0, -1) : schemaKey + '#';
          if (!this.#schemas.has(altKey)) {
            this.#schemas.set(altKey, schema);
          }
        }

        // Also traverse the schema to find and store all internal $id anchors
        // This is important for remote schemas that may have location-independent identifiers
        // We use a wrapper that skips already-existing keys instead of throwing
        this.#traverseAndStoreIds(schemaKey, schema);
      }
    }
    return this;
  }

  /**
   * Traverse a schema and store all $id anchors in the schemas map.
   * This is a wrapper around storeSchemaIdsInMap that skips already-existing keys.
   * Anchors are scoped to their document context (anchorsGlobal: false) to prevent
   * conflicts between different schemas that may use the same anchor names.
   * @param {string} baseUri - The base URI for the schema
   * @param {object} schema - The schema to traverse
   */
  #traverseAndStoreIds(baseUri, schema) {
    const traverseOpts = this.#options.traverse;

    // Create options with anchorsGlobal: false to scope anchors to their document.
    // This prevents conflicts when multiple schemas use the same anchor names (e.g., '#foo').
    // Anchors will be stored as 'baseUri#anchor' instead of just '#anchor'.
    const scopedOpts = new TraverseOptions(
      traverseOpts.origin,
      traverseOpts.mergeSchemas,
      false, // anchorsGlobal: false - scope anchors to document
      traverseOpts.anchorsAllowed,
      traverseOpts.skipErrors
    );

    // Use a wrapper map to collect new entries, then merge them
    const newSchemas = new Map();
    try {
      storeSchemaIdsInMap(newSchemas, baseUri, schema, scopedOpts);
    } catch (_e) {
      // Ignore errors for already-existing schemas at the root level
    }

    // Merge new entries into the main schemas map, skipping existing keys
    for (const [id, value] of newSchemas.entries()) {
      if (!this.#schemas.has(id)) {
        this.#schemas.set(id, value);
      }
    }
  }

  /**
   *
   * @param {JarenValidator} self
   * @param {string} origin
   * @param {Map} schemas
   * @returns {(data) => boolean | {valid: boolean, errors: import("./messages.js").ValidationError[]}}
   */
  static #compileSchema(self, origin, schemas) {
    const root = new ValidationRoot(
      origin,
      schemas,
      self.#formats,
      self.#options.validation,
      self.#options.traverse,
      self);

    const collectErrors = self.#options.validation?.collectErrors || false;

    function jarenValidateSchema(data) {
      const valid = root.validate(data);
      if (collectErrors) {
        return {
          valid,
          errors: valid ? [] : convertInternalErrors(root.errors)
        };
      }
      return valid;
    }

    return jarenValidateSchema;
  }

  /**
   * Compile schema using a pre-created ValidationRoot (with pre-compiled refs).
   * @param {JarenValidator} self
   * @param {string} origin
   * @param {Map} schemas
   * @param {ValidationRoot} root - Pre-created root with pre-compiled refs
   * @returns {(data) => boolean | {valid: boolean, errors: import("./messages.js").ValidationError[]}}
   */
  static #compileSchemaWithRoot(self, origin, schemas, root) {
    const collectErrors = self.#options.validation?.collectErrors || false;

    if (!collectErrors) {
      const jarenValidateSchema = root.createValidateFn();
      Object.defineProperty(jarenValidateSchema, "errors", {
        get: function () { return root.errors }
      })
      return jarenValidateSchema;
    }

    function jarenValidateSchema(data) {
      const valid = root.validate(data);
      return {
        valid,
        errors: valid ? [] : convertInternalErrors(root.errors)
      };
    }

    Object.defineProperty(jarenValidateSchema, "errors", {
      get: function () { return root.errors }
    })

    return jarenValidateSchema;
  }

  static normalizeUriKey(key) {
    return key;
  }

  /**
   * Adds meta-schema(s) that can be used to validate schemas.
   * Meta-schemas are schemas that describe the structure of valid JSON schemas.
   * @param {JSONSchema | boolean | (JSONSchema | boolean)[]} schema - The meta-schema(s) to add
   * @param {string} [key] - Optional key/URI for the meta-schema
   * @returns {this} This validator instance for chaining (the polymorphic `this` keeps the collectErrors type parameter across a chain)
   * @example
   * validator.addMetaSchema(draft7MetaSchema, 'http://json-schema.org/draft-07/schema');
   */
  addMetaSchema(schema, key = undefined) {
    key = JarenValidator.normalizeUriKey(key)
    if (Array.isArray(schema)) {
      const first = schema.shift();
      const { origin, map } = JarenValidator.#traverseSchema(first, schema, undefined, new TraverseOptions(key));
      const compiled = JarenValidator.#compileSchema(this, origin, map);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    else if (isBoolOrObjectClass(schema)) {
      const { origin, map } = JarenValidator.#traverseSchema(schema, undefined, undefined, new TraverseOptions(key));
      const compiled = JarenValidator.#compileSchema(this, origin, map);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    return this;
  }

  /**
   * Retrieves a registered schema by its key/URI.
   * @param {string} key - The schema URI/key
   * @returns {JSONSchema | boolean | null} The registered schema, or null if not found
   */
  getSchema(key) {
    key = JarenValidator.normalizeUriKey(key)
    return this.#schemas.get(key) || null;
  }

  /**
   * Validates a schema against a registered meta-schema.
   * This is used to ensure schemas are valid according to the JSON Schema specification.
   * @param {JSONSchema | boolean} schema - The schema to validate
   * @returns {boolean} True if the schema is valid
   * @example
   * validator.addMetaSchema(draft7MetaSchema);
   * const isValid = validator.validateSchema({ type: 'string' }); // true
   */
  validateSchema(schema) {
    // if no meta schema is present, just return true;
    if (this.#metaSchemas.size == 0)
      return true;

    const schemaId = JarenValidator.normalizeUriKey(schema.$schema || DEFAULT_SCHEMA_DRAFT);
    const metaSchema = this.#metaSchemas.get(schemaId);
    // if the metaSchema is not present, we fail the validation
    if (!metaSchema)
      return false;

    // otherwise, validate the schema
    return metaSchema(schema);
  }

  /**
   * Pre-compile refs to eliminate validation-time overhead.
   * Creates ValidationObjects for all refs in the schemas map during compile time.
   * @param {ValidationRoot} root - The validation root
   * @param {Map} schemas - The schemas map
   * @param {string} origin - The origin schema ID
   */
  static #precompileRefs(root, schemas, origin) {
    // Pre-create validation objects for all refs in the schemas map
    // This moves ref resolution from validation time to compile time

    // First pass: Create objects for schemas with $id (canonical paths)
    // These establish the base URIs for their descendants
    for (const [id, schema] of schemas.entries()) {
      // Skip if already compiled
      if (root.unresolvedObject(id) !== null) continue;

      // Skip null placeholders
      if (schema == null) continue;

      // Only process schemas with $id that are stored under their $id path
      // (not JSON pointer paths)
      if (!isObjectClass(schema) || !schema.$id) continue;

      // Check if this id matches the resolved $id
      const { id: resolvedId } = createJsonPointer(schema.$id, origin);
      if (id === resolvedId || id === resolvedId + '#') {
        // This is a canonical $id path - create with origin as base
        try {
          root.createObject(id, schema, origin);
        } catch (_e) {
          // May fail if dependencies not resolved yet
        }
      }
    }

    // Second pass: Create objects for remaining schemas
    // This includes:
    // 1. JSON pointer paths (e.g., #/definitions/x) - calculate baseUri by finding nearest ancestor $id
    // 2. Canonical $id paths with relative $ids that weren't matched in first pass
    for (const [id, schema] of schemas.entries()) {
      // Skip if already compiled
      if (root.unresolvedObject(id) !== null) continue;

      // Skip null placeholders
      if (schema == null) continue;

      // Skip schemas without $id that aren't refs - they're subschemas
      // that will be reached through traversal from a parent
      const hasId = isObjectClass(schema) && schema.$id;
      const isJsonPointerPath = id.includes('#/');
      const isCanonicalPath = !isJsonPointerPath && id.endsWith('#');

      if (!hasId && !isJsonPointerPath) continue;

      // Calculate baseUri for this schema
      let baseUri = origin;

      if (isJsonPointerPath) {
        // JSON pointer path - traverse from root to find nearest $id ancestor
        const hashIndex = id.indexOf('#/');
        const baseDoc = id.substring(0, hashIndex);
        const pointer = id.substring(hashIndex + 1);
        const pointerParts = pointer.split('/').filter(p => p);

        const rootId = baseDoc + '#';
        const rootSchema = schemas.get(rootId);

        // Check if the root schema has an $id that matches the baseDoc.
        // If so, the baseDoc is already the resolved $id and we shouldn't
        // apply $id resolution during traversal (that would double-resolve).
        let rootIdMatchesBaseDoc = false;
        if (rootSchema && isObjectClass(rootSchema) && rootSchema.$id) {
          const { id: resolvedRootId } = createJsonPointer(rootSchema.$id, origin);
          const resolvedRootBase = resolvedRootId.endsWith('#') ? resolvedRootId.slice(0, -1) : resolvedRootId;
          if (baseDoc === resolvedRootBase) {
            rootIdMatchesBaseDoc = true;
          }
        }

        let currentSchema = rootSchema;
        let currentBaseUri = baseDoc;

        // Traverse and find the nearest $id ancestor
        for (let i = 0; i < pointerParts.length && currentSchema; i++) {
          const part = pointerParts[i];

          // Check if current schema has $id (before moving to child)
          if (isObjectClass(currentSchema) && currentSchema.$id) {
            const isRootSchema = (i === 0);
            const shouldApplyId = !isRootSchema || !rootIdMatchesBaseDoc;

            if (shouldApplyId) {
              const { id: resolvedId } = createJsonPointer(currentSchema.$id, currentBaseUri);
              currentBaseUri = resolvedId.endsWith('#') ? resolvedId.slice(0, -1) : resolvedId;
            }
          }

          // Move to next level - handle both direct properties and definitions/$defs
          const nextSchema = currentSchema[part] ||
                            currentSchema.$defs?.[part] ||
                            currentSchema.definitions?.[part];
          currentSchema = nextSchema;
        }

        baseUri = currentBaseUri;
      } else if (hasId && isCanonicalPath) {
        // Canonical $id path that wasn't handled in first pass
        // This happens when the $id is relative and resolves differently
        // than against the origin. We need to find the correct base URI.

        // Find any schema in the map that has this schema as a descendant
        // and use its $id as the base
        for (const [candidateId, candidateSchema] of schemas.entries()) {
          if (!candidateSchema || candidateSchema === schema) continue;

          // Check if candidate is an ancestor by checking if our id starts with candidate's path
          if (isJsonPointerPath && id.startsWith(candidateId.replace('#', '#/') + '/')) {
            // This is a descendant of a JSON pointer path - skip for now
            continue;
          }

          // If candidate has an $id, it could be our base
          if (isObjectClass(candidateSchema) && candidateSchema.$id) {
            // Try resolving our $id against this candidate's resolved $id
            const { id: candidateResolvedId } = createJsonPointer(candidateSchema.$id, origin);
            const candidateBase = candidateResolvedId.endsWith('#') ? candidateResolvedId.slice(0, -1) : candidateResolvedId;

            try {
              const { id: testResolvedId } = createJsonPointer(schema.$id, candidateBase);
              const testResolvedIdWithHash = testResolvedId.endsWith('#') ? testResolvedId : testResolvedId + '#';

              if (id === testResolvedIdWithHash || id === testResolvedId) {
                baseUri = candidateBase;
                break;
              }
            } catch (_e) {
              // Invalid URL, skip this candidate
            }
          }
        }
      }

      try {
        root.createObject(id, schema, baseUri);
      } catch (_e) {
        // Ref may not be resolvable yet, that's ok
      }
    }
  }

  /**
   * Compiles a schema into a validation function.
   * This is the main method for creating validators. It resolves all $ref references,
   * compiles the schema structure, and returns a function that validates data.
   * The return type follows the instance's `collectErrors` setting: a type
   * guard over `unknown` by default, or a function producing
   * `{ valid, errors }` when errors are collected. Jaren does not infer `T`
   * from the schema — the caller asserts what the schema describes, which is
   * what a checked contract wrapper wants; pair it with a schema-to-type
   * generator if you need the shape derived mechanically.
   * @template [T=unknown]
   * @param {JSONSchema | boolean} schema - The schema to compile
   * @param {(JSONSchema | boolean)[]} [schemas] - Additional schemas to reference during compilation
   * @returns {TCollect extends true ? CompiledCollector : CompiledPredicate<T>} A validation function
   * @example
   * const validate = validator.compile({
   *   type: 'object',
   *   properties: {
   *     name: { type: 'string' }
   *   }
   * });
   *
   * const valid = validate({ name: 'John' }); // true
   * const invalid = validate({ name: 123 }); // false
   *
   * // Narrowing to a caller-asserted type
   * const isUser = validator.compile<{ name: string }>(userSchema);
   * if (isUser(input)) input.name; // input is { name: string } here
   *
   * // With error collection
   * const collecting = new JarenValidator({ collectErrors: true });
   * const result = collecting.compile(schema)({ name: 123 });
   * // result = { valid: false, errors: [...] }
   */
  compile(schema, schemas = undefined) {
    const { origin, map } = JarenValidator.#traverseSchema(schema, schemas, this.#schemas, this.#options.traverse);

    // Detect draft version from schema and update validation options
    const draftVersion = detectSchemaDraft(schema);
    const existingValidation = this.#options.validation || new ValidationOptions();
    // For draft7, contentValidation defaults to true; for 2019-09+, defaults to false
    const contentValidationDefault = draftVersion < 2019;

    // When the schema declares a custom metaschema via $schema, its
    // $vocabulary decides which keyword vocabularies are asserted. A
    // metaschema that omits the validation vocabulary turns keywords like
    // 'type' and 'minimum' into annotations that assert nothing.
    let vocabValidation = true;
    // In draft 2020-12 the format keyword is annotation-only unless the
    // metaschema opts into the format-assertion vocabulary (or the user
    // sets the formatAssertion option explicitly).
    let formatAssertion = existingValidation.formatAssertion ?? null;
    if (isObjectClass(schema) && isStringType(schema.$schema)) {
      const metaKey = JarenValidator.normalizeUriKey(schema.$schema);
      const metaSchema = map.get(metaKey)
        || map.get(metaKey.endsWith('#') ? metaKey.slice(0, -1) : metaKey + '#');
      if (isObjectClass(metaSchema) && isObjectClass(metaSchema.$vocabulary)) {
        vocabValidation = Object.keys(metaSchema.$vocabulary)
          .some(uri => uri.includes('/vocab/validation'));
        if (formatAssertion == null
          && Object.keys(metaSchema.$vocabulary).some(uri => uri.includes('/vocab/format-assertion'))) {
          formatAssertion = true;
        }
      }
    }
    if (formatAssertion == null) {
      formatAssertion = draftVersion < 2020;
    }

    const validationOptions = new ValidationOptions(
      existingValidation.skipErrors ?? true,
      existingValidation.useGrapheme ?? true,
      existingValidation.collectErrors ?? false,
      existingValidation.contentValidation ?? contentValidationDefault,
      draftVersion,
      vocabValidation,
      formatAssertion,
      existingValidation.messages ?? true
    );

    // Pre-compile all refs before returning the validator
    // This ensures all ref chains are resolved at compile time
    const root = new ValidationRoot(
      origin,
      map,
      this.#formats,
      validationOptions,
      this.#options.traverse,
      this
    );

    // Pre-create validation objects for all refs
    JarenValidator.#precompileRefs(root, map, origin);

    // Re-compile with the pre-populated root
    return JarenValidator.#compileSchemaWithRoot(this, origin, map, root);
  }
}
