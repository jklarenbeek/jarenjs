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
  isRefCycleError,
  RefCycleError,
  assertRootReadsInstance,
  resolveRefSchemaDeep,
  traverseOptionsFor,
  encodeJsonPointerPath,
  TraverseOptions,
  createJsonPointer,
} from './traverse.js';

import {
  isBoolOrObjectClass,
  hasSchemaReference,
  hasUnevaluatedPropertiesCoverage,
  hasUnevaluatedItemsCoverage,
  EvalLog,
  assertRelativePointerDialect,
  markStep,
} from './tools.js';
import { wrapUnevaluated } from './unevaluated.js';
import { registerFormatCompiler, registerFormatCompilers } from './format.js';
import { mergeMap } from '@jarenjs/core/object';
import { hasRecursiveAnchor, getDynamicAnchorName, collectDynamicAnchors, collectDynamicAnchorsDeep } from './dynamic-ref.js';
import { isRecursiveQueryCompileError } from './query-keyword.js';
import { boundReference, assertReferenceDepth, assertOutputFormat, REFERENCE_DEPTH_CEILING } from './errors.js';
import { TRAVERSE_SCHEMA_MAP_MAPS, detectSchemaDraft } from './schema-keywords.js';
import { VALIDATOR_STATE } from './validator-state.js';

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

export { SchemaCompileError, SchemaRuntimeError, VALIDATE_CODES } from './errors.js';

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
 * @property {Record<string, Record<string, JSONSchema>>} [propertyDependencies] - Schemas applied to the whole object when a member holds a given string (proposal keyword; asserts only with the `propertyDependencies` option)
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
 * A schema as a validator boundary ACCEPTS it. {@link JSONSchema}
 * documents what a schema IS — typed keywords, open for extensions —
 * but a schema held as a plain `Record<string, unknown>` map (the
 * natural type for a document that crossed a wire or a package
 * boundary) does not assign to that keyword intersection under strict
 * TypeScript, and forcing the consumer to cast at every `compile` and
 * `addSchema` call site teaches them to cast, which is worse than the
 * looser parameter. The boundary methods accept this union; both arms
 * are treated identically at runtime, which was always true.
 * @typedef {JSONSchema | Record<string, unknown>} JSONSchemaLike
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

export const DEFAULT_SCHEMA_DRAFT = 'http://json-schema.org/draft-07/schema#'

