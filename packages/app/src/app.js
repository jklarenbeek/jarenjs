//@ts-check
/**
 * @file The Jaren application loop.
 *
 * `createApp` takes an **app document** — one JSON value holding the
 * initial state, a JSLT view stylesheet, named action documents and
 * subscription entries — compiles every embedded document once, and runs
 * a serialized dispatch loop over the compiled closures:
 *
 *   DOM event → binding → action document → transition → next state
 *     → effects → listeners → subscriptions refresh → batched re-render
 *
 * JavaScript enters only at named, registered boundaries: effect and
 * subscription handlers, the `compileTypeTest` hook, and the optional
 * `validateState` invariant hook. Everything between the boundaries is
 * data. See docs/APP-FORMAT.md for the document contract.
 *
 * **Transaction model (APP-FORMAT §8).** Every dispatch is one
 * transaction on one FIFO queue. Only the queue drain evaluates and
 * applies transitions; a dispatch from an effect, listener, observer,
 * subscription handler, widget or lifecycle hook queues behind the
 * current transaction and never nests. Within a transaction the order
 * is: state commit → effect invocation → listener notification →
 * subscription reconciliation → render scheduling → observer
 * notification; all of it completes before the next transaction begins.
 * Every listener therefore observes every transaction in the same
 * order, and each notification carries the state produced by exactly
 * that transaction. Native event data is reduced to JSON synchronously
 * at dispatch time, before queuing. A listener, observer or cleanup
 * error is isolated: it is reported through `onError`, and whatever the
 * sink throws is re-thrown only after the drain has fully completed —
 * the queue always drains, cleanups are never skipped.
 */

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { createDomRenderer } from '@jarenjs/view';

import { compileActions, compileSubs } from './actions.js';
import { AppCompileError, AppRuntimeError, toError, safeErrorMessage } from './errors.js';

/**
 * @typedef {Object} AppOptions
 * @property {any} [node] - DOM element to mount into; omit for a headless
 *   app (drive it via `getVnode`/`subscribe`).
 * @property {any} [document] - The DOM document (defaults to
 *   `node.ownerDocument`).
 * @property {Record<string, (props: any, dispatch: Dispatch) => void>} [effects]
 *   Effect handlers by name. A handler function may carry an optional
 *   `dispose()` member, called exactly once by `app.destroy()` (a
 *   handler registered under several names is disposed once).
 * @property {Record<string, (props: any, dispatch: Dispatch) => (() => void) | void>} [subs]
 *   Subscription handlers by name; may return a cleanup function.
 * @property {Record<string, (nativeEvent: any) => any>} [eventFields]
 *   Named event-field extractors: when a binding requests a field by
 *   name, an extractor registered here wins over the built-in
 *   allow-list. An extractor receives the native event and MUST return
 *   a JSON value (`$event` stays serializable end to end).
 * @property {Record<string, any>} [widgets] - Registered widget
 *   definitions by name for `jaren-widget` vnodes (VIEW-FORMAT §7),
 *   forwarded to the renderer — the mechanism lives in `@jarenjs/view`;
 *   the app only names the boundary, like effects and subs.
 * @property {(schema: any, docPath: string) => ((value: any) => boolean)} [compileTypeTest]
 *   Enables JSON Schema operators (`$valid`/`$assert`/`$as`) and schema
 *   matches inside the view and the action documents.
 * @property {(state: any, context: ValidateContext) => boolean | { valid: boolean, errors?: any }} [validateState]
 *   Invariant hook, called with every candidate next state plus a
 *   context carrying the previous state, the acting action name, its
 *   payload and the transition's changed paths (`null` = unknown, the
 *   whole state must be treated as changed — selective validation on
 *   `changes` is only sound when the hook falls back to a full check
 *   for `null`). A rejection (`false` or `{ valid: false }`) blocks the
 *   transition (fail closed) and reports `JA2005` through `onError`.
 *   The hook is host code and may itself fail: a throwing validator is
 *   isolated as `JA2015` (the transaction fails, the original cause is
 *   preserved, and the queue keeps draining — parked errors from the
 *   default rethrowing sink surface only after the drain). The hook
 *   also runs once at boot against the initial state (see
 *   {@link ValidateContext}).
 * @property {(state: any) => any} [viewModel] - The derivation boundary:
 *   maps the state to the view stylesheet's input document before every
 *   render (default identity). This is where JS-computed derivations —
 *   `buildFormViewModel` from `@jarenjs/forms`, aggregations, joins —
 *   enter the render path without ever entering the state.
 * @property {(error: Error) => void} [onError] - Runtime error sink;
 *   default rethrows. Errors reported from isolated sites (listeners,
 *   observers, cleanups, unknown event fields) never break the
 *   transaction queue: whatever the sink throws surfaces to the outer
 *   dispatch caller only after the drain completes.
 * @property {(flush: () => void) => void} [schedule] - Render scheduler;
 *   default batches on a microtask. Pass `(f) => f()` for synchronous
 *   rendering (tests, SSR pipelines).
 * @property {() => void} [afterRender] - Called exactly once per
 *   settled, NONTERMINAL committed frame: after the DOM patch and
 *   widget mounts complete, and — when a widget hook error was parked
 *   during the frame — BEFORE that error is delivered to `onError`
 *   (the committed frame is real; its callback is never starved by
 *   error delivery). Never called for a pass that ended in terminal
 *   teardown, and never on headless apps. The post-render
 *   focus/measurement queue (`createFocusEffect`) plugs in here.
 * @property {number} [maxTurns] - The dispatch-loop guard (default
 *   1000): the maximum number of transactions one drain may process
 *   before the queue is abandoned with `JA2010` — an accidental
 *   action→effect→action loop diagnoses instead of hanging.
 * @property {boolean} [capturePayloads] - Include `payload` and `event`
 *   values in transaction records handed to observers (default false —
 *   diagnostics must not leak data by default).
 */

