//@ts-check

/**
 * JSON Schema Validation Error
 * 
 * Represents a validation error according to the JSON Schema specification.
 * @see https://json-schema.org/draft/2020-12/json-schema-core.html#output
 */
export class ValidationError {
  /**
   * @param {object} options - Error options
   * @param {string} options.keyword - The keyword that failed validation
   * @param {string} options.instancePath - JSON Pointer to the data location (e.g., "/foo/0/bar")
   * @param {string} options.schemaPath - JSON Pointer to the schema location (e.g., "#/properties/foo")
   * @param {object} options.params - Keyword-specific parameters
   * @param {string} [options.message] - Human-readable error message
   * @param {any} [options.data] - The data that failed validation
   */
  constructor(options) {
    this.keyword = options.keyword;
    this.instancePath = options.instancePath || '';
    this.schemaPath = options.schemaPath || '';
    this.params = options.params || {};
    this.message = options.message || this._generateMessage();
    this.data = options.data;
  }

  /**
   * Generate a default error message based on keyword and params
   * @returns {string} The generated message
   * @private
   */
  _generateMessage() {
    const msg = errorMessages[this.keyword];
    if (typeof msg === 'function') {
      return msg(this.params);
    }
    return msg || `validation failed for keyword '${this.keyword}'`;
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
 * Error message generators for each keyword
 * Each function takes params and returns a human-readable message
 */
export const errorMessages = {
  // Type validation
  type: ({ type, types }) => {
    if (types && Array.isArray(types)) {
      return `must be one of the following types: ${types.join(', ')}`;
    }
    return `must be ${type === 'integer' ? 'an' : 'a'} ${type}`;
  },
  
  // Required validation
  required: ({ missingProperty }) => {
    return missingProperty 
      ? `must have required property '${missingProperty}'`
      : 'must have required properties';
  },
  
  // Number validation
  minimum: ({ limit, comparison }) => {
    return comparison === '>' 
      ? `must be > ${limit}` 
      : `must be >= ${limit}`;
  },
  maximum: ({ limit, comparison }) => {
    return comparison === '<' 
      ? `must be < ${limit}` 
      : `must be <= ${limit}`;
  },
  exclusiveMinimum: ({ limit }) => `must be > ${limit}`,
  exclusiveMaximum: ({ limit }) => `must be < ${limit}`,
  multipleOf: ({ multipleOf }) => `must be multiple of ${multipleOf}`,
  
  // String validation
  minLength: ({ limit }) => `must NOT have fewer than ${limit} characters`,
  maxLength: ({ limit }) => `must NOT have more than ${limit} characters`,
  pattern: ({ pattern }) => `must match pattern "${pattern}"`,
  format: ({ format }) => `must match format "${format}"`,
  contentEncoding: ({ encoding }) => `must respect content encoding "${encoding}"`,
  contentMediaType: ({ mediaType }) => `must respect content media type "${mediaType}"`,
  
  // Array validation
  minItems: ({ limit }) => `must NOT have fewer than ${limit} items`,
  maxItems: ({ limit }) => `must NOT have more than ${limit} items`,
  uniqueItems: () => 'must NOT have duplicate items',
  contains: () => 'must contain at least one valid item',
  
  // Object validation
  minProperties: ({ limit }) => `must NOT have fewer than ${limit} properties`,
  maxProperties: ({ limit }) => `must NOT have more than ${limit} properties`,
  additionalProperties: ({ additionalProperty }) => {
    return additionalProperty 
      ? `must NOT have additional property '${additionalProperty}'`
      : 'must NOT have additional properties';
  },
  propertyNames: ({ propertyName }) => {
    return propertyName 
      ? `property name '${propertyName}' is invalid`
      : 'property name is invalid';
  },
  dependencies: ({ property, missing }) => {
    return missing 
      ? `must have property '${missing}' when property '${property}' is present`
      : `has unmet dependencies`;
  },
  requiredProperty: ({ missingProperty }) => {
    return `must have required property '${missingProperty}'`;
  },
  
  // Enum and const
  enum: ({ allowedValues }) => `must be equal to one of the allowed values`,
  const: ({ allowedValue }) => `must be equal to constant`,
  
  // Combination keywords
  allOf: () => 'must match all of the subschemas',
  anyOf: () => 'must match a subschema in anyOf',
  oneOf: () => 'must match exactly one subschema in oneOf',
  not: () => 'must NOT match the subschema',
  
  // Conditional
  if: () => 'must match "if" schema',
  then: () => 'must match "then" schema',
  else: () => 'must match "else" schema',
  
  // References
  $ref: ({ ref }) => `must pass validation for ${ref}`,
  
  // Boolean schemas
  'false schema': () => 'boolean schema false is always invalid',
  
  // Nullable
  nullable: () => 'must be null',
};

/**
 * Error collection manager
 * Handles collecting and formatting validation errors
 */
export class ErrorCollection {
  constructor() {
    this.errors = [];
  }

  /**
   * Add an error to the collection
   * @param {ValidationError} error - The error to add
   */
  add(error) {
    this.errors.push(error);
  }

  /**
   * Get all errors
   * @returns {ValidationError[]} Array of errors
   */
  getErrors() {
    return this.errors;
  }

  /**
   * Get error count
   * @returns {number} Number of errors
   */
  get count() {
    return this.errors.length;
  }

  /**
   * Check if there are any errors
   * @returns {boolean} True if there are errors
   */
  hasErrors() {
    return this.errors.length > 0;
  }

  /**
   * Clear all errors
   */
  clear() {
    this.errors = [];
  }

  /**
   * Convert all errors to plain objects
   * @returns {object[]} Array of error objects
   */
  toJSON() {
    return this.errors.map(e => e.toJSON());
  }
}

/**
 * Create a validation result object
 * @param {boolean} valid - Whether validation passed
 * @param {ValidationError[]} [errors] - Validation errors if any
 * @returns {object} Validation result
 */
export function createValidationResult(valid, errors = []) {
  return {
    valid,
    errors: errors.map(e => e.toJSON ? e.toJSON() : e),
  };
}

/**
 * Format an instance path from path segments
 * @param {string[]} segments - Path segments
 * @returns {string} JSON Pointer path
 */
export function formatInstancePath(segments) {
  if (!segments || segments.length === 0) {
    return '';
  }
  
  return segments.map(seg => {
    // Escape special characters according to JSON Pointer spec
    const str = String(seg);
    return '/' + str.replace(/~/g, '~0').replace(/\//g, '~1');
  }).join('');
}

/**
 * Format a schema path from path segments
 * @param {string[]} segments - Path segments
 * @returns {string} JSON Pointer path
 */
export function formatSchemaPath(segments) {
  if (!segments || segments.length === 0) {
    return '#';
  }
  
  const path = segments.map(seg => {
    const str = String(seg);
    return '/' + str.replace(/~/g, '~0').replace(/\//g, '~1');
  }).join('');
  
  return '#' + path;
}
