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
  withParsedPointers,
  restoreSchemaRefsInMap,
  reachedKeys,
  pointerBase,
  pointerStart,
  placeAt,
  underOwnName,
  spellsHeldPlace,
  heldNameOf,
  isRefCycleError,
  RefCycleError,
  assertRootReadsInstance,
  resolveRefSchemaDeep,
  resolveRefSchemaShallow,
  isReferenceHop,
  traverseOptionsFor,
  decodeJsonPointerPath,
  TraverseOptions,
  createJsonPointer,
  keywordLocation,
  placeDraftOf,
  readsForeign,
  unresolvedReference,
  locatedRefusal,
  compiledLocation,
  refuseContestedReference,
  isContestedRefusal,
  identifierOf,
  declaredDraftOf,
  keptRefBase,
  documentPlace,
  compiledPlacesOf,
} from './traverse.js';

import {
  isBoolOrObjectClass,
  hasSchemaReference,
  schemaReference,
  hasUnevaluatedPropertiesCoverage,
  hasUnevaluatedItemsCoverage,
  EvalLog,
  assertRelativePointerDialect,
  markStep,
} from './tools.js';
import { wrapUnevaluated } from './unevaluated.js';
import { assertLengthUnit } from './string.js';
import { registerFormatCompiler, registerFormatCompilers } from './format.js';
import { equalsJson, mergeMap } from '@jarenjs/core/object';
import { isStringWhiteSpace } from '@jarenjs/core/string';
import { hasRecursiveAnchor, getDynamicAnchorName, collectDynamicAnchors, collectDynamicAnchorsDeep, appliesRefSiblings } from './dynamic-ref.js';
import { isRecursiveQueryCompileError } from './query-keyword.js';
import { openReferences, referencesTooDeep, referenceUnwound, assertDepthOption, assertOutputFormat, schemaTooDeep, unimplementedVocabulary, REFERENCE_DEPTH_CEILING, SCHEMA_DEPTH_CEILING } from './errors.js';
import { TRAVERSE_SCHEMA_OBJECTS, TRAVERSE_SCHEMA_MAPS, TRAVERSE_SCHEMA_MAP_MAPS, detectSchemaDraft, dialectVocabulary, caselessUri, heldUriKey, heldDialect, identifierKeyword, identifierText, dialectDraft } from './schema-keywords.js';
import { VALIDATOR_STATE } from './validator-state.js';
import { encodeJsonPointerPath, withoutFragment } from './origin.js';

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
 * @property {number | DollarDataRef} [minLength] - Minimum string length (in graphemes by default; see the `lengthUnit` option)
 * @property {number | DollarDataRef} [maxLength] - Maximum string length (in graphemes by default; see the `lengthUnit` option)
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

// One fault as a keyword records it; nothing reads a clock per fault (a
// collecting walk builds one for every branch it tries).
class InternalValidationError {
  constructor(obj, key, expected, dataKey, value, rest) {
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
   * @param {'error'|'ignore'} [unknownFormats='ignore'] - What to do when an ASSERTING `format` names no registered compiler (an unregistered name, or a value that is no name): 'ignore' (the default, and what the specification requires) accepts it as an annotation; 'error' refuses the schema at COMPILE time (`JK0015`, located at the keyword). Never affects instance validation, and never applies where format is annotation-only anyway.
   * @param {boolean} [propertyDependencies=false] - Whether the `propertyDependencies` proposal keyword asserts. Off, it is an unknown keyword like any other; on, it applies in documents of draft 2020-12 (and the draft-next dialect) and in documents that declare no draft.
   * @param {'handrews-01'|'bhutton-00'} [relativePointerDialect='handrews-01'] - Which Relative JSON Pointer grammar the `data` and `$data` keywords and the `relative-json-pointer` format speak: `'handrews-01'` is draft-handrews-relative-json-pointer-01 (what the format suite asserts); `'bhutton-00'` is draft-bhutton-relative-json-pointer-00, which also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`). Any other value is a TypeError when a schema compiles.
   * @param {number} [maxReferenceDepth=256] - The deepest nesting, in levels of schema, of the references one validation enters before it throws `JK2001`, a reference back into a schema enclosing it weighing the levels between them (a positive safe integer, else `JK0002` when a schema compiles). Fixed by default so the answer is the same on every host; raising it lets the host's call stack decide again.
   * @param {OutputFormat<any>} [outputFormat] - A JSON Schema standard output format from `@jarenjs/validate/output`, returned by a compiled validator instead of a boolean or `{ valid, errors }`; unset, the return shape is `collectErrors`'. Any other value is refused `JK0003` when a schema compiles.
   * @param {number} [maxSchemaDepth=128] - The deepest nesting of subschemas one compile builds before it throws `JK0017` (a positive safe integer, else `JK0002` when a schema compiles). Fixed by default so the answer is the same on every host; raising it lets the host's call stack decide again.
   * @param {'grapheme'|'codepoint'|'utf16'} [lengthUnit] - What `minLength`/`maxLength` count: grapheme clusters, code points (what JSON Schema, SQLite's `length()` and PostgreSQL's `char_length()` count) or UTF-16 code units. Unset, `useGrapheme` decides (`true`: `'grapheme'`, `false`: `'utf16'`); set, it wins over `useGrapheme`. Any other value is a TypeError when a schema compiles.
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
    outputFormat = undefined,
    maxSchemaDepth = SCHEMA_DEPTH_CEILING,
    lengthUnit = undefined
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
    /** @type {number} The deepest nesting, in levels of schema, of the references one validation enters */
    this.maxReferenceDepth = maxReferenceDepth;
    /** @type {OutputFormat<any>|undefined} The standard output format a compiled validator returns, or undefined for the `collectErrors` shapes */
    this.outputFormat = outputFormat;
    /** @type {number} The deepest nesting of subschemas one compile builds */
    this.maxSchemaDepth = maxSchemaDepth;
    /** @type {'grapheme'|'codepoint'|'utf16'|undefined} What string length counts; undefined leaves `useGrapheme` to decide */
    this.lengthUnit = lengthUnit;
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
 * The draft a schema's place declares, as the walks that registered it read
 * it: a reference target is compiled under the draft of the document that
 * holds it. A flattened copy of a target is found by its location, and a
 * place no walk recorded reads as the nearest one on the way to it
 * ({@link unwalkedReading}).
 * @param {import('./traverse.js').SchemaPlaces|undefined} places - What the walks read
 * @param {Map<string, any>} schemas - The compilation's schemas by URI
 * @param {string} path - The schema's location
 * @param {any} schema - The schema, or a copy of it
 * @returns {number|null} The declared draft, or null when none is
 */
function placeDraft(places, schemas, path, schema) {
  const drafts = places?.drafts;
  if (drafts === undefined) return null;
  const place = placeOf(places, schemas, path, schema);
  return drafts.has(place) ? placeDraftOf(places, place, schemas) ?? null : unwalkedReading(places, schemas, path).draft;
}

/**
 * How a schema object no walk recorded is read: one a pointer reaches below
 * a position the walks do not enter (a keyword no draft defines, as the
 * `components` of an OpenAPI document). It reads as the nearest object on
 * the way to it in its document, itself included, that a walk recorded or
 * that declares a `$schema` of its own, as the normalizer's index places it
 * (`resolveSchemaReference`): a draft-07 document's `#/components/schemas/a`
 * is read as draft-07, and under the vocabularies draft-07 switches on.
 * @param {import('./traverse.js').SchemaPlaces} places - What the walks read
 * @param {Map<string, any>} schemas - The compilation's schemas by URI
 * @param {string} path - The object's location
 * @returns {{ draft: number|null, foreign: boolean, dialectUri: string|undefined }}
 *   The draft it is read under (null for none), whether its `$schema` names
 *   no draft this package knows ({@link readsForeign}), and that `$schema`
 *   URI, whose vocabularies it is read under (undefined for none)
 */
function unwalkedReading(places, schemas, path) {
  const start = pointerStart(schemas, path, places.rooted);
  const whole = start === -1 || start === path.length;
  let node = schemas.get(whole ? path : path.slice(0, start));
  const parts = whole ? [] : decodeJsonPointerPath(path.slice(start));
  let draft = null;
  let foreign = false;
  /** @type {string|undefined} */
  let dialectUri;
  for (let i = 0; ; i++) {
    if (places.drafts.has(node)) {
      draft = placeDraftOf(places, node, schemas) ?? null;
      foreign = readsForeign(places, node, schemas);
      dialectUri = places.dialectUris.get(node);
    }
    else if (isObjectClass(node) && isStringType(node.$schema)) {
      const named = dialectDraft(node.$schema, schemas);
      draft = named ?? 7;
      foreign = named === null;
      dialectUri = node.$schema;
    }
    if (i === parts.length) return { draft, foreign, dialectUri };
    node = node?.[parts[i]];
  }
}

/**
 * @typedef {object} DialectVocabularies What a dialect switches on
 * @property {boolean} validation - Whether the validation vocabulary asserts (`type`, `minimum`, ...)
 * @property {boolean} formatAssertion - Whether `format` asserts
 * @property {boolean} contentValidation - Whether `contentEncoding`/`contentMediaType` assert
 * @property {string|undefined} unimplemented - A vocabulary its meta-schema requires that this
 *   package does not implement, which refuses a schema of the dialect (`JK0016`)
 */

/**
 * What the dialect a `$schema` URI names switches on, as its meta-schema
 * declares it in `$vocabulary` ({@link dialectVocabulary}) and its draft
 * defaults it. A dialect whose meta-schema declares no `$vocabulary` (or is
 * not held, or is of a draft before 2019-09, where the member is no
 * keyword), and a place under no `$schema`, keep validation on; `format`
 * asserts where the option says so, else where the dialect declares the
 * format-assertion vocabulary, else below draft 2020-12; the content
 * keywords assert where the option says so, else below draft 2019-09. The
 * draft is the dialect's, or the compile's for a place under no `$schema`.
 * @param {unknown} uri - The `$schema` value, or undefined for none
 * @param {Map<string, any>} schemas - The compilation's schemas by URI
 * @param {boolean|null} formatOption - The `formatAssertion` option, null when unset
 * @param {boolean|null} contentOption - The `contentValidation` option, null when unset
 * @param {number} draftVersion - The draft the compile reads
 * @returns {DialectVocabularies}
 */
function dialectVocabularies(uri, schemas, formatOption, contentOption, draftVersion) {
  let validation = true;
  let formatAssertion = formatOption;
  let draft = draftVersion;
  let unimplemented;
  if (isStringType(uri)) {
    draft = detectSchemaDraft({ $schema: uri }, schemas);
    const declared = dialectVocabulary(uri, (key) => schemas.get(key), draft);
    validation = declared.validation;
    unimplemented = declared.unimplemented;
    if (formatAssertion == null && declared.formatAssertion) formatAssertion = true;
  }
  return { validation, formatAssertion: formatAssertion ?? draft < 2020, contentValidation: contentOption ?? draft < 2019, unimplemented };
}

/**
 * The schema object the walks recorded for a schema: itself, or, for a
 * flattened copy, the object at its location.
 * @param {import('./traverse.js').SchemaPlaces} places - What the walks read
 * @param {Map<string, any>} schemas
 * @param {string} path
 * @param {any} schema
 * @returns {any}
 */
function placeOf(places, schemas, path, schema) {
  return places.drafts.has(schema) ? schema : placeAt(schemas, path, places.rooted);
}

/**
 * The keywords that assert nothing under any option: two places that differ
 * only in them validate alike. `default` stays (the normalizer reads it), as
 * do `format` and `content*` (options make them assertions).
 */
const PURE_ANNOTATIONS = Object.freeze(['title', 'description', '$comment', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

/**
 * A schema without its pure annotations, at every schema position (a member
 * named `title` in `properties` is kept).
 * @param {any} schema
 * @returns {any}
 */
function withoutAnnotations(schema) {
  if (!isObjectClass(schema)) return schema;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (PURE_ANNOTATIONS.includes(key)) continue;
    if (TRAVERSE_SCHEMA_OBJECTS.includes(key))
      out[key] = Array.isArray(value) ? value.map(withoutAnnotations) : withoutAnnotations(value);
    else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isObjectClass(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, withoutAnnotations(sub)]));
    else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && isObjectClass(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, withoutAnnotations({ properties: inner }).properties]));
    else out[key] = value;
  }
  return out;
}