/**
 * The context handed to `validateState` (second argument). During boot
 * the hook is called once with the initial state and the **boot
 * context**: `previous` and `action` are `null` (no transition
 * produced the state) and `changes` is `null` (validate fully); this
 * runs before any subscription starts or effect runs.
 * @typedef {Object} ValidateContext
 * @property {any} previous - The state the transition started from
 *   (`null` for the boot-time initial-state check).
 * @property {string | null} action - The acting action name (`null`
 *   for the boot-time initial-state check).
 * @property {any} payload - The dispatch payload (`null` when absent).
 * @property {string[] | null} changes - Changed JSON Pointers when the
 *   transition was patch-only, else `null` (= unknown, validate fully).
 */

/**
 * A transaction record handed to observers (APP-FORMAT §8.3). Payload
 * and event members are present only when `capturePayloads` is on.
 * @typedef {Object} TransactionRecord
 * @property {number} seq - Monotonic transaction sequence number.
 * @property {string} action - The dispatched action name.
 * @property {string} source - What queued it: `'dispatch'` (external),
 *   `'binding'` (DOM/widget), `'effect'`, `'subscription'`.
 * @property {'applied' | 'noop' | 'rejected' | 'failed'} status
 * @property {string[] | null} changedPaths - Changed JSON Pointers, or
 *   `null` when the whole state was replaced (unknown = everything).
 * @property {string[]} scheduledEffects - Names of effects invoked.
 * @property {number} durationMs
 * @property {string | null} errorCode - The `JA2xxx` code when the
 *   transaction failed or was rejected.
 * @property {any} [payload]
 * @property {any} [event]
 */

/**
 * @callback Dispatch
 * @param {string} name - The action name.
 * @param {any} [payload] - Bound to `$payload` (`null` when absent).
 * @param {any} [domEvent] - A DOM event to derive `$event` from.
 * @param {string[] | null} [eventFields] - Extra `$event` field names to
 *   resolve from the event (the binding's `event` member; headless
 *   callers get the same capability).
 * @returns {void}
 */

/** The aggregate envelope message for multiple same-drain sink
 * failures (see `safeError`); exact-match tested so nesting flattens. */
const MULTIPLE_SINK_FAILURES = 'multiple failures surfaced in one drain';

/**
 * Compile an app document and start the loop.
 *
 * Boot is a transaction: compiling the documents, creating the
 * renderer, validating the initial state, starting the initial
 * subscriptions, painting the first frame and draining the dispatches
 * queued by starting handlers either all succeed, or every
 * already-acquired resource (subscriptions, effect handlers, the
 * renderer — the container ends empty) is disposed and `createApp`
 * throws `JA0007` (an `AppCompileError` carrying the original failure
 * as `cause`). `onError` observes individual boot-time failures first —
 * a sink that swallows a subscription-start failure, the initial-state
 * check or an error inside queued boot work recovers it and boots the
 * rest; renderer-construction and first-frame failures are always
 * fatal; the default rethrowing sink aborts boot on any of them. After
 * a successful boot the returned app never throws from `createApp`
 * paths again.
 *
 * @param {any} appDoc
 * @param {AppOptions} [options]
 */
