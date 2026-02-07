//@ts-check

import {
  isObjectClass,
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
} from './tools.js';
import { registerFormatCompiler, registerFormatCompilers } from './format.js';
import { mergeMap } from '@jarenjs/core/object';

export {
  registerFormatCompilers
} from './format.js';

export { TraverseOptions };

export const DEFAULT_SCHEMA_DRAFT = 'http://json-schema.org/draft-06/schema#'

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
 * JSON Schema Validation Error
 * Represents a validation error according to the JSON Schema specification.
 * @see https://json-schema.org/draft/2020-12/json-schema-core.html#output
 */
export class ValidationError {
  /**
   * @param {object} options - Error options
   * @param {string} options.keyword - The keyword that failed validation
   * @param {string} options.instancePath - JSON Pointer to the data location
   * @param {string} options.schemaPath - JSON Pointer to the schema location
   * @param {object} options.params - Keyword-specific parameters
   * @param {string} [options.message] - Human-readable error message
   */
  constructor(options) {
    this.keyword = options.keyword;
    this.instancePath = options.instancePath || '';
    this.schemaPath = options.schemaPath || '';
    this.params = options.params || {};
    this.message = options.message || '';
  }

  /**
   * Convert error to a plain object
   * @returns {object} Plain object representation
   */
  toJSON() {
    return {
      keyword: this.keyword,
      instancePath: this.instancePath,
      schemaPath: this.schemaPath,
      params: this.params,
      message: this.message,
    };
  }
}

/**
 * ValidationOptions configures the behavior of the validation process.
 * @class
 */
class ValidationOptions {
  /**
   * Creates validation options.
   * @param {boolean} [skipErrors=true] - Whether to stop at first error or continue
   * @param {boolean} [useGrapheme=true] - Whether to use grapheme cluster counting for strings
   * @param {boolean} [collectErrors=false] - Whether to collect all errors or just return boolean
   */
  constructor(
    skipErrors = true,
    useGrapheme = true,
    collectErrors = false
  ) {
    /** @type {boolean} Whether to stop at first error or continue */
    this.skipErrors = skipErrors;
    /** @type {boolean} Whether to use grapheme cluster counting for string length */
    this.useGrapheme = useGrapheme;
    /** @type {boolean} Whether to collect and return detailed errors */
    this.collectErrors = collectErrors;
  }
}

/**
 * ValidationRoot manages the compilation and validation context for a schema.
 * It holds references to all schemas, formats, options, and compiled ValidationObjects.
 * @class
 */
class ValidationRoot {
  /**
   * Creates a ValidationObject and stores it in the root's object map.
   * @private
   * @param {ValidationRoot} self - The ValidationRoot instance
   * @param {string} path - The URI path for this schema object
   * @param {object|boolean} schema - The JSON schema
   * @param {string} baseUri - The base URI for resolving relative refs
   * @returns {ValidationObject} The created ValidationObject
   */
  static #createObject(self, path, schema, baseUri) {
    const objects = self.#objects;
    if (objects.has(path)) {
      const p = objects.get(path);
      if (p != null)
        throw new Error(`Object at '${path}' is already created`);
    }

    const obj = new ValidationObject(self, path, schema, baseUri);
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

  /**
   * Creates a new ValidationRoot.
   * @param {string} origin - The root schema origin/URI
   * @param {Map} schemas - Map of schema paths to schema objects
   * @param {object} formats - Registered format validators
   * @param {ValidationOptions} [opts] - Validation options
   * @param {TraverseOptions} [traverse] - Schema traversal options
   */
  constructor(origin, schemas, formats, opts = new ValidationOptions(), traverse = new TraverseOptions) {
    const schema = schemas.get(origin);
    this.#rootOrigin = origin;
    this.#schemas = schemas;
    this.#formats = formats;

    this.#options = opts;
    this.#traverse = traverse;

    this.#objects = new Map();
    this.#errors = [];

    // For the root schema, baseUri is the origin
    this.#firstSchema = ValidationRoot.#createObject(this, origin, schema, origin);
  }

