//@ts-check
/**
 * @file The post-render focus/measurement queue (APP-FORMAT §8.4).
 *
 * Focus, text selection and measurement need a real DOM element at a
 * moment when the frame is committed — but DOM nodes must never enter
 * state. The bridge is a JSON intent naming a `data-ref` token that the
 * view places as an ordinary attribute:
 *
 *   view:    ["input", { "data-ref": "search" }]
 *   action:  { "effects": [{ "run": "focus", "with": { "ref": "search" } }] }
 *
 * Intents queue during the transaction and flush after the NEXT
 * committed frame — after the DOM patch and after widget mounts, so a
 * target inside freshly rendered markup is already connected. A missing
 * target is a diagnosable `JA2014`, never a silent no-op. Destroying
 * the app (or `dispose()`) cancels pending intents; a headless app
 * never flushes (there is no frame), which makes the queue a documented
 * no-op there.
 */

import { AppRuntimeError } from './errors.js';

/**
 * @typedef {Object} FocusEffectOptions
 * @property {any} container - The rendered root (the same element
 *   handed to `createApp` as `node`); intents resolve inside it.
 * @property {(error: Error) => void} [onError] - Sink for `JA2014`
 *   missing-target diagnostics; default: the first one is thrown after
 *   the flush completes (siblings still run).
 */

/**
 * The effect handler returned by {@link createFocusEffect}, with its
 * host-side controls.
 * @typedef {((props: any, dispatch: (name: string, payload?: any) => void) => void) & {
 *   flush: () => void,
 *   dispose: () => void,
 * }} FocusEffect
 */

/**
 * Create the post-render intent queue as a registered effect. Intent
 * props (all JSON):
 *
 *  - `ref` (REQUIRED, string) — the `data-ref` token to resolve;
 *  - `op`  (OPTIONAL) — `"focus"` (default), `"select"`, or
 *    `"measure"`;
 *  - `done` (REQUIRED for `measure`) — the action dispatched with
 *    `{ id, ref, rect }` where `rect` is the JSON-reduced bounding
 *    rect;
 *  - `id`  (OPTIONAL) — echoed in the `measure` completion payload.
 *
 * Wire `flush` as the app's `afterRender` so intents resolve exactly
 * once per committed frame, ordered after widget mounts:
 *
 * @example
 * const focus = createFocusEffect({ container: node });
 * const app = createApp(doc, {
 *   node,
 *   effects: { focus },
 *   afterRender: focus.flush,
 * });
 * // app.destroy() disposes the queue through the handler's dispose()
 *
 * @param {FocusEffectOptions} options
 * @returns {FocusEffect}
 */
export function createFocusEffect(options) {
  const container = options?.container;
  if (container === null || container === undefined) {
    throw new TypeError('createFocusEffect: an options.container element is required');
  }
  const onError = options.onError ?? null;

  /** @type {Array<{ props: any, dispatch: (name: string, payload?: any) => void }>} */
  let queue = [];
  let disposed = false;

  /** @type {any} */
  const focusEffect = function focusEffect(props, dispatch) {
    if (props === null || typeof props !== 'object' || typeof props.ref !== 'string') {
      throw new TypeError('createFocusEffect: the effect props must carry a string "ref"');
    }
    const op = props.op ?? 'focus';
    if (op !== 'focus' && op !== 'select' && op !== 'measure') {
      throw new TypeError(`createFocusEffect: unknown op '${String(op)}'`);
    }
    if (op === 'measure' && typeof props.done !== 'string') {
      throw new TypeError('createFocusEffect: a "measure" intent must carry a "done" action name');
    }
    if (disposed) return;
    queue.push({ props, dispatch });
  };

  /**
   * Resolve every queued intent against the committed frame. Missing
   * targets report `JA2014`; every sibling intent still runs.
   */
  focusEffect.flush = function flush() {
    if (disposed || queue.length === 0) return;
    const batch = queue;
    queue = [];
    /** @type {Error | null} */
    let firstError = null;
    for (const { props, dispatch } of batch) {
      const target = findByRef(container, props.ref);
      if (target === null) {
        const err = new AppRuntimeError('JA2014',
          `a post-render intent named data-ref '${props.ref}' but no rendered element carries it`);
        if (onError !== null) onError(err);
        else if (firstError === null) firstError = err;
        continue;
      }
      const op = props.op ?? 'focus';
      if (op === 'focus') {
        if (typeof target.focus === 'function') target.focus();
      }
      else if (op === 'select') {
        if (typeof target.select === 'function') target.select();
        else if (typeof target.focus === 'function') target.focus();
      }
      else {
        const rect = typeof target.getBoundingClientRect === 'function'
          ? target.getBoundingClientRect()
          : null;
        dispatch(props.done, {
          id: props.id ?? null,
          ref: props.ref,
          rect: rect === null ? null : {
            x: rect.x, y: rect.y,
            width: rect.width, height: rect.height,
            top: rect.top, left: rect.left,
            right: rect.right, bottom: rect.bottom,
          },
        });
      }
    }
    if (firstError !== null) throw firstError;
  };

  /** Terminal: drop pending intents and ignore new ones. Idempotent. */
  focusEffect.dispose = function dispose() {
    disposed = true;
    queue = [];
  };

  return focusEffect;
}

/**
 * Depth-first search for the element whose `data-ref` attribute equals
 * the token. Attribute-based on purpose: it works on any DOM the
 * renderer can write to (real, stub, test), independent of
 * `querySelector` and CSS escaping rules.
 * @param {any} node
 * @param {string} token
 * @returns {any | null}
 */
function findByRef(node, token) {
  if (typeof node?.getAttribute === 'function' && node.getAttribute('data-ref') === token) {
    return node;
  }
  const children = node?.childNodes;
  if (children === undefined) return null;
  for (let i = 0; i < children.length; i++) {
    const found = findByRef(children[i], token);
    if (found !== null) return found;
  }
  return null;
}
