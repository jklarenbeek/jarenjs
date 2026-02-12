/**
 * JarenJS Validation - TypeScript Type Definitions
 */

/**
 * Ajv-style $data reference object.
 * The value is a Relative JSON Pointer that resolves from the current data location.
 * Format: <non-negative-integer>("#"|<json-pointer>)
 * - "0" - The current value itself
 * - "0#" - The property name/index of the current value
 * - "0/foo" - The "foo" property of the current value
 * - "1" - The parent value
 * - "1/foo" - The "foo" property of the parent value
 * @see https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data
 */
export interface DollarDataRef {
  $data: string;
}

/**
 * Data keyword schema for referencing instance data.
 * Allows constraints to reference values from other parts of the instance.
 * @see https://docs.json-everything.net/schema/examples/data-ref/
 */
export interface DataKeywordSchema {
  // Number constraints referencing instance data
  minimum?: string;           // JSON Pointer to minimum value
  maximum?: string;           // JSON Pointer to maximum value
  exclusiveMinimum?: string;  // JSON Pointer to exclusive minimum value
  exclusiveMaximum?: string;  // JSON Pointer to exclusive maximum value
  multipleOf?: string;        // JSON Pointer to multipleOf value

  // String constraints referencing instance data
  minLength?: string;         // JSON Pointer to minLength value
  maxLength?: string;         // JSON Pointer to maxLength value
  pattern?: string;           // JSON Pointer to pattern string
  format?: string;            // JSON Pointer to format name

  // Enum/const referencing instance data
  enum?: string;              // JSON Pointer to array of valid values
  const?: string;             // JSON Pointer to constant value

  // Array constraints referencing instance data
  minItems?: string;          // JSON Pointer to minItems value
  maxItems?: string;          // JSON Pointer to maxItems value

  // Object constraints referencing instance data
  minProperties?: string;     // JSON Pointer to minProperties value
  maxProperties?: string;     // JSON Pointer to maxProperties value
}

/**
 * Represents a JSON Schema object.
 * Covers the most common JSON Schema draft-07/2019-09/2020-12 keywords.
 */
export interface JSONSchema {
  // Core schema metadata
  $id?: string;
  $schema?: string;
  $ref?: string;
  $anchor?: string;
  $dynamicRef?: string;
  $dynamicAnchor?: string;
  $vocabulary?: Record<string, boolean>;
  $comment?: string;
  $defs?: Record<string, JSONSchema>;
  definitions?: Record<string, JSONSchema>; // draft-07 and earlier

  // Type constraints
  type?: string | string[];
  enum?: unknown[] | DollarDataRef;
  const?: unknown | DollarDataRef;

  // String constraints
  minLength?: number | DollarDataRef;
  maxLength?: number | DollarDataRef;
  pattern?: string | DollarDataRef;
  contentEncoding?: string;
  contentMediaType?: string;
  contentSchema?: JSONSchema;

  // Number constraints
  multipleOf?: number | DollarDataRef;
  minimum?: number | DollarDataRef;
  maximum?: number | DollarDataRef;
  exclusiveMinimum?: number | boolean | DollarDataRef;
  exclusiveMaximum?: number | boolean | DollarDataRef;

  // Object constraints
  properties?: Record<string, JSONSchema>;
  patternProperties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  unevaluatedProperties?: boolean | JSONSchema;
  required?: string[] | DollarDataRef;
  propertyNames?: JSONSchema;
  minProperties?: number | DollarDataRef;
  maxProperties?: number | DollarDataRef;

  // Array constraints
  items?: JSONSchema | JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  unevaluatedItems?: boolean | JSONSchema;
  contains?: JSONSchema;
  minItems?: number | DollarDataRef;
  maxItems?: number | DollarDataRef;
  uniqueItems?: boolean | DollarDataRef;
  minContains?: number;
  maxContains?: number;

  // Combining schemas
  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: JSONSchema;
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;

  // Conditional schemas
  dependentSchemas?: Record<string, JSONSchema>;
  dependentRequired?: Record<string, string[]>;

  // Metadata
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;

  // Format
  format?: string | DollarDataRef;

  // Format range extensions (non-standard but commonly used)
  formatMinimum?: string;
  formatMaximum?: string;
  formatExclusiveMinimum?: string;
  formatExclusiveMaximum?: string;

