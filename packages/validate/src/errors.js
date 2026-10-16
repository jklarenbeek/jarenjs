//@ts-check
/**
 * @file The validator's coded refusals. When a schema compiles: a loop of
 * references that never reads the instance (`JK0001`), an invalid
 * `maxReferenceDepth` option (`JK0002`) and an `outputFormat` option that
 * is not an output format (`JK0003`). When `compileAsync`
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
 * documents declare is refused by the compile that reads it. A schema `deriveStrictProfile`
 * (`@jarenjs/validate/strict-profile`) cannot make strict is refused where
 * the derivation reads the place (`JK0101`–`JK0108`). When a validator
 * runs: a validation that nests more schema references than
 * `maxReferenceDepth` (default {@link REFERENCE_DEPTH_CEILING}) is refused
 * where the bound is crossed (`JK2001`), before the host's call stack can
 * overflow. Every refusal is thrown, never folded into a `false` answer:
 * under `not` a folded failure would read as success.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The validator's diagnosis codes, one line each (the normative table is
 * in `docs/ERROR-MESSAGES.md`).
 * @type {Readonly<Record<string, string>>}
 */
export const VALIDATE_CODES = Object.freeze({
  JK0001: 'a loop of references and in-place applicators never reads the instance',
  JK0002: 'the maxReferenceDepth option is not a positive safe integer',
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
 * The default deepest nesting of schema references one validation enters
 * (the `maxReferenceDepth` option): a `$ref` resolved on first use, a
 * `$dynamicRef` or a `$recursiveRef`. Every recursion through a schema
 * passes one of them, so the bound holds both a deeply nested instance and
 * a reference loop that does not descend into it. Fixed by default, so a
 * refusal is the same on every host.
 */
export const REFERENCE_DEPTH_CEILING = 256;

/**
 * Error thrown when a schema is refused while it is compiled
 * (`JK0xxx` codes).
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
 * Refuse a `maxReferenceDepth` option that is not a positive safe integer.
 * @param {unknown} value - The option, `undefined` when not given
 * @throws {SchemaCompileError} `JK0002`
 */
export function assertReferenceDepth(value) {
  if (value !== undefined && !(Number.isSafeInteger(value) && /** @type {number} */ (value) > 0))
    throw new SchemaCompileError('JK0002',
      `maxReferenceDepth must be a positive safe integer, got ${describeCount(value)}`);
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
 * Name the value given where a function or an object of one kind is taken:
 * a string quoted (it is often the name of what was meant), anything else
 * by its type.
 * @param {unknown} value
 * @returns {string}
 */
export function describeKind(value) {
  return typeof value === 'string' ? `'${value}'` : typeof value;
}

let referenceDepth = 0;

/**
 * Wrap the validator a schema reference calls so that entering it counts
 * toward the reference depth bound: one nested reference past `ceiling`
 * throws `JK2001` instead of descending, and the count is restored however
 * the call ends. The count is shared by every validator (it measures the
 * one call stack); each reference compares it with its own compilation's
 * ceiling.
 * @template {(data: any, dataPath: any, dataRoot: any, dataKey?: any) => any} F
 * @param {string} location - The schema location of the reference, named
 *   by the refusal
 * @param {number} ceiling - The compilation's `maxReferenceDepth`
 * @param {F} validate - What the reference calls
 * @returns {F}
 */
export function boundReference(location, ceiling, validate) {
  return /** @type {F} */ (function validateBoundReference(data, dataPath, dataRoot, dataKey) {
    if (referenceDepth >= ceiling) {
      throw new SchemaRuntimeError('JK2001',
        `validation nests more than ${ceiling} schema references at ${location} `
        + '(an instance nested this deep, or a loop of references that never reads it)');
    }
    referenceDepth++;
    try {
      return validate(data, dataPath, dataRoot, dataKey);
    }
    finally {
      referenceDepth--;
    }
  });
}