export function createApp(appDoc, options = {}) {
  if (appDoc === null || typeof appDoc !== 'object' || Array.isArray(appDoc)) {
    throw new AppCompileError('JA0001', 'the app document must be an object', '');
  }
  if (appDoc.view === undefined) {
    throw new AppCompileError('JA0002', 'the app document has no "view" stylesheet', '/view');
  }
  const queryOptions = { compileTypeTest: options.compileTypeTest };

  let view;
  try {
    // memoized rule outputs: unchanged state subtrees yield reference-
    // equal vnodes frame over frame, so the renderer's === fast path
    // skips them (VIEW-FORMAT §5.1). Vnodes are immutable by contract,
    // which is exactly the discipline memoization needs.
    view = compileJsltStylesheet(appDoc.view, { ...queryOptions, memo: true });
  }
  catch (err) {
    const cause = toError(err);
    throw new AppCompileError('JA0002',
      `the "view" stylesheet failed to compile: ${safeErrorMessage(cause)}`,
      '/view', cause);
  }
  const actions = compileActions(appDoc.actions, queryOptions);
  const subs = compileSubs(appDoc.subs, queryOptions);

  const effectHandlers = options.effects ?? {};
  const subHandlers = options.subs ?? {};
  const eventExtractors = options.eventFields ?? {};
  const onError = options.onError ?? ((err) => { throw err; });
  const schedule = options.schedule ?? ((flush) => queueMicrotask(flush));
  const afterRender = options.afterRender ?? null;
  const maxTurns = options.maxTurns ?? 1000;
  // a loop guard that silently coerces (NaN, '50', 2.5, 0) is no guard
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new TypeError('createApp: options.maxTurns must be a positive integer');
  }
  const capturePayloads = options.capturePayloads === true;

  let state = appDoc.state;
  let running = true;
  let destroyed = false;
  let renderScheduled = false;
  /** @type {Set<(state: any, changes: string[] | null) => void>} */
  const stateListeners = new Set();
  /** @type {Set<(tx: TransactionRecord) => void>} */
  const observers = new Set();
  /** Per compiled sub: `{ live: boolean, cleanup: (() => void) | void }`. */
  const subStates = subs.map(() => ({ live: false, cleanup: undefined }));

  /**
   * The FIFO transaction queue (APP-FORMAT §8). Entries carry the
   * already-JSON-reduced event — native events never wait in the queue.
   * @type {Array<{ source: string, name: string, payload: any, event: any, unknownFields: string[] | null, extractorFailures: Array<{ field: string, value: unknown }> | null }>}
   */
  const actionQueue = [];
  let draining = false;
  let txSeq = 0;
  /**
   * The first value an `onError` sink (or an isolated site) threw
   * while the drain was running, as a PRESENCE record — host code may
   * legally `throw null`/`throw undefined`, so the thrown value itself
   * can never double as the absence sentinel. The drain always
   * completes; the value surfaces to the outermost caller afterwards
   * BY IDENTITY, so the default rethrowing sink still fails loudly
   * without ever corrupting the queue.
   * @type {{ value: unknown } | null}
   */
  let pendingError = null;

  /** @type {(((vnode: any) => void) & { destroy?: () => void }) | null} */
  let renderer = null;

  /**
   * Report an error without ever breaking the drain: the sink runs, and
   * anything it throws parks on `pendingError` until the drain (or the
   * calling entry point) finishes.
   * @param {Error} err
   */
  function safeError(err) {
    try {
      onError(err);
    }
    catch (thrown) {
      if (pendingError === null) {
        pendingError = { value: thrown };
      }
      else {
        // a second sink failure in the same drain must not disappear:
        // both cross the caller boundary in one AggregateError, each
        // retained by identity (APP-FORMAT §10.1)
        const prior = pendingError.value;
        const errors = prior instanceof AggregateError
          && prior.message === MULTIPLE_SINK_FAILURES
          ? [...prior.errors, thrown]
          : [prior, thrown];
        pendingError = { value: new AggregateError(errors, MULTIPLE_SINK_FAILURES) };
      }
    }
  }

  /** Re-throw the parked drain error at an entry-point boundary. */
  function flushPendingError() {
    if (pendingError !== null) {
      const { value } = pendingError;
      pendingError = null;
      throw value;
    }
  }

  /**
   * Queue one transaction and drain if no drain is running. The native
   * event is reduced to JSON here, synchronously — by the time the
   * transaction runs, the event object may be recycled by the browser.
   * @param {string} source
   * @param {string} name
   * @param {any} payload
   * @param {any} domEvent
   * @param {string[] | null} eventFields
   */
  function queueDispatch(source, name, payload, domEvent, eventFields) {
    if (!running) return;
    let event = null;
    let unknownFields = null;
    let extractorFailures = null;
    if (domEvent !== null && domEvent !== undefined) {
      /** @type {string[]} */
      const unknown = [];
      /** @type {Array<{ field: string, value: unknown }>} */
      const failures = [];
      // tagged outcomes: a thrown `undefined` is a FAILURE, structurally
      // distinct from an unknown field — the two must never share a signal
      event = eventData(domEvent, eventFields, eventExtractors,
        (outcome) => {
          if (outcome.kind === 'unknown') unknown.push(outcome.field);
          else failures.push({ field: outcome.field, value: outcome.value });
        });
      if (unknown.length > 0) unknownFields = unknown;
      if (failures.length > 0) extractorFailures = failures;
    }
    actionQueue.push({ source, name, payload, event, unknownFields, extractorFailures });
    drainQueue();
  }

  /** Drain the queue to empty; the sole caller of `runTransaction`. */
  function drainQueue() {
    if (draining) return;
    draining = true;
    let turns = 0;
    try {
      while (actionQueue.length > 0) {
        if (++turns > maxTurns) {
          actionQueue.length = 0;
          safeError(new AppRuntimeError('JA2010',
            `the dispatch loop exceeded ${maxTurns} queued transactions in one drain; `
            + 'the queue was abandoned (an action/effect dispatch loop?)'));
          break;
        }
        const entry = /** @type {NonNullable<ReturnType<typeof actionQueue.shift>>} */ (actionQueue.shift());
        runTransaction(entry);
      }
    }
    finally {
      draining = false;
    }
    flushPendingError();
  }

  /** @type {Dispatch} */
  function dispatch(name, payload = null, domEvent = null, eventFields = null) {
    queueDispatch('dispatch', name, payload, domEvent, eventFields);
  }

  /** The dispatch handed to effect handlers: tags the source. */
  function effectDispatch(name, payload = null, domEvent = null, eventFields = null) {
    queueDispatch('effect', name, payload, domEvent, eventFields);
  }

  /** The dispatch handed to subscription handlers: tags the source. */
  function subDispatch(name, payload = null, domEvent = null, eventFields = null) {
    queueDispatch('subscription', name, payload, domEvent, eventFields);
  }

  /**
   * An `on` binding fired by the renderer (or a widget's `emit`): an
   * action name, or `{ "action": name, "with"?: payload, "event"?:
   * [fieldName, ...], "preventDefault"?: bool, "stopPropagation"?:
   * bool }`. The two native controls run synchronously in the event
   * callback, before the transaction is queued — but only a REGISTERED
   * action owns the native behavior: an unknown action name suppresses
   * nothing (it still queues and reports `JA2001`). A registered action
   * that later fails keeps its already-applied modifiers — whether the
   * action succeeds cannot retroactively change them. Headless events
   * without the methods are a documented no-op.
   * @param {any} binding
   * @param {any} event
   */
  function handleBinding(binding, event) {
    if (typeof binding === 'string') {
      queueDispatch('binding', binding, null, event, null);
      return;
    }
    if (binding !== null && typeof binding === 'object'
      && typeof binding.action === 'string'
      && (binding.event === undefined || isFieldNameArray(binding.event))
      && (binding.preventDefault === undefined || typeof binding.preventDefault === 'boolean')
      && (binding.stopPropagation === undefined || typeof binding.stopPropagation === 'boolean')) {
      const registered = actions.has(binding.action);
      if (registered && binding.preventDefault === true
        && typeof event?.preventDefault === 'function') {
        event.preventDefault();
      }
      if (registered && binding.stopPropagation === true
        && typeof event?.stopPropagation === 'function') {
        event.stopPropagation();
      }
      queueDispatch('binding', binding.action, binding.with ?? null, event, binding.event ?? null);
      return;
    }
    safeError(new AppRuntimeError('JA2001',
      `unusable event binding: ${JSON.stringify(binding)}`));
    if (!draining) flushPendingError();
  }

  /**
   * Run one queued transaction to completion: evaluate the action,
   * commit the state, invoke effects, notify listeners, reconcile
   * subscriptions, schedule the render, then notify observers.
   * @param {{ source: string, name: string, payload: any, event: any, unknownFields: string[] | null, extractorFailures: Array<{ field: string, value: unknown }> | null }} entry
   */
  function runTransaction(entry) {
    const started = now();
    const seq = ++txSeq;
    /** @type {'applied' | 'noop' | 'rejected' | 'failed'} */
    let status = 'noop';
    /** @type {string | null} */
    let errorCode = null;
    /** @type {string[] | null} */
    let changes = null;
    /** @type {string[]} */
    const scheduledEffects = [];

    // a typo in one requested event field binds null and reports; the
    // dispatch itself is never dropped (JA2009 contract)
    if (entry.unknownFields !== null) {
      for (const field of entry.unknownFields) {
        safeError(new AppRuntimeError('JA2009',
          `a binding requested an unknown event field '${field}'`));
      }
    }
    // an extractor is host code: a throw surfaces as the dispatching
    // action's JA2002 (APP-FORMAT §5.4), the member binds null, and the
    // dispatch itself is never dropped
    if (entry.extractorFailures !== null) {
      for (const { field, value } of entry.extractorFailures) {
        const cause = toError(value);
        safeError(new AppRuntimeError('JA2002',
          `action '${entry.name}' event-field extractor '${field}' threw: ${safeErrorMessage(cause)}`,
          cause));
      }
    }

    const action = actions.get(entry.name);
    if (action === undefined) {
      safeError(new AppRuntimeError('JA2001', `unknown action '${entry.name}'`));
      finish('failed', 'JA2001');
      return;
    }

    let transition;
    try {
      transition = action.first(state, { event: entry.event, payload: entry.payload });
    }
    catch (err) {
      const cause = toError(err);
      safeError(new AppRuntimeError('JA2002',
        `action '${entry.name}' failed: ${safeErrorMessage(cause)}`, cause));
      finish('failed', 'JA2002');
      return;
    }

    if (transition === undefined || transition === null) {
      finish('noop', null);
      return;
    }
    if (typeof transition !== 'object' || Array.isArray(transition)) {
      safeError(new AppRuntimeError('JA2003',
        `action '${entry.name}' produced a transition that is not an object`));
      finish('failed', 'JA2003');
      return;
    }

    let next = state;
    // changed paths for this transition: an array of JSON Pointers when
    // the transition was patch-only (the engine's tracked writes), else
    // null = "unknown, treat everything as changed"
    if ('state' in transition) next = transition.state;
    if (transition.patch !== undefined) {
      try {
        const tracked = applyJSONPatch(next, transition.patch, { changes: true });
        next = tracked.doc;
        if (!('state' in transition)) changes = tracked.changes;
      }
      catch (err) {
        const cause = toError(err);
        safeError(new AppRuntimeError('JA2004',
          `action '${entry.name}' produced a patch that failed to apply: ${safeErrorMessage(cause)}`,
          cause));
        finish('failed', 'JA2004');
        return;
      }
    }
    if (next !== state && options.validateState !== undefined) {
      let verdict;
      try {
        verdict = options.validateState(next, {
          previous: state,
          action: entry.name,
          payload: entry.payload,
          changes,
        });
      }
      catch (err) {
        // the validator is host code: a throw is its own failure mode
        // (JA2015), never a rejection verdict — the transaction fails,
        // the queue keeps draining
        const cause = toError(err);
        safeError(new AppRuntimeError('JA2015',
          `the validateState hook threw for action '${entry.name}': ${safeErrorMessage(cause)}`,
          cause));
        finish('failed', 'JA2015');
        return;
      }
      if (verdict === false
        || (verdict !== null && typeof verdict === 'object' && verdict.valid === false)) {
        const err = new AppRuntimeError('JA2005',
          `action '${entry.name}' violated the app's state invariants; transition rejected`);
        err.detail = typeof verdict === 'object' ? verdict.errors : undefined;
        safeError(err);
        finish('rejected', 'JA2005');
        return;
      }
    }

    const changed = next !== state;
    state = next;
    if (transition.effects !== undefined) {
      runEffects(entry.name, transition.effects, scheduledEffects);
    }
    if (changed) {
      for (const listener of stateListeners) {
        try {
          listener(state, changes);
        }
        catch (err) {
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2011',
            `a state listener threw: ${safeErrorMessage(cause)}`, cause));
        }
      }
      refreshSubs();
      scheduleRender();
    }
    finish(changed || scheduledEffects.length > 0 ? 'applied' : 'noop', null);

    /**
     * Build the transaction record and notify observers (isolated: an
     * observer failure never reaches the queue).
     * @param {'applied' | 'noop' | 'rejected' | 'failed'} finalStatus
     * @param {string | null} code
     */
    function finish(finalStatus, code) {
      status = finalStatus;
      errorCode = code;
      if (observers.size === 0) return;
      /** @type {TransactionRecord} */
      const record = {
        seq,
        action: entry.name,
        source: entry.source,
        status,
        changedPaths: status === 'applied' ? changes : null,
        scheduledEffects,
        durationMs: now() - started,
        errorCode,
      };
      if (capturePayloads) {
        record.payload = entry.payload;
        record.event = entry.event;
      }
      for (const observer of observers) {
        try {
          observer(record);
        }
        catch (err) {
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2011',
            `a transaction observer threw: ${safeErrorMessage(cause)}`, cause));
        }
      }
    }
  }

  /**
   * @param {string} name
   * @param {any} effects
   * @param {string[]} scheduled - Records invoked effect names.
   */
  function runEffects(name, effects, scheduled) {
    if (!Array.isArray(effects)) {
      safeError(new AppRuntimeError('JA2003',
        `action '${name}' produced "effects" that are not an array`));
      return;
    }
    for (const effect of effects) {
      const run = effect?.run;
      const handler = typeof run === 'string' ? effectHandlers[run] : undefined;
      if (handler === undefined) {
        safeError(new AppRuntimeError('JA2006',
          `action '${name}' invoked unregistered effect '${String(run)}'`));
        continue;
      }
      scheduled.push(run);
      try {
        handler(effect.with ?? null, effectDispatch);
      }
      catch (err) {
        const cause = toError(err);
        safeError(new AppRuntimeError('JA2007',
          `effect '${run}' threw: ${safeErrorMessage(cause)}`, cause));
      }
    }
  }

  /**
   * Start and stop subscriptions to match their `when` queries against
   * the current state. A broken `when` fails CLOSED (the subscription
   * stops — a broken rule must never keep side effects alive) and is
   * reported through `onError`.
   *
   * Startup is resource acquisition: a slot is committed live only
   * after its handler returned. A throwing handler leaves the slot
   * stopped (`JA2013`); a throwing cleanup is isolated (`JA2012`) and
   * never skips its siblings. Because dispatches queue (they never
   * nest), condition changes made by a starting handler coalesce: they
   * are observed by the next transaction's reconciliation, which then
   * disposes the just-started resource through the ordinary stop path.
   */
  function refreshSubs() {
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const slot = subStates[i];
      let live = running;
      if (live && sub.when !== null) {
        try {
          live = sub.when.ebv(state);
        }
        catch (err) {
          live = false;
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2002',
            `subscription '${sub.run}' has a "when" that failed: ${safeErrorMessage(cause)}`, cause));
        }
      }
      if (live && !slot.live) {
        const handler = subHandlers[sub.run];
        if (handler === undefined) {
          safeError(new AppRuntimeError('JA2008',
            `subscription '${sub.run}' has no registered handler`));
          continue;
        }
        let cleanup;
        try {
          cleanup = handler(sub.props, subDispatch);
        }
        catch (err) {
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2013',
            `subscription '${sub.run}' threw while starting; it stays stopped: ${safeErrorMessage(cause)}`,
            cause));
          continue;
        }
        slot.live = true;
        slot.cleanup = cleanup;
      }
      else if (!live && slot.live) {
        const cleanup = slot.cleanup;
        slot.live = false;
        slot.cleanup = undefined;
        if (typeof cleanup === 'function') {
          try {
            cleanup();
          }
          catch (err) {
            const cause = toError(err);
            safeError(new AppRuntimeError('JA2012',
              `subscription '${sub.run}' threw while cleaning up: ${safeErrorMessage(cause)}`, cause));
          }
        }
      }
    }
  }

  function scheduleRender() {
    if (renderer === null || renderScheduled) return;
    renderScheduled = true;
    schedule(() => {
      renderScheduled = false;
      if (!running) return;
      // a renderer failure (a throwing widget hook) always routes
      // through the app error policy: under a synchronous scheduler it
      // must not corrupt the transaction queue (the parked error
      // surfaces after the drain); under a deferred scheduler `onError`
      // observes it and whatever the sink throws surfaces to the
      // scheduler's context
      try {
        render();
      }
      catch (err) {
        safeError(toError(err));
      }
      if (!draining) flushPendingError();
    });
  }

  const viewModel = options.viewModel ?? null;

  /** The current view output (through the viewModel derivation). */
  function vnode() {
    return view(viewModel !== null ? viewModel(state) : state);
  }

  /** Render synchronously, now. `afterRender` is NOT called here: the
   * renderer's `onFrame` channel invokes it exactly once per settled,
   * nonterminal committed frame — a normal return is the wrong signal
   * (the renderer may have performed terminal teardown, or may be
   * about to deliver a parked widget error for a frame that DID
   * commit). */
  function render() {
    if (renderer === null) return;
    renderer(vnode());
  }

  /**
   * Dispose every live subscription and clear the listeners; shared by
   * stop/destroy/boot-rollback. Cleanup errors are isolated.
   */
  function teardownLoop() {
    running = false;
    actionQueue.length = 0;
    refreshSubs();
    stateListeners.clear();
  }

  /** Dispose registered effect handlers, each identity exactly once. */
  function disposeEffectHandlers() {
    const seen = new Set();
    for (const name in effectHandlers) {
      const handler = effectHandlers[name];
      if (seen.has(handler)) continue;
      seen.add(handler);
      const dispose = /** @type {any} */ (handler)?.dispose;
      if (typeof dispose === 'function') {
        try {
          dispose.call(handler);
        }
        catch (err) {
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2012',
            `effect handler '${name}' threw while disposing: ${safeErrorMessage(cause)}`, cause));
        }
      }
    }
  }

  // boot: renderer construction, the initial-state check, the initial
  // subscriptions, the first frame AND the queued work they produce are
  // one transaction — any failure that would escape createApp rolls
  // back every acquired resource (subscriptions, effect handlers, the
  // renderer; the container ends empty, scheduled work becomes a no-op)
  // and throws one JA0007. A custom onError that swallows a reported
  // boot failure (a subscription start, the initial-state check, an
  // error inside queued boot work) recovers it and boot continues;
  // renderer construction and first-frame failures are always fatal.
  {
    /** A presence record: a boot step may legally throw `null`.
     * @type {{ value: unknown } | null} */
    let bootFailure = null;
    draining = true; // dispatches made by starting handlers queue
    try {
      if (options.node !== undefined) {
        renderer = createDomRenderer(options.node, {
          document: options.document,
          onEvent: handleBinding,
          widgets: options.widgets,
          // terminal-cleanup provenance: a widget unmount that throws
          // during renderer teardown — deferred teardown after an
          // app.destroy() from inside a hook included — is a CLEANUP
          // failure (JA2012, original cause preserved, reported after
          // every sibling cleaned up), never an anonymous render error
          onCleanupError: (thrown) => {
            const cause = toError(thrown);
            safeError(new AppRuntimeError('JA2012',
              `the renderer threw while being destroyed: ${safeErrorMessage(cause)}`, cause));
          },
          // the committed-live-frame boundary: `afterRender` runs once
          // per SETTLED, NONTERMINAL frame — after the DOM patch and
          // widget mounts, before a parked hook error is delivered —
          // and never after terminal teardown (APP-FORMAT §8.4)
          onFrame: (state) => {
            if (state === 'live' && afterRender !== null) {
              // isolated: an afterRender failure (the focus queue's
              // JA2014 included) is reported through the app policy and
              // can never starve the same frame's parked widget error,
              // which the renderer delivers right after this returns
              try {
                afterRender();
              }
              catch (err) {
                safeError(toError(err));
              }
            }
          },
        });
      }
      if (options.validateState !== undefined) {
        validateInitialState();
      }
      refreshSubs();
      render();
    }
    catch (err) {
      bootFailure = { value: err };
    }
    finally {
      draining = false;
    }
    if (bootFailure === null && pendingError !== null) {
      bootFailure = pendingError;
      pendingError = null;
    }
    // subscriptions queued dispatches during boot: drain them inside
    // the boot ownership window, so a queued failure that escapes the
    // sink still rolls back instead of leaving a half-booted app behind
    if (bootFailure === null) {
      try {
        drainQueue();
      }
      catch (err) {
        bootFailure = { value: err };
      }
    }
    if (bootFailure !== null) {
      // rollback: each step is isolated so a throwing cleanup never
      // skips its siblings; the original boot failure always wins
      try {
        teardownLoop();
      }
      catch { /* isolated */ }
      try {
        disposeEffectHandlers();
      }
      catch { /* isolated */ }
      if (renderer !== null) {
        try {
          if (typeof renderer.destroy === 'function') renderer.destroy();
        }
        catch { /* isolated */ }
        renderer = null;
      }
      pendingError = null;
      const cause = toError(bootFailure.value);
      throw new AppCompileError('JA0007',
        `the app failed to boot: ${safeErrorMessage(cause)}`, '', cause);
    }
  }

  /**
   * The boot-time initial-state check (see {@link ValidateContext}):
   * a rejection is `JA2005`, a throwing validator `JA2015` — both are
   * reported first, so a swallowing sink can accept the state and boot
   * on; under the default rethrowing sink they abort the boot.
   */
  function validateInitialState() {
    /** @type {ReturnType<NonNullable<AppOptions['validateState']>>} */
    let verdict;
    try {
      verdict = /** @type {NonNullable<AppOptions['validateState']>} */ (options.validateState)(
        state, { previous: null, action: null, payload: null, changes: null });
    }
    catch (err) {
      const cause = toError(err);
      safeError(new AppRuntimeError('JA2015',
        `the validateState hook threw for the initial state: ${safeErrorMessage(cause)}`, cause));
      return;
    }
    if (verdict === false
      || (verdict !== null && typeof verdict === 'object' && verdict.valid === false)) {
      const err = new AppRuntimeError('JA2005',
        'the initial state violates the app\'s state invariants');
      err.detail = typeof verdict === 'object' ? verdict.errors : undefined;
      safeError(err);
    }
  }

  return {
    dispatch,
    /** The current state (treat as immutable). */
    getState: () => state,
    /** The current view output — for SSR or custom renderers. */
    getVnode: vnode,
    render,
    /**
     * Observe state changes. The listener receives the new state and the
     * transition's changed paths: an array of JSON Pointers when the
     * transition was patch-only (see the patch engine's `changes` option
     * for the invalidation-sound semantics), or `null` when the whole
     * state was replaced — treat everything as changed. Listeners run
     * inside the transaction, in registration order, all observing the
     * same state/changes pair; a throwing listener is isolated (JA2011).
     * @param {(state: any, changes: string[] | null) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    /**
     * Observe completed transactions (APP-FORMAT §8.3). The observer
     * receives one bounded JSON metadata record per transaction, after
     * the transaction fully settled (state, effects, listeners,
     * subscriptions, render scheduling). Payload/event values are
     * included only when the app was created with `capturePayloads`.
     * A throwing observer is isolated and never corrupts the queue.
     * @param {(tx: TransactionRecord) => void} observer
     * @returns {() => void} unsubscribe
     */
    observe(observer) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    /**
     * Stop the loop — one-way and nonterminal, not a resumable pause:
     * live subscriptions are cleaned up (isolated), listeners are
     * cleared and further dispatches are ignored, permanently. The
     * renderer and effect handlers stay untouched — `destroy()` is the
     * terminal teardown that owns them.
     */
    stop() {
      teardownLoop();
      flushPendingError();
    },
    /**
     * Terminal teardown: `stop()` plus observer removal, effect-handler
     * `dispose()` (each handler identity once), and renderer
     * destruction (widgets unmount exactly once, the container is left
     * empty). Idempotent; scheduled render flushes become exact no-ops;
     * every cleanup error is isolated so siblings always run.
     */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      teardownLoop();
      observers.clear();
      disposeEffectHandlers();
      if (renderer !== null) {
        try {
          if (typeof renderer.destroy === 'function') renderer.destroy();
        }
        catch (err) {
          const cause = toError(err);
          safeError(new AppRuntimeError('JA2012',
            `the renderer threw while being destroyed: ${safeErrorMessage(cause)}`, cause));
        }
        renderer = null;
      }
      flushPendingError();
    },
  };
}

