//#region Jaren JTLT errors
// Error classes for the Jaren JTLT template engine. Every error carries a
// stable `code` and a `docPath`, an RFC 6901 JSON Pointer into the template
// document. Wrapped JSLT/query errors are exposed through `cause`.

/**
 * Error thrown when a JTLT template is rejected at compile time
 * (`TL0xxx` codes).
 */
export class JtltCompileError extends Error {
  constructor(code, message, docPath, cause = undefined) {
    super(`${code}: ${message} at ${docPath}`,
      cause === undefined ? undefined : { cause });
    this.name = 'JtltCompileError';
    this.code = code;
    this.docPath = docPath;
  }
}

/**
 * Error thrown when rendering with a compiled JTLT template fails
 * (`TL2xxx` codes).
 */
export class JtltRuntimeError extends Error {
  constructor(code, message, docPath, cause = undefined) {
    super(`${code}: ${message} at ${docPath}`,
      cause === undefined ? undefined : { cause });
    this.name = 'JtltRuntimeError';
    this.code = code;
    this.docPath = docPath;
  }
}

//#endregion
