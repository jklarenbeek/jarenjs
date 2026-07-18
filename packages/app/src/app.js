//@ts-check
/**
 * @file The Jaren application loop.
 *
 * `createApp` takes an **app document** — one JSON value holding the
 * initial state, a JSLT view stylesheet, named action documents and
 * subscription entries — compiles every embedded document once, and runs
 * hyperapp's dispatch loop over the compiled closures:
 *
 *   DOM event → binding → action document → transition → next state
 *     → subscriptions refresh → batched re-render → keyed DOM patch
 *
 * JavaScript enters only at named, registered boundaries: effect and
 * subscription handlers, the `compileTypeTest` hook, and the optional
 * `validateState` invariant hook. Everything between the boundaries is
 * data. See docs/APP-FORMAT.md for the document contract.
 */

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { createDomRenderer } from '@jarenjs/view';

import { compileActions, compileSubs } from './actions.js';
import { AppCompileError, AppRuntimeError } from './errors.js';

/**
 * @typedef {Object} AppOptions
 * @property {any} [node] - DOM element to mount into; omit for a headless
 *   app (drive it via `getVnode`/`subscribe`).
 * @property {any} [document] - The DOM document (defaults to
 *   `node.ownerDocument`).
 * @property {Record<string, (props: any, dispatch: Dispatch) => void>} [effects]
 *   Effect handlers by name.
 * @property {Record<string, (props: any, dispatch: Dispatch) => (() => void) | void>} [subs]
 *   Subscription handlers by name; may return a cleanup function.
 * @property {(schema: any, docPath: string) => ((value: any) => boolean)} [compileTypeTest]
 *   Enables JSON Schema operators (`$valid`/`$assert`/`$as`) and schema
 *   matches inside the view and the action documents.
 * @property {(state: any) => boolean | { valid: boolean, errors?: any }} [validateState]
 *   Invariant hook, called with every candidate next state. A rejection
 *   (`false` or `{ valid: false }`) blocks the transition (fail closed)
 *   and reports `JA2005` through `onError`.
 * @property {(state: any) => any} [viewModel] - The derivation boundary:
 *   maps the state to the view stylesheet's input document before every
 *   render (default identity). This is where JS-computed derivations —
 *   `buildFormViewModel` from `@jarenjs/forms`, aggregations, joins —
 *   enter the render path without ever entering the state.
 * @property {(error: Error) => void} [onError] - Runtime error sink;
 *   default rethrows.
 * @property {(flush: () => void) => void} [schedule] - Render scheduler;
 *   default batches on a microtask. Pass `(f) => f()` for synchronous
 *   rendering (tests, SSR pipelines).
 */

/**
 * @callback Dispatch
 * @param {string} name - The action name.
 * @param {any} [payload] - Bound to `$payload` (`null` when absent).
 * @param {any} [domEvent] - A DOM event to derive `$event` from.
 * @returns {void}
 */

