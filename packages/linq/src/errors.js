//@ts-check
/**
 * @file Error types for @jarenjs/linq, built on `@jarenjs/core`'s coded
 * contract: every failure carries a stable `code` (JL0xxx build, JL2xxx
 * runtime), a bare `reason`, a composed `message`, and — where a
 * document position exists — a `docPath`. The normative table lives in
 * docs/QUERY-PEN.md §9, proven in sync with `LINQ_CODES` below by a
 * test.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with QUERY-PEN.md §9's
 * normative table by a test.
 */
export const LINQ_CODES = Object.freeze({
  JL0001: 'from() received neither an iterable nor a provider',
  JL0002: 'an expression proxy escaped its capture callback',
  JL0003: 'ofType/cast need an injected compileTypeTest',
  JL0004: 'an undeclared or reserved parameter name was used',
  JL0005: 'an operator was used invalidly at build time',
  JL0006: 'an unsupported operator was invoked',
  JL0007: 'a provider serves several entity roots and has no root of its own',
  JL0101: 'a pen received a value it cannot spell: not JSON, or not what the keyword takes',
  JL0102: 'a pen was asked for a construct the format cannot carry',
  JL0103: 'a $defs name collision, a dangling ref, or an unnamed recursion',
  JL0104: 'a pen-owned keyword through meta(), or an external a captured rule did not declare',
  JL0105: 'a relation hop cannot lower: a many-to-many member, a composite or undeclared key, or a malformed relation entry',
  JL0106: 'a migration step names a table the target model does not declare, or a draft it cannot match',
  JL0107: 'a client operation named a member that is not the relation kind it needs',
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
 *    `g`, and the relation-hop bindings `r1`, `r2`, … — the document's
 *    own binding names), a binding is not query data, or the two sides
 *    of a `join`/`groupJoin`/`concat` bind one name to different values
 *  - `JL0005` — an operator was used invalidly at build time (`thenBy`
 *    without `orderBy`, `all()` off an operator result rather than a
 *    path, a member read off a to-many relation before `all()`, a
 *    negative `skip`/`take`, a value that cannot embed in a document)
 *  - `JL0006` — an operator the mapping table records as
 *    `unsupported` was invoked (`zip`); the table names the reason
 *  - `JL0007` — `from()`/`fromAsync()` received a provider that serves
 *    several entity roots (`roots`) and has no `root` of its own — a
 *    store with entities; chain over one of them (`store.entity(name)`)
 *
 * The pens (`@jarenjs/linq/schema`, `/model`, `/jslt`, `/migration`,
 * `/contract`, `/flow`) and the client (`/db`; LINQ-FORMAT.md §1.3)
 * refuse with the `JL01xx` codes:
 *
 *  - `JL0101` — a pen received a value it cannot spell: a function,
 *    symbol, bigint, `NaN`, `±Infinity`, `-0`, a class instance or a
 *    cycle where JSON was needed, or a value that is not what the
 *    keyword takes (`min('x')`, a non-builder member)
 *  - `JL0102` — a construct the format cannot carry: a function
 *    `refine`/`transform`, a coercion the normalizer would never run,
 *    closed objects under `allOf`, an annotation on `never()`, an
 *    `apply()` as a bare object member, a `match` of `{}`, a path
 *    template form CONTRACT-FORMAT §4.2 reserves, an operation `kind`
 *    outside the three, a flow guard given as a plain string
 *    (FLOW-FORMAT §3 makes a non-`$` literal vacuously true), a state
 *    or node id no declaration carries
 *  - `JL0103` — two distinct builders under one `$defs` name, a
 *    `ref()` no definition answers, or a `lazy()` that is not named
 *  - `JL0104` — a pen-owned keyword written through `meta()`, or a
 *    captured rule naming an external it did not declare (a `check()`
 *    or `body()` external other than `root`/`path` and, for a body,
 *    its declared parameters; a `compute()` external at all, or a flow
 *    guard/`with`/node-query/`select` external at all — both flow
 *    engines evaluate with one `$` and nothing else)
 *  - `JL0105` — a relation hop on the chain (the query pen) cannot
 *    lower: the member is a many-to-many relation, whose join table is
 *    not a queryable root in this version (`load({ include })` reads the
 *    memberships); or the relation's key column or the key it references
 *    is composite or undeclared; or the provider's relation table holds
 *    something that is not a relation record
 *  - `JL0106` — a migration step names an entity or collection the
 *    target model does not declare (`transform`, `assert`, `derive`),
 *    or a `transform` over a planned document finds no draft to
 *    replace, or two drafts for one name
 *  - `JL0107` — the client was handed a member that is not the relation
 *    kind the operation needs: `include()` picks a declared relation
 *    member (a scalar member, or a name the model does not declare, is
 *    refused naming the declared ones); `link()`/`unlink()` attach
 *    many-to-many memberships only (a to-one or to-many relation is
 *    refused naming its kind)
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
