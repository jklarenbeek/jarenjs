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

class ValidationError {
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

class ValidationOptions {
  constructor(
    skipErrors = true,
    useGrapheme = true
  ) {
    this.skipErrors = skipErrors;
    this.useGrapheme = true;
  }
}

class ValidationRoot {
  static _createObject(self, path, schema, baseUri) {
    const objects = self._objects;
    if (objects.has(path)) {
      const p = objects.get(path);
      if (p != null)
        throw new Error(`Object at '${path}' is already created`);
    }

    const obj = new ValidationObject(self, path, schema, baseUri);
    objects.set(path, obj);
    return obj;
  }

  constructor(origin, schemas, formats, opts = new ValidationOptions(), traverse = new TraverseOptions) {
    const schema = schemas.get(origin);
    this._rootOrigin = origin;
    this._schemas = schemas;
    this._formats = formats;

    this._options = opts;
    this._traverse = traverse;

    this._objects = new Map();
    this._errors = [];

    // For the root schema, baseUri is the origin
    this._firstSchema = ValidationRoot._createObject(this, origin, schema, origin);
  }

  get options() { return this._options; }

  get formats() { return this._formats; }

  get errors() { return this._errors; }

  createObject(path, schema, baseUri) {
    return ValidationRoot._createObject(this, path, schema, baseUri);
  }

  unresolvedObject(path) {
    const objects = this._objects;
    if (objects.has(path))
      return objects.get(path);

    objects.set(path, null);
    return null;
  }

  resolveObject(ref, path, schema) {
    // return a validator if compiled
    const objects = this._objects;
    if (objects.has(ref)) {
      const obj = objects.get(ref);
      if (obj != null)
        return objects.get(ref);
    }

    const schemas = this._schemas;
    const traverse = this._traverse;
    const { id, schema: root } = resolveRefSchemaDeep(schemas, path, schema, traverse);

    if (objects.has(id)) {
      const obj = objects.get(id);
      if (obj != null)
        return obj;
    }

    return ValidationRoot._createObject(this, id, root);
  }

  addError(error /*:JarenError*/) {
    this._errors.push(error);
    return false;
  }

  validate(data /*:unknown*/) {
    // clear all errors
    this._errors = [];
    // call compiled validator
    return this._firstSchema.validate(data, data);
  }
}

class ValidationObject {
  /**
   * Compiles a schema validation error handler
   * @param {ValidationObject} self The validation object that is compiling this validator
   * @param {string} path The path to this schema object
   * @param {any} schema The schema object to compile
   * @param {string} baseUri The base URI for resolving $ref (parent's base, before any sibling $id)
   * @returns {function(any, any):boolean} A function that validates data against the compiled schema and returns a boolean.
   */
  static _compileValidator(self, path, schema, baseUri) {
    if (!hasSchemaRef(schema))
      return compileSchemaObject(self, schema);

    const root = self._root;

    // When resolving $ref, use baseUri (parent's base) instead of path.
    // This ensures that a sibling $id does not change the base URI for $ref resolution.
    // Per JSON Schema spec, $ref prevents a sibling $id from changing the base URI.
    const refBase = baseUri || path;
    const { id: ref } = createJsonPointer(schema.$ref, refBase, root._traverse);

    const resolved = root.unresolvedObject(ref);
    if (resolved != null) {
      const validator = resolved.validate;
      self._validator = function validateRefSchemaOnTime(data, dataRoot) {
        return validator(data, dataRoot);
      };
      return self._validator;
    }

    return function resolveSchemaCompiler(data, dataRoot) {
      const obj = root.resolveObject(ref, refBase, schema);
      const validator = obj.validate;
      self._validator = function validateRefSchemaLate(_data, _dataRoot) {
        return validator(_data, _dataRoot);
      };
      return self._validator(data, dataRoot);
    };
  }

  constructor(root, path, schema, baseUri) {
    this._root = root;
    this._path = path;
    this._baseUri = baseUri || path;  // Store base URI for child objects
    this._members = [];
    this._schema = schema;
    this._validator = null;

    this._validator = ValidationObject._compileValidator(this, path, schema, baseUri);
  }

  get path() {
    return this._path;
  }

  get errors() {
    return this._root.errors;
  }

  get validate() {
    return this._validator;
  }

  get options() {
    return this._root.options;
  }

  get formats() {
    return this._root.formats;
  }

/**
 * Compiles a schema validation error handler
 * @param {any} expected - anything that is expected by this handler
 * @param {string | string[]} key - the key or keys that is expected
 * @returns {function(unknown): boolean} A function that validates data against the compiled schema and returns a boolean.
 */
  createErrorHandler(expected, key) {
    const self = this;

    if (!Array.isArray(key)) {
      return function addNormalError(data, ...meta) {
        const error = new ValidationError(self, key, expected, null, data, meta);
        return self._root.addError(error);
      };
    }
    else {
      return function addKeyedError(dataKey, data, ...meta) {
        const error = new ValidationError(self, key, expected, dataKey, data, meta);
        return self._root.addError(error);
      };
    }
  }

