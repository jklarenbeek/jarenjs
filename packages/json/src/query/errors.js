//#region Jaren JSON Query errors
// Error classes for the Jaren JSON Query engine (QUERY-FORMAT.md section 10).
// Every error carries a stable `code` from the spec registry and a `docPath`,
// an RFC 6901 JSON Pointer into the *query document* locating the offending
// construct.

/**
 * Shared constructor body for the two query error classes: `cause`
 * retains what host code threw, BY VALUE — set via an own property
 * even for `undefined`, so presence is testable.
 */
class JsonQueryError extends Error {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} code
   * @param {string} message
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options]
   */
  constructor(name, code, message, docPath, options) {
    super(`${code}: ${message} at ${docPath}`);
    this.name = name;
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
 * Error thrown when a query document is rejected at compile time
 * (`JQ0xxx` codes, QUERY-FORMAT.md section 10.2).
 */
export class JsonQueryCompileError extends JsonQueryError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options] - `cause` retains what a
   *   host hook (e.g. `compileTypeTest`) threw
   */
  constructor(code, message, docPath, options) {
    super('JsonQueryCompileError', code, message, docPath, options);
  }
}

/**
 * Error thrown when evaluating a compiled query fails
 * (`JQ2xxx` codes, QUERY-FORMAT.md section 10.3).
 */
export class JsonQueryRuntimeError extends JsonQueryError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options] - `cause` retains what host
   *   code threw
   */
  constructor(code, message, docPath, options) {
    super('JsonQueryRuntimeError', code, message, docPath, options);
  }
}

//#endregion