export { detectSchemaDraft };

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
   * @param {'error'|'ignore'} [unknownFormats='ignore'] - What to do when an ASSERTING `format` names something no compiler is registered for: 'ignore' (the default, and what the specification requires) accepts it as an annotation; 'error' throws at COMPILE time. Never affects instance validation, and never applies where format is annotation-only anyway.
   * @param {boolean} [propertyDependencies=false] - Whether the `propertyDependencies` proposal keyword asserts. Off, it is an unknown keyword like any other; on, it applies in documents of draft 2020-12 (and the draft-next dialect) and in documents that declare no draft.
   * @param {'handrews-01'|'bhutton-00'} [relativePointerDialect='handrews-01'] - Which Relative JSON Pointer grammar the `data` and `$data` keywords and the `relative-json-pointer` format speak: `'handrews-01'` is draft-handrews-relative-json-pointer-01 (what the format suite asserts); `'bhutton-00'` is draft-bhutton-relative-json-pointer-00, which also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`). Any other value is a TypeError when a schema compiles.
   * @param {number} [maxReferenceDepth=256] - The deepest nesting of schema references one validation enters before it throws `JK2001` (a positive safe integer, else `JK0002` when a schema compiles). Fixed by default so the answer is the same on every host; raising it lets the host's call stack decide again.
   * @param {OutputFormat<any>} [outputFormat] - A JSON Schema standard output format from `@jarenjs/validate/output`, returned by a compiled validator instead of a boolean or `{ valid, errors }`; unset, the return shape is `collectErrors`'. Any other value is refused `JK0003` when a schema compiles.
   */
  constructor(
    skipErrors = true,
    useGrapheme = true,
    collectErrors = false,
    contentValidation = null,
    draftVersion = 7,
    vocabValidation = true,
    formatAssertion = null,
    messages = true,
    unknownFormats = 'ignore',
    propertyDependencies = false,
    relativePointerDialect = 'handrews-01',
    maxReferenceDepth = REFERENCE_DEPTH_CEILING,
    outputFormat = undefined
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
    /** @type {'error'|'ignore'} What an asserting `format` with no registered compiler does */
    this.unknownFormats = unknownFormats;
    /** @type {boolean} Whether the propertyDependencies proposal keyword asserts */
    this.propertyDependencies = propertyDependencies;
    /** @type {'handrews-01'|'bhutton-00'} The Relative JSON Pointer grammar of `data`, `$data` and the `relative-json-pointer` format */
    this.relativePointerDialect = relativePointerDialect;
    /** @type {number} The deepest nesting of schema references one validation enters */
    this.maxReferenceDepth = maxReferenceDepth;
    /** @type {OutputFormat<any>|undefined} The standard output format a compiled validator returns, or undefined for the `collectErrors` shapes */
    this.outputFormat = outputFormat;
  }
}

/**
 * A JSON Schema standard output format, imported from
 * `@jarenjs/validate/output` (`flagOutput`, `basicOutput`,
 * `detailedOutput`, `verboseOutput`, `listOutput`, `hierarchicalOutput`).
 * @template R - What the compiled validator returns
 * @typedef {import('./output.js').OutputFormat<R>} OutputFormat
 */

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

    // The paths under construction right now: a reference back to one of
    // them is resolved when it is first used, not by building the object a
    // second time (see `resolveObject`).
    const building = self.#building;
    building.add(path);
    let obj;
    try {
      obj = new ValidationObject(self, path, schema, baseUri, parentDeclaredDraft);
    }
    finally {
      building.delete(path);
    }
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
  /** ids of reference chains known to end without a loop (see assertNoRefLoop) */
  #loopFree = new Set();
  /** @type {Map|null} Map of paths to ValidationObjects */
  #objects = null;
  /** @type {Set<string>} Paths whose ValidationObject is being constructed */
  #building = new Set();
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
  /** @type {Map<object, Map<string, object>>} Anchor validators keyed by schema identity and resolution base */
  #anchorObjects = new Map();
  /** @type {boolean} Whether any schema in this compilation reads the location of its instance */
  #usesDollarData = false;
  /** @type {WeakMap<object, {base: string, reads: boolean}>} Schema subtree -> whether it holds or reaches a location reader, judged against the base its references resolve against */
  #readsBelowSchema = new WeakMap();
  /** @type {WeakMap<object, {base: string, reads: boolean}>} Map of schemas (names -> schemas) -> the same; apart from the schema memo because an object read as a map has names where one read as a schema has keywords */
  #readsBelowMap = new WeakMap();
  /** @type {Map<string, boolean>} Reference target id -> whether it reaches a location reader */
  #targetReads = new Map();
  /** @type {boolean} Whether any schema in this compilation contains unevaluatedProperties/unevaluatedItems */
  #usesUnevaluated = false;
  /** @type {EvalLog} Log of evaluated properties/items for unevaluated* support */
  #evalLog = new EvalLog();
  /** @type {object|null} The JarenValidator instance this compilation belongs to, or null when constructed standalone */
  #owner = null;
  /** @type {Map<string, object>|null} Compiled 'errorMessage' specs by schema path; null when the schema set has none */
  #errorMessages = null;
  /** @type {UnitRecorder|null} The recorder of an output format's units (`@jarenjs/validate/output`), or null when this compilation records none */
  #recorder = null;

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
   * Walks a schema (sub)tree and offers every keyword to `visit`. Keys inside
   * name->schema maps (properties, $defs, ...) are property/definition names
   * and are not offered. The value of `$query` is a query document and the
   * value of `errorMessage` a message spec: the keys inside them (operators,
   * embedded schema literals, a map form spelling `$query`) are not keywords
   * of this schema and are not walked.
   * @param {any} node - The schema node to walk
   * @param {Set<object>} seen - Cycle guard
   * @param {(node: object, key: string) => boolean} visit - Returns true to stop the walk
   * @param {boolean} [isSchema=true] - Whether node's keys are schema keywords
   * @param {boolean} [mapMaps=false] - Whether `propertyDependencies` is on, so its value is a map of maps of schemas (off, it is an unknown keyword and walked like one)
   * @returns {boolean} True when `visit` stopped the walk
   */
  static #walkKeywords(node, seen, visit, isSchema = true, mapMaps = false) {
    if (node == null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; ++i) {
        if (ValidationRoot.#walkKeywords(node[i], seen, visit, isSchema, mapMaps)) return true;
      }
      return false;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; ++i) {
      const key = keys[i];
      if (isSchema) {
        if (visit(node, key)) return true;
        if (key === '$query' || key === 'errorMessage') continue;
        if (mapMaps && TRAVERSE_SCHEMA_MAP_MAPS.includes(key)) {
          // member name -> member value -> schema: both levels are names.
          const outer = node[key];
          if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) continue;
          for (const inner of Object.values(outer)) {
            if (ValidationRoot.#walkKeywords(inner, seen, visit, false, mapMaps)) return true;
          }
          continue;
        }
        if (ValidationRoot.#SCAN_MAP_KEYWORDS.has(key)) {
          // The value is a name->schema map: its keys are names, its values schemas.
          if (ValidationRoot.#walkKeywords(node[key], seen, visit, false, mapMaps)) return true;
          continue;
        }
      }
      if (ValidationRoot.#walkKeywords(node[key], seen, visit, true, mapMaps)) return true;
    }
    return false;
  }

  /**
   * Whether a keyword reads the location of the instance it applies to: a
   * `$data` reference, the json-everything `data` keyword (an object, which
   * resolves relative pointers against the data path at validation time) and
   * `$query` (which binds the instance path to its `path` external).
   * @param {object} node - The schema object holding the keyword
   * @param {string} key - The keyword
   * @returns {boolean}
   */
  static #readsLocation(node, key) {
    return key === '$data' || key === '$query'
      || (key === 'data' && node[key] !== null && typeof node[key] === 'object');
  }

  /**
   * Whether a subtree holds a location reader, or can reach one through a
   * reference. A `$ref` is resolved and its target walked too; one that is no
   * reference string or does not resolve, a `$dynamicRef` or `$recursiveRef`
   * (whose target the instance decides), and a `$ref` in a subtree holding an
   * embedded `$id` (which moves the base it resolves against) count as
   * reaching one.
   * @param {any} node - The subtree
   * @param {boolean} isSchema - Whether its keys are keywords (not names)
   * @param {string} base - The base its references resolve against
   * @param {{bases: Map<string, Set<any>>, targets: string[]}} walk - Per
   *   base, the nodes and reference targets already walked against it (an
   *   object shared by two documents is judged under each one's base), and
   *   the targets this walk entered
   * @returns {boolean}
   */
  #readsBelow(node, isSchema, base, walk) {
    let moved = false;
    let followed = false;
    const seen = walk.bases.get(base) ?? new Set();
    walk.bases.set(base, seen);
    return ValidationRoot.#walkKeywords(node, seen, (holder, key) => {
      if (ValidationRoot.#readsLocation(holder, key) || key === '$dynamicRef' || key === '$recursiveRef')
        return true;
      if (key === '$id') {
        moved = true;
        return followed;
      }
      if (key !== '$ref') return false;
      if (moved || !hasSchemaReference(holder, '$ref')) return true;
      followed = true;
      let target;
      try {
        target = this.referencedSchema(base, holder);
      }
      catch {
        return true;
      }
      const { id } = target;
      const known = this.#targetReads.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return false;
      seen.add(id);
      walk.targets.push(id);
      // A target that reaches a reader always does; one that reaches none is
      // known only once the whole walk has found none.
      const reads = this.#readsBelow(target.schema, true, id, walk);
      if (reads) this.#targetReads.set(id, true);
      return reads;
    }, isSchema, this.#options.propertyDependencies === true);
  }

  /**
   * Scans every schema of the compilation once for the features that need
   * runtime support: location readers (see `#readsLocation`) and
   * 'unevaluatedProperties'/'unevaluatedItems'.
   * @param {any} node - The schema node to scan
   * @param {Set<object>} seen - Cycle guard
   * @param {{dollarData: boolean, unevaluated: boolean, canElide: boolean}} flags - Output flags
   * @param {boolean} mapMaps - Whether `propertyDependencies` is on
   */
  static #scanSchemaFeatures(node, seen, flags, mapMaps) {
    ValidationRoot.#walkKeywords(node, seen, (holder, key) => {
      if (ValidationRoot.#readsLocation(holder, key)) flags.dollarData = true;
      else if (key === 'unevaluatedProperties' || key === 'unevaluatedItems') {
        if (!flags.canElide || ValidationRoot.#unevaluatedForcesTracking(holder, key))
          flags.unevaluated = true;
      }
      return flags.dollarData && flags.unevaluated;
    }, true, mapMaps);
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

    assertRelativePointerDialect(opts.relativePointerDialect);
    assertReferenceDepth(opts.maxReferenceDepth);
    assertOutputFormat(opts.outputFormat);
    this.#recorder = opts.outputFormat?.recorder?.(schemas) ?? null;
    this.#options = opts;
    this.#traverse = traverseOptionsFor(traverse, opts.propertyDependencies);
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
      ValidationRoot.#scanSchemaFeatures(value, seen, flags, opts.propertyDependencies === true);
      if (flags.dollarData && flags.unevaluated) break;
    }
    this.#usesDollarData = flags.dollarData;
    // Recording runs every branch of an `anyOf` (each passing branch has
    // annotations to report), which annotation tracking already does.
    this.#usesUnevaluated = flags.unevaluated || this.#recorder !== null;

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
    this.#rootDynamicAnchors = collectDynamicAnchorsDeep(rootSchema, opts.propertyDependencies === true)
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

  /** @returns {boolean} Whether any schema in this compilation reads the location of its instance (`$data`, `data`, `$query`) */
  get usesDollarData() { return this.#usesDollarData; }

  /**
   * Whether a schema has to hand locations to the subschemas under the given
   * keywords. Locations are strings built per member and per item, so they are
   * built only where something below can read one: a `$data` reference, the
   * `data` keyword or a `$query`, there or in a schema a reference below leads
   * to (see `#readsBelow`). A subtree that reaches none of those is given its
   * parent's location unextended and nothing in it looks. An internal
   * collaborator of the keyword compilers, like `usesDollarData`; not part of
   * the package's API.
   * @param {object} schema - The schema object holding the keywords
   * @param {readonly string[]} keywords - The keywords whose values are validated against the children
   * @param {string} base - The base the children's references resolve against
   * @returns {boolean}
   */
  childLocationsNeeded(schema, keywords, base) {
    if (!this.#usesDollarData) return false;
    for (let i = 0; i < keywords.length; ++i) {
      const key = keywords[i];
      const value = schema[key];
      if (value === null || typeof value !== 'object') continue;
      const isSchema = !ValidationRoot.#SCAN_MAP_KEYWORDS.has(key);
      const memo = isSchema ? this.#readsBelowSchema : this.#readsBelowMap;
      let judged = memo.get(value);
      if (judged === undefined || judged.base !== base) {
        const walk = { bases: new Map(), targets: [] };
        judged = { base, reads: this.#readsBelow(value, isSchema, base, walk) };
        memo.set(value, judged);
        // A walk that found no reader went through everything its targets reach.
        if (!judged.reads) for (const id of walk.targets) this.#targetReads.set(id, false);
      }
      if (judged.reads) return true;
    }
    return false;
  }

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
   * @param {boolean} [unlessBuilding] - Answer `null` instead of building the
   *   target when it is one of the objects under construction (a reference
   *   that leads back to an enclosing schema), so the caller keeps the
   *   reference to resolve on first use
   * @returns {ValidationObject|null} The resolved ValidationObject
   */
  resolveObject(ref, path, schema, unlessBuilding = false) {
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
    if (unlessBuilding && this.#building.has(id)) return null;

    // Create and cache the validation object
    return ValidationRoot.#createObject(this, id, root);
  }

  /**
   * The schema a `$ref` leads to, found without building it: the id and the
   * schema `resolveObject` builds for the same reference. An internal
   * collaborator of the compile-time analyses; not part of the package's API.
   * @param {string} base - The base the reference resolves against
   * @param {object} schema - The schema containing the $ref
   * @returns {{id: string, schema: any}}
   * @throws {Error} When the target is not loaded or the chain loops
   */
  referencedSchema(base, schema) {
    return resolveRefSchemaDeep(this.#schemas, base, schema, this.#traverse);
  }

  /**
   * Refuses a reference that leads back to itself through pure references.
   * A target not built yet resolves on first use, so a loop would otherwise
   * surface as a flattened empty schema or as a call-stack overflow.
   * @param {string} path - The base the reference resolves against
   * @param {object} schema - The schema containing the $ref
   */
  assertNoRefLoop(path, schema) {
    try {
      resolveRefSchemaDeep(this.#schemas, path, schema, this.#traverse, this.#loopFree);
    }
    catch (e) {
      // A target that is not loaded is reported where it is used.
      if (isRefCycleError(e)) throw e;
    }
  }

  /**
   * Adds an error to the validation errors list.
   * @param {InternalValidationError} error - The error to add
   * @returns {boolean} Always returns false for convenience in validators
   */
  addError(error /*:InternalValidationError*/) {
    this.#errors.push(error);
    this.#recorder?.error(error);
    return false;
  }

  /** @returns {UnitRecorder|null} The output units' recorder, or null (an internal collaborator of the keyword compilers) */
  get recorder() { return this.#recorder; }

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
   * Returns the bottom of the stack (first/outermost registered validator) -
   * the same resolution `$dynamicRef` makes, so it delegates.
   * @param {string} anchorName - The anchor name (empty string for $recursiveRef)
   * @returns {Function|null} The validator function or null if not set
   */
  getOutermostDynamicAnchorValidator(anchorName) {
    return this.getDynamicAnchorValidator(anchorName);
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
    let byBase = this.#anchorObjects.get(schema);
    if (byBase === undefined) {
      byBase = new Map();
      this.#anchorObjects.set(schema, byBase);
    }
    const cached = byBase.get(baseUri);
    if (cached !== undefined) return cached.validate;
    // An annotation prefix cannot identify a schema. The object's identity
    // and resolution base own the cache; the synthetic path is only a unique
    // diagnostic location within this compilation.
    const path = basePath + '/$def-anchor/' + this.#objects.size;
    const obj = ValidationRoot.#createObject(this, path, schema, baseUri);
    byBase.set(baseUri, obj);
    return obj.validate;
  }
}

/**
 * The recorder an output format of `@jarenjs/validate/output` hands a
 * compilation: every subschema applied enters it, carrying the evaluation
 * path segment an applicator marked as `pending`.
 * @typedef {import('./output.js').UnitRecorder} UnitRecorder
 */

/** The evaluation step of a `$ref` (see `markStep`). */
const REF_STEP = Object.freeze(['$ref']);

/**
 * Whether a schema id lies in the document being compiled. A loop among
 * registrations of other documents is reported when something reaches it.
 * @param {string} id
 * @param {string} origin
 * @returns {boolean}
 */
function inDocument(id, origin) {
  const hash = origin.indexOf('#');
  return id.startsWith(hash === -1 ? origin : origin.slice(0, hash));
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
    if (!hasSchemaReference(schema, '$ref'))
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
    // A schema that references itself decides nothing: validating it re-enters
    // the same validator on the same instance until the stack runs out.
    if (ref === path)
      throw new RefCycleError([path, path]);
    // Only check for sibling validators in draft 2019-09+
    const siblingValidator = draftVersion >= 2019 ? compileSchemaObject(self, schema) : null;

    // Collect dynamic anchors from the current schema's $defs/definitions.
    // When following a $ref, dynamic anchors defined in the source schema's $defs
    // should be in scope for $dynamicRef in the target schema.
    // This handles cases like: root has $defs.foo with $dynamicAnchor, root.$ref points to list,
    // and list.items has $dynamicRef that should resolve to root.$defs.foo's anchor.
    const sourceDynamicAnchors = draftVersion >= 2020 ? collectDynamicAnchors(schema) : [];

    // A target already built is called directly. A target still under
    // construction - a reference back into a schema that encloses this one -
    // or not built yet is resolved when it is first used, below.
    const resolved = root.unresolvedObject(ref);
    if (resolved != null) {
      const refValidator = resolved.validate;
      // Recording, the call through the reference is its own output unit;
      // the dynamic scope keeps the target's own function.
      const callRef = markStep(root.recorder, REF_STEP, refValidator);
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
      const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema, root.options.propertyDependencies === true);
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
              return combineRefAndSiblings(callRef, siblingValidator, self.options.skipErrors,
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
              return callRef(data, dataPath, dataRoot);
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
          return combineRefAndSiblings(callRef, siblingValidator, self.options.skipErrors,
              data, dataPath, dataRoot);
        });
      }
      
      self.#validator = callRef;
      return callRef;
    }

    // Resolved on first use. Every loop through references passes at least
    // one reference compiled here: the one that closes the loop finds its
    // target still under construction.
    // Pre-bind values to avoid closure overhead in hot path
    const rootRef = root;
    const boundRef = ref;
    const boundRefBase = refBase;
    const boundSchema = schema;
    const boundSiblingValidator = siblingValidator;
    root.assertNoRefLoop(refBase, schema);
    const boundSourceAnchors = sourceDynamicAnchors;

    // Memoized state of the first resolution - the target never changes.
    let resolvedState = null;

    // Every loop through schemas passes a reference resolved on first use, so
    // the reference depth bound holds a deep instance and a loop that never
    // descends into it alike.
    return wrapUnevaluated(self, schema, boundReference(path, root.options.maxReferenceDepth, function resolveSchemaCompiler(data, dataPath, dataRoot) {
      if (resolvedState === null) {
        const obj = rootRef.resolveObject(boundRef, boundRefBase, boundSchema);
        const resolvedSchema = obj.schema;

        // Entering the target resource brings ALL of its $dynamicAnchors into
        // the dynamic scope, exactly like the pre-compiled path above.
        const enterAnchors = boundSourceAnchors.slice();
        const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema, root.options.propertyDependencies === true);
        for (let i = 0; i < targetDeepAnchors.length; i++) {
          const anchor = targetDeepAnchors[i];
          if (anchor.schema === resolvedSchema) continue;
          anchor.base = obj.baseUri;
          enterAnchors.push(anchor);
        }

        const targetValidator = obj.validate;
        resolvedState = {
          refValidator: targetValidator,
          // Recording, the call through the reference is its own output unit.
          callRef: markStep(rootRef.recorder, REF_STEP, targetValidator),
          enterAnchors,
          hasRecAnchor: isObjectClass(resolvedSchema) && hasRecursiveAnchor(resolvedSchema),
          dynAnchorName: isObjectClass(resolvedSchema) ? getDynamicAnchorName(resolvedSchema) : null,
        };
      }
      const { refValidator, callRef, enterAnchors, hasRecAnchor, dynAnchorName } = resolvedState;

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
              return combineRefAndSiblings(callRef, boundSiblingValidator,
                self.options.skipErrors, data, dataPath, dataRoot);
            }
            return callRef(data, dataPath, dataRoot);
          } finally {
            rootRef.popDynamicAnchorValidator(anchorName);
          }
        }

        // If there are sibling validators (draft 2019-09+), combine them with the ref validator
        if (boundSiblingValidator) {
          return combineRefAndSiblings(callRef, boundSiblingValidator,
                self.options.skipErrors, data, dataPath, dataRoot);
        }

        // Cache the validator directly (skipping this resolver) only when
        // this ref registers no dynamic anchors - otherwise later calls
        // would lose the registrations.
        if (enterAnchors.length === 0 && rootRef.recorder === null) {
          self.#validator = refValidator;
        }
        return callRef(data, dataPath, dataRoot);
      } finally {
        // Pop anchors in reverse order
        for (let i = enterAnchors.length - 1; i >= 0; i--) {
          rootRef.popDynamicAnchorValidator(enterAnchors[i].name);
        }
      }
    }));
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
  /** @type {function|null} Dynamic resource scope around the current validator */
  #resourceValidator = null;
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
    // Recording output units, applying this subschema is one.
    const recorder = root.recorder;
    if (recorder !== null) {
      const validate = this.#validator;
      this.#validator = (data, dataPath, dataRoot, dataKey) => recorder.enter(this, validate, data, dataPath, dataRoot, dataKey);
    }

    // An applicator may enter an embedded resource without following a ref.
    // Its anchors have the same lifetime as that evaluation. Keep this
    // wrapper separate so a ref's lazy validator cache cannot discard it.
    const draft = this.#declaredDraft ?? root.options.draftVersion;
    if (draft >= 2020 && isObjectClass(schema) && isStringType(schema.$id)
      && path !== baseUri) {
      const anchors = collectDynamicAnchorsDeep(schema, root.options.propertyDependencies === true, this.#declaredDraft);
      if (anchors.length > 0) {
        const resourceBase = this.#effectiveBaseUri;
        const inner = (data, dataPath, dataRoot, dataKey) => this.#validator(data, dataPath, dataRoot, dataKey);
        this.#resourceValidator = (data, dataPath, dataRoot, dataKey) => {
          for (const anchor of anchors) {
            anchor.validator ??= anchor.schema === schema
              ? inner
              : root.getOrCreateValidator(anchor.schema, path, resourceBase);
            root.pushDynamicAnchorValidator(anchor.name, anchor.validator);
          }
          try {
            return inner(data, dataPath, dataRoot, dataKey);
          }
          finally {
            for (let i = anchors.length - 1; i >= 0; i--)
              root.popDynamicAnchorValidator(anchors[i].name);
          }
        };
      }
    }
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
    return this.#resourceValidator ?? this.#validator;
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
   * @param {number|string} [index] - Optional array index for tuple items, or the name inside a map
   * @param {string} [member] - Optional name inside a map of maps, below `index`
   * @returns {function|undefined} The compiled validator function, or undefined if schema is invalid
   */
  createValidator(schema, key, index, member) {
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
        : member == null
          ? encodeJsonPointerPath(id, key, String(index))
          : encodeJsonPointerPath(encodeJsonPointerPath(id, key, String(index)), member);



    // Pass basePath as the baseUri for the child object.
    // This ensures that $ref in the child will be resolved against basePath,
    // not against any sibling $id that the child might have.
    // The child inherits this document's declared draft version.
    // The items fast path of a `$ref` can build this very object first, when the
    // reference points at a sibling still to be compiled: the path names the
    // same schema location, so take that one.
    const built = root.unresolvedObject(path);
    const child = built !== null
      ? built
      : root.createObject(path, schema, basePath, this.#declaredDraft);
    this.#members.push(child);

    return markStep(root.recorder, [key, index, member], child.validate);
  }
}

