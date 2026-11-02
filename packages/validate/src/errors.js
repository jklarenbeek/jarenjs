//@ts-check
/**
 * @file The validator's coded refusals. When a schema compiles: a loop of
 * references that never reads the instance (`JK0001`), an invalid
 * `maxReferenceDepth` or `maxSchemaDepth` option (`JK0002`), an
 * `outputFormat` option that is not an output format (`JK0003`) and a
 * schema that nests subschemas deeper than `maxSchemaDepth` (default
 * {@link SCHEMA_DEPTH_CEILING}), refused where the bound is crossed
 * before the host's call stack can overflow (`JK0017`). When `compileAsync`
 * (`@jarenjs/validate/load`) loads what a schema references: a document the
 * loader fails to load (`JK0004`), one that is not a schema (`JK0005`), a
 * compilation that needs more loads than its bound (`JK0006`) and an
 * argument it does not take (`JK0007`). A draft-07 `$ref` whose sibling
 * `$id` does not set its base, and which then resolves to no schema the
 * validator holds, is refused when it compiles (`JK0008`); any other
 * reference that resolves to no schema the validator holds is refused
 * `JK0009`. A reference resolved on first use, and a `$dynamicRef` or
 * `$recursiveRef`, is refused (`JK0008` or `JK0009`) by the first call that
 * reaches it. A `$ref`, `$dynamicRef`, `$recursiveRef` or `$id` that is no
 * valid URI reference is refused `JK0010` where it is read, and a
 * `$recursiveRef` other than `"#"` read as draft 2019-09 `JK0011` by the
 * first call that reaches it. An identifier (`$id`, `$anchor`,
 * `$dynamicAnchor`) that names two schemas — declared twice in a document,
 * or already naming another schema the validator holds — is refused where
 * the second is read (`JK0012`); one that two places of the registered
 * documents declare is refused by the compile that reads it. A keyword the
 * validator reads at a place whose value is not of the shape its draft's
 * meta-schema requires is refused where the place compiles (`JK0013`), and
 * a `pattern` or `patternProperties` name that is no regular expression
 * `JK0014`. Under `unknownFormats: 'error'`, a `format` that asserts and
 * names no registered format (an unregistered name, or a value that is no
 * name) is refused where the place compiles (`JK0015`). A schema of a
 * dialect whose meta-schema requires (`$vocabulary`, `true`) a vocabulary
 * this package does not implement is refused where a place under that
 * dialect compiles (`JK0016`). A `$query`
 * document that does not compile is refused with the query compiler's own
 * code (`JQ0xxx`, `@jarenjs/json/query`), located under the `$query`
 * keyword, its error as the `cause`. A schema `deriveStrictProfile`
 * (`@jarenjs/validate/strict-profile`) cannot make strict is refused where
 * the derivation reads the place (`JK0101`–`JK0108`). When a validator
 * runs: a validation that nests schema references deeper than
 * `maxReferenceDepth` (default {@link REFERENCE_DEPTH_CEILING}) levels is
 * refused where the bound is crossed (`JK2001`), before the host's call
 * stack can overflow; the normalizer of `@jarenjs/validate/normalize` holds
 * the same bound. Every refusal is thrown, never folded into a `false`
 * answer: under `not` a folded failure would read as success.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The validator's diagnosis codes, one line each (the normative table is
 * in `docs/ERROR-MESSAGES.md`).
 * @type {Readonly<Record<string, string>>}
 */
export const VALIDATE_CODES = Object.freeze({
  JK0001: 'a loop of references and in-place applicators never reads the instance',
  JK0002: 'the maxReferenceDepth or maxSchemaDepth option is not a positive safe integer',
  JK0003: 'outputFormat is not a format of @jarenjs/validate/output',
  JK0004: 'compileAsync: the loadSchema function failed to load a referenced schema',
  JK0005: 'compileAsync: a loaded document is not a schema (an object or a boolean)',
  JK0006: 'compileAsync: a compilation needs more schema loads than the maxLoads option',
  JK0007: 'compileAsync: its validator, loadSchema or maxLoads argument is not one it takes',
  JK0008: 'a draft-07 $ref beside an $id resolves to no schema',
  JK0009: 'a reference resolves to no schema the validator holds',
  JK0010: 'a reference or an identifier is not a valid URI reference',
  JK0011: 'a $recursiveRef read as draft 2019-09 is not "#"',
  JK0012: 'an identifier names two schemas',
  JK0013: 'a keyword value is not of the shape its draft requires',
  JK0014: 'a pattern or a patternProperties name is not a regular expression',
  JK0015: "under unknownFormats: 'error', an asserting format names no registered format",
  JK0016: 'a meta-schema requires a vocabulary the validator does not implement',
  JK0017: 'a schema nests subschemas deeper than the schema depth ceiling',
  JK0101: 'retired: a schema that accepts any value is carried as JSON text',
  JK0102: 'a strict profile cannot carry an object whose member names are open',
  JK0103: 'a strict profile cannot carry a keyword that applies members, items or branches beside its node',
  JK0104: 'a strict profile cannot bundle a reference',
  JK0105: 'a profile cannot turn oneOf into anyOf on a node that carries both',
  JK0106: 'a strict profile cannot close an object around a required member it does not declare',
  JK0107: 'a profile derivation was given an argument it does not take',
  JK0108: 'a strict profile cannot carry a schema that accepts no value',
  JK2001: 'validation nests schema references deeper than the reference depth ceiling',
  JK2002: 'fromProfile: a member carried as JSON text is not JSON text',
  JK2003: 'fromProfile: a map carried as entries names one key twice',
});

