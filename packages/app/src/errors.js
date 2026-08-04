//@ts-check
/**
 * @file Error types for @jarenjs/app, built on `@jarenjs/core`'s coded
 * contract: every failure carries a stable `code` (JA0xxx compile,
 * JA2xxx runtime), a bare `reason`, a composed `message`, and — where
 * one exists — the `docPath` of the offending member of the app
 * document. The feedback shape a repair loop needs.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with APP-FORMAT.md's normative
 * table by a test.
 */
export const APP_CODES = Object.freeze({
  JA0001: 'the app document is not an object',
  JA0002: 'view is missing or failed to compile',
  JA0003: 'actions is not an object of named documents',
  JA0004: 'an action document failed to compile',
  JA0005: 'subs is not an array of subscription entries',
  JA0006: 'a subscription entry is malformed or its when failed to compile',
  JA0007: 'the app failed to boot after compilation succeeded',
  JA0008: 'a subscription dynamic member failed to compile or combines invalidly',
  JA2001: 'an unknown action was dispatched',
  JA2002: 'an action, when document or event-field extractor threw',
  JA2003: 'an action produced a transition that is not an object',
  JA2004: 'a transition patch failed to apply',
  JA2005: 'the next state violated the app invariants',
  JA2006: 'a transition named an effect with no registered handler',
  JA2007: 'an effect handler threw',
  JA2008: 'a subscription entry names no registered handler',
  JA2009: 'a binding requested an unknown event field',
  JA2010: 'the dispatch loop exceeded maxTurns transactions in one drain',
  JA2011: 'a state listener or transaction observer threw',
  JA2012: 'a cleanup threw while stopping, reconciling or destroying',
  JA2013: 'a subscription handler threw while starting',
  JA2014: 'a post-render intent named a data-ref with no rendered target',
  JA2015: 'the validateState hook itself threw',
  JA2016: 'a subscription dynamic query (withQuery, key or for) failed at runtime',
  JA2017: 'a subscription fan-out exceeded maxSubInstances',
});

/**
 * A defect in the app document itself, raised while `createApp` compiles
 * it. Codes:
 *
 *  - `JA0001` — the app document is not an object
 *  - `JA0002` — `view` is missing or not a stylesheet document
 *  - `JA0003` — `actions` is not an object of named documents
 *  - `JA0004` — an action document failed to compile (see `cause`)
 *  - `JA0005` — `subs` is not an array of subscription entries
 *  - `JA0006` — a subscription entry is malformed or its `when` failed
 *    to compile (see `cause`)
 *  - `JA0007` — the app failed to boot: the renderer construction, the
 *    initial-state check, the initial subscriptions, the first frame or
 *    the queued boot work failed after compilation succeeded; every
 *    already-acquired resource was rolled back (see `cause`)
 *  - `JA0008` — a subscription's dynamic member (`withQuery`, `key`,
 *    `for`) failed to compile (see `cause`), or the members combine
 *    invalidly (`with` beside `withQuery` or `for`; `key` without
 *    either)
 */
export class AppCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed as
   *   `${code}: ${reason} at ${docPath}` per the coded contract.
   * @param {string} [docPath] - JSON Pointer into the app document;
   *   `''` is the document root, `undefined` means no location (never
   *   normalized to `''` — root and unknown are different facts).
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('AppCompileError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A failure while the app is running. Codes:
 *
 *  - `JA2001` — an unknown action was dispatched
 *  - `JA2002` — an action or `when` document threw while evaluating,
 *    or a registered event-field extractor threw (see `cause`; the
 *    extractor's member binds `null` and the dispatch still runs)
 *  - `JA2003` — an action produced a transition that is not an object
 *  - `JA2004` — a transition's `patch` failed to apply (see `cause`)
 *  - `JA2005` — the next state violated the app's invariants
 *    (`validateState` rejected it); the transition was NOT applied
 *  - `JA2006` — a transition named an effect with no registered handler
 *  - `JA2007` — an effect handler threw (see `cause`)
 *  - `JA2008` — a subscription entry names no registered handler
 *  - `JA2009` — a binding requested an unknown event field (the member
 *    is bound `null`; the dispatch itself is NOT dropped)
 *  - `JA2010` — the dispatch loop exceeded `maxTurns` transactions in
 *    one drain (an accidental action/effect loop); the queue was
 *    abandoned
 *  - `JA2011` — a state listener or transaction observer threw
 *    (isolated; the queue drains on)
 *  - `JA2012` — a cleanup threw while stopping/reconciling/destroying
 *    (isolated; sibling cleanups still run)
 *  - `JA2013` — a subscription handler threw while starting; the slot
 *    stays stopped
 *  - `JA2014` — a post-render focus/measure intent named a `data-ref`
 *    with no rendered target
 *  - `JA2015` — the `validateState` hook itself threw (see `cause`) —
 *    distinct from a rejection verdict (`JA2005`); the transaction
 *    fails and the queue keeps draining
 *  - `JA2016` — a subscription's dynamic query (`withQuery`, `key` or
 *    `for`) threw while evaluating — a cyclic resolved value included —
 *    and the subscription failed closed (see `cause`; `docPath` names
 *    the member)
 *  - `JA2017` — a subscription fan-out resolved more instances than
 *    `maxSubInstances`; the previous instance set was kept
 */
export class AppRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed
   *   from `code`, `reason` and the location per the coded contract.
   * @param {{ docPath?: string, cause?: Error }} [options] - `docPath`
   *   is a JSON Pointer into the app document where one exists
   *   (`undefined` when there is no location — never `''`, which means
   *   the document root); `cause` retains what host code threw.
   */
  constructor(code, reason, options) {
    super('AppRuntimeError', code, reason, options?.docPath,
      options !== undefined && options.cause !== undefined
        ? { cause: options.cause }
        : undefined);
    /** Structured detail, e.g. validateState errors for JA2005. */
    this.detail = undefined;
  }
}

