//@ts-check
/**
 * @file The validator's coded refusals: a schema whose references loop
 * without reading the instance is refused when it is compiled
 * (`JK0001`), an invalid `maxReferenceDepth` option likewise (`JK0002`),
 * an `outputFormat` option that is not an output format likewise
 * (`JK0003`), and a validation that nests more schema references than that option
 * (default {@link REFERENCE_DEPTH_CEILING}) is refused where the bound is
 * crossed (`JK2001`), before the host's call stack can overflow. Both are
 * thrown, never folded into a `false` answer: under `not` a folded
 * failure would read as success.
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
  JK2001: 'validation nests schema references deeper than the reference depth ceiling',
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
   */
  constructor(code, reason) {
    super('SchemaCompileError', code, reason);
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
   */
  constructor(code, reason) {
    super('SchemaRuntimeError', code, reason);
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
      `maxReferenceDepth must be a positive safe integer, got ${typeof value === 'number' ? String(value) : JSON.stringify(value) ?? typeof value}`);
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
      `outputFormat takes a format of '@jarenjs/validate/output', got ${typeof value === 'string' ? `'${value}'` : typeof value}`);
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
