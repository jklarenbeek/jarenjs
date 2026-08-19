//@ts-check
/**
 * @file Error types for @jarenjs/contract, built on `@jarenjs/core`'s
 * coded contract: every failure carries a stable `code`, a bare
 * `reason`, a composed `message`, and — for compile errors — the
 * `docPath` of the offending member of the contract document. The
 * normative table lives in docs/CONTRACT-FORMAT.md §6, proven in sync
 * with `CONTRACT_CODES` below by a test.
 *
 * The `JC` code space is partitioned by range so the layers of this
 * package never collide:
 *
 *  - `JC0001–JC0049` document compile (`ContractCompileError`)
 *  - `JC0050–JC0069` binding declaration compile
 *  - `JC1001–JC1049` host programming errors (thrown `TypeError`s)
 *  - `JC2001–JC2049` http request-time (`ContractRuntimeError`)
 *  - `JC2050–JC2069` client-side
 *  - `JC2070–JC2089` port/local bindings
 *  - `JC2090–JC2109` stream binding
 *
 * Only the document-compile range is populated by this module today;
 * the others are reserved for the bindings and are listed here so a
 * later addition lands in its range rather than at the next free
 * number.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table: one entry per code this package can raise,
 * proven in sync with CONTRACT-FORMAT.md §6's normative table by a test.
 */
export const CONTRACT_CODES = Object.freeze({
  JC0001: 'the document is not a well-formed contract object: not an object, $contract is not "0.1", $defs is not a map of schemas, a member is not a JSON value, or a member threw when read',
  JC0002: 'operations is not an object with at least one member',
  JC0003: 'an operation id is not a dotted lowercase identifier',
  JC0004: 'kind is neither read nor command (subscribe is not part of format 0.1)',
  JC0005: 'input is not a schema whose effective type is object',
  JC0006: 'output is absent or not a schema',
  JC0007: 'a $ref resolves neither within the document nor against the registered schemas',
  JC0008: 'http.path is not a valid path template',
  JC0009: 'a path variable, http.in key or http.body names no input member, or a member is mapped to a location it cannot travel in',
  JC0010: 'two operations share method and canonical path shape',
  JC0011: 'errors is malformed: not an object, a code is not a lowercase hyphenated word, a status is not a 100–599 integer, or a schema is not a schema',
  JC0012: 'http.method is not an uppercase token of the supported set, http.status is not a 200–299 integer, or http.media is not a media type',
  JC0013: 'an unknown member in a closed object (the document root, an operation, policy, http, limits, retry, or an error declaration)',
  JC0014: 'a policy member is mistyped or outside its declared set',
  JC0015: 'id, version, compat or an operation doc is mistyped',
  JC0016: 'an operation bound to GET or HEAD carries a body-located member (a GET body)',
});

/**
 * A defect in the contract document itself, raised while
 * `compileContract` compiles it. Every instance carries the JSON
 * Pointer of the offending member as `docPath` (`''` is the document
 * root; an operation id is one reference token, so a dotted id such as
 * `product.save` appears unescaped and only `~` and `/` are escaped per
 * RFC 6901). The codes are `JC0001–JC0049` (docs/CONTRACT-FORMAT.md §6).
 */
export class ContractCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the contract document;
   *   `''` is the document root, `undefined` means no location.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('ContractCompileError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A request-time failure (`JC2xxx`) as it exists in-process before a
 * binding maps it onto its wire: a stable `code`, a `msgid`
 * (`contract/<slug>`) with `params` for the locale catalogs, and the
 * transport hints a binding may carry (`status`, `retryable`). It has no
 * document location — a request is not a document — so `docPath` is
 * always `undefined`. Never thrown across a binding: a binding settles
 * it into a wire error.
 */
export class ContractRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare English reason; `message` is
   *   composed per the coded contract.
   * @param {{ msgid: string, params?: Record<string, unknown>, status?: number, retryable?: boolean, cause?: unknown }} options
   *   `msgid` is the catalog key; `cause` is installed as an own property
   *   exactly when the key is present (`hasOwn` form).
   */
  constructor(code, reason, options) {
    super('ContractRuntimeError', code, reason, undefined,
      options !== undefined && Object.hasOwn(options, 'cause') ? { cause: options.cause } : undefined);
    /** @type {string} */
    this.msgid = options.msgid;
    /** @type {Record<string, unknown>} */
    this.params = options.params ?? {};
    /** @type {number | undefined} */
    this.status = options.status;
    /** @type {boolean | undefined} */
    this.retryable = options.retryable;
  }
}