  // Data keyword for referencing instance data (json-everything style)
  data?: DataKeywordSchema;

  // Extensibility for custom keywords and additional properties
  [key: string]: unknown;
}

/**
 * Validation error details.
 */
export interface ValidationError {
  /** The keyword that failed validation */
  keyword: string;
  /** JSON Pointer to the data location */
  instancePath: string;
  /** JSON Pointer to the schema location */
  schemaPath: string;
  /** Keyword-specific parameters */
  params: Record<string, unknown>;
  /** Human-readable error message */
  message?: string;
}

/**
 * Validation options for configuring validator behavior.
 */
export class ValidationOptions {
  /**
   * Creates validation options.
   * @param skipErrors - Whether to stop at first error or continue
   * @param useGrapheme - Whether to use grapheme cluster counting for strings
   * @param collectErrors - Whether to collect all errors or just return boolean
   */
  constructor(
    skipErrors?: boolean,
    useGrapheme?: boolean,
    collectErrors?: boolean
  );

  /** Whether to stop at first error or continue */
  skipErrors: boolean;
  /** Whether to use grapheme cluster counting for string length */
  useGrapheme: boolean;
  /** Whether to collect and return detailed errors */
  collectErrors: boolean;
}

/**
 * Options for JSON Pointer creation and schema traversal.
 */
export class TraverseOptions {
  /**
   * Creates traverse options.
   * @param origin - The origin URI for schemas
   * @param mergeSchemas - Whether to merge schemas during ref resolution
   * @param anchorsGlobal - Whether anchors are global or document-scoped
   * @param anchorsAllowed - Whether anchors are allowed
   * @param skipErrors - Whether to skip errors during traversal
   */
  constructor(
    origin?: string,
    mergeSchemas?: boolean,
    anchorsGlobal?: boolean,
    anchorsAllowed?: boolean,
    skipErrors?: boolean
  );

  /** The origin URI for schemas */
  origin: string;
  /** Whether to merge schemas during ref resolution */
  mergeSchemas: boolean;
  /** Whether anchors are global or document-scoped */
  anchorsGlobal: boolean;
  /** Whether anchors are allowed */
  anchorsAllowed: boolean;
  /** Whether to skip errors during traversal */
  skipErrors: boolean;
}

/**
 * Type for format compiler functions.
 */
export type FormatCompiler = (
  schemaObj: ValidationObject,
  jsonSchema: JSONSchema
) => (data: unknown, dataPath?: string) => boolean;

/**
 * Represents a compiled validation object for a specific schema.
 */
export class ValidationObject {
  /** The path/URI identifier for this schema */
  readonly path: string;
  /** The compiled validator function */
  readonly validate: (data: unknown, dataPath?: string, dataRoot?: unknown) => boolean;
  /** The current validation errors from the root */
  readonly errors: unknown[];

  /**
   * Creates an error handler function for the given keyword.
   * @param expected - The expected value that failed validation
   * @param key - The keyword or keywords that failed
   * @returns A function that adds an error and returns false
   */
  createErrorHandler(
    expected: unknown,
    key: string | string[]
  ): (data: unknown, dataKey?: string, ...meta: unknown[]) => boolean;

  /**
   * Creates a validator function for a child schema.
   * @param schema - The child schema to compile
   * @param key - The property key where the schema is located
   * @param index - Optional array index for tuple items
   * @returns The compiled validator function, or undefined if schema is invalid
   */
  createValidator(
    schema: JSONSchema | boolean,
    key: string,
    index?: number
  ): ((data: unknown) => boolean) | undefined;
}

/**
 * Validation root manages the compilation and validation context for a schema.
 * It holds references to all schemas, formats, options, and compiled ValidationObjects.
 */
export class ValidationRoot {
  /**
   * Creates a new ValidationRoot.
   * @param origin - The root schema origin/URI
   * @param schemas - Map of schema paths to schema objects
   * @param formats - Registered format validators
   * @param opts - Validation options
   * @param traverse - Schema traversal options
   */
  constructor(
    origin: string,
    schemas: Map<string, JSONSchema | boolean>,
    formats: Record<string, FormatCompiler>,
    opts?: ValidationOptions,
    traverse?: TraverseOptions
  );

  /** The root schema origin/URI */
  readonly rootOrigin: string;
  /** Schema traversal options */
  readonly traverse: TraverseOptions;
  /** Validation options */
  readonly options: ValidationOptions;
  /** Registered format validators */
  readonly formats: Record<string, FormatCompiler>;
  /** Array of validation errors */
  readonly errors: unknown[];