/** Monotonic-ish milliseconds for transaction durations. */
function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Is this value a binding's `event` member: an array of field names?
 * @param {any} value
 * @returns {value is string[]}
 */
function isFieldNameArray(value) {
  if (!Array.isArray(value)) return false;
  for (const name of value) {
    if (typeof name !== 'string') return false;
  }
  return true;
}

/**
 * The built-in `$event` field allow-list (APP-FORMAT §3.1): field name →
 * where it is read from. Every entry is a JSON primitive by construction;
 * host-object-valued fields (`target`, `files`, touch lists) are
 * deliberately absent — `$event` must survive `JSON.stringify`, the same
 * invariant as state. Null prototype so lookups never walk to
 * `Object.prototype`.
 */
const EVENT_FIELD_SOURCES = Object.freeze(Object.assign(Object.create(null), {
  shiftKey: 'event', ctrlKey: 'event', altKey: 'event', metaKey: 'event',
  button: 'event', buttons: 'event',
  clientX: 'event', clientY: 'event', offsetX: 'event', offsetY: 'event',
  pageX: 'event', pageY: 'event', screenX: 'event', screenY: 'event',
  movementX: 'event', movementY: 'event',
  deltaX: 'event', deltaY: 'event', deltaMode: 'event',
  code: 'event', repeat: 'event', location: 'event', isComposing: 'event',
  detail: 'event',
  pointerId: 'event', pointerType: 'event', pressure: 'event', isPrimary: 'event',
  selectionStart: 'target', selectionEnd: 'target',
}));