/**
 * A registration key as a message names the document: without an empty
 * fragment.
 * @param {string} key
 * @returns {string}
 */
function documentName(key) {
  return key.endsWith('#') ? key.slice(0, -1) : key;
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
   * @param {number|null} [parentDeclaredDraft] - The draft inherited from the
   *   parent schema object; omitted for a reference target, which reads the
   *   draft its own place declares
   * @param {ValidationObject|null} [up] - The object it is a subschema of,
   *   where it is built as one: its place is below that object's
   * @param {Array<string|number|undefined>} [step] - The keyword, then the
   *   index or name inside it, then the name inside that, below `up`
   * @param {string} [reference] - The reference it is built as the target
   *   of, which names its place where no walk recorded one
   * @returns {ValidationObject} The created ValidationObject
   */
  static #createObject(self, path, schema, baseUri, parentDeclaredDraft = undefined, up = null, step = undefined, reference = undefined) {
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
    // Each object under construction holds the host's call stack: the
    // compile refuses to nest past the bound rather than exhaust it.
    const ceiling = self.#options.maxSchemaDepth ?? SCHEMA_DEPTH_CEILING;
    if (building.size >= ceiling)
      throw schemaTooDeep(ceiling, compiledLocation(up === null ? self.documentPlace(path, schema, reference) : placeBelow(up.place, /** @type {any[]} */ (step)), /** @type {string} */ (self.#rootOrigin)));
    building.set(path, schema);
    let obj;
    try {
      obj = new ValidationObject(self, path, schema, baseUri,
        parentDeclaredDraft === undefined ? placeDraft(self.#places, self.#schemas, path, schema) : parentDeclaredDraft, up, step, reference);
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
  /** @type {Map<string, unknown>} Paths whose ValidationObject is being constructed, in the order they nest, with their schemas */
  #building = new Map();
  /** @type {WeakMap<object, string>} The schema objects whose `$ref` a place declaring a contested identifier reads against itself, with that identifier */
  #ownReads = new WeakMap();
  /** @type {Array} Array of validation errors */
  #errors = null;
  /** @type {ValidationObject|null} The root schema's ValidationObject */
  #firstSchema = null;
  /** @type {DynamicScope} The dynamic scope of the validation running: the anchors of the resources it entered, outermost first */
  #dynamicScope = { names: [], validators: [], top: 0 };
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
  /** @type {boolean} Whether a collecting walk keeps what a resolved reference answered while branches are tried ({@link ValidationRoot#callReference}) */
  #keepsReferenceAnswers = false;
  /** @type {{ open: number }} The `oneOf`/`anyOf` branch walks open on the call stack */
  #branchWalks = { open: 0 };
  /** @type {Map<Function, Map<string, {data: unknown, depth: number, valid: boolean, errors: InternalValidationError[]}>>|null} What resolved references answered in this validation, by target and location */
  #keptAnswers = null;
  /** @type {EvalLog} Log of evaluated properties/items for unevaluated* support */
  #evalLog = new EvalLog();
  /** @type {object|null} The JarenValidator instance this compilation belongs to, or null when constructed standalone */
  #owner = null;
  /** @type {import('./traverse.js').SchemaPlaces|undefined} What the owner's walks read at each schema's place */
  #places = undefined;
  /** @type {Map<string, object>|null} Compiled 'errorMessage' specs by schema path; null when the schema set has none */
  #errorMessages = null;
  /** @type {UnitRecorder|null} The recorder of an output format's units (`@jarenjs/validate/output`), or null when this compilation records none */
  #recorder = null;
  /** @type {((uri: string) => DialectVocabularies)|undefined} What a dialect switches on, or undefined when every place reads the compilation's options */
  #vocabularies = undefined;
  /** @type {Map<string, ValidationOptions>} The options each `$schema` URI governing a place is read under */
  #dialectOptions = new Map();

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
    // One frame per open container, on a stack of its own rather than the
    // host's, so a document nested past the host stack (a deep `const` or
    // `default` among them) is walked; the keywords are offered in the order
    // a recursive walk offers them, each value walked before the next key.
    // `inner` holds the values of a map of maps still to walk as maps.
    const enter = (value, schema) => {
      if (value == null || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      return { node: value, keys: Array.isArray(value) ? null : Object.keys(value), at: 0, isSchema: schema, inner: null, innerAt: 0 };
    };
    const first = enter(node, isSchema);
    if (first === null) return false;
    const frames = [first];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      let child = null;
      if (frame.inner !== null) {
        if (frame.innerAt < frame.inner.length)
          child = enter(frame.inner[frame.innerAt++], false);
        else
          frame.inner = null;
      }
      else if (frame.keys === null) {
        if (frame.at < frame.node.length)
          child = enter(frame.node[frame.at++], frame.isSchema);
        else
          frames.pop();
      }
      else if (frame.at >= frame.keys.length) {
        frames.pop();
      }
      else {
        const key = frame.keys[frame.at++];
        if (!frame.isSchema)
          child = enter(frame.node[key], true);
        else if (visit(frame.node, key))
          return true;
        else if (key === '$query' || key === 'errorMessage')
          continue;
        else if (mapMaps && TRAVERSE_SCHEMA_MAP_MAPS.includes(key)) {
          // member name -> member value -> schema: both levels are names.
          const outer = frame.node[key];
          if (outer !== null && typeof outer === 'object' && !Array.isArray(outer)) {
            frame.inner = Object.values(outer);
            frame.innerAt = 0;
          }
        }
        else
          // The value of a name->schema map keyword: its keys are names, its values schemas.
          child = enter(frame.node[key], !ValidationRoot.#SCAN_MAP_KEYWORDS.has(key));
      }
      if (child !== null) frames.push(child);
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
   * runtime support: location readers (see `#readsLocation`),
   * 'unevaluatedProperties'/'unevaluatedItems', and the dynamic scope's
   * keywords.
   * @param {any} node - The schema node to scan
   * @param {Set<object>} seen - Cycle guard
   * @param {{dollarData: boolean, unevaluated: boolean, dynamic: boolean, canElide: boolean}} flags - Output flags
   * @param {boolean} mapMaps - Whether `propertyDependencies` is on
   */
  static #scanSchemaFeatures(node, seen, flags, mapMaps) {
    ValidationRoot.#walkKeywords(node, seen, (holder, key) => {
      if (ValidationRoot.#readsLocation(holder, key)) flags.dollarData = true;
      else if (key === 'unevaluatedProperties' || key === 'unevaluatedItems') {
        if (!flags.canElide || ValidationRoot.#unevaluatedForcesTracking(holder, key))
          flags.unevaluated = true;
      }
      else if (key === '$dynamicRef' || key === '$recursiveRef' || key === '$dynamicAnchor' || key === '$recursiveAnchor')
        flags.dynamic = true;
      return flags.dollarData && flags.unevaluated && flags.dynamic;
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
   * @param {(uri: string) => DialectVocabularies} [vocabularies] - What the
   *   dialect a `$schema` URI names switches on; a place under a `$schema`
   *   compiles under it ({@link ValidationRoot#optionsAt}). Without it, every
   *   place compiles under `opts`
   * @param {Map<string, any>} [held] - The schemas of the owner that `schemas`
   *   was copied from, for a compile on a validator that holds some: their
   *   features are scanned once per held set, not by every compile
   */
  constructor(origin, schemas, formats, opts = new ValidationOptions(), traverse = new TraverseOptions, owner = null, vocabularies = undefined, held = undefined) {
    const schema = schemas.get(origin);
    this.#rootOrigin = origin;
    this.#schemas = schemas;
    this.#formats = formats;
    this.#vocabularies = vocabularies;

    assertRelativePointerDialect(opts.relativePointerDialect);
    assertLengthUnit(opts.lengthUnit);
    assertDepthOption('maxReferenceDepth', opts.maxReferenceDepth);
    assertDepthOption('maxSchemaDepth', opts.maxSchemaDepth);
    assertOutputFormat(opts.outputFormat);
    this.#recorder = opts.outputFormat?.recorder?.(schemas) ?? null;
    this.#options = opts;
    this.#traverse = traverseOptionsFor(traverse, opts.propertyDependencies);
    this.#owner = owner;
    this.#places = VALIDATOR_STATE.get(owner)?.places;

    this.#objects = new Map();
    this.#errors = [];

    // Detect $data references and unevaluated* keywords once, so fast paths
    // can skip path building / annotation logging when nothing consumes them.
    // Must run before validators are compiled below.
    // Elision of unreachable unevaluated* checks relies on validators
    // short-circuiting at the first failure, so it only holds in
    // skipErrors mode (see #unevaluatedForcesTracking).
    const flags = { dollarData: false, unevaluated: false, dynamic: false, canElide: opts.skipErrors === true };
    const mapMaps = opts.propertyDependencies === true;
    /** @param {typeof flags} found @param {Map<string, any>} entries @param {Set<object>} seen */
    const scan = (found, entries, seen) => entries.forEach((value, id) => {
      // every feature found ends the scan; what the validator holds was scanned for its held set
      if (!(found.dollarData && found.unevaluated && found.dynamic) && (found !== flags || held?.get(id) !== value))
        ValidationRoot.#scanSchemaFeatures(value, seen, found, mapMaps);
    });
    const own = new Set();
    let seen = own;
    if (held !== undefined && this.#places !== undefined) {
      // the compile's reach made it (`reachedKeys`)
      const kept = /** @type {import('./traverse.js').HeldKept} */ (this.#places.kept);
      // (one validator compiles under one set of the options the scan reads)
      if (kept.scan === undefined) scan(kept.scan = { ...flags }, held, kept.scanned = new Set());
      Object.assign(flags, kept.scan);
      // a target the compile restored is read once more; the held schema objects below it were
      const theirs = /** @type {Set<object>} */ (kept.scanned);
      seen = /** @type {Set<object>} */ ({ has: (value) => theirs.has(value) || own.has(value), add: (value) => own.add(value) });
    }
    scan(flags, schemas, seen);
    this.#usesDollarData = flags.dollarData;
    // Recording runs every branch of an `anyOf` (each passing branch has
    // annotations to report), which annotation tracking already does.
    this.#usesUnevaluated = flags.unevaluated || this.#recorder !== null;
    // A collecting walk runs every branch of a `oneOf`, and the branches of
    // an `anyOf` up to a match, in full: branches that enter one definition
    // on one member through references enter it again per branch, at every
    // level below. What such an entry answers depends on the member, its
    // location and the references open around it alone where no annotation
    // is tracked, nothing records output units and no dynamic reference
    // reads the scope; there it is kept for the validation and given again,
    // errors included.
    this.#keepsReferenceAnswers = !opts.skipErrors && this.#recorder === null
      && !this.#usesUnevaluated && !flags.dynamic;

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
    this.#rootDynamicAnchors = collectDynamicAnchorsDeep(rootSchema, opts.propertyDependencies === true, null, schemas)
      .filter(anchor => anchor.schema !== rootSchema);
  }

  /** @returns {TraverseOptions} Schema traversal options */
  get traverse() { return this.#traverse; }

  /** @returns {string} The URI the compiled document is held under */
  get origin() { return /** @type {string} */ (this.#rootOrigin); }

  /** @returns {ValidationOptions} Validation options */
  get options() { return this.#options; }

  /**
   * The options a schema object is compiled under: the compilation's, with
   * the vocabularies of the dialect governing its place — the nearest
   * `$schema` on the way to it in its own document, so a document compiled
   * directly and through a `$ref` reads alike, and so does a place no walk
   * recorded (below a keyword no draft defines), which reads the nearest
   * one on the way to it as it reads its draft ({@link unwalkedReading}). A
   * place under no `$schema` reads the compilation's, as it reads the
   * compilation's draft. A dialect that requires a vocabulary this package
   * does not implement refuses every place under it (`JK0016`), one no walk
   * recorded as one it recorded. An internal collaborator of the compiler.
   * @param {string} path - The schema's location
   * @param {any} schema - The schema, or a copy of it
   * @param {string|{ place: string }} [lies] - Where it lies in its document, as
   *   a refusal names it, or the object that knows it ({@link ValidationObject#place})
   * @returns {ValidationOptions}
   */
  optionsAt(path, schema, lies = path) {
    const places = this.#places;
    const read = this.#vocabularies;
    if (read === undefined || places === undefined || !isObjectClass(schema)) return this.#options;
    const place = placeOf(places, this.#schemas, path, schema);
    const uri = places.drafts.has(place) ? places.dialectUris.get(place) : unwalkedReading(places, this.#schemas, this.#unwalkedPath(path, schema, place, lies)).dialectUri;
    if (uri === undefined) return this.#options;
    let options = this.#dialectOptions.get(uri);
    if (options === undefined) {
      const { validation, formatAssertion, contentValidation, unimplemented } = read(uri);
      if (unimplemented !== undefined)
      {
        const at = typeof lies === 'string' ? lies : lies.place;
        throw unimplementedVocabulary(uri, unimplemented, compiledLocation(isStringType(schema.$schema) ? keywordLocation(at, '$schema') : at, /** @type {string} */ (this.#rootOrigin)));
      }
      const own = this.#options;
      options = own;
      if (validation !== own.vocabValidation || formatAssertion !== own.formatAssertion || contentValidation !== own.contentValidation) {
        options = Object.assign(new ValidationOptions(), own);
        options.vocabValidation = validation;
        options.formatAssertion = formatAssertion;
        options.contentValidation = contentValidation;
      }
      this.#dialectOptions.set(uri, options);
    }
    return options;
  }

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
   * @param {number|null} [parentDeclaredDraft] - Omitted for a reference
   *   target, which reads the draft its own place declares
   * @param {ValidationObject|null} [up] - The object it is a subschema of
   * @param {Array<string|number|undefined>} [step] - Where below `up` it lies
   * @returns {ValidationObject} The created ValidationObject
   */
  createObject(path, schema, baseUri, parentDeclaredDraft = undefined, up = null, step = undefined) {
    return ValidationRoot.#createObject(this, path, schema, baseUri, parentDeclaredDraft, up, step);
  }

  /**
   * Where the schema built under a key lies in its document, as a compile
   * refusal names a place ({@link documentPlace}): an absolute spelling, a
   * place of the compiled document as `#/…`. An internal collaborator of the
   * compiler.
   * @param {string} key - The key it is built under
   * @param {unknown} schema - The schema
   * @param {string} [reference] - A reference naming it, read after the key
   * @returns {string}
   */
  documentPlace(key, schema, reference = undefined) {
    return documentPlace(this.#schemas, key, this.#places, schema, reference);
  }

  /**
   * The location an object no walk recorded is read from ({@link unwalkedReading}):
   * its own, or, where that names nothing (an object below a keyword no draft
   * defines that declares an `$id` of its own, built under it), the pointer to
   * it in its document, from which the `$schema`s on the way to it are read.
   * @param {string} path - The schema's location
   * @param {any} schema
   * @param {any} place - What the location names ({@link placeOf})
   * @param {string|{ place: string }} [lies] - Where it lies, or the object that knows it
   * @returns {string}
   */
  #unwalkedPath(path, schema, place, lies = undefined) {
    if (place !== undefined || !isObjectClass(schema)) return path;
    const at = lies === undefined || lies === path ? documentPlace(this.#schemas, path, this.#places, schema) : typeof lies === 'string' ? lies : lies.place;
    return at.startsWith('#') ? `${withoutFragment(/** @type {string} */ (this.#rootOrigin))}${at}` : at;
  }

  /**
   * Whether a schema's place lies under a `$schema` that names no draft this
   * package knows: its dynamic references are read there as where no draft
   * is declared. An internal collaborator of the compiler.
   * @param {string} path - The schema's location
   * @param {any} schema - The schema, or a copy of it
   * @param {{ place: string }} [lies] - The object that knows where it lies in its document ({@link ValidationObject#place})
   * @returns {boolean}
   */
  inForeignDialect(path, schema, lies = undefined) {
    const places = this.#places;
    if (places === undefined) return false;
    const place = placeOf(places, this.#schemas, path, schema);
    return places.drafts.has(place) ? readsForeign(places, place, this.#schemas) : unwalkedReading(places, this.#schemas, this.#unwalkedPath(path, schema, place, lies)).foreign;
  }

  /**
   * The identifier a walked schema object declares, as the walk read it: a
   * non-empty `$id`, else the draft-04 `id` where its document declares no
   * known draft. An internal collaborator of the compiler.
   * @param {any} schema - A schema object the walks recorded
   * @returns {any} The `$id` or the `id`, or undefined
   */
  identifierOf(schema) {
    return identifierOf(schema, declaredDraftOf(schema, this.#places));
  }

  /**
   * The object built at a path, without building it: `null` when none is
   * built there yet (one under construction included), and a path not seen
   * before is marked so.
   * @param {string} path - The URI path to check
   * @returns {ValidationObject|null} The existing object, or null
   */
  unresolvedObject(path) {
    const objects = this.#objects;
    if (objects.has(path))
      return objects.get(path);

    objects.set(path, null);
    return null;
  }

  /**
   * Names the object built at a path under a second key, where no object
   * is built under that key: a lookup by either key finds the one object.
   * An internal collaborator of the compiler; not part of the package's API.
   * @param {string} alias - The second key
   * @param {string} path - The key the object is built under
   * @returns {boolean} Whether this call named it under `alias`
   */
  aliasObject(alias, path) {
    const objects = this.#objects;
    const built = objects.get(path);
    if (built == null || objects.get(alias) != null) return false;
    objects.set(alias, built);
    return true;
  }

  /**
   * The levels of schema a reference compiled now spans each time a
   * validation enters it ({@link boundReference}): where its target is one
   * of the objects under construction, a schema enclosing the reference,
   * the objects nested below that target down to the one holding the
   * reference; else 1. A dynamic reference weighs the levels below its
   * initial target, which every target its dynamic scope picks instead
   * reaches the reference through. An internal collaborator of the
   * compiler; not part of the package's API.
   * @param {string} target - The reference, resolved
   * @param {unknown} [schema] - The schema it names, for a name no path spells (`#anchor`)
   * @returns {number}
   */
  referenceWeight(target, schema = undefined) {
    const building = this.#building;
    if (schema === undefined && !building.has(target)) return 1;
    let below = building.size;
    for (const [path, built] of building) {
      below--;
      if (path === target || (schema !== undefined && built === schema)) return Math.max(below, 1);
    }
    return 1;
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
   * @param {boolean} [tentative] - Answer `null` where the caller compiles
   *   the reference itself: when the target is one of the objects under
   *   construction (a reference that leads back to an enclosing schema, kept
   *   to resolve on first use), or when a hop names a document the validator
   *   holds no schema under
   * @returns {ValidationObject|null} The resolved ValidationObject
   */
  resolveObject(ref, path, schema, tentative = false) {
    if (!this.#ownReads.has(schema)) this.refuseContested(ref);
    // Fast path - check if already compiled first
    const objects = this.#objects;
    const cached = objects.get(ref);
    if (cached != null) return cached;

    // Resolve ref chain and check final ID cache
    const schemas = this.#schemas;
    const traverse = this.#traverse;
    const places = this.#placesFor(schema);
    const resolved = resolveRefSchemaDeep(schemas, path, schema, traverse, undefined, places, this.#options.draftVersion, tentative);
    if (resolved === undefined) return null;
    const { id, schema: root } = resolved;

    // A target reached by a pointer whose place declares an identifier two
    // registered places declare is built under the reference: the object
    // built under that identifier may be the other place's.
    if (places?.contested.has(id)) {
      if (tentative && this.#building.has(ref)) return null;
      return ValidationRoot.#createObject(this, ref, root, id, undefined, null, undefined, ref);
    }

    // Check if final ID is already compiled
    const finalCached = objects.get(id);
    if (finalCached != null) return finalCached;
    if (tentative && this.#building.has(id)) return null;

    // Create and cache the validation object
    return ValidationRoot.#createObject(this, id, root, undefined, undefined, null, undefined, ref);
  }

  /**
   * Refuses a reference read through an identifier two registered places
   * declare (`JK0012`): it would answer by the place registered first. A
   * reference the held place makes against its own identifier answers by
   * it, and is admitted for `holder`. An internal collaborator of the
   * compiler; not part of the package's API.
   * @param {string} ref - The reference, resolved
   * @param {string} [location] - Where the schema object holding it sits
   * @param {object} [holder] - The schema object holding it
   * @param {() => string} [at] - What names the reference's place, for the refusal
   */
  refuseContested(ref, location = undefined, holder = undefined, at = undefined) {
    const key = ref.slice(0, ref.indexOf('#') + 1) || `${ref}#`;
    if (holder !== undefined && location !== undefined && this.#readsOwnPlace(key, location)) {
      this.#ownReads.set(holder, key);
      return;
    }
    try {
      refuseContestedReference(this.#places, ref);
    }
    catch (e) {
      throw at === undefined ? e : locatedRefusal(e, at());
    }
  }

  /**
   * Whether a reference read through a contested document identifier is read
   * from inside the place the validator holds under it: a reference such a
   * place makes against its own identifier names that place, and answers by it.
   * @param {string} key - The document identifier the reference is read through
   * @param {string} location - Where the schema object holding it sits
   * @returns {boolean}
   */
  #readsOwnPlace(key, location) {
    if (!this.#places?.contested.has(key)) return false;
    const held = this.#schemas.get(key);
    const hash = location.indexOf('#');
    let place = this.#schemas.get(hash === -1 ? `${location}#` : location.slice(0, hash + 1));
    if (place === held) return true;
    if (hash === -1 || hash === location.length - 1) return false;
    for (const part of decodeJsonPointerPath(location.slice(hash + 1))) {
      place = place?.[part];
      if (place === held) return true;
    }
    return false;
  }

  /**
   * What the walks read, as a reference resolves: for a reference a place
   * reads against its own contested identifier, without that identifier.
   * @param {object} holder - The schema object holding the reference
   * @returns {import('./traverse.js').SchemaPlaces|undefined}
   */
  #placesFor(holder) {
    const places = this.#places;
    const own = this.#ownReads.get(holder);
    if (places === undefined || own === undefined) return places;
    const contested = new Map(places.contested);
    contested.delete(own);
    return { ...places, contested };
  }

  /**
   * The schema a `$ref` leads to, found without building it: the id and the
   * schema `resolveObject` builds for the same reference. An internal
   * collaborator of the compile-time analyses; not part of the package's API.
   * @param {string} base - The base the reference resolves against
   * @param {object} schema - The schema containing the $ref
   * @returns {{id: string, schema: any}}
   * @throws {SchemaCompileError} `JK0009` when the target is not held, `JK0001` when the chain loops
   */
  referencedSchema(base, schema) {
    return resolveRefSchemaDeep(this.#schemas, base, schema, this.#traverse, undefined, this.#places, this.#options.draftVersion);
  }

  /**
   * The compilation's schemas by URI: a `$schema` naming one is read by that
   * meta-schema's own `$schema` ({@link detectSchemaDraft}). An internal
   * collaborator of the compiler; not part of the package's API.
   * @returns {Map<string, any>}
   */
  get held() { return this.#schemas; }

  /**
   * The base the `$ref` of a schema object resolves against where the `$id`
   * beside it does not set it, as the walk that registered the object read
   * it. An internal collaborator of the compiler; not part of the package's
   * API.
   * @param {object} schema - The schema object holding the `$ref`
   * @param {number|null} reading - The draft the compile reads the object under
   * @returns {string|undefined}
   */
  keptRefBase(schema, reading) {
    return keptRefBase(this.#places, schema, reading);
  }

  /**
   * The schema a reference names, without following that schema's own
   * reference. An internal collaborator of the compiler; not part of the
   * package's API.
   * @param {string} ref - The reference
   * @param {string} base - The base it resolves against
   * @returns {{id: string, schema: any}}
   * @throws {SchemaCompileError} `JK0009` when the target is not held
   */
  heldSchema(ref, base) {
    return resolveRefSchemaShallow(this.#schemas, ref, base, this.#traverse, this.#places);
  }

  /**
   * Refuses (`JK0009`, at the reference) a reference that names a place below
   * the name of a document held under a plain name alone from outside that
   * document ({@link spellsHeldPlace}). An internal collaborator of the
   * compiler; not part of the package's API.
   * @param {string} ref - The reference, resolved
   * @param {object} holder - The schema object holding it
   * @param {string} keyword - Its keyword
   * @param {string|(() => string)} location - The reference's place, or what names it
   */
  refuseHeldPlace(ref, holder, keyword, location) {
    if (spellsHeldPlace(this.#schemas, ref, this.#places, holder, keyword))
      throw locatedRefusal(unresolvedReference(ref), compiledLocation(typeof location === 'function' ? location() : location, /** @type {string} */ (this.#rootOrigin)));
  }

  /**
   * The name of the document held under a plain name alone that a base lies
   * in ({@link heldNameOf}), or undefined. An internal collaborator of the
   * compiler; not part of the package's API.
   * @param {string} base
   * @returns {string|undefined}
   */
  heldNameOf(base) {
    return heldNameOf(this.#schemas, base, this.#places?.rooted);
  }

  /**
   * Refuses a reference that leads back to itself through pure references.
   * A target not built yet resolves on first use, so a loop would otherwise
   * surface as a flattened empty schema or as a call-stack overflow.
   * @param {string} path - The base the reference resolves against
   * @param {object} schema - The schema containing the $ref
   * @param {() => string} [at] - What names the `$ref`'s place, where a refusal locates it
   */
  assertNoRefLoop(path, schema, at = undefined) {
    try {
      resolveRefSchemaDeep(this.#schemas, path, schema, this.#traverse, this.#loopFree, this.#placesFor(schema), this.#options.draftVersion);
    }
    catch (e) {
      // A target that is not loaded is reported where it is used; one read
      // through a contested identifier is refused here, at compile time.
      if (isRefCycleError(e) || isContestedRefusal(e)) throw at === undefined ? e : locatedRefusal(e, at());
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

  /** @returns {boolean} Whether resolved references keep their answers while branches are tried ({@link ValidationRoot#callReference}) */
  get keepsReferenceAnswers() { return this.#keepsReferenceAnswers; }

  /**
   * The count of `oneOf`/`anyOf` branch walks open on the call stack. A
   * walk raises `open` and lowers it by assignment however it ends: while
   * the host's stack is full a call throws again, and would leave the walk
   * open for every later validation.
   * @returns {{ open: number }}
   */
  get branchWalks() { return this.#branchWalks; }

  /**
   * Call what a resolved reference enters. While a branch walk is open in a
   * compilation that keeps reference answers, an entry on the member it
   * answered before, at the same location with the same references open,
   * gives that answer again and records the errors that entry left; any
   * other call runs the target and keeps what it answered.
   * @param {Function} validate - The reference's target
   * @param {unknown} data - The member
   * @param {string} dataPath - Its location
   * @param {unknown} dataRoot - The instance
   * @returns {unknown} What the target answers
   */
  callReference(validate, data, dataPath, dataRoot) {
    if (this.#branchWalks.open === 0) return validate(data, dataPath, dataRoot);
    // Whether a reference refuses depends on the levels open, so an entry
    // made with as many open answers for this one.
    const depth = openReferences.depth;
    let byPath = this.#keptAnswers?.get(validate);
    const kept = byPath?.get(dataPath);
    if (kept !== undefined && kept.data === data && kept.depth === depth) {
      const errors = this.#errors;
      for (let i = 0; i < kept.errors.length; i++) errors.push(kept.errors[i]);
      return kept.valid;
    }
    const mark = this.#errors.length;
    const valid = validate(data, dataPath, dataRoot);
    if (typeof valid === 'boolean') {
      if (this.#keptAnswers === null) this.#keptAnswers = new Map();
      if (byPath === undefined) {
        byPath = new Map();
        this.#keptAnswers.set(validate, byPath);
      }
      byPath.set(dataPath, { data, depth, valid, errors: this.#errors.slice(mark) });
    }
    return valid;
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
    try {
      return this.#validateOnce(data);
    }
    finally {
      // The answers kept for this validation hold its instance.
      this.#keptAnswers = null;
    }
  }

  /**
   * The work of {@link validate}.
   * @param {unknown} data
   * @returns {boolean}
   */
  #validateOnce(data) {
    // only clear errors array when we need to collect errors
    // When skipErrors=true (default), we don't use the errors array
    if (!this.#options.skipErrors) {
      this.#errors = [];
    }
    // Every frame that enters a dynamic scope restores the scope it found,
    // so it is empty here already; emptied defensively.
    const scope = this.#dynamicScope;
    scope.top = 0;
    // Clear evaluation annotations from the previous validation
    if (this.#usesUnevaluated) {
      this.#evalLog.reset();
    }

    const rootValidator = this.#rootValidator;
    const anchorName = this.#rootAnchorName;
    const rootAnchors = this.#rootDynamicAnchors;
    if (anchorName !== null || rootAnchors.length !== 0) {
      try {
        if (anchorName !== null)
          this.pushDynamicAnchorValidator(anchorName, rootValidator);
        for (let i = 0; i < rootAnchors.length; ++i) {
          const anchor = rootAnchors[i];
          if (anchor.validator === null)
            anchor.validator = this.getOrCreateValidator(anchor.schema, this.#rootOrigin, this.#rootOrigin);
          this.pushDynamicAnchorValidator(anchor.name, anchor.validator);
        }
        // call compiled validator with dataRoot as third argument
        return rootValidator(data, '', data);
      } finally {
        scope.top = 0;
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
    const { names, validators, top } = this.#dynamicScope;
    for (let i = 0; i < top; i++)
      if (names[i] === anchorName) return validators[i];
    return null;
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
   * The dynamic scope of the validation running. A frame that enters a
   * resource reads `top`, pushes the resource's anchors
   * ({@link pushDynamicAnchorValidator}) and restores `top` by assignment
   * however its call ends: while the host's stack is full a call throws
   * again, and an anchor left in the scope would answer the dynamic
   * references of every later validation.
   * @returns {DynamicScope}
   */
  get dynamicScope() { return this.#dynamicScope; }

  /**
   * Push a validator onto the dynamic scope for a dynamic anchor.
   * Called when entering a schema with $recursiveAnchor or $dynamicAnchor;
   * the caller restores the scope's `top` ({@link dynamicScope}).
   * @param {string} anchorName - The anchor name
   * @param {Function} validator - The validator function
   */
  pushDynamicAnchorValidator(anchorName, validator) {
    const scope = this.#dynamicScope;
    const top = scope.top;
    scope.names[top] = anchorName;
    scope.validators[top] = validator;
    scope.top = top + 1;
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

/**
 * The dynamic scope of one compilation's validation: the validators the
 * `$dynamicAnchor`s and `$recursiveAnchor`s (named `''`) of the resources
 * entered name, in the order they were entered. The first `top` entries
 * are in scope; a dynamic reference reads the first of its name, the
 * outermost.
 * @typedef {object} DynamicScope
 * @property {string[]} names - The anchor names
 * @property {Function[]} validators - The validator each names
 * @property {number} top - How many entries are in scope
 */

/** The evaluation step of a `$ref` (see `markStep`). */
const REF_STEP = Object.freeze(['$ref']);

/**
 * The two readings of a document that declares no draft, as a compile reads
 * it: from 2019-09 on (`null`: an `$id` beside a `$ref` sets its base), and
 * before (draft-07).
 */
const LOOP_READINGS = Object.freeze([null, 7]);

/**
 * The place of a subschema below the place of the schema object holding
 * it, as a compile refusal names a place: each token escaped.
 * @param {string} place - The holder's place
 * @param {Array<string|number|undefined>} step - The keyword, then the index or name inside it, then the name inside that
 * @returns {string}
 */
function placeBelow(place, [key, index, member]) {
  if (index == null) return encodeJsonPointerPath(place, /** @type {string} */ (key));
  const at = encodeJsonPointerPath(place, /** @type {string} */ (key), String(index));
  return member == null ? at : encodeJsonPointerPath(at, String(member));
}

/**
 * Whether a document holds a blank `$ref` anywhere in it (a value that
 * merely looks like a schema object counts too).
 * @param {unknown} document
 * @returns {boolean}
 */
function holdsBlankReference(document) {
  const stack = [document];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && hasSchemaReference(node, '$ref') && isStringWhiteSpace(node.$ref)) return true;
    for (const value of Object.values(node)) stack.push(value);
  }
  return false;
}


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
    // The dynamic scope, restored by assignment by every frame that enters
    // a resource (`ValidationRoot#dynamicScope`).
    const scope = root.dynamicScope;

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
    // The walk that registered the object recorded the base it read such a
    // `$ref` against: a target reached by its own `$id`, or a document
    // root reached from another document, is built without its parent's.
    const refBase = appliesRefSiblings(draftVersion)
      ? (self.baseUri || baseUri || path)
      : (root.keptRefBase(schema, draftVersion) || baseUri || path);
    /** Where the `$ref` lies, as a refusal names it */
    const refAt = () => self.locationOf('$ref');
    const { id: ref } = createJsonPointer(schemaReference(schema, '$ref'), refBase, root.traverse, '$ref', refAt);
    root.refuseHeldPlace(ref, schema, '$ref', refAt);
    // A schema that references itself decides nothing: validating it re-enters
    // the same validator on the same instance until the stack runs out.
    if (ref === path)
      throw new RefCycleError([path, path], refAt());
    root.refuseContested(ref, path, schema, refAt);
    // Only check for sibling validators in draft 2019-09+
    const siblingValidator = appliesRefSiblings(draftVersion) ? compileSchemaObject(self, schema) : null;

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
      const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema, root.options.propertyDependencies === true, null, root.held);
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
            const entered = scope.top;
            try {
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
              return combineRefAndSiblings(callRef, siblingValidator, self.options.skipErrors,
              data, dataPath, dataRoot);
            } finally {
              scope.top = entered;
            }
          });
        } else {
          return function validateRefWithDynamicAnchor(data, dataPath, dataRoot) {
            const entered = scope.top;
            try {
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
              return callRef(data, dataPath, dataRoot);
            } finally {
              scope.top = entered;
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
    root.assertNoRefLoop(refBase, schema, refAt);
    const boundSourceAnchors = sourceDynamicAnchors;

    // Memoized state of the first resolution - the target never changes.
    let resolvedState = null;
    // The target itself, once resolved, where the reference enters no
    // dynamic scope, has no siblings and records nothing.
    let direct = null;

    // Every loop through schemas passes a reference resolved on first use, so
    // the reference depth bound holds a deep instance and a loop that never
    // descends into it alike; one back into an enclosing schema nests the
    // levels between them on each entry, and weighs them.
    const resolveAndCall = function resolveReference(data, dataPath, dataRoot) {
      if (resolvedState === null) {
        let obj;
        try {
          obj = rootRef.resolveObject(boundRef, boundRefBase, boundSchema);
        }
        catch (e) {
          // A draft-07 `$ref` that resolves to nothing, whose `$id` would
          // have named another target, says why.
          throw locatedRefusal(e?.code === 'JK0009' && createJsonPointer(schemaReference(boundSchema, '$ref'), self.baseUri || boundRefBase, rootRef.traverse).id !== boundRef
            ? unresolvedReference(boundRef, true)
            : e, refAt());
        }
        const resolvedSchema = obj.schema;

        // Entering the target resource brings ALL of its $dynamicAnchors into
        // the dynamic scope, exactly like the pre-compiled path above.
        const enterAnchors = boundSourceAnchors.slice();
        const targetDeepAnchors = collectDynamicAnchorsDeep(resolvedSchema, root.options.propertyDependencies === true, null, root.held);
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
        if (enterAnchors.length === 0 && !resolvedState.hasRecAnchor && !resolvedState.dynAnchorName
          && !boundSiblingValidator && rootRef.recorder === null)
          direct = targetValidator;
      }
      const { refValidator, callRef, enterAnchors, hasRecAnchor, dynAnchorName } = resolvedState;

      const entered = scope.top;
      try {
        for (let i = 0; i < enterAnchors.length; i++) {
          const anchor = enterAnchors[i];
          if (anchor.validator == null)
            anchor.validator = rootRef.getOrCreateValidator(anchor.schema, path, anchor.base || baseUri);
          rootRef.pushDynamicAnchorValidator(anchor.name, anchor.validator);
        }

        if (hasRecAnchor || dynAnchorName) {
          rootRef.pushDynamicAnchorValidator(dynAnchorName || '', refValidator);
          // If there are sibling validators (draft 2019-09+), combine them with the ref validator
          if (boundSiblingValidator) {
            return combineRefAndSiblings(callRef, boundSiblingValidator,
              self.options.skipErrors, data, dataPath, dataRoot);
          }
          return callRef(data, dataPath, dataRoot);
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
        scope.top = entered;
      }
    };

    // The reference counts toward the depth bound itself (as boundReference
    // would around it, and by its rules: the count lowered by assignment,
    // the host's stack refusal coded by the outermost counted reference,
    // which alone holds a handler), a call per validation fewer. The count
    // is read through this closure: an import binding read per access is
    // slower.
    const ceiling = root.options.maxReferenceDepth;
    const weight = root.referenceWeight(ref);
    const keepsAnswers = root.keepsReferenceAnswers;
    const open = openReferences;
    const outermost = function resolveOutermostReference(data, dataPath, dataRoot) {
      if (open.depth + weight > ceiling) throw referencesTooDeep(path, ceiling, weight);
      open.depth += weight;
      open.count++;
      try {
        if (direct !== null)
          return keepsAnswers ? rootRef.callReference(direct, data, dataPath, dataRoot) : direct(data, dataPath, dataRoot);
        return resolveAndCall(data, dataPath, dataRoot);
      }
      catch (error) {
        throw referenceUnwound(error, path);
      }
      finally {
        open.depth -= weight;
        open.count--;
      }
    };
    return wrapUnevaluated(self, schema, function resolveSchemaCompiler(data, dataPath, dataRoot) {
      if (open.count === 0) return outermost(data, dataPath, dataRoot);
      if (open.depth + weight > ceiling) throw referencesTooDeep(path, ceiling, weight);
      open.depth += weight;
      open.count++;
      try {
        if (direct !== null)
          return keepsAnswers ? rootRef.callReference(direct, data, dataPath, dataRoot) : direct(data, dataPath, dataRoot);
        return resolveAndCall(data, dataPath, dataRoot);
      }
      finally {
        open.depth -= weight;
        open.count--;
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
  /** @type {function|null} Dynamic resource scope around the current validator */
  #resourceValidator = null;
  /** @type {string} The effective base URI for child $ref resolution */
  #effectiveBaseUri = null;
  /** @type {number|null} Draft version declared by this schema's document ($schema), inherited by subschemas; null when never declared */
  #declaredDraft = null;
  /** @type {ValidationOptions} The options this object compiles under: its root's, with the vocabularies of the dialect governing its place */
  #options;
  /** @type {ValidationObject|null} The object this one is a subschema of, where it was built as one */
  #up = null;
  /** @type {Array<string|number|undefined>|undefined} Where below `#up` it lies */
  #step = undefined;
  /** @type {string|undefined} The reference it was built as the target of, which names its place where no walk recorded one */
  #reference = undefined;
  /** @type {string|null} Where it lies in its document, once asked ({@link ValidationObject#place}) */
  #place = null;

  /**
   * Creates a new ValidationObject.
   * @param {ValidationRoot} root - The root validation context
   * @param {string} path - The URI path identifying this schema object
   * @param {any} schema - The schema object to compile
   * @param {string} baseUri - The base URI for resolving $ref
   * @param {number|null} [parentDeclaredDraft] - The declared draft inherited from the parent schema object
   * @param {ValidationObject|null} [up] - The object it is a subschema of, where it is built as one
   * @param {Array<string|number|undefined>} [step] - Where below `up` it lies: the keyword, the index or name inside it, the name inside that
   * @param {string} [reference] - The reference it is built as the target of
   */
  constructor(root, path, schema, baseUri, parentDeclaredDraft = null, up = null, step = undefined, reference = undefined) {
    this.#root = root;
    this.#path = path;
    this.#up = up;
    this.#step = step;
    this.#reference = reference;
    this.#members = [];
    this.#schema = schema;
    this.#validator = null;

    // A document that declares its own $schema is processed per that draft
    // (cross-draft references); subschemas inherit the document's draft.
    this.#declaredDraft = (isObjectClass(schema) && isStringType(schema.$schema))
      ? detectSchemaDraft(schema, root.held)
      : parentDeclaredDraft;

    // Calculate the effective base URI for this schema.
    // The effective base is what children should use for resolving relative $refs.
    // If this schema has an $id, it becomes the new base for children.
    // (`$id`, or the draft-04 `id` where no known draft is declared)
    const identifier = identifierOf(schema, root.inForeignDialect(path, schema, this) ? null : this.#declaredDraft);
    if (identifier !== undefined) {
      // This schema has its own $id - resolve it against the parent's baseUri
      // to get the absolute base for children
      const keyword = schema.$id ? '$id' : 'id';
      const { id: resolvedId } = createJsonPointer(identifier, baseUri, undefined, keyword, () => this.locationOf(keyword));
      this.#effectiveBaseUri = resolvedId.endsWith('#') ? resolvedId.slice(0, -1) : resolvedId;
    } else {
      // No $id - inherit parent's base
      this.#effectiveBaseUri = baseUri;
    }

    this.#options = root.optionsAt(path, schema, this);
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
    if (draft >= 2020 && isStringType(identifier)
      && path !== baseUri) {
      const anchors = collectDynamicAnchorsDeep(schema, root.options.propertyDependencies === true, this.#declaredDraft, root.held);
      if (anchors.length > 0) {
        const resourceBase = this.#effectiveBaseUri;
        const inner = (data, dataPath, dataRoot, dataKey) => this.#validator(data, dataPath, dataRoot, dataKey);
        const scope = root.dynamicScope;
        this.#resourceValidator = (data, dataPath, dataRoot, dataKey) => {
          const entered = scope.top;
          try {
            for (let i = 0; i < anchors.length; i++) {
              const anchor = anchors[i];
              anchor.validator ??= anchor.schema === schema
                ? inner
                : root.getOrCreateValidator(anchor.schema, path, resourceBase);
              root.pushDynamicAnchorValidator(anchor.name, anchor.validator);
            }
            return inner(data, dataPath, dataRoot, dataKey);
          }
          finally {
            scope.top = entered;
          }
        };
      }
    }
  }

  /** @returns {string} The URI path identifying this schema object */
  get path() {
    return this.#path;
  }

  /**
   * Where the schema object lies in its document, as a compile refusal names
   * a place: the JSON Pointer to it, every token escaped, after the name of
   * a document the validator holds, or alone after `#` in the compiled
   * document. An embedded resource is a place of its document (its `$id`
   * names no place), and a reference target is named where it lies.
   * @returns {string}
   */
  get place() {
    if (this.#place === null) {
      const up = this.#up;
      this.#place = up === null ? this.#root.documentPlace(this.#path, this.#schema, this.#reference) : placeBelow(up.place, /** @type {any[]} */ (this.#step));
    }
    return this.#place;
  }

  /**
   * Where a keyword of the schema object lies, or a member or item inside
   * its value, as a compile refusal names it (`docPath`).
   * @param {string} keyword
   * @param {...(string|number)} members - The member names and item indexes inside the value
   * @returns {string}
   */
  locationOf(keyword, ...members) {
    return compiledLocation(keywordLocation(this.place, keyword, ...members), this.#root.origin);
  }

  /** @returns {string} The effective base URI for resolving relative $refs */
  get baseUri() {
    return this.#effectiveBaseUri;
  }

  /** @returns {function} The compiled validator function */
  get validate() {
    return this.#resourceValidator ?? this.#validator;
  }

  /** @returns {ValidationOptions} The validation options this object compiles under */
  get options() {
    return this.#options;
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
   * @returns {number|null} The draft its dynamic references (`$recursiveRef`,
   *   `$dynamicRef`) are read in: the declared draft, or null under a
   *   `$schema` that names no draft this package knows
   */
  get dynamicReferenceDraft() {
    return this.#declaredDraft !== null && this.#root.inForeignDialect(this.#path, this.#schema, this) ? null : this.#declaredDraft;
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

    // Check if schema has $id (or the draft-04 `id` where it is read) - this
    // affects how we calculate the path
    const identifier = root.identifierOf(schema);
    const hasId = identifier !== undefined;

    // If schema has $id, resolve it against basePath to get the new base URI
    // Otherwise, use the current path
    const step = [key, index, member];
    const keyword = schema.$id ? '$id' : 'id';
    const id = hasId
      ? createJsonPointer(identifier, basePath || this.#path, undefined, keyword,
        () => compiledLocation(keywordLocation(placeBelow(this.place, step), keyword), root.origin)).id
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
      : root.createObject(path, schema, basePath, this.#declaredDraft, this, step);
    this.#members.push(child);

    return markStep(root.recorder, step, child.validate);
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
      if (opts.collectErrors != null || opts.skipErrors != null || opts.useGrapheme != null || opts.contentValidation != null || opts.draftVersion != null || opts.formatAssertion != null || opts.messages != null || opts.unknownFormats != null || opts.propertyDependencies != null || opts.relativePointerDialect != null || opts.maxReferenceDepth != null || opts.outputFormat !== undefined || opts.maxSchemaDepth != null || opts.lengthUnit != null) {
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
          opts.outputFormat,
          opts.maxSchemaDepth ?? SCHEMA_DEPTH_CEILING,
          opts.lengthUnit ?? undefined
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
 * The object a compiled validator returns when `collectErrors` is enabled,
 * discriminated by `valid`: a valid instance answers no errors. It carries
 * no copy of the instance, so it cannot narrow the instance's type: the
 * collector's `narrow` answers {@link NarrowedResult}, which does.
 * @typedef {{ valid: true, errors: [] } | { valid: false, errors: import("./messages.js").ValidationError[] }} ValidationResultObject
 */

/**
 * What a collect-mode validator's `narrow(data)` returns: its
 * {@link ValidationResultObject}, whose valid branch also carries the
 * instance as `value`, typed `T` (the instance itself, not a copy).
 * @template [T=unknown]
 * @typedef {{ valid: true, value: T, errors: [] } | { valid: false, errors: import("./messages.js").ValidationError[] }} NarrowedResult
 */

/**
 * A compiled validator in the default boolean mode. It is a type guard, so
 * `T` is whatever the caller asserts the schema describes; with no `T` it
 * behaves as an ordinary boolean predicate.
 * @template T
 * @typedef {(data: unknown) => data is T} CompiledPredicate
 */

/**
 * A compiled validator in collect-errors mode. Called, it answers
 * `{ valid, errors }`; its `narrow` answers the same validation with the
 * instance on the valid branch, typed `T`, so `if (r.valid) r.value`
 * reads the instance as `T` with no type guard of the caller's own.
 * @template [T=unknown]
 * @typedef {((data: unknown) => ValidationResultObject) & { readonly narrow: (data: unknown) => NarrowedResult<T> }} CompiledCollector
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
 * @property {boolean} [useGrapheme] - Count grapheme clusters for string length (default true); false counts UTF-16 code units. An alias of `lengthUnit` (`'grapheme'` / `'utf16'`), which wins when both are given
 * @property {'grapheme'|'codepoint'|'utf16'} [lengthUnit] - What `minLength`/`maxLength` count: `'grapheme'` (the default) clusters, `'codepoint'` code points (what JSON Schema, SQLite's `length()` and PostgreSQL's `char_length()` count), `'utf16'` code units. Another value: a TypeError when a schema compiles
 * @property {boolean} [contentValidation] - Assert contentEncoding/contentMediaType
 * @property {number} [draftVersion] - The JSON Schema draft version
 * @property {boolean} [formatAssertion] - Assert the format keyword
 * @property {boolean} [messages] - Render English message text on collected errors
 * @property {'error'|'ignore'} [unknownFormats] - What an ASSERTING `format` with no registered compiler (an unregistered name, or a value that is no name) does: 'ignore' (default, per spec) accepts it as an annotation, 'error' refuses the schema at compile time (`JK0015`)
 * @property {boolean} [propertyDependencies] - Assert the `propertyDependencies` proposal keyword (default false: it is an unknown keyword); applies in draft 2020-12 (and draft-next) documents and in documents that declare no draft
 * @property {'handrews-01'|'bhutton-00'} [relativePointerDialect] - The Relative JSON Pointer grammar of `data`, `$data` and the `relative-json-pointer` format: `'handrews-01'` (default) or `'bhutton-00'`, which also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`)
 * @property {number} [maxReferenceDepth] - The deepest nesting, in levels of schema, of the references one validation enters before it throws `JK2001`, a reference back into a schema enclosing it weighing the levels between them (default 256, the same on every host; a larger value lets the host's call stack decide again). Also bounds `validateSchema`. Not a positive safe integer: `JK0002` when a schema compiles
 * @property {TOutput} [outputFormat] - Return a JSON Schema standard output instead of a boolean or `{ valid, errors }`: a format from `@jarenjs/validate/output`; it takes precedence over `collectErrors`. Another value (a format's name as a string included): `JK0003` when a schema compiles
 * @property {number} [maxSchemaDepth] - The deepest nesting of subschemas one compile builds before it throws `JK0017` (default 128, the same on every host; a larger value lets the host's call stack decide again). Not a positive safe integer: `JK0002` when a schema compiles
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
  /** @type {import('./traverse.js').SchemaPlaces} What the walks read at each registered schema's place */
  #places = { drafts: new WeakMap(), refBases: new WeakMap(), keptRefs: new Set(), unread: new Map(), undecidedBases: new WeakMap(), lateTargets: new Set(), foreign: new WeakSet(), dialects: new WeakMap(), dialectUris: new WeakMap(), contested: new Map(), refs: new WeakMap(), idBases: new WeakMap(), locations: new WeakMap(), rooted: undefined, ownRefs: undefined, kept: undefined };
  /** @type {Map<string, string>} The key of the document each registered identifier came from */
  #registeredIn = new Map();
  /** @type {WeakSet<object>} The documents `addSchema` registered under a key of their own */
  #documents = new WeakSet();
  /** @type {WeakMap<object, object>} The caller's own document of each copy `addSchema` holds with a resolved root `$id` */
  #originals = new WeakMap();

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
    VALIDATOR_STATE.set(this, { schemas: this.#schemas, traverse: this.#traverse, places: this.#places });
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
   * The schema a compile reads: the schema itself, or, when its root `$id`
   * is a relative reference that names another URI when it is resolved
   * again against itself (`sub/s.json`), a copy whose `$id` is that
   * reference resolved once against the origin. Every later step resolves
   * the root's `$id` against the URI the document is held under, which only
   * an absolute `$id` leaves unchanged.
   * @param {boolean | object} schema
   * @param {TraverseOptions} traverse
   * @returns {boolean | object}
   */
  static #withResolvedRootId(schema, traverse) {
    if (!isObjectClass(schema) || !isStringType(schema.$id) || isStringWhiteSpace(schema.$id)) return schema;
    // read without a JSON Pointer fragment; one that is only such a fragment
    // is read as no `$id` by the walk
    const text = identifierText(schema.$id);
    if (text === undefined) return schema;
    const { id } = createJsonPointer(text, traverse.origin, traverse, '$id', '#/%24id');
    if (text === schema.$id && createJsonPointer(text, id, traverse).id === id) return schema;
    return { ...schema, $id: id.endsWith('#') ? id.slice(0, -1) : id };
  }

  /**
   *
   * @param {boolean | object} schema
   * @param {object[] | undefined} schemas
   * @param {TraverseOptions} opts
   * @param {import('./traverse.js').SchemaPlaces} [places] - Where the walks record what each place reads
   * @param {boolean} [namesDocument] - Whether a root `$id` with a fragment also names the
   *   document: a compile's own map, which no later compile reads
   * @param {import('./traverse.js').SchemaPlaces} [records] - Where the walks record what each
   *   reference asks for and the base of each identifier: `places` for a compile, the
   *   validator's for a meta-schema, which is walked without `places`
   * @returns {{origin:string, map: Map, reached: Map<string, string>|undefined}} The id the
   *   document is compiled under, the schemas, and, for a compile on a validator that holds
   *   schemas, what it reaches of them
   */
  static #traverseSchema(schema, schemas = undefined, fromMap = undefined, opts = new TraverseOptions(), places = undefined, namesDocument = false, records = places) {
    // initialize schema map for all ids and refs
    const schemaMap = new Map(fromMap);
    /** The first `$ref` of the documents naming each target, where a refusal to resolve it is located. */
    const sites = new Map();
    // What the references of a compile's documents ask for is recorded apart
    // from what the registered documents' do, which is kept per held set,
    // and only where the validator holds schemas the compile may not reach.
    const refs = fromMap ? fromMap.size ? new Map() : undefined : records?.refs;
    // The places of a compile's documents are its own: the compiled one's are
    // spelled `#/…`; a meta-schema's are the validator's.
    const located = fromMap ? compiledPlacesOf(schemaMap) : records?.locations;
    // The schema's document is read under the draft `compile` reads it
    // under: the one it declares, draft-07 when it declares none.
    const origin = storeSchemaIdsInMap(
      schemaMap,
      opts.origin,
      schema,
      opts,
      undefined,
      places,
      detectSchemaDraft(schema, schemaMap),
      undefined,
      undefined,
      sites,
      refs,
      records?.idBases,
      located && { map: located, as: fromMap ? '#' : undefined });
    // A root `$id` with a fragment (`#root`, `…/s.json#root`) names the
    // document too: its pointers resolve against the URI before the
    // fragment, as `addSchema(document, key)` holds it under the key. The URI
    // is taken only where no other schema holds it, and only for a compile:
    // a meta-schema held so under the origin would take it from every later
    // document without an `$id` (`JK0012`). The document is then compiled
    // under that URI, where its places are (`…/s.json#/properties/a`), and
    // its name answers by the same build (`#precompileRefs`).
    let root = origin;
    const hash = namesDocument && isObjectClass(schema) && isStringType(schema.$id) ? origin.indexOf('#') : -1;
    if (hash > 0 && hash < origin.length - 1) {
      const document = origin.slice(0, hash);
      for (const key of [document, `${document}#`])
        if (schemaMap.get(key) == null) schemaMap.set(key, schema);
      if (schemaMap.get(`${document}#`) === schema) root = `${document}#`;
    }

    // Then add the other reference schemas
    if (Array.isArray(schemas) && schemas.length > 0) {
      schemas.forEach(ref => storeSchemaIdsInMap(
        schemaMap,
        origin,
        ref,
        opts,
        undefined,
        places,
        undefined,
        undefined,
        undefined,
        sites,
        refs,
        records?.idBases,
        located && { map: located }));
    }

    // What this compile reaches of the schemas the validator holds: its own
    // documents are read whole, a held schema only where a reference leads.
    // (the map of a compile's own records: one that holds schemas, and has its places)
    const reached = refs instanceof Map
      ? reachedKeys(Array.isArray(schemas) ? [schema, ...schemas] : [schema], refs, /** @type {import('./traverse.js').SchemaPlaces} */ (places), /** @type {Map<string, any>} */ (fromMap), opts)
      : undefined;

    // make sure the schemas this compile reads are connected
    restoreSchemaRefsInMap(schemaMap, opts, places, detectSchemaDraft(schema, schemaMap), sites, reached);

    return { origin: root, map: schemaMap, reached };
  }

  /**
   * Adds schema(s) to the validator instance.
   * This method does not compile schemas - it only registers them for reference.
   * Dependencies can be added in any order, and circular dependencies are supported.
   * A document answers as the same document compiled with the URI it is
   * held under as its root `$id`: a relative root `$id` is resolved against
   * the key (or the origin), and a root without an identifier is named by
   * the key. `getSchema` answers the object added.
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
      this.#places.kept = undefined;
      const document = this.#heldDocument(schema, key);
      if (document !== schema) this.#originals.set(document, schema);
      schema = document;
      const named = key || (isObjectClass(schema) ? schema.$id : undefined);
      const schemaKey = typeof named === 'string' ? caselessUri(named) : named;
      if (schemaKey) {
        schema = this.#underOwnName(schema, schemaKey);
        const before = new Map(this.#schemas);
        const contestedBefore = new Map(this.#places.contested);
        this.#schemas.set(schemaKey, schema);
        if (isObjectClass(schema)) this.#documents.add(schema);
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
        const faulted = this.#traverseAndStoreIds(schemaKey, schema);

        // A ring of references registered here would make every later compile
        // on this validator throw, so it is refused where it is added. A
        // document holding a place the walk refused does not compile as a
        // whole, and what else it holds answers: a ring in it is refused by
        // the compile that reaches it (`JK0001`), not here.
        try {
          if (!faulted) this.#assertNoRefLoops(schemaKey);
        }
        catch (e) {
          this.#schemas.clear();
          for (const [k, v] of before) this.#schemas.set(k, v);
          const contested = this.#places.contested;
          contested.clear();
          for (const [k, v] of contestedBefore) contested.set(k, v);
          throw e;
        }
      }
    }
    return this;
  }

  /**
   * The document `addSchema` holds: read as the same document compiled with
   * the URI it is held under as its root `$id`. A relative root `$id` is
   * resolved once, against the key, or against the origin when there is
   * none, as a compile resolves a reference to it; a root that declares no
   * identifier (no string `$id`, nor a draft-04 `id` where one is read),
   * held under a key that is an absolute URI of a document (no fragment), is
   * named by the key. Either
   * way a copy is held, and `getSchema` answers the caller's own object. A
   * fragment-only root `$id` (`#node`) is such a relative reference: it names
   * the document by the key and the name.
   * @param {any} schema
   * @param {string|undefined} key
   * @returns {any}
   */
  #heldDocument(schema, key) {
    if (!isObjectClass(schema)) return schema;
    const id = schema.$id;
    if (isStringType(id) && !isStringWhiteSpace(id)) {
      // read without a JSON Pointer fragment: one that is only such a
      // fragment is no identifier, held as a document without `$id` is
      const text = identifierText(id);
      if (text === undefined) {
        const { $id: _pointer, ...document } = schema;
        return this.#heldDocument(document, key);
      }
      if (text === id && URL.canParse(id)) return schema;
      let resolved;
      try {
        resolved = createJsonPointer(text, key ?? this.#traverse.origin, this.#traverse).id;
      }
      catch {
        return schema; // no URI reference: every compile refuses it (`JK0010`)
      }
      return { ...schema, $id: resolved.endsWith('#') ? resolved.slice(0, -1) : resolved };
    }
    // a key with a fragment names a place, not the document
    if (typeof key !== 'string' || !URL.canParse(key) || /#./.test(key)) return schema;
    const declared = isStringType(schema.$schema) ? dialectDraft(schema.$schema, this.#schemas) : null;
    if (identifierKeyword(schema, declared) === 'id') return schema;
    return { ...schema, $id: key.endsWith('#') ? key.slice(0, -1) : key };
  }

  /**
   * The document `addSchema` holds where it is held under a plain name
   * alone: its root `$id` holds a plain-name fragment (`#root`,
   * `…/r.json#root`) and the document is not held under the URI before that
   * fragment (no key, or the key of another URI), so that URI is another
   * schema's, a later compile's own document's, or nobody's. Such a document
   * is the document of its own places: a copy is held whose references to
   * itself (`#`, `#/definitions/s`) name the places below its name
   * (`…#root/definitions/s`, {@link underOwnName}), and `getSchema` answers
   * the caller's own objects. Any other document is returned as it is.
   * @param {any} document - The document, its root `$id` resolved ({@link JarenValidator.#heldDocument})
   * @param {string} key - The key `addSchema` registers it under
   * @returns {any}
   */
  #underOwnName(document, key) {
    if (!isObjectClass(document) || !isStringType(document.$id) || isStringWhiteSpace(document.$id)) return document;
    const text = identifierText(document.$id);
    if (text === undefined) return document;
    // anchors are read per document, as the registration walk reads them
    const opts = { anchorsGlobal: false, anchorsAllowed: this.#traverse.anchorsAllowed, skipErrors: true };
    let name;
    try {
      const { id, leftUri, fragment } = createJsonPointer(text, key, opts);
      const hash = key.indexOf('#');
      // not a plain name, or the document is registered under that URI itself
      if (fragment === null || fragment[0] === '/' || leftUri === (hash === -1 ? `${key}#` : hash === key.length - 1 ? key : undefined)) return document;
      name = id;
    }
    catch {
      return document; // no URI reference: every compile that reads it refuses it (`JK0010`)
    }
    const held = underOwnName(document, name, opts, this.#schemas, this.#originals, this.#places.ownRefs ??= new WeakMap());
    (this.#places.rooted ??= new WeakSet()).add(held);
    return held;
  }

  /**
   * Refuses a loop of pure references among the registrations of one
   * document that every compile would read. A `$ref` beside an `$id` in a
   * document that declares no draft is read two ways (the `$id` sets its
   * base from 2019-09 on, not before): a loop only one reading makes is
   * refused by the compile that reads it so (`JK0001`), not here. In a
   * document holding a blank `$ref` a loop is refused by the compile that
   * reaches it too: such a document registered when a blank `$ref` was read
   * as none, and what else it holds answers.
   * @param {string} documentKey - The key the document was registered under
   */
  #assertNoRefLoops(documentKey) {
    const hash = documentKey.indexOf('#');
    const prefix = hash === -1 ? documentKey : documentKey.slice(0, hash);
    if (holdsBlankReference(this.#schemas.get(documentKey))) return;
    for (const [key, entry] of this.#schemas) {
      if (!key.startsWith(prefix) || !isObjectClass(entry) || !hasSchemaReference(entry, '$ref'))
        continue;
      let loop;
      for (const reading of LOOP_READINGS) {
        try {
          resolveRefSchemaDeep(this.#schemas, key, entry, this.#traverse, undefined, this.#places, reading);
        }
        catch (e) {
          // A target not registered yet is reported where it is used.
          if (isRefCycleError(e)) {
            loop ??= e;
            continue;
          }
        }
        loop = undefined;
        break;
      }
      // (located at the `$ref` of the registration that enters the loop)
      if (loop !== undefined) throw locatedRefusal(loop, keywordLocation(documentPlace(this.#schemas, key, this.#places, entry), '$ref'));
    }
  }

  /**
   * Traverse a schema and store all $id anchors in the schemas map.
   * This is a wrapper around storeSchemaIdsInMap that skips already-existing keys.
   * Anchors are scoped to their document context (anchorsGlobal: false) to prevent
   * conflicts between different schemas that may use the same anchor names.
   * @param {string} baseUri - The base URI for the schema
   * @param {object} schema - The schema to traverse
   * @returns {boolean} Whether the walk refused a place below the document's root
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

    // Use a wrapper map to collect new entries, then merge them. A place the
    // walk refuses registers nothing and the walk goes on, so the rest of
    // the document stays registered: an `$id` or a `$ref` that is no URI
    // reference is refused (`JK0010`) by the compile that reads it. An
    // identifier declared twice keeps its first place, and is contested
    // when the two places differ: a compile that reads it is refused
    // (`JK0012`), every other compile answers. A document whose own `$id`
    // is no URI reference registers nothing more; every compile refuses it.
    const contested = this.#places.contested;
    const newSchemas = new Map();
    let faulted = false;
    try {
      storeSchemaIdsInMap(newSchemas, baseUri, schema, scopedOpts, undefined, this.#places, null, (_error, twice) => {
        faulted = true;
        if (twice === undefined || this.#samePlace(twice.id, twice.first, twice.second)) return;
        const names = `in '${documentName(baseUri)}', at '${twice.firstAt ?? '#'}' and at '${twice.secondAt}'`;
        contested.set(twice.id, names);
      }, this.#schemas, undefined, this.#places.refs, this.#places.idBases, { map: this.#places.locations });
    } catch (_e) {
      // the document's own `$id` (see above)
    }

    // Merge new entries into the main schemas map; an unresolved entry (a
    // reference an earlier schema made) is filled. An identifier an earlier
    // document declares keeps that place, and is contested when the two
    // places differ.
    const registeredIn = this.#registeredIn;
    for (const [id, value] of newSchemas.entries()) {
      const held = this.#schemas.get(id);
      if (held == null) {
        this.#schemas.set(id, value);
        if (value != null) registeredIn.set(id, baseUri);
      }
      else if (value != null && !this.#samePlace(id, held, value))
        contested.set(id, `one registered under '${documentName(registeredIn.get(id) ?? id)}', one under '${documentName(baseUri)}'`);
    }
    return faulted;
  }

  /**
   * Whether an identifier two registered places declare answers one way:
   * both are one object, or equal JSON read under one draft once the pure
   * annotations are set aside, or the
   * identifier names a document (no anchor) and the first place is a
   * document registered under a key of its own (the latest registration
   * under a key names it, whatever a nested place declares).
   * @param {string} id
   * @param {any} first
   * @param {any} second
   * @returns {boolean}
   */
  #samePlace(id, first, second) {
    if (first === second) return true;
    const hash = id.indexOf('#');
    if (this.#documents.has(first) && (hash === -1 || hash === id.length - 1)) return true;
    const places = this.#places;
    const held = this.#schemas;
    if (placeDraftOf(places, first, held) !== placeDraftOf(places, second, held)
      || readsForeign(places, first, held) !== readsForeign(places, second, held)) return false;
    try {
      return equalsJson(withoutAnnotations(first), withoutAnnotations(second));
    }
    catch {
      return false; // a cycle or a nesting too deep to compare
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
    // The same answer, carrying the instance on its valid branch.
    Object.defineProperty(jarenValidateSchema, "narrow", {
      value: function narrow(data) {
        const result = jarenValidateSchema(data);
        return result.valid ? { valid: true, value: data, errors: result.errors } : result;
      }
    })

    return jarenValidateSchema;
  }

  /**
   * The key a schema is held under for a URI: its scheme and host in lower
   * case (RFC 3986 reads both in any case), the rest as written, and an
   * empty fragment where it has none. Anything but a string is returned as is.
   * @template T
   * @param {T} key - A schema URI
   * @returns {T}
   */
  static normalizeUriKey(key) {
    return /** @type {T} */ (typeof key === 'string' ? heldUriKey(key) : key);
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
      const { origin, map } = JarenValidator.#traverseSchema(first, siblings, undefined, new TraverseOptions(key), undefined, false, this.#places);
      const compiled = JarenValidator.#compileSchema(this, origin, map, validation);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    else if (isBoolOrObjectClass(schema)) {
      const { origin, map } = JarenValidator.#traverseSchema(schema, undefined, undefined, new TraverseOptions(key), undefined, false, this.#places);
      const compiled = JarenValidator.#compileSchema(this, origin, map, validation);
      this.#metaSchemas.set(origin, compiled);
      mergeMap(this.#schemas, map);
    }
    // what was kept of the held schemas ends here
    this.#places.kept = undefined;
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
    let held = this.#schemas.get(JarenValidator.normalizeUriKey(key));
    // a relative key names what `addSchema` held a relative `$id` under:
    // the `$id` resolved against the origin
    if (held == null && typeof key === 'string' && !URL.canParse(key)) {
      try {
        held = this.#schemas.get(createJsonPointer(key, this.#traverse.origin, this.#traverse).id);
      }
      catch {
        // no URI reference: nothing is held under it
      }
    }
    return held == null ? null : this.#originals.get(held) ?? held;
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

    const named = (isObjectClass(schema) ? schema.$schema : undefined) || DEFAULT_SCHEMA_DRAFT;
    const metaSchema = typeof named === 'string' ? heldDialect(named, (key) => this.#metaSchemas.get(key)) : undefined;
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
  /**
   * The pure `$ref` hop a pointer id names in its document, or undefined
   * where it names another schema, or nothing: the object at its location,
   * walked as `placeOf` walks one.
   * @param {Map<string, any>} schemas
   * @param {string} id - A key of the map holding a JSON Pointer fragment
   * @param {TraverseOptions} traverse
   * @param {WeakSet<object>} [rooted] - The documents held under a plain name alone
   * @returns {object|undefined}
   */
  static #referenceHopAt(schemas, id, traverse, rooted) {
    const node = placeAt(schemas, id, rooted);
    return isReferenceHop(node, traverse) ? node : undefined;
  }

  static #precompileRefs(root, schemas, origin, places, held = undefined, reached = undefined) {
    // Pre-create validation objects for the refs in the schemas map
    // This moves ref resolution from validation time to compile time

    // Of the schemas the validator holds, only the ones this compile reaches
    // are built. A held schema whose identifier is no URI reference is among
    // them for every compile (`reachedKeys`): the first pass refuses it.
    /** @param {string} id @param {any} schema @returns {boolean} Whether the entry is a held schema this compile does not reach */
    const unreached = (id, schema) => held?.get(id) === schema && !/** @type {Map<string, string|null>} */ (reached).has(id);
    /**
     * Whether a failure to build the schema under `id` is the compile's: a
     * query literal that compiles its own document, a reference cycle in the
     * compiled document. In a place built only because its references are
     * not known (`reachedKeys` enters it without a place) neither is.
     * @param {unknown} error @param {string} id @returns {boolean}
     */
    const fails = (error, id) => reached?.get(id) !== null && (isRecursiveQueryCompileError(error) || (isRefCycleError(error) && inDocument(id, origin)));

    // First pass: Create objects for schemas with $id (canonical paths)
    // These establish the base URIs for their descendants
    /** @type {Set<string>} The plain names of documents built under their URI: each answers by that build */
    const named = new Set();
    for (const [id, schema] of schemas.entries()) {
      // Skip null placeholders, and what this compile does not reach
      if (schema == null || unreached(id, schema)) continue;

      // A plain name of the document itself (`…/s.json#root`, by a root
      // `$id` or an anchor, where `…/s.json#` is the same schema): the
      // document is built once, under its URI, where its places are, and
      // that object answers for the name.
      const hash = id.indexOf('#');
      if (hash > 0 && hash < id.length - 1 && id[hash + 1] !== '/' && schemas.get(id.slice(0, hash + 1)) === schema) {
        named.add(id);
        continue;
      }

      // Skip if already compiled
      if (root.unresolvedObject(id) !== null) continue;

      // Only process schemas with $id that are stored under their $id path
      // (not JSON pointer paths)
      const identifier = root.identifierOf(schema);
      if (identifier === undefined) continue;

      // Check if this id matches the resolved $id
      const { id: resolvedId } = createJsonPointer(identifier, origin, undefined, schema.$id ? '$id' : 'id', () => compiledLocation(keywordLocation(root.documentPlace(id, schema), schema.$id ? '$id' : 'id'), origin));
      if (id === resolvedId) {
        // This is a canonical $id path - create with origin as base
        try {
          root.createObject(id, schema, origin);
        } catch (_e) {
          if (fails(_e, id)) throw _e;
          // May fail if dependencies not resolved yet
        }
      }
    }

    // Second pass: Create objects for remaining schemas
    // This includes:
    // 1. JSON pointer paths (e.g., #/definitions/x) - calculate baseUri by finding nearest ancestor $id
    // 2. Canonical $id paths with relative $ids that weren't matched in first pass
    // An `$id`'s URI is held with and without the empty fragment
    // (`…/s.json#` and `…/s.json`); the document is built once, under the
    // `#` spelling, and that object answers for both spellings.
    /** Spellings without the fragment whose `#` spelling was not built yet when they were reached */
    const unaliased = [];
    for (const [id, schema] of schemas.entries()) {
      // Skip null placeholders, what this compile does not reach, and a name of a document built under its URI
      if (schema == null || unreached(id, schema) || named.has(id)) continue;

      // Skip if already compiled
      if (root.unresolvedObject(id) !== null) continue;

      // Skip schemas without $id that aren't refs - they're subschemas
      // that will be reached through traversal from a parent
      const identifier = root.identifierOf(schema);
      const hasId = identifier !== undefined;
      // (a pointer from a document's URI, or from the plain name a document is held under alone)
      const pointer = pointerStart(schemas, id, places.rooted);
      const isJsonPointerPath = pointer !== -1 && pointer < id.length;
      const isCanonicalPath = !isJsonPointerPath && id.endsWith('#');

      if (!hasId && !isJsonPointerPath) continue;

      if (!id.includes('#') && schemas.get(`${id}#`) === schema) {
        if (!root.aliasObject(id, `${id}#`)) unaliased.push(id);
        continue;
      }

      // A pointer to a pure `$ref` hop holds the end of the chain it starts,
      // flattened: built from it here, that end would be read at the hop's
      // place, under its draft and against its base. The hop is built
      // instead, and its reference reaches the end under the end's own id.
      const hop = isJsonPointerPath ? JarenValidator.#referenceHopAt(schemas, id, root.traverse, places.rooted) : undefined;

      // Calculate baseUri for this schema
      let baseUri = origin;

      if (isJsonPointerPath) {
        // JSON pointer path: the nearest identifier above the place sets its
        // base. Each identifier is read against the base the walk that
        // registered its object read it against (the root's then names the
        // document again), or, for an object no walk identified, against
        // the base so far.
        baseUri = pointerBase(schemas, id, places);
      } else if (hasId && isCanonicalPath) {
        // Canonical $id path that wasn't handled in first pass: a relative
        // $id, which names another URI when it is read against the origin.
        // It is read against the base the walk that registered the object
        // read it against.
        baseUri = places.idBases.get(schema) ?? origin;
      }

      try {
        root.createObject(id, hop ?? schema, baseUri);
      } catch (_e) {
        if (fails(_e, id)) throw _e;
        // Ref may not be resolvable yet, that's ok
      }
    }
    for (const id of unaliased) root.aliasObject(id, `${id}#`);
    for (const id of named) root.aliasObject(id, id.slice(0, id.indexOf('#') + 1));
  }

  /**
   * Compiles a schema into a validation function.
   * This is the main method for creating validators. It resolves all $ref references,
   * compiles the schema structure, and returns a function that validates data.
   * The return type follows the instance's `collectErrors` setting: a type
   * guard over `unknown` by default, or a function producing
   * `{ valid, errors }` when errors are collected, whose `narrow` answers
   * the same with the instance, typed `T`, on the valid branch. Jaren does not infer `T`
   * from the schema — the caller asserts what the schema describes, which is
   * what a checked contract wrapper wants; pair it with a schema-to-type
   * generator if you need the shape derived mechanically.
   * @template [T=unknown]
   * @param {JSONSchemaLike | boolean} schema - The schema to compile
   * @param {(JSONSchemaLike | boolean)[]} [schemas] - Additional schemas to reference during compilation
   * @returns {TOutput extends OutputFormat<infer R> ? (data: unknown) => R : TCollect extends true ? CompiledCollector<T> : CompiledPredicate<T>} A validation function;
   *   it throws `SchemaRuntimeError` `JK2001` for an instance that nests schema references
   *   more than 256 levels deep (a deep instance, or one that reaches a loop that never reads
   *   it), and
   *   `SchemaCompileError` `JK0008`/`JK0009` when it first reaches a reference resolved on
   *   first use that resolves to no schema
   * @throws {SchemaCompileError} `JK0001` when a loop of references never reads the instance;
   *   `JK0009` (`JK0008` for a draft-07 `$ref` beside an `$id`) when a reference resolves to
   *   no schema the validator holds
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
   *
   * // Narrowing in collect mode
   * const checked = collecting.compile<{ name: string }>(userSchema).narrow(input);
   * if (checked.valid) checked.value.name; // checked.value is { name: string } here
   */
  compile(schema, schemas = undefined) {
    return withParsedPointers(() => this.#compileDocument(schema, schemas));
  }

  /**
   * The work of {@link compile}, run with the pointers it parses kept: it
   * resolves one reference against one base many times over.
   * @param {JSONSchemaLike | boolean} schema
   * @param {(JSONSchemaLike | boolean)[]} [schemas]
   * @returns {any}
   */
  #compileDocument(schema, schemas) {
    schema = JarenValidator.#withResolvedRootId(schema, this.#traverse);
    const { origin, map, reached } = JarenValidator.#traverseSchema(schema, schemas, this.#schemas, this.#traverse, this.#places, true);
    /** The schemas the validator holds, where this compile reads only what it reaches of them. */
    const held = reached === undefined ? undefined : this.#schemas;

    // Detect draft version from schema and update validation options
    const draftVersion = detectSchemaDraft(schema, map);
    const existingValidation = this.#options.validation || new ValidationOptions();

    // The vocabularies a dialect's meta-schema declares, and the assertions
    // its draft defaults (`format` below 2020-12, the content keywords below
    // 2019-09), decide which keywords assert where that dialect governs: the
    // root's here, each place's own where another `$schema` governs it
    // (`ValidationRoot#optionsAt`).
    const vocabularies = (/** @type {unknown} */ uri) => dialectVocabularies(uri, map,
      existingValidation.formatAssertion ?? null, existingValidation.contentValidation ?? null, draftVersion);
    const { validation: vocabValidation, formatAssertion, contentValidation } = vocabularies(isObjectClass(schema) ? schema.$schema : undefined);

    const validationOptions = new ValidationOptions(
      existingValidation.skipErrors ?? true,
      existingValidation.useGrapheme ?? true,
      existingValidation.collectErrors ?? false,
      contentValidation,
      draftVersion,
      vocabValidation,
      formatAssertion,
      existingValidation.messages ?? true,
      existingValidation.unknownFormats ?? 'ignore',
      existingValidation.propertyDependencies ?? false,
      existingValidation.relativePointerDialect ?? 'handrews-01',
      existingValidation.maxReferenceDepth ?? REFERENCE_DEPTH_CEILING,
      existingValidation.outputFormat,
      existingValidation.maxSchemaDepth ?? SCHEMA_DEPTH_CEILING,
      existingValidation.lengthUnit
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
    assertRootReadsInstance(map, origin, schema, { options: validationOptions, formats: this.#formats, drafts: this.#places.drafts, foreign: this.#places.foreign, dialects: this.#places.dialects, held: map, rooted: this.#places.rooted, locations: this.#places.locations }, this.#traverse);

    // Pre-compile all refs before returning the validator
    // This ensures all ref chains are resolved at compile time
    const root = new ValidationRoot(
      origin,
      map,
      this.#formats,
      validationOptions,
      this.#traverse,
      this,
      vocabularies,
      held
    );

    // Pre-create validation objects for the refs this compile reaches
    JarenValidator.#precompileRefs(root, map, origin, this.#places, held, reached);

    // Re-compile with the pre-populated root
    return JarenValidator.#compileSchemaWithRoot(this, origin, map, root);
  }
}
