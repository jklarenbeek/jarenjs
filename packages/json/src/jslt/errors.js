//#region Jaren JSLT errors
// Error classes for the Jaren JSLT engine. Every error carries a stable
// `code` and a `docPath`, an RFC 6901 JSON Pointer into the stylesheet
// document. Wrapped parser/query/hook errors are exposed through `cause`.

/**
 * Error thrown when a JSLT stylesheet is rejected at compile time
 * (`JT0xxx` codes).
 */
export class JsltCompileError extends Error {
  constructor(code, message, docPath, cause = undefined) {
    super(`${code}: ${message} at ${docPath}`,
      cause === undefined ? undefined : { cause });
    this.name = 'JsltCompileError';
    this.code = code;
    this.docPath = docPath;
  }
}

/**
 * Error thrown when evaluating a compiled JSLT stylesheet fails
 * (`JT2xxx` codes).
 */
export class JsltRuntimeError extends Error {
  constructor(code, message, docPath, cause = undefined) {
    super(`${code}: ${message} at ${docPath}`,
      cause === undefined ? undefined : { cause });
    this.name = 'JsltRuntimeError';
    this.code = code;
    this.docPath = docPath;
  }
}

//#endregion
