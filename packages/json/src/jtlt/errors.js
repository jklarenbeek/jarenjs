//#region Jaren JTLT errors
// Error classes for the Jaren JTLT template engine. Every error carries a
// stable `code` and a `docPath`, an RFC 6901 JSON Pointer into the template
// document. Wrapped JSLT/query errors are exposed through `cause`.

import { CodedDocPathError } from '../errors.js';

/**
 * Error thrown when a JTLT template is rejected at compile time
 * (`TL0xxx` codes).
 */
export class JtltCompileError extends CodedDocPathError {
  constructor(code, message, docPath, cause = undefined) {
    super('JtltCompileError', code, message, docPath, cause);
  }
}

/**
 * Error thrown when rendering with a compiled JTLT template fails
 * (`TL2xxx` codes).
 */
export class JtltRuntimeError extends CodedDocPathError {
  constructor(code, message, docPath, cause = undefined) {
    super('JtltRuntimeError', code, message, docPath, cause);
  }
}

//#endregion