/**
 * The default deepest nesting, in levels of schema, of the references one
 * validation enters (the `maxReferenceDepth` option): a `$ref` resolved on
 * first use, a `$dynamicRef` or a `$recursiveRef`, each spanning the
 * levels between it and the schema it enters where that schema encloses
 * it, else one ({@link boundReference}). Every recursion through a schema
 * passes one of them, so the bound holds both a deeply nested instance and
 * a reference loop that does not descend into it. Fixed by default, so a
 * refusal is the same on every host.
 */
export const REFERENCE_DEPTH_CEILING = 256;

/**
 * The default deepest nesting of subschemas one compile builds (the
 * `maxSchemaDepth` option): the compile, and the validation of an instance
 * as deep, take the host's call stack per level, so the bound sits where
 * a host stack half the default size still holds every keyword's levels
 * in every reporting mode. Fixed by default, so a refusal is the same on
 * every host.
 */
export const SCHEMA_DEPTH_CEILING = 128;

/**
 * Error thrown when a schema is refused while it is compiled (`JK0xxx`
 * codes, and the query compiler's `JQ0xxx` code for a `$query` document
 * that does not compile).
 */
export class SchemaCompileError extends CodedError {
  /**
   * @param {string} code - Stable diagnosis code
   * @param {string} reason - What is wrong
   * @param {string} [location] - Where in the schema, as `docPath`
   * @param {{ cause?: unknown }} [options] - `cause`: the error behind the refusal
   */
  constructor(code, reason, location = undefined, options = undefined) {
    super('SchemaCompileError', code, reason, location, options);
  }
}

/**
 * Error thrown when a compiled validator refuses an instance it cannot
 * decide (`JK2xxx` codes).
 */
export class SchemaRuntimeError extends CodedError {
  /**
   * @param {string} code - Stable diagnosis code
   * @param {string} reason - What is wrong
   * @param {{ dataPath?: string }} [location] - Where in the instance
   */
  constructor(code, reason, location = undefined) {
    super('SchemaRuntimeError', code, reason, location);
  }
}

/**
 * The refusal of a schema whose dialect's meta-schema requires a vocabulary
 * this package does not implement: read on, that vocabulary's keywords
 * would be annotations and assert nothing, where 2019-09 and 2020-12 ask a
 * validator to refuse the schema.
 * @param {string} dialect - The `$schema` URI naming the meta-schema
 * @param {string} vocabulary - The vocabulary's URI, as the meta-schema's `$vocabulary` spells it
 * @param {string} [location] - Where in the schema, as `docPath`
 * @returns {SchemaCompileError} `JK0016`
 */
export function unimplementedVocabulary(dialect, vocabulary, location = undefined) {
  return new SchemaCompileError('JK0016', `the meta-schema '${dialect}' requires the vocabulary '${vocabulary}', `
    + 'which this validator does not implement, so its keywords would assert nothing; declare it false in that '
    + "meta-schema's $vocabulary to read them as annotations, or name a dialect without it", location);
}

/**
 * Refuse a depth option (`maxReferenceDepth`, `maxSchemaDepth`) that is not
 * a positive safe integer.
 * @param {string} name - The option's name
 * @param {unknown} value - The option, `undefined` when not given
 * @throws {SchemaCompileError} `JK0002`
 */
export function assertDepthOption(name, value) {
  if (value !== undefined && !(Number.isSafeInteger(value) && /** @type {number} */ (value) > 0))
    throw new SchemaCompileError('JK0002',
      `${name} must be a positive safe integer, got ${describeCount(value)}`);
}

/**
 * The refusal of a schema whose subschemas nest deeper than the compile's
 * `maxSchemaDepth`: compiling on, the compile or a validation of an
 * instance as deep could exhaust the host's call stack, at a depth that
 * differs from host to host, with an uncoded `RangeError`.
 * @param {number} ceiling - The compilation's `maxSchemaDepth`
 * @param {string} location - The subschema past the bound, as `docPath`
 * @param {string} [work] - What the compiled schema does: `validates`, or
 *   `normalizes` for the normalizer, which holds the same option
 * @returns {SchemaCompileError} `JK0017`
 */