/**
 * A non-Error value thrown by host code, wrapped for the framework's
 * error channels. JavaScript permits `throw null`, `throw undefined`,
 * strings, numbers and arbitrary objects; host extension points
 * (effects, subscriptions, validators, extractors, listeners,
 * observers, widgets, sinks) may produce any of them, and the
 * framework's isolation guarantees must hold for all of them.
 *
 * The original value is retained as an OWN `cause` property — set even
 * when the value is `undefined`, so `Object.hasOwn(err, 'cause')`
 * distinguishes "threw undefined" from "no cause" — and the message
 * describes the value without invoking any user coercion (`toString`
 * on a hostile object is never called).
 */
export class HostValueError extends Error {
  /** @param {unknown} value - The value host code threw. */
  constructor(value) {
    super(`host code threw a non-Error value (${describeThrown(value)})`);
    this.name = 'HostValueError';
    Object.defineProperty(this, 'cause', {
      value, writable: true, enumerable: false, configurable: true,
    });
  }
}

/**
 * Describe a thrown non-Error value without observing it: only
 * conversions no host code can trap are used — never a `toString`,
 * never `Symbol.toPrimitive`, and never proxy-observable reflection
 * (`Array.isArray` runs the proxy-sensitive IsArray operation, so a
 * revoked proxy is simply "an object"). `typeof` and identity
 * comparisons are untrappable, which is the whole vocabulary here.
 * @param {unknown} value
 * @returns {string}
 */
function describeThrown(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'string': {
      const short = value.length > 80 ? value.slice(0, 80) + '…' : value;
      return JSON.stringify(short);
    }
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    default:
      return 'an object';
  }
}

/**
 * `value instanceof Error` without trusting the value: `instanceof`
 * walks the prototype chain, which a revoked or hostile proxy turns
 * into a throw. A value whose very classification throws is treated as
 * not-an-Error and wrapped.
 * @param {unknown} value
 * @returns {value is Error}
 */
export function isErrorSafely(value) {
  try {
    return value instanceof Error;
  }
  catch {
    return false;
  }
}

/**
 * Read an error's `message` without trusting it: JavaScript permits an
 * own `message` accessor (or a proxy `get` trap) that throws, and the
 * framework must never fail while formatting a failure. The original
 * error object is never mutated — it stays the causal identity; this
 * only projects a safe diagnostic string.
 * @param {Error} error
 * @returns {string}
 */
export function safeErrorMessage(error) {
  try {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  catch { /* a hostile accessor is a diagnostic, not a crash */ }
  return 'host error (message unavailable)';
}

/**
 * The one host-failure normalization policy (APP-FORMAT §10.1): every
 * value caught at a host boundary passes through here, and the policy
 * is TOTAL — no ECMAScript value, revoked proxies and throwing
 * accessors included, can make it throw. An `Error` instance passes by
 * IDENTITY — wherever a contract promises the original error as
 * `cause`, that identity survives; anything else (a value whose
 * classification itself throws included) is wrapped in a
 * {@link HostValueError} that retains the original value as an own
 * `cause` property. No caught value is ever assumed to have
 * `.message`, and no thrown value is ever used as an absence sentinel.
 * @param {unknown} value - Whatever host code threw.
 * @returns {Error}
 */
export function toError(value) {
  return isErrorSafely(value) ? /** @type {Error} */ (value) : new HostValueError(value);
}
