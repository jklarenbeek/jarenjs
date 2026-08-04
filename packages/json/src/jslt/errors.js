//#region Jaren JSLT errors
// Error classes for the Jaren JSLT engine. Every error carries a stable
// `code` and a `docPath`, an RFC 6901 JSON Pointer into the stylesheet
// document. Wrapped parser/query/hook errors are exposed through `cause`.

import { CodedError } from '@jarenjs/core/errors';
import { CodedDocPathError } from '../errors.js';

/**
 * Error thrown when a JSLT stylesheet is rejected at compile time
 * (`JT0xxx` codes).
 */
export class JsltCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason
   * @param {string} docPath
   * @param {...unknown} cause - When a fourth argument is passed AT
   *   ALL, it is retained as an own `cause` — even `undefined`, so a
   *   host hook that threw `undefined` stays distinguishable from "no
   *   cause".
   */
  constructor(code, reason, docPath, ...cause) {
    super('JsltCompileError', code, reason, docPath,
      cause.length > 0 ? { cause: cause[0] } : undefined);
  }
}

/**
 * Error thrown when evaluating a compiled JSLT stylesheet fails
 * (`JT2xxx` codes).
 */
export class JsltRuntimeError extends CodedDocPathError {
  constructor(code, reason, docPath, cause = undefined) {
    super('JsltRuntimeError', code, reason, docPath, cause);
  }
}

//#endregion
