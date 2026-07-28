//#region Jaren JSLT errors
// Error classes for the Jaren JSLT engine. Every error carries a stable
// `code` and a `docPath`, an RFC 6901 JSON Pointer into the stylesheet
// document. Wrapped parser/query/hook errors are exposed through `cause`.

import { CodedDocPathError } from '../errors.js';

/**
 * Error thrown when a JSLT stylesheet is rejected at compile time
 * (`JT0xxx` codes).
 */
export class JsltCompileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} docPath
   * @param {...unknown} cause - When a fourth argument is passed AT
   *   ALL, it is retained as an own `cause` — even `undefined`, so a
   *   host hook that threw `undefined` stays distinguishable from "no
   *   cause".
   */
  constructor(code, message, docPath, ...cause) {
    super(`${code}: ${message} at ${docPath}`);
    this.name = 'JsltCompileError';
    this.code = code;
    this.docPath = docPath;
    if (cause.length > 0) {
      Object.defineProperty(this, 'cause', {
        value: cause[0], writable: true, enumerable: false, configurable: true,
      });
    }
  }
}

/**
 * Error thrown when evaluating a compiled JSLT stylesheet fails
 * (`JT2xxx` codes).
 */
export class JsltRuntimeError extends CodedDocPathError {
  constructor(code, message, docPath, cause = undefined) {
    super('JsltRuntimeError', code, message, docPath, cause);
  }
}

//#endregion