/** The default `$event` members; a requested name from this set is
 * already bound and is never overwritten (a `null` re-bind would erase
 * real data). A registered extractor still wins — the host chose to
 * redefine the member. */
const DEFAULT_EVENT_MEMBERS = Object.freeze(Object.assign(Object.create(null), {
  type: true, value: true, checked: true, key: true,
}));

/**
 * Bind one member of the `$event` object without ever mutating a
 * prototype: `__proto__` becomes an ordinary own data property.
 * @param {any} obj
 * @param {string} name
 * @param {any} value
 */
function setEventMember(obj, name, value) {
  if (name === '__proto__') {
    Object.defineProperty(obj, name, {
      value, writable: true, enumerable: true, configurable: true,
    });
  }
  else {
    obj[name] = value;
  }
}

/**
 * Resolve one requested `$event` field, in precedence order: a registered
 * host extractor, the built-in allow-list, else `null` + a JA2009 report
 * (a typo in one field must not swallow the dispatch). `undefined`
 * coerces to `null` so the result stays JSON.
 * @param {any} event
 * @param {string} name
 * @param {Record<string, (nativeEvent: any) => any>} extractors
 * @param {(outcome: { kind: 'unknown', field: string }) => void} report
 * @returns {any}
 */
function resolveEventField(event, name, extractors, report) {
  const source = EVENT_FIELD_SOURCES[name];
  if (source !== undefined) {
    const value = source === 'target' ? event?.target?.[name] : event?.[name];
    return value === undefined ? null : value;
  }
  report({ kind: 'unknown', field: name });
  return null;
}