/**
 * Compile an app document and start the loop.
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
    throw new AppCompileError('JA0002',
      `the "view" stylesheet failed to compile: ${/** @type {Error} */ (err).message}`,
      '/view', /** @type {Error} */ (err));
  }
  const actions = compileActions(appDoc.actions, queryOptions);
  const subs = compileSubs(appDoc.subs, queryOptions);

  const effectHandlers = options.effects ?? {};
  const subHandlers = options.subs ?? {};
  const onError = options.onError ?? ((err) => { throw err; });
  const schedule = options.schedule ?? ((flush) => queueMicrotask(flush));

  let state = appDoc.state;
  let running = true;
  let renderScheduled = false;
  /** @type {Set<(state: any) => void>} */
  const stateListeners = new Set();
  /** Per compiled sub: `{ live: boolean, cleanup: (() => void) | void }`. */
  const subStates = subs.map(() => ({ live: false, cleanup: undefined }));

  /** @type {((vnode: any) => void) | null} */
  let renderer = null;
  if (options.node !== undefined) {
    renderer = createDomRenderer(options.node, {
      document: options.document,
      onEvent: handleBinding,
    });
  }

  /** @type {Dispatch} */
  function dispatch(name, payload = null, domEvent = null) {
    if (!running) return;
    const action = actions.get(name);
    if (action === undefined) {
      onError(new AppRuntimeError('JA2001', `unknown action '${name}'`));
      return;
    }
    let transition;
    try {
      transition = action.first(state, {
        event: domEvent !== null ? eventData(domEvent) : null,
        payload,
      });
    }
    catch (err) {
      onError(new AppRuntimeError('JA2002',
        `action '${name}' failed: ${/** @type {Error} */ (err).message}`,
        /** @type {Error} */ (err)));
      return;
    }
    applyTransition(name, transition);
  }

  /**
   * An `on` binding fired by the renderer: an action name, or
   * `{ "action": name, "with": payload }`.
   * @param {any} binding
   * @param {any} event
   */
  function handleBinding(binding, event) {
    if (typeof binding === 'string') {
      dispatch(binding, null, event);
    }
    else if (binding !== null && typeof binding === 'object'
      && typeof binding.action === 'string') {
      dispatch(binding.action, binding.with ?? null, event);
    }
    else {
      onError(new AppRuntimeError('JA2001',
        `unusable event binding: ${JSON.stringify(binding)}`));
    }
  }

  /**
   * @param {string} name - The acting action, for error messages.
   * @param {any} transition
   */
  function applyTransition(name, transition) {
    if (transition === undefined || transition === null) return;
    if (typeof transition !== 'object' || Array.isArray(transition)) {
      onError(new AppRuntimeError('JA2003',
        `action '${name}' produced a transition that is not an object`));
      return;
    }
    let next = state;
    // changed paths for this transition: an array of JSON Pointers when
    // the transition was patch-only (the engine's tracked writes), else
    // null = "unknown, treat everything as changed"
    let changes = null;
    if ('state' in transition) next = transition.state;
    if (transition.patch !== undefined) {
      try {
        const tracked = applyJSONPatch(next, transition.patch, { changes: true });
        next = tracked.doc;
        if (!('state' in transition)) changes = tracked.changes;
      }
      catch (err) {
        onError(new AppRuntimeError('JA2004',
          `action '${name}' produced a patch that failed to apply: ${/** @type {Error} */ (err).message}`,
          /** @type {Error} */ (err)));
        return;
      }
    }
    if (next !== state && options.validateState !== undefined) {
      const verdict = options.validateState(next);
      if (verdict === false
        || (verdict !== null && typeof verdict === 'object' && verdict.valid === false)) {
        const err = new AppRuntimeError('JA2005',
          `action '${name}' violated the app's state invariants; transition rejected`);
        err.detail = typeof verdict === 'object' ? verdict.errors : undefined;
        onError(err);
        return;
      }
    }
    const changed = next !== state;
    state = next;
    if (transition.effects !== undefined) runEffects(name, transition.effects);
    if (changed) {
      for (const listener of stateListeners) listener(state, changes);
      refreshSubs();
      scheduleRender();
    }
  }

  /**
   * @param {string} name
   * @param {any} effects
   */
  function runEffects(name, effects) {
    if (!Array.isArray(effects)) {
      onError(new AppRuntimeError('JA2003',
        `action '${name}' produced "effects" that are not an array`));
      return;
    }
    for (const effect of effects) {
      const run = effect?.run;
      const handler = typeof run === 'string' ? effectHandlers[run] : undefined;
      if (handler === undefined) {
        onError(new AppRuntimeError('JA2006',
          `action '${name}' invoked unregistered effect '${String(run)}'`));
        continue;
      }
      try {
        handler(effect.with ?? null, dispatch);
      }
      catch (err) {
        onError(new AppRuntimeError('JA2007',
          `effect '${run}' threw: ${/** @type {Error} */ (err).message}`,
          /** @type {Error} */ (err)));
      }
    }
  }

  /**
   * Start and stop subscriptions to match their `when` queries against
   * the current state. A broken `when` fails CLOSED (the subscription
   * stops — a broken rule must never keep side effects alive) and is
   * reported through `onError`.
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
          onError(new AppRuntimeError('JA2002',
            `subscription '${sub.run}' has a "when" that failed: ${/** @type {Error} */ (err).message}`,
            /** @type {Error} */ (err)));
        }
      }
      if (live && !slot.live) {
        const handler = subHandlers[sub.run];
        if (handler === undefined) {
          onError(new AppRuntimeError('JA2008',
            `subscription '${sub.run}' has no registered handler`));
          continue;
        }
        slot.live = true;
        slot.cleanup = handler(sub.props, dispatch);
      }
      else if (!live && slot.live) {
        slot.live = false;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = undefined;
      }
    }
  }

  function scheduleRender() {
    if (renderer === null || renderScheduled) return;
    renderScheduled = true;
    schedule(() => {
      renderScheduled = false;
      if (running) render();
    });
  }

  const viewModel = options.viewModel ?? null;

  /** The current view output (through the viewModel derivation). */
  function vnode() {
    return view(viewModel !== null ? viewModel(state) : state);
  }

  /** Render synchronously, now. */
  function render() {
    if (renderer !== null) renderer(vnode());
  }

  // boot: subscriptions against the initial state, then the first frame
  refreshSubs();
  render();

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
     * state was replaced — treat everything as changed.
     * @param {(state: any, changes: string[] | null) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    /** Stop the loop: cleans up subscriptions, ignores further dispatches. */
    stop() {
      running = false;
      refreshSubs();
      stateListeners.clear();
    },
  };
}

/**
 * The serializable slice of a DOM event bound to `$event`.
 * @param {any} event
 * @returns {{ type: string, value: any, checked: any, key: any }}
 */
function eventData(event) {
  const target = event?.target;
  return {
    type: event?.type ?? '',
    value: target?.value ?? null,
    checked: target?.checked ?? null,
    key: event?.key ?? null,
  };
}
