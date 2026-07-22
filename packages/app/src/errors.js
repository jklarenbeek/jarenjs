//@ts-check
/**
 * @file Error types for @jarenjs/app, following the suite convention:
 * every failure carries a stable `code` (JA0xxx compile, JA2xxx runtime)
 * and, where one exists, the `docPath` of the offending member of the
 * app document — the feedback shape a repair loop needs.
 */

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
 *  - `JA0007` — the app failed to boot: the initial subscriptions or
 *    the first frame failed after compilation succeeded; every
 *    already-acquired resource was rolled back (see `cause`)
 */
export class AppCompileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [docPath] - JSON Pointer into the app document.
   * @param {Error} [cause]
   */
  constructor(code, message, docPath, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AppCompileError';
    this.code = code;
    this.docPath = docPath ?? '';
  }
}

/**
 * A failure while the app is running. Codes:
 *
 *  - `JA2001` — an unknown action was dispatched
 *  - `JA2002` — an action document threw while evaluating (see `cause`)
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
 */
export class AppRuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(code, message, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AppRuntimeError';
    this.code = code;
    /** Structured detail, e.g. validateState errors for JA2005. */
    this.detail = undefined;
  }
}
