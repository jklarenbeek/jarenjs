/**
 * JarenJS Validation - TypeScript Type Definitions
 */

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
  enum?: unknown[];
  const?: unknown;

  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  contentEncoding?: string;
  contentMediaType?: string;
  contentSchema?: JSONSchema;

  // Number constraints
  multipleOf?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;

  // Object constraints
  properties?: Record<string, JSONSchema>;
  patternProperties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  unevaluatedProperties?: boolean | JSONSchema;
  required?: string[];
  propertyNames?: JSONSchema;
  minProperties?: number;
  maxProperties?: number;

  // Array constraints
  items?: JSONSchema | JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  unevaluatedItems?: boolean | JSONSchema;
  contains?: JSONSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
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
  format?: string;

  // Format range extensions (non-standard but commonly used)
  formatMinimum?: string;
  formatMaximum?: string;
  formatExclusiveMinimum?: string;
  formatExclusiveMaximum?: string;

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
export interface ValidationOptions {
  /** Skip error collection for faster validation */
  skipErrors?: boolean;
  /** Enable strict mode (throw on unknown formats) */
  strict?: boolean;
  /** Coerce types when possible (e.g., "123" → 123 for type: "integer") */
  coerceTypes?: boolean;
  /** Remove additional properties not defined in schema */
  removeAdditional?: boolean | 'all' | 'failing';
  /** Use defaults from schema when value is undefined */
  useDefaults?: boolean;
}

/**
 * Represents a compiled validation object for a specific schema.
 */
export interface ValidationObject {
  /** The path/URI identifier for this schema */
  readonly path: string;
  /** The compiled validator function */
  readonly validate: (data: unknown, rootData?: unknown) => boolean;
  /** The schema object */
  readonly schema: JSONSchema;
  /** Validation options */
  readonly options: ValidationOptions;
  /** Creates an error handler function for the given keyword */
  createErrorHandler(expected: unknown, key: string, constraint?: string): (data: unknown, dataPath?: string) => boolean;
}

/**
 * JarenValidator class - Main validator instance.
 */
export class JarenValidator {
  /**
   * Creates a new JarenValidator instance.
   * @param options - Validation options
   */
  constructor(options?: ValidationOptions);

  /**
   * Add a schema to the validator's schema cache.
   * @param schema - The schema to add
   * @param key - Optional key/URI to identify the schema
   */
  addSchema(schema: JSONSchema | boolean, key?: string): void;

  /**
   * Compile a schema into a validation function.
   * @param schema - The schema to compile
   * @param schemas - Additional schemas to include in the compilation context
   * @returns A validation function
   */
  compile<T = unknown>(schema: JSONSchema | boolean, schemas?: Record<string, JSONSchema>): (data: T) => boolean;

  /**
   * Validate data against a schema (one-shot validation).
   * @param schema - The schema to validate against
   * @param data - The data to validate
   */
  validate<T = unknown>(schema: JSONSchema | boolean, data: T): boolean;

  /** Array of validation errors from the last validation */
  readonly errors: ValidationError[];
}

/**
 * Register a single format compiler.
 * @param formatName - The format name
 * @param compiler - The compiler function
 */
export function registerFormatCompiler(
  formatName: string,
  compiler: (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean
): void;

/**
 * Register multiple format compilers.
 * @param formats - Object mapping format names to compiler functions
 */
export function registerFormatCompilers(
  formats: Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>
): void;

/**
 * Default schema draft URI used by the validator.
 */
export const DEFAULT_SCHEMA_DRAFT: string;