  /** @returns {string} The root schema origin/URI */
  get rootOrigin() { return this.#rootOrigin; }

  /** @returns {TraverseOptions} Schema traversal options */
  get traverse() { return this.#traverse; }

  /** @returns {ValidationOptions} Validation options */
  get options() { return this.#options; }

  /** @returns {object} Registered format validators */
  get formats() { return this.#formats; }

  /** @returns {Array} Array of validation errors */
  get errors() { return this.#errors; }

  /**
   * Creates a new ValidationObject for the given path and schema.
   * @param {string} path - The URI path for this schema object
   * @param {object|boolean} schema - The JSON schema
   * @param {string} baseUri - The base URI for resolving relative refs
   * @returns {ValidationObject} The created ValidationObject
   */
  createObject(path, schema, baseUri) {
    return ValidationRoot.#createObject(this, path, schema, baseUri);
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
   * Validates data against the root schema.
   * @param {unknown} data - The data to validate
   * @returns {boolean} True if valid, false otherwise
   */
  validate(data /*:unknown*/) {
    // clear all errors
    this.#errors = [];
    // call compiled validator
    return this.#firstSchema.validate(data, data);
  }
}

/**
 * ValidationObject represents a single schema location with its compiled validator.
 * It handles the compilation of schema validation logic and provides methods for
 * creating child validators and error handlers.
 * @class
 */
class ValidationObject {
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

    // When resolving $ref, use baseUri (parent's base) instead of path.
    // This ensures that a sibling $id does not change the base URI for $ref resolution.
    // Per JSON Schema spec, $ref prevents a sibling $id from changing the base URI.
    const refBase = baseUri || path;
    const { id: ref } = createJsonPointer(schema.$ref, refBase, root.traverse);

    // Since refs are now pre-compiled at compile time,
    // we should always find the target immediately
    const resolved = root.unresolvedObject(ref);
    if (resolved != null) {
      const validator = resolved.validate;
      self.#validator = validator;
      return validator;
    }

    // Fallback for edge cases (e.g., recursive refs that weren't pre-compiled)
    // Pre-bind values to avoid closure overhead in hot path
    const rootRef = root;
    const boundRef = ref;
    const boundRefBase = refBase;
    const boundSchema = schema;

    return function resolveSchemaCompiler(data, dataRoot) {
      const obj = rootRef.resolveObject(boundRef, boundRefBase, boundSchema);
      const validator = obj.validate;
      // Cache the validator directly - no wrapper function
      self.#validator = validator;
      return validator(data, dataRoot);
    };
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
  /** @type {string} The base URI passed during construction */
  #baseUri = null;
  /** @type {string} The effective base URI for child $ref resolution */
  #effectiveBaseUri = null;

  /**
   * Creates a new ValidationObject.
   * @param {ValidationRoot} root - The root validation context
   * @param {string} path - The URI path identifying this schema object
   * @param {any} schema - The schema object to compile
   * @param {string} baseUri - The base URI for resolving $ref
   */
  constructor(root, path, schema, baseUri) {
    this.#root = root;
    this.#path = path;
    this.#members = [];
    this.#schema = schema;
    this.#validator = null;

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
    this.#baseUri = baseUri;

    this.#validator = ValidationObject.compileValidator(this, path, schema, baseUri);
  }

  /** @returns {string} The URI path identifying this schema object */
  get path() {
    return this.#path;
  }

  /** @returns {Array} The current validation errors from the root */
  get errors() {
    return this.#root.errors;
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

/**
   * Creates an error handler function for validation failures.
   * @param {any} expected - The expected value that failed validation
   * @param {string | string[]} key - The keyword or keywords that failed
   * @returns {function(unknown, ...any): boolean} A function that adds an error and returns false
   */
  createErrorHandler(expected, key) {
    const self = this;

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
   * @param {object|boolean} schema - The child schema to compile
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
    const child = root.createObject(path, schema, basePath);
    this.#members.push(child);

    return child.#validator;
  }
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
      if (opts.collectErrors != null || opts.skipErrors != null || opts.useGrapheme != null) {
        this.validation = new ValidationOptions(opts.skipErrors || true, opts.useGrapheme || false, opts.collectErrors || false);
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
 * JarenValidator is the main entry point for JSON Schema validation.
 * It manages schema registration, format registration, and compilation.
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
   * @param {ValidatorOptions} [options] - Validator options including formats, schemas, validation options, and traverse options
   */
  constructor(options = new ValidatorOptions()) {
    this.#formats = options.formats || {};
    this.#schemas = new Map();
    this.#metaSchemas = new Map();
    this.#options = options;
  }

  /**
   * Adds a format validator.
   * @param {string} name - The format name (e.g., 'email', 'uri', 'date-time')
   * @param {Function} formatCompiler - A function that compiles format validators
   * @returns {JarenValidator} This validator instance for chaining
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
   * @param {object} formatCompilers - Object mapping format names to compiler functions
   * @returns {JarenValidator} This validator instance for chaining
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
   * @param {boolean | object | object[]} schema - The schema(s) to add
   * @param {string} [key] - Optional key/URI to register the schema under
   * @returns {JarenValidator} This validator instance for chaining
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
    } catch (e) {
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
   * Convert internal validation errors to public ValidationError format
   * @param {InternalValidationError[]} internalErrors
   * @returns {ValidationError[]}
   */
  static #convertErrors(internalErrors) {
    return internalErrors.map(err => {
      const keyword = Array.isArray(err.key) ? err.key[err.key.length - 1] : err.key;

      // Build params based on error type
      const params = {};
      if (keyword === 'required') {
        params.missingProperty = err.dataKey;
      } else if (keyword === 'type') {
        if (Array.isArray(err.expected)) {
          params.types = err.expected;
        } else {
          params.type = err.expected;
        }
      } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'minItems', 'maxItems'].includes(keyword)) {
        params.limit = err.expected;
        if (keyword === 'minimum' || keyword === 'maximum') {
          params.comparison = keyword === 'minimum' ? '>=' : '<=';
        } else if (keyword === 'exclusiveMinimum' || keyword === 'exclusiveMaximum') {
          params.comparison = keyword === 'exclusiveMinimum' ? '>' : '<';
        }
      } else if (keyword === 'multipleOf') {
        params.multipleOf = err.expected;
      } else if (keyword === 'pattern') {
        params.pattern = err.expected?.source || err.expected;
      } else if (keyword === 'additionalProperties') {
        params.additionalProperty = err.dataKey;
      }

      // Generate message
      let message = `validation failed for keyword '${keyword}'`;
      if (keyword === 'required') {
        message = params.missingProperty
          ? `must have required property '${params.missingProperty}'`
          : 'must have required properties';
      } else if (keyword === 'type') {
        message = params.types
          ? `must be one of the following types: ${params.types.join(', ')}`
          : `must be ${params.type === 'integer' ? 'an' : 'a'} ${params.type}`;
      } else if (keyword === 'minimum' || keyword === 'maximum') {
        message = `must be ${params.comparison} ${params.limit}`;
      } else if (keyword === 'exclusiveMinimum' || keyword === 'exclusiveMaximum') {
        message = `must be ${params.comparison} ${params.limit}`;
      } else if (keyword === 'multipleOf') {
        message = `must be multiple of ${params.multipleOf}`;
      } else if (keyword === 'minLength') {
        message = `must NOT have fewer than ${params.limit} characters`;
      } else if (keyword === 'maxLength') {
        message = `must NOT have more than ${params.limit} characters`;
      } else if (keyword === 'pattern') {
        message = `must match pattern "${params.pattern}"`;
      } else if (keyword === 'additionalProperties') {
        message = params.additionalProperty
          ? `must NOT have additional property '${params.additionalProperty}'`
          : 'must NOT have additional properties';
      } else if (keyword === 'minProperties') {
        message = `must NOT have fewer than ${params.limit} properties`;
      } else if (keyword === 'maxProperties') {
        message = `must NOT have more than ${params.limit} properties`;
      } else if (keyword === 'minItems') {
        message = `must NOT have fewer than ${params.limit} items`;
      } else if (keyword === 'maxItems') {
        message = `must NOT have more than ${params.limit} items`;
      } else if (keyword === 'uniqueItems') {
        message = 'must NOT have duplicate items';
      } else if (keyword === 'contains') {
        message = 'must contain at least one valid item';
      } else if (keyword === 'items') {
        message = 'array items are invalid';
      } else if (keyword === 'allOf') {
        message = 'must match all of the subschemas';
      } else if (keyword === 'anyOf') {
        message = 'must match a subschema in anyOf';
      } else if (keyword === 'oneOf') {
        message = 'must match exactly one subschema in oneOf';
      } else if (keyword === 'not') {
        message = 'must NOT match the subschema';
      } else if (keyword === 'format') {
        const formatName = err.expected || err.value;
        params.format = formatName;
        message = `must match format "${formatName}"`;
      } else if (keyword === 'if') {
        message = 'must match "if" schema';
      } else if (keyword === 'then') {
        message = 'must match "then" schema';
      } else if (keyword === 'else') {
        message = 'must match "else" schema';
      } else if (keyword === 'false schema') {
        message = 'boolean schema false is always invalid';
      }

      return new ValidationError({
        keyword,
        instancePath: '',  // TODO: implement proper path tracking
        schemaPath: err.object?.path || '',
        params,
        message,
      });
    });
  }

  /**
   *
   * @param {JarenValidator} self
   * @param {string} origin
   * @param {Map} schemas
   * @returns {(data) => boolean | {valid: boolean, errors: ValidationError[]}}
   */
  static #compileSchema(self, origin, schemas) {
    const root = new ValidationRoot(
      origin,
      schemas,
      self.#formats,
      self.#options.validation,
      self.#options.traverse);

    const collectErrors = self.#options.validation?.collectErrors || false;

    function jarenValidateSchema(data) {
      const valid = root.validate(data);
      if (collectErrors) {
        return {
          valid,
          errors: valid ? [] : JarenValidator.#convertErrors(root.errors)
        };
      }
      return valid;
    }

    Object.defineProperty(jarenValidateSchema, "errors", {
      get: function () { return root.errors }
    })

    return jarenValidateSchema;
  }

  /**
   * Compile schema using a pre-created ValidationRoot (with pre-compiled refs).
   * @param {JarenValidator} self
   * @param {string} origin
   * @param {Map} schemas
   * @param {ValidationRoot} root - Pre-created root with pre-compiled refs
   * @returns {(data) => boolean | {valid: boolean, errors: ValidationError[]}}
   */
  static #compileSchemaWithRoot(self, origin, schemas, root) {
    const collectErrors = self.#options.validation?.collectErrors || false;

    function jarenValidateSchema(data) {
      const valid = root.validate(data);
      if (collectErrors) {
        return {
          valid,
          errors: valid ? [] : JarenValidator.#convertErrors(root.errors)
        };
      }
      return valid;
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
   * @param {boolean | object | object[]} schema - The meta-schema(s) to add
   * @param {string} [key] - Optional key/URI for the meta-schema
   * @returns {JarenValidator} This validator instance for chaining
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
   * @returns {object|null} The registered schema, or null if not found
   */
  getSchema(key) {
    key = JarenValidator.normalizeUriKey(key)
    return this.#schemas.get(key) || null;
  }

  /**
   * Validates a schema against a registered meta-schema.
   * This is used to ensure schemas are valid according to the JSON Schema specification.
   * @param {boolean | object} schema - The schema to validate
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
   * @private
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
        } catch (e) {
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
            } catch (e) {
              // Invalid URL, skip this candidate
            }
          }
        }
      }

      try {
        root.createObject(id, schema, baseUri);
      } catch (e) {
        // Ref may not be resolvable yet, that's ok
      }
    }
  }

  /**
   * Compiles a schema into a validation function.
   * This is the main method for creating validators. It resolves all $ref references,
   * compiles the schema structure, and returns a function that validates data.
   * @param {boolean | object} schema - The schema to compile
   * @param {object[]} [schemas] - Additional schemas to reference during compilation
   * @returns {(data: any) => boolean | {valid: boolean, errors: ValidationError[]}} A validation function
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
   * // With error collection
   * validator = new JarenValidator({ collectErrors: true });
   * const result = validate({ name: 123 });
   * // result = { valid: false, errors: [...] }
   */
  compile(schema, schemas = undefined) {
    const { origin, map } = JarenValidator.#traverseSchema(schema, schemas, this.#schemas, this.#options.traverse);

    // Pre-compile all refs before returning the validator
    // This ensures all ref chains are resolved at compile time
    const root = new ValidationRoot(
      origin,
      map,
      this.#formats,
      this.#options.validation,
      this.#options.traverse
    );

    // Pre-create validation objects for all refs
    JarenValidator.#precompileRefs(root, map, origin);

    // Re-compile with the pre-populated root
    return JarenValidator.#compileSchemaWithRoot(this, origin, map, root);
  }
}
