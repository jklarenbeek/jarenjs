//#region Jaren JSON Query errors
// Error classes for the Jaren JSON Query engine (QUERY-FORMAT.md section 10).
// Every error carries a stable `code` from the spec registry and a `docPath`,
// an RFC 6901 JSON Pointer into the *query document* locating the offending
// construct.

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * the engine can raise, proven in sync with QUERY-FORMAT.md §10's
 * normative tables by a test — the table cannot silently drift from
 * the spec.
 */
export const QUERY_CODES = Object.freeze({
  JQ0001: 'object mixes $-prefixed and plain keys',
  JQ0002: 'unknown operator or $-key outside the vocabulary',
  JQ0003: 'known phrase with bad arity, value shape, or key combination',
  JQ0004: 'string starting $ is not a valid path or escape',
  JQ0005: 'variable reference neither bound nor a declared external',
  JQ0006: 'version envelope with unknown or non-string $query',
  JQ0007: 'duplicate variable binding within one phrase',
  JQ0008: 'schema operator in a query compiled without a type-test compiler',
  JQ0009: 'schema literal rejected by the type-test compiler',
  JQ0010: '$call/$collation naming no registered function/collation',
  JQ0011: 'expression nesting deeper than limits.depth',
  JQ0012: 'lexical provider missing or request declaration rejected',
  JQ2001: 'runtime type error',
  JQ2002: '$idiv/$mod by zero',
  JQ2003: 'EBV of a multi-item sequence',
  JQ2004: '$map key expression not a single string',
  JQ2005: 'incomparable $orderby/$sort keys',
  JQ2006: 'reference to an unbound external parameter',
  JQ2007: 'resource guard: an operator result exceeding an implementation limit',
  JQ2008: 'schema assertion failure',
  JQ2009: 'an execution limit exceeded',
  JQ2010: 'a registered $call function threw',
  JQ2011: 'the input document is undefined',
  JQ2012: 'lexical provider threw or returned an invalid result',
});

/**
 * Shared constructor body for the two query error classes: `cause`
 * retains what host code threw, BY VALUE — set via an own property
 * even for `undefined`, so presence is testable (the base's `hasOwn`
 * options form, passed through unchanged).
 */
class JsonQueryError extends CodedError {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} code
   * @param {string} reason
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options]
   */
  constructor(name, code, reason, docPath, options) {
    super(name, code, reason, docPath, options);
  }
}

/**
 * Error thrown when a query document is rejected at compile time
 * (`JQ0xxx` codes, QUERY-FORMAT.md section 10.2).
 */
export class JsonQueryCompileError extends JsonQueryError {
  /**
   * @param {string} code
   * @param {string} reason
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options] - `cause` retains what a
   *   host hook (e.g. `compileTypeTest`) threw
   */
  constructor(code, reason, docPath, options) {
    super('JsonQueryCompileError', code, reason, docPath, options);
  }
}

/**
 * Error thrown when evaluating a compiled query fails
 * (`JQ2xxx` codes, QUERY-FORMAT.md section 10.3).
 */
export class JsonQueryRuntimeError extends JsonQueryError {
  /**
   * @param {string} code
   * @param {string} reason
   * @param {string} docPath
   * @param {{ cause?: unknown }} [options] - `cause` retains what host
   *   code threw
   */
  constructor(code, reason, docPath, options) {
    super('JsonQueryRuntimeError', code, reason, docPath, options);
  }
}

//#endregion
