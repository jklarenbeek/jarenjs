//@ts-check
/**
 * @file Error types for @jarenjs/linq, built on `@jarenjs/core`'s coded
 * contract: every failure carries a stable `code` (JL0xxx build, JL2xxx
 * runtime), a bare `reason`, a composed `message`, and — where a
 * document position exists — a `docPath`. The normative table lives in
 * docs/LINQ-FORMAT.md §9, proven in sync with `LINQ_CODES` below by a
 * test.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with LINQ-FORMAT.md §9's
 * normative table by a test.
 */
export const LINQ_CODES = Object.freeze({
  JL0001: 'from() received neither an iterable nor a provider',
  JL0002: 'an expression proxy escaped its capture callback',
  JL0003: 'ofType/cast need an injected compileTypeTest',
  JL0004: 'an undeclared or reserved parameter name was used',
  JL0005: 'an operator was used invalidly at build time',
  JL0006: 'an unsupported operator was invoked',
  JL2001: 'first/single found no element',
  JL2002: 'single found more than one element',
  JL2003: 'elementAt is out of range',
  JL2004: 'an asynchronous provider cannot back the synchronous surface',
  JL2005: 'a push queue was fed after it ended',
  JL2006: 'a provider answered an element terminal with something other than one array',
});

/**
 * A defect in how the query was BUILT — raised while capturing
 * expressions or emitting the document, before anything runs. Codes:
 *
 *  - `JL0001` — `from()`/`fromDocument()` received a source that is
 *    neither an iterable nor a provider (`execute` duck)
 *  - `JL0002` — an expression proxy escaped the callback it was handed
 *    to (stored and reused across captures); the emitted document
 *    would be nonsense, so the build fails instead
 *  - `JL0003` — `ofType`/`cast` compile schema operators, which need
 *    the injected `compileTypeTest` hook (`from(src, {
 *    compileTypeTest })`, e.g. `createTypeTestCompiler()` from
 *    `@jarenjs/validate/query`)
 *  - `JL0004` — a parameter was referenced without being declared via
 *    `.params({...})`, a declared name is reserved (`it`, `it2`, `acc`,
 *    `g` — the document's own binding names), a binding is not query
 *    data, or the two sides of a `join`/`groupJoin`/`concat` bind one
 *    name to different values
 *  - `JL0005` — an operator was used invalidly at build time (`thenBy`
 *    without `orderBy`, `all()` off an operator result rather than a
 *    path, a negative `skip`/`take`, a value that cannot embed in a
 *    document)
 *  - `JL0006` — an operator the mapping table records as
 *    `unsupported` was invoked (`zip`); the table names the reason
 */
export class LinqBuildError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the emitted query
   *   document, where one exists.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('LinqBuildError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A failure while a terminal operation ran. Codes:
 *
 *  - `JL2001` — `first()`/`single()` over an empty sequence (the
 *    `OrDefault` variants return the default instead)
 *  - `JL2002` — `single()`/`singleOrDefault()` over two or more
 *    elements
 *  - `JL2003` — `elementAt(i)` with no element at position `i`
 *  - `JL2004` — a provider's `execute()` answered a promise. A
 *    `Sequence` terminal is a value (`toArray(): T[]`), so a promise
 *    cannot be returned under that type; emit `toDocument()` and await
 *    the provider directly instead.
 *  - `JL2005` — `feed()` was called on a push queue after `end()`
 *    closed it (a condition of the running stream, not of the build)
 *  - `JL2006` — a provider answered an element terminal (`toArray`,
 *    `first`, …) with something other than exactly one array; the
 *    emitted document is an array constructor, so a conforming
 *    `execute()` never answers `undefined` there
 */
export class LinqRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the emitted query
   *   document, where one exists.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('LinqRuntimeError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}
