//@ts-check

import {
  isObjectClass,
} from '@jaren/core';

import {
  compileSchemaObject,
} from './schema.js';

import {
  storeSchemaIdsInMap,
  restoreSchemaRefsInMap,
  resolveRefSchemaDeep,
  encodeJsonPointerPath,
  SchemaRefOptions,
  createJsonPointer,
} from './traverse.js';

import {
  isBoolOrObjectClass,
  hasSchemaRef,
} from './tools.js';

export {
  registerFormatCompilers
} from './format.js';

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

class ValidationOptions extends SchemaRefOptions {
  constructor(origin = 'https://github.com/jklarenbeek/jaren', mergeSchemas = true, anchorsGlobal = true, anchorsAllowed = true, skipErrors = true) {
    super(mergeSchemas, anchorsGlobal, anchorsAllowed, skipErrors);
    this.origin = origin;
  }
}

class ValidationRoot {
  static _createObject(self, path, schema) {
    const objects = self._objects;
    if (objects.has(path)) {
      const p = objects.get(path);
      if (p != null)
        throw new Error(`Object at '${path}' is already created`);
    }

    const obj = new ValidationObject(self, path, schema);
    objects.set(path, obj);
    return obj;
  }

  constructor(schemas, schema, origin, opts = new ValidationOptions()) {
    this._options = opts;
    this._schemas = schemas;
    this._rootOrigin = origin;
    this._objects = new Map();
    this._errors = [];
    this._firstSchema = ValidationRoot._createObject(this, origin, schema);
  }

  get options() { return this._options; }

  createObject(path, schema) {
    return ValidationRoot._createObject(this, path, schema);
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
    const opts = this._options;
    const { id, schema: root } = resolveRefSchemaDeep(schemas, path, schema, opts);
    return ValidationRoot._createObject(this, id, root);
  }

  addError(error /*:JarenError*/) {
    this._errors.push(error);
    return false;
  }

  validate(data /*:unknown*/) {
    // clear all errors
    this._errors.length = 0;
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
   * @returns {function(any, any):boolean} A function that validates data against the compiled schema and returns a boolean.
   */
  static _compileValidator(self, path, schema) {
    if (!hasSchemaRef(schema))
      return compileSchemaObject(self, schema);

    const root = self._root;

    const { id: ref } = createJsonPointer(schema.$ref, path, root.options);

    const resolved = root.unresolvedObject(ref);
    if (resolved != null) {
      const validator = resolved.validate;
      self._validator = function validateRefSchemaOnTime(data, dataRoot) {
        return validator(data, dataRoot);
      };
      return self._validator;
    }

    return function resolveSchemaCompiler(data, dataRoot) {
      const obj = root.resolveObject(ref, path, schema);
      const validator = obj.validate;
      self._validator = function validateRefSchemaLate(_data, _dataRoot) {
        return validator(_data, _dataRoot);
      };
      return self._validator(data, dataRoot);
    };
  }

  constructor(root, path, schema) {
    this._root = root;
    this._path = path;
    this._members = [];
    this._schema = schema;
    this._validator = null;

    this._validator = ValidationObject._compileValidator(this, path, schema);
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

    const id = isObjectClass(schema)
      ? createJsonPointer(schema.$id, this._path).id
      : this._path;

    const root = this._root;
    const path = index == null
      ? encodeJsonPointerPath(id, key)
      : encodeJsonPointerPath(id, key, String(index));

    const child = root.createObject(path, schema);
    this._members.push(child);

    return child._validator;
  }
}

export function compileSchemaValidator(schema, referenceSchemas = [], opts = new ValidationOptions()) {
  // initialize schema map for all ids and refs
  const schemas = new Map();
  const origin = storeSchemaIdsInMap(schemas, opts.origin, schema, opts);

  // Then add the other reference schemas
  referenceSchemas.forEach(ref => storeSchemaIdsInMap(schemas, origin, ref, opts));

  restoreSchemaRefsInMap(schemas, opts);

  // create a new schema root
  const root = new ValidationRoot(schemas, schema, origin, opts);

  return {
    validate: (data) => root.validate(data),
  };
}
