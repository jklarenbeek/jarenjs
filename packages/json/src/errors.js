//#region Jaren shared error bases
// Shared constructors for the coded error classes of the json package.
// Each engine keeps its own exported class (the `name` and `message`
// shapes are public API); these bases only centralize the constructor
// bodies that were byte-identical across engines. The `name` is passed
// as a string literal because the bundle is minified and a mangled
// class name must not leak into `error.name`.

import { CodedError } from '@jarenjs/core/errors';

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
