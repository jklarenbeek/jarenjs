//#region Jaren shared error bases
// Shared constructors for the coded error classes of the json package.
// Each engine keeps its own exported class (the `name` and `message`
// shapes are public API); these bases only centralize the constructor
// bodies that were byte-identical across engines. The `name` is passed
// as a string literal because the bundle is minified and a mangled
// class name must not leak into `error.name`.

import { CodedError } from '@jarenjs/core/errors';

/**
 * The deepest expression nesting the package compiles or parses: the
 * JSON Query compiler's ceiling (`JQ0011` past it), shared by the
 * recursive-descent front-ends whose texts become query or path
 * expressions - the JSONPath filter grammar and the XQuery front-end -
 * so hostile nesting is refused by position with the parser's own syntax
 * error before the host stack can overflow.
 */
export const NESTING_CEILING = 256;

/**
 * The deepest data nesting the package's recursive walkers descend - the
 * JSONPath descendant segment (`..`) and the canonical serializer - before
 * they refuse the value instead of overflowing the host's call stack. Fixed,
 * so a refusal is the same on every host.
 */
export const DATA_DEPTH_CEILING = 1000;

/**
 * The deepest nesting the JSON Patch and Merge Patch diffs walk: the bound
 * `equalsJson` and `stableStringify` of `@jarenjs/core/object` hold, which
 * the diffs call on whole subtrees, so one refusal (`JO2001`) answers past
 * it whichever walker meets the level first. Past every nesting a default
 * host stack could walk recursively, and fixed, so a refusal - a cycle
 * included - is the same on every host.
 */
export const JSON_WALK_DEPTH_CEILING = 10000;

/**
 * The refusal of a value nested past {@link JSON_WALK_DEPTH_CEILING}, the
 * one `@jarenjs/core/object` raises for the same bound.
 * @param {string} verb - What could not be done, in the passive
 * @returns {CodedError}
 */
export function walkTooDeep(verb) {
  return new CodedError('JsonDepthError', 'JO2001',
    `a value nested deeper than ${JSON_WALK_DEPTH_CEILING} levels cannot be ${verb}`);
}

/**
 * Base for errors that carry a stable `code` and a `docPath`, an RFC
 * 6901 JSON Pointer into the offending document. A wrapped error is
 * exposed through the native `cause` option when one is given. This is
 * the positional adapter over `@jarenjs/core`'s {@link CodedError}: a
 * trailing `undefined` cause means "no cause" (no own property), per
 * the base's contract.
 */
export class CodedDocPathError extends CodedError {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} code - Stable diagnosis code
   * @param {string} reason - What is wrong (bare; the message is composed)
   * @param {string} docPath - JSON Pointer into the offending document
   * @param {unknown} [cause] - Wrapped error, when there is one
   */
  constructor(name, code, reason, docPath, cause = undefined) {
    super(name, code, reason, docPath,
      cause === undefined ? undefined : { cause });
  }
}

/**
 * Base for syntax errors over a source string: `source` and `position`
 * locate the offending token, and the message is prefixed with a
 * human-readable language label. Deliberately NOT a {@link CodedError}:
 * this family carries no stable code and locates by source offset, not
 * by document pointer.
 */
export class LabeledSyntaxError extends SyntaxError {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} label - Language label for the message prefix
   * @param {string} message - What is wrong
   * @param {string} source - The offending source text
   * @param {number} position - 0-based index of the offending token
   */
  constructor(name, label, message, source, position) {
    super(`Invalid ${label}: ${message} at position ${position} in '${source}'`);
    this.name = name;
    this.source = source;
    this.position = position;
  }
}

/**
 * Build a `fail(code, message, docPath)` throw-adapter for a coded
 * error class; compilers use it to keep rejection one-liners readable.
 * @param {new (code: string, message: string, docPath: string) => Error} ErrorClass
 * @returns {(code: string, message: string, docPath: string) => never}
 */
export function failerFor(ErrorClass) {
  return function fail(code, message, docPath) {
    throw new ErrorClass(code, message, docPath);
  };
}

//#endregion
