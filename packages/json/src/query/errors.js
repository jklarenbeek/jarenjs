//#region Jaren JSON Query errors
// Error classes for the Jaren JSON Query engine (QUERY-FORMAT.md section 10).
// Every error carries a stable `code` from the spec registry and a `docPath`,
// an RFC 6901 JSON Pointer into the *query document* locating the offending
// construct.

/**
 * Error thrown when a query document is rejected at compile time
 * (`JQ0xxx` codes, QUERY-FORMAT.md section 10.2).
 */
export class JsonQueryCompileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options] - `cause` retains what a
   *   host hook (e.g. `compileTypeTest`) threw, BY VALUE — set via an
   *   own property even for `undefined`, so presence is testable.
   */
  constructor(code, message, docPath, options) {
    super(`${code}: ${message} at ${docPath}`);
    this.name = 'JsonQueryCompileError';
    this.code = code;
    this.docPath = docPath;
    if (options !== undefined && Object.hasOwn(options, 'cause')) {
      Object.defineProperty(this, 'cause', {
        value: options.cause, writable: true, enumerable: false, configurable: true,
      });
    }
  }
}

/**
 * Error thrown when evaluating a compiled query fails
 * (`JQ2xxx` codes, QUERY-FORMAT.md section 10.3).
 */
export class JsonQueryRuntimeError extends Error {
  constructor(code, message, docPath) {
    super(`${code}: ${message} at ${docPath}`);
    this.name = 'JsonQueryRuntimeError';
    this.code = code;
    this.docPath = docPath;
  }
}

//#endregion