/**
 * Run a `$ref` and its sibling keywords, which are INDEPENDENT of each other:
 * a document can fail the referenced schema and its siblings for unrelated
 * reasons, and reporting only the first would hide half of every issue list.
 * Boolean mode keeps the early exit.
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
      if (opts.collectErrors != null || opts.skipErrors != null || opts.useGrapheme != null || opts.contentValidation != null || opts.draftVersion != null || opts.formatAssertion != null || opts.messages != null || opts.unknownFormats != null || opts.propertyDependencies != null || opts.relativePointerDialect != null || opts.maxReferenceDepth != null || opts.outputFormat !== undefined) {
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
          opts.messages ?? true,
          opts.unknownFormats ?? 'ignore',
          opts.propertyDependencies ?? false,
          opts.relativePointerDialect ?? 'handrews-01',
          opts.maxReferenceDepth ?? REFERENCE_DEPTH_CEILING,
          opts.outputFormat
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
 * @template {OutputFormat<any>|undefined} [TOutput=undefined]
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
 * @property {'error'|'ignore'} [unknownFormats] - What an ASSERTING `format` with no registered compiler does: 'ignore' (default, per spec) accepts it as an annotation, 'error' throws at compile time
 * @property {boolean} [propertyDependencies] - Assert the `propertyDependencies` proposal keyword (default false: it is an unknown keyword); applies in draft 2020-12 (and draft-next) documents and in documents that declare no draft
 * @property {'handrews-01'|'bhutton-00'} [relativePointerDialect] - The Relative JSON Pointer grammar of `data`, `$data` and the `relative-json-pointer` format: `'handrews-01'` (default) or `'bhutton-00'`, which also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`)
 * @property {number} [maxReferenceDepth] - The deepest nesting of schema references one validation enters before it throws `JK2001` (default 256, the same on every host; a larger value lets the host's call stack decide again). Also bounds `validateSchema`. Not a positive safe integer: `JK0002` when a schema compiles
 * @property {TOutput} [outputFormat] - Return a JSON Schema standard output instead of a boolean or `{ valid, errors }`: a format from `@jarenjs/validate/output`; it takes precedence over `collectErrors`. Another value (a format's name as a string included): `JK0003` when a schema compiles
 */