/**
 * The serializable slice of a DOM event bound to `$event`: the default
 * `{ type, value, checked, key }` plus one member per requested field
 * name (APP-FORMAT §3.1). Runs synchronously at dispatch time — the
 * result is plain JSON by contract, never the native event.
 * @param {any} event
 * @param {string[] | null} fields - Requested field names, or `null`.
 * @param {Record<string, (nativeEvent: any) => any>} extractors
 * @param {(outcome: { kind: 'unknown', field: string } | { kind: 'threw', field: string, value: unknown }) => void} report
 *   The failure sink, TAGGED so a thrown `undefined` can never be
 *   mistaken for an unknown field: `'unknown'` = the field name
 *   resolves nowhere (JA2009), `'threw'` = a registered extractor
 *   threw (JA2002, the thrown value retained verbatim). Either way the
 *   member binds `null` and the dispatch continues.
 * @returns {{ type: string, value: any, checked: any, key: any }}
 */
function eventData(event, fields, extractors, report) {
  const target = event?.target;
  const data = {
    type: event?.type ?? '',
    value: target?.value ?? null,
    checked: target?.checked ?? null,
    key: event?.key ?? null,
  };
  if (fields !== null) {
    for (const name of fields) {
      if (Object.hasOwn(extractors, name)) {
        let value = null;
        try {
          const out = extractors[name](event);
          value = out === undefined ? null : out;
        }
        catch (err) {
          report({ kind: 'threw', field: name, value: err });
        }
        setEventMember(data, name, value);
        continue;
      }
      // a requested default member is already bound; never null it out
      if (DEFAULT_EVENT_MEMBERS[name] === true) continue;
      setEventMember(data, name, resolveEventField(event, name, extractors, report));
    }
  }
  return data;
}