  /**
   * Validates data against the root schema.
   * @param data - The data to validate
   * @returns True if valid, false otherwise
   */
  validate(data: unknown): boolean;
}

/**
 * Validator options for creating a JarenValidator instance.
 * Can be created with positional arguments or an options object.
 */
export class ValidatorOptions {
  /**
   * Creates validator options.
   * @param formats - Format validators or options object
   * @param schemas - Initial schemas to register
   * @param validation - Validation behavior options
   * @param traverse - Schema traversal options
   */
  constructor(
    formats?: Record<string, FormatCompiler> | { formats?: Record<string, FormatCompiler>; schemas?: (JSONSchema | boolean)[]; validation?: ValidationOptions; traverse?: TraverseOptions; skipErrors?: boolean; useGrapheme?: boolean; collectErrors?: boolean },
    schemas?: (JSONSchema | boolean)[],
    validation?: ValidationOptions,
    traverse?: TraverseOptions
  );

  /** Registered format validators */
  formats: Record<string, FormatCompiler>;
  /** Initial schemas to register */
  schemas: (JSONSchema | boolean)[];
  /** Validation behavior options */
  validation: ValidationOptions;
  /** Schema traversal options */
  traverse: TraverseOptions;
}

/**
 * JarenValidator is the main entry point for JSON Schema validation.
 * It manages schema registration, format registration, and compilation.
 */
export class JarenValidator {
  /**
   * Creates a new JarenValidator instance.
   * @param options - Validator options including formats, schemas, validation options, and traverse options
   */
  constructor(options?: ValidatorOptions);

  /**
   * Adds a format validator.
   * @param name - The format name (e.g., 'email', 'uri', 'date-time')
   * @param formatCompiler - A function that compiles format validators
   * @returns This validator instance for chaining
   */
  addFormat(name: string, formatCompiler: FormatCompiler): this;

  /**
   * Adds multiple format validators at once.
   * @param formatCompilers - Object mapping format names to compiler functions
   * @returns This validator instance for chaining
   */
  addFormats(formatCompilers: Record<string, FormatCompiler>): this;

  /**
   * Adds schema(s) to the validator instance.
   * This method does not compile schemas - it only registers them for reference.
   * @param schema - The schema(s) to add
   * @param key - Optional key/URI to register the schema under
   * @returns This validator instance for chaining
   */
  addSchema(schema: JSONSchema | boolean | (JSONSchema | boolean)[], key?: string): this;

  /**
   * Adds meta-schema(s) that can be used to validate schemas.
   * @param schema - The meta-schema(s) to add
   * @param key - Optional key/URI for the meta-schema
   * @returns This validator instance for chaining
   */
  addMetaSchema(schema: JSONSchema | boolean | (JSONSchema | boolean)[], key?: string): this;

  /**
   * Retrieves a registered schema by its key/URI.
   * @param key - The schema URI/key
   * @returns The registered schema, or null if not found
   */
  getSchema(key: string): JSONSchema | boolean | null;

  /**
   * Validates a schema against a registered meta-schema.
   * @param schema - The schema to validate
   * @returns True if the schema is valid
   */
  validateSchema(schema: JSONSchema | boolean): boolean;

  /**
   * Compiles a schema into a validation function.
   * This is the main method for creating validators.
   * @param schema - The schema to compile
   * @param schemas - Additional schemas to reference during compilation
   * @returns A validation function
   */
  compile<T = unknown>(
    schema: JSONSchema | boolean,
    schemas?: (JSONSchema | boolean)[]
  ): {
    (data: T): boolean | { valid: boolean; errors: ValidationError[] };
    /** Array of validation errors from the last validation */
    errors: unknown[];
  };
}

/**
 * Register multiple format compilers globally.
 * Note: This function requires a formats registry object as the first parameter.
 * @param formats - The formats registry object
 * @param formatCompilers - Object mapping format names to compiler functions
 */
export function registerFormatCompilers(
  formats: Record<string, FormatCompiler>,
  formatCompilers: Record<string, FormatCompiler>
): Record<string, FormatCompiler>;

/**
 * Default schema draft URI used by the validator.
 */
export const DEFAULT_SCHEMA_DRAFT: string;