/**
 * JarenValidator is the main entry point for JSON Schema validation.
 * It manages schema registration, format registration, and compilation.
 *
 * The `collectErrors` option decides what a compiled validator returns, and
 * it is carried in the type parameter so the two shapes never have to be
 * distinguished at runtime.
 * @template {boolean} [TCollect=false]
 * @template {OutputFormat<any>|undefined} [TOutput=undefined]
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
  /** @type {TraverseOptions} The traversal options, carrying the `propertyDependencies` switch of the validation options */
  #traverse = new TraverseOptions();

  /**
   * Creates a new JarenValidator instance.
   * @param {ValidatorOptions | ValidatorInit<TCollect, TOutput>} [options] - Validator options including formats, schemas, validation options, and traverse options
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
    this.#traverse = traverseOptionsFor(options.traverse, options.validation?.propertyDependencies);
    VALIDATOR_STATE.set(this, { schemas: this.#schemas, traverse: this.#traverse });
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
   * @param {JSONSchemaLike | boolean | (JSONSchemaLike | boolean)[]} schema - The schema(s) to add
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
    else if (isBoolOrObjectClass(schema)) {
      const schemaKey = key || (isObjectClass(schema) ? schema.$id : undefined);
      if (schemaKey) {
        const before = new Map(this.#schemas);
        this.#schemas.set(schemaKey, schema);
        // Only an empty fragment aliases the document URI. Replace both
        // aliases together; a named anchor remains a distinct registration.
        const fragment = schemaKey.indexOf('#');
        if (!schemaKey.startsWith('#') && (fragment === -1 || fragment === schemaKey.length - 1)) {
          const altKey = schemaKey.endsWith('#') ? schemaKey.slice(0, -1) : schemaKey + '#';
          this.#schemas.set(altKey, schema);
        }

        // Also traverse the schema to find and store all internal $id anchors
        // This is important for remote schemas that may have location-independent identifiers
        // We use a wrapper that skips already-existing keys instead of throwing,
        // and fills a key an earlier schema's reference left unresolved
        this.#traverseAndStoreIds(schemaKey, schema);

        // A ring of references registered here would make every later compile
        // on this validator throw, so it is refused where it is added.
        try {
          this.#assertNoRefLoops(schemaKey);
        }
        catch (e) {
          this.#schemas.clear();
          for (const [k, v] of before) this.#schemas.set(k, v);
          throw e;
        }
      }
    }
    return this;
  }

  /**
   * Refuses a loop of pure references among the registrations of one document.
   * @param {string} documentKey - The key the document was registered under
   */
  #assertNoRefLoops(documentKey) {
    const hash = documentKey.indexOf('#');
    const prefix = hash === -1 ? documentKey : documentKey.slice(0, hash);
    for (const [key, entry] of this.#schemas) {
      if (!key.startsWith(prefix) || !isObjectClass(entry) || !hasSchemaReference(entry, '$ref'))
        continue;
      try {
        resolveRefSchemaDeep(this.#schemas, key, entry, this.#traverse);
      }
      catch (e) {
        // A target not registered yet is reported where it is used.
        if (isRefCycleError(e)) throw e;
      }
    }
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
    const traverseOpts = this.#traverse;

    // Create options with anchorsGlobal: false to scope anchors to their document.
    // This prevents conflicts when multiple schemas use the same anchor names (e.g., '#foo').
    // Anchors will be stored as 'baseUri#anchor' instead of just '#anchor'.
    const scopedOpts = new TraverseOptions(
      traverseOpts.origin,
      traverseOpts.mergeSchemas,
      false, // anchorsGlobal: false - scope anchors to document
      traverseOpts.anchorsAllowed,
      traverseOpts.skipErrors,
      traverseOpts.propertyDependencies
    );

    // Use a wrapper map to collect new entries, then merge them
    const newSchemas = new Map();
    try {
      storeSchemaIdsInMap(newSchemas, baseUri, schema, scopedOpts);
    } catch (_e) {
      // Ignore errors for already-existing schemas at the root level
    }

    // Merge new entries into the main schemas map, skipping existing keys;
    // an unresolved entry (a reference an earlier schema made) is filled.
    for (const [id, value] of newSchemas.entries()) {
      if (this.#schemas.get(id) == null) {
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
  static #compileSchema(self, origin, schemas, validation = self.#options.validation) {
    const root = new ValidationRoot(
      origin,
      schemas,
      self.#formats,
      validation,
      self.#traverse,
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
    const outputFormat = root.options.outputFormat;
    if (outputFormat !== undefined) return outputFormat.validator(root);

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
    return typeof key === 'string' && !key.includes('#') ? key + '#' : key;
  }

  /**
   * Adds meta-schema(s) that can be used to validate schemas.
   * Meta-schemas are schemas that describe the structure of valid JSON schemas.
   * @param {JSONSchemaLike | boolean | (JSONSchemaLike | boolean)[]} schema - The meta-schema(s) to add
   * @param {string} [key] - Optional key/URI for the meta-schema
   * @returns {this} This validator instance for chaining (the polymorphic `this` keeps the collectErrors type parameter across a chain)
   * @example
   * validator.addMetaSchema(draft7MetaSchema, 'http://json-schema.org/draft-07/schema');
   */
  addMetaSchema(schema, key = undefined) {
    key = JarenValidator.normalizeUriKey(key)
    // A meta-schema is infrastructure, not something the caller authored:
    // every JSON Schema meta-schema declares `format: "uri-reference"` on
    // `$id`/`$ref`, and nobody registers formats in order to check that a
    // SCHEMA is well-formed. The unknownFormats guard protects an author
    // from a keyword of their own that silently checks nothing, so it does
    // not apply here — otherwise merely registering draft-07 would throw.
    const validation = JarenValidator.#withOption(JarenValidator.#withOption(this.#options.validation,
      'unknownFormats', 'ignore'), 'outputFormat', undefined);
    if (Array.isArray(schema)) {
      const [first, ...siblings] = schema;
      const { origin, map } = JarenValidator.#traverseSchema(first, siblings, undefined, new TraverseOptions(key));
      const compiled = JarenValidator.#compileSchema(this, origin, map, validation);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    else if (isBoolOrObjectClass(schema)) {
      const { origin, map } = JarenValidator.#traverseSchema(schema, undefined, undefined, new TraverseOptions(key));
      const compiled = JarenValidator.#compileSchema(this, origin, map, validation);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    return this;
  }

  /** A ValidationOptions with one member replaced, leaving the original
   * untouched (the validator's own options must not drift). */
  static #withOption(validation, name, value) {
    const next = new ValidationOptions();
    Object.assign(next, validation ?? new ValidationOptions());
    next[name] = value;
    return next;
  }

  /**
   * Retrieves a registered schema by its key/URI.
   * @param {string} key - The schema URI/key
   * @returns {JSONSchema | boolean | null} The registered schema, or null if not found
   */
  getSchema(key) {
    key = JarenValidator.normalizeUriKey(key)
    return this.#schemas.get(key) ?? null;
  }

  /**
   * Validates a schema against a registered meta-schema.
   * This is used to ensure schemas are valid according to the JSON Schema specification.
   * @param {JSONSchemaLike | boolean} schema - The schema to validate
   * @returns {boolean} True if the schema is valid
   * @example
   * validator.addMetaSchema(draft7MetaSchema);
   * const isValid = validator.validateSchema({ type: 'string' }); // true
   */
  validateSchema(schema) {
    // if no meta schema is present, just return true;
    if (this.#metaSchemas.size == 0)
      return true;

    const schemaId = JarenValidator.normalizeUriKey(
      (isObjectClass(schema) ? schema.$schema : undefined) || DEFAULT_SCHEMA_DRAFT);
    const metaSchema = this.#metaSchemas.get(schemaId);
    // if the metaSchema is not present, we fail the validation
    if (!metaSchema)
      return false;

    // otherwise, validate the schema
    const result = metaSchema(schema);
    return typeof result === 'boolean' ? result : result.valid === true;
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
          if (isRecursiveQueryCompileError(_e) || (isRefCycleError(_e) && inDocument(id, origin))) throw _e;
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
            // A descendant of a JSON pointer path is no base for our $id: skip it
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
        if (isRecursiveQueryCompileError(_e) || (isRefCycleError(_e) && inDocument(id, origin))) throw _e;
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
   * @param {JSONSchemaLike | boolean} schema - The schema to compile
   * @param {(JSONSchemaLike | boolean)[]} [schemas] - Additional schemas to reference during compilation
   * @returns {TOutput extends OutputFormat<infer R> ? (data: unknown) => R : TCollect extends true ? CompiledCollector : CompiledPredicate<T>} A validation function;
   *   it throws `SchemaRuntimeError` `JK2001` for an instance that nests more than 256 schema
   *   references (a deep instance, or one that reaches a loop that never reads it)
   * @throws {SchemaCompileError} `JK0001` when a loop of references never reads the instance
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
    const { origin, map } = JarenValidator.#traverseSchema(schema, schemas, this.#schemas, this.#traverse);

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
      existingValidation.messages ?? true,
      existingValidation.unknownFormats ?? 'ignore',
      existingValidation.propertyDependencies ?? false,
      existingValidation.relativePointerDialect ?? 'handrews-01',
      existingValidation.maxReferenceDepth ?? REFERENCE_DEPTH_CEILING,
      existingValidation.outputFormat
    );
    // A recording output format records the errors of every keyword;
    // `flag` is the boolean validator, which stops at the first failure.
    const outputFormat = validationOptions.outputFormat;
    if (outputFormat != null) {
      validationOptions.skipErrors = outputFormat.recorder === undefined;
      validationOptions.collectErrors = false;
    }
    // A root that loops back to itself before reading the instance decides
    // nothing on any instance: refused here rather than when it validates.
    // Whether a keyword reads the instance depends on these options.
    assertRootReadsInstance(map, origin, schema, { options: validationOptions, formats: this.#formats }, this.#traverse);

    // Pre-compile all refs before returning the validator
    // This ensures all ref chains are resolved at compile time
    const root = new ValidationRoot(
      origin,
      map,
      this.#formats,
      validationOptions,
      this.#traverse,
      this
    );

    // Pre-create validation objects for all refs
    JarenValidator.#precompileRefs(root, map, origin);

    // Re-compile with the pre-populated root
    return JarenValidator.#compileSchemaWithRoot(this, origin, map, root);
  }
}