export function schemaTooDeep(ceiling, location, work = 'validates') {
  return new SchemaCompileError('JK0017', `the schema nests subschemas more than ${ceiling} levels deep, `
    + `deeper than a small host call stack compiles and ${work}; raise maxSchemaDepth to compile it`, location);
}

/**
 * Refuse an `outputFormat` option that is not one of the output formats
 * `@jarenjs/validate/output` exports (a format's name as a string
 * included: the formats live behind that subpath, so a validator that
 * uses none ships none).
 * @param {unknown} value - The option, `undefined` when not given
 * @throws {SchemaCompileError} `JK0003`
 */
export function assertOutputFormat(value) {
  if (value !== undefined && typeof (/** @type {any} */ (value))?.validator !== 'function')
    throw new SchemaCompileError('JK0003',
      `outputFormat takes a format of '@jarenjs/validate/output', got ${describeKind(value)}`);
}

/**
 * Name the value given for a count option in its refusal: a number as
 * written, anything else as JSON (`"3"`, `null`), or its type when JSON has
 * no spelling for it.
 * @param {unknown} value
 * @returns {string}
 */
export function describeCount(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? typeof value;
}

/**
 * Name a refused value: a string quoted (as the other option and keyword
 * refusals quote one), a number, boolean or null as written, anything else
 * by its kind.
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (typeof value === 'string') return `'${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'an empty array' : 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Name the value given where a function or an object of one kind is taken:
 * a string quoted (it is often the name of what was meant), anything else
 * by its type.
 * @param {unknown} value
 * @returns {string}
 */
export function describeKind(value) {
  return typeof value === 'string' ? `'${value}'` : typeof value;
}

// The levels of schema the references entered on the call stack span, and
// how many references they are.
let referenceDepth = 0;
let referenceCount = 0;

/**
 * Wrap the validator a schema reference calls so that entering it counts
 * toward the reference depth bound: the reference adds the levels of
 * schema it spans (`weight`), a reference that would carry the count past
 * `ceiling` throws `JK2001` instead of descending, and the count is
 * restored however the call ends. A reference that sits K levels below the
 * schema it enters nests K levels per entry, so it weighs K: the bound
 * holds the levels between the references, not only their number. The
 * count is shared by every validator and normalizer (it measures the one
 * call stack); each reference compares it with its own compilation's
 * ceiling.
 * @template {(data: any, dataPath: any, dataRoot: any, dataKey?: any) => any} F
 * @param {string} location - The schema location of the reference, named
 *   by the refusal
 * @param {number} ceiling - The compilation's `maxReferenceDepth`
 * @param {number} weight - The levels of schema the reference spans: how
 *   far below its target it sits where its target encloses it, else 1
 * @param {F} validate - What the reference calls
 * @param {string} [subject] - What nests the references, as the refusal
 *   names it
 * @returns {F}
 */
export function boundReference(location, ceiling, weight, validate, subject = 'validation') {
  return /** @type {F} */ (function validateBoundReference(data, dataPath, dataRoot, dataKey) {
    enterReference(location, ceiling, weight, subject);
    try {
      return validate(data, dataPath, dataRoot, dataKey);
    }
    finally {
      leaveReference(weight);
    }
  });
}

/**
 * Count entering a schema reference toward the reference depth bound, as
 * {@link boundReference} does around what it wraps; the caller restores the
 * count with {@link leaveReference} however the call ends.
 * @param {string} location - The schema location of the reference
 * @param {number} ceiling - The compilation's `maxReferenceDepth`
 * @param {number} weight - The levels of schema the reference spans
 * @param {string} [subject] - What nests the references
 * @throws {SchemaRuntimeError} `JK2001` when the count would pass `ceiling`
 */
export function enterReference(location, ceiling, weight, subject = 'validation') {
  if (referenceDepth + weight > ceiling) {
    // every reference on the way spanning one level, the levels are the references
    throw new SchemaRuntimeError('JK2001', `${subject} nests ${referenceDepth === referenceCount && weight === 1
      ? `more than ${ceiling} schema references`
      : `schema references more than ${ceiling} levels deep`} at ${location} `
      + '(an instance nested this deep, or a loop of references that never reads it)');
  }
  referenceDepth += weight;
  referenceCount++;
}

/**
 * Restore the count {@link enterReference} raised.
 * @param {number} weight - The weight it was entered with
 */
export function leaveReference(weight) {
  referenceDepth -= weight;
  referenceCount--;
}

/** @returns {number} The levels of schema the references open on the call stack span */
export function referenceDepthNow() {
  return referenceDepth;
}