  createValidator(schema, key, index) {
    if (!isBoolOrObjectClass(schema))
      return undefined;

    const root = this._root;
    // Use root origin as base if path is just an anchor (not a valid base URL)
    const basePath = this._path.startsWith('#') ? root._rootOrigin : this._path;

    const id = isObjectClass(schema)
      ? createJsonPointer(schema.$id, basePath).id
      : this._path;

    const path = index == null
      ? encodeJsonPointerPath(id, key)
      : encodeJsonPointerPath(id, key, String(index));

    // Pass basePath as the baseUri for the child object.
    // This ensures that $ref in the child will be resolved against basePath,
    // not against any sibling $id that the child might have.
    const child = root.createObject(path, schema, basePath);
    this._members.push(child);

    return child._validator;
  }
}

export class ValidatorOptions {
  constructor(
    formats = {},
    schemas = [],
    validation = new ValidationOptions(),
    traverse = new TraverseOptions(),
  ) {
    this.formats = formats;
    this.schemas = schemas;
    this.validation = validation;
    this.traverse = traverse;
  }
}

export class JarenValidator {

  #formats = {}
  #schemas = new Map();
  #metaSchemas = new Map();
  #options = new ValidatorOptions();

  /**
   * Create a new JarenValidator instance
   * @param {ValidatorOptions} [options] - Validator options
   */
  constructor(options = new ValidatorOptions()) {
    this.#formats = options.formats || {};
    this.#schemas = new Map();
    this.#metaSchemas = new Map();
    this.#options = options;
  }

  /**
   * Add format to validate strings or numbers.
   * @param {string} name
   * @param {Function} formatCompiler
   * @returns {JarenValidator}
   */
  addFormat(name, formatCompiler) {
    registerFormatCompiler(
      this.#formats,
      name,
      formatCompiler);
    return this;
  }

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
   * Add schema(s) to validator instance.
   * This method does not compile schemas (but it still validates them).
   * Because of that dependencies can be added in any order and
   * circular dependencies are supported.
   * It also prevents unnecessary compilation of schemas that are
   * containers for other schemas but not used as a whole.
   * @param {boolean | object | object[]} schema
   * @param {string | undefined} key
   * @returns {JarenValidator}
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
   *
   * @param {JarenValidator} self
   * @param {string} origin
   * @param {Map} schemas
   * @returns {(data) => boolean}
   */
  static #compileSchema(self, origin, schemas) {
    const root = new ValidationRoot(
      origin,
      schemas,
      self.#formats,
      self.#options.validation,
      self.#options.traverse);

    function jarenValidateSchema(data) {
      return root.validate(data)
    }

    Object.defineProperty(jarenValidateSchema, "errors", {
      get: function () { return root._errors }
    })

    return jarenValidateSchema;
  }

  static normalizeUriKey(key) {
    return key;
  }

  /**
   * Adds meta schema(s) that can be used to validate other schemas.
   * @param {boolean | object | object[]} schema
   * @param {string | undefined} key
   * @returns {JarenValidator}
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
   *
   * @param {string} key
   * @returns {object}
   */
  getSchema(key) {
    key = JarenValidator.normalizeUriKey(key)
    return this.#schemas.get(key) || null;
  }

  /**
   * Validates schema. This method should be used to validate schemas rather than validate due to the inconsistency of uri format in JSON Schema standard.
   * By default this method is called automatically when the schema is added, so you rarely need to use it directly.
   * If schema doesn't have $schema property, it is validated against draft 6 meta-schema (option meta should not be false).
   * If schema has $schema property, then the schema with this id (that should be previously added) is used to validate passed schema.
   * Errors will be available at ajv.errors
   * @param {boolean | object} schema
   * @returns {boolean}
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
   * Generate validating function and cache the compiled schema for future use.
   * Note: This function does NOT return a promise. Use compileAsync instead!
   * @param {boolean | object} schema
   * @param {object[] | undefined} [schemas=undefined]
   * @returns {(data: any) => boolean}
   */
  compile(schema, schemas = undefined) {
    const { origin, map } = JarenValidator.#traverseSchema(schema, schemas, this.#schemas, this.#options.traverse);
    return JarenValidator.#compileSchema(this, origin, map);
  }

  /**
   * Generate validating function and cache the compiled schema for future use.
   * Note: This function returns a promise.
   * @param {boolean | object} schema
   * @returns {Promise<any>}
   */
  compileAsync(schema) {
    throw new Error('compileAsync is not implemented');
  }
}
