//@ts-check
/**
 * @file The DOM renderer — a keyed vnode-JSON patcher.
 *
 * This is the only module in the Jaren suite that touches the DOM. It
 * follows the repository philosophy at the render level: decide once,
 * then run tight loops.
 *
 * Reconciliation contract (see docs/VIEW-FORMAT.md §5):
 *
 *  - `oldVnode === newVnode` skips the whole subtree in O(1). The JSLT
 *    engine's structural sharing (unchanged input → shared output) is what
 *    makes this fast path fire in practice.
 *  - Children reconcile with a head/tail two-pointer sweep plus a key map
 *    for the middle — keyed moves reuse DOM nodes, unkeyed children patch
 *    positionally.
 *  - Vnodes are never mutated or annotated: the DOM-node ↔ vnode
 *    correspondence lives in parallel arrays local to each patch, so
 *    frozen or shared vnode JSON (a JSLT output, a cached document) is
 *    always safe.
 *  - The render boundary is serialized: a `render` entered from inside
 *    a widget hook or event callback (a synchronous `emit` chain) never
 *    nests — it queues behind the running patch, nested requests
 *    coalesce to the latest vnode, and it applies against the committed
 *    baseline. No widget sees `update` before its `mount` returned or
 *    receives stale previous props.
 *
 * Event handling stores the binding JSON on the DOM node and attaches one
 * shared proxy listener per event type; rebinding a handler on re-render
 * never touches `addEventListener`.
 *
 * Widgets (VIEW-FORMAT §7): a vnode with the reserved tag `jaren-widget`
 * mounts a registered JavaScript widget into a host element the patcher
 * owns but never descends into. Widget bookkeeping lives on the DOM node
 * (`__jarenWidget`), never on the vnode — §5.1 forbids annotating vnodes
 * — and the destroy walk that guarantees `unmount` only runs when a
 * widget has actually been created, so widget-free documents keep O(1)
 * subtree removal.
 */

import { kebabCase } from '@jarenjs/core/string';
import {
  isTextNode,
  isElementNode,
  isSameNode,
  propsOf,
  keyOf,
  childrenOf,
  EMPTY_PROPS,
  WIDGET_TAG,
} from './vnode.js';
import { createSafePolicy } from './safe.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Props that are renderer instructions, never written to the DOM. */
const SKIP_PROPS = { key: true, on: true, memo: true };

/**
 * Widget-vnode props that configure the widget instead of the host
 * element. Every other prop (`key`/`on` included) flows through
 * `setProp` exactly as on any element vnode.
 */
const WIDGET_SKIP_PROPS = { name: true, props: true, tag: true };

/**
 * @callback EventBindingHandler
 * @param {any} binding - The opaque `on` binding JSON from the vnode.
 * @param {any} event - The native DOM event.
 * @returns {void}
 */

/**
 * @callback WidgetEmit
 * @param {any} binding - An opaque binding, delivered verbatim to the
 *   renderer's `onEvent` hook — the identical contract to a vnode `on`
 *   member (VIEW-FORMAT §4).
 * @param {any} [nativeEvent] - The native event, when the emission was
 *   caused by one.
 * @returns {void}
 */

/**
 * A registered widget definition (VIEW-FORMAT §7). The renderer owns the
 * host element and the widget owns the host's subtree.
 *
 * Failure policy: a throwing `mount` or `update` poisons the widget —
 * siblings and the frame still complete, the first error surfaces after
 * the frame settles, and the NEXT render replaces it with a fresh
 * lifecycle (`unmount` runs on the old instance only when its `mount`
 * had succeeded). Recovery never depends on the producer allocating a
 * fresh vnode: while any widget is poisoned the `===` subtree fast
 * path is suspended, so a memoized reference-equal tree still reaches
 * and replaces it. A poisoned widget never receives further `update`
 * calls.
 * @typedef {Object} WidgetDef
 * @property {(host: any, props: any, emit: WidgetEmit) => any} mount -
 *   Called with the host element after it is connected to the rendered
 *   tree; returns an opaque handle threaded to `update`/`unmount`.
 * @property {(handle: any, props: any, prevProps: any) => void} [update]
 *   Called when the vnode's `props` reference changed. Absent: the
 *   renderer falls back to `unmount` + fresh `mount` into the same host.
 * @property {(handle: any) => void} [unmount] - Called exactly once when
 *   the widget leaves the tree; timers, listeners and observers die here.
 * @property {(props: any) => any} [ssr] - A vnode for `renderToString`.
 */

/**
 * @typedef {Object} DomRendererOptions
 * @property {EventBindingHandler} [onEvent] - Receives every fired `on`
 *   binding; without it, `on` props are stored but never fired.
 * @property {Record<string, WidgetDef>} [widgets] - Registered widget
 *   definitions by name (VIEW-FORMAT §7).
 * @property {any} [document] - The document to create nodes with
 *   (defaults to `container.ownerDocument`).
 * @property {boolean} [safe=false] - Render under the SAFE policy
 *   ({@link createSafePolicy}): treat the vnode as untrusted. Tags are
 *   restricted to an inert HTML/SVG allow-list, scripting-sink and inline
 *   `on*` properties are dropped, injection-shaped names are rejected, URL
 *   attributes are sanitized, and `on` event bindings are stripped. The
 *   default is trusted rendering — the equivalent of writing the DOM by
 *   hand — so a source-authored view is unaffected. Client and server share
 *   the one policy, so they neutralize an attack identically.
 * @property {(info: { kind: 'tag' | 'prop' | 'event' | 'widget', name: string }) => void}
 *   [onUnsafe] - In safe mode, called for everything stripped: a disallowed
 *   `tag`, a rejected or sanitized-away `prop`, a stripped `on` binding
 *   (`event`) or a `widget`.
 * @property {(thrown: unknown) => void} [onCleanupError] - Receives
 *   the first VALUE a widget `unmount` threw during TERMINAL teardown
 *   (`destroy()`, direct or deferred) — by identity, whatever host
 *   code threw — after every sibling cleaned up: the provenance
 *   channel that lets a host assign cleanup failures their own error
 *   policy, distinct from mount/update/render failures. Absent: the
 *   value surfaces after the teardown (thrown from `destroy()` or
 *   from the render pass that finished a deferred teardown).
 * @property {(state: 'live' | 'destroyed') => void} [onFrame] - Called
 *   once at the end of every top-level render pass: `'live'` = a
 *   committed live frame settled (DOM patch and widget mounts done; a
 *   parked widget hook error, if any, is delivered AFTER this call),
 *   `'destroyed'` = the pass ended in terminal teardown. Not called
 *   for a post-destroy no-op render or by `destroy()` itself.
 */

/**
 * The renderer returned by {@link createDomRenderer}: the patch
 * function, carrying the terminal `destroy()` (VIEW-FORMAT §7.3.1).
 * @typedef {((vnode: any) => void) & { destroy: () => void }} DomRenderer
 */

/**
 * Create a renderer bound to a container element. The returned function
 * patches the container's single root node to match the given vnode;
 * `render.destroy()` is the terminal teardown.
 *
 * @example
 * const render = createDomRenderer(document.getElementById('app'), {
 *   onEvent: (binding, event) => dispatch(binding, event),
 * });
 * render(['main', {}, ['h1', {}, 'Hello']]);
 * render.destroy();
 *
 * @param {any} container - The DOM element to render into (emptied on
 *   first render).
 * @param {DomRendererOptions} [options]
 * @returns {DomRenderer}
 */
export function createDomRenderer(container, options = {}) {
  const ctx = {
    doc: options.document ?? container.ownerDocument,
    onEvent: options.onEvent ?? null,
    widgets: options.widgets ?? EMPTY_PROPS,
    /** The safe render policy, or null for trusted (default) rendering.
     * Consulted for every tag and prop; the same object the SSR serializer
     * uses, so client and server strip an attack identically. */
    policy: options.safe ? createSafePolicy() : null,
    /** Reports everything safe mode strips — a tag, a property, an `on`
     * binding or a widget — so a host can observe a hostile document rather
     * than have it silently vanish. The policy stays a pure decision; the
     * renderer reports at the point it acts. */
    onUnsafe: typeof options.onUnsafe === 'function' ? options.onUnsafe : null,
    /** Controlled form-control nodes (`value`/`checked`), reconciled against
     * the live DOM at the END of every render pass — so an authoritative
     * value is reasserted even when the `===`/`memo` fast paths skip the
     * subtree the control lives in. Trusted mode only: safe mode strips
     * events, so a safe-mode view has no controlled inputs to fight the user
     * over. @type {Set<any>} */
    controlled: new Set(),
    /** Widget host nodes created this patch, awaiting `mount` (§7). */
    mountQueue: [],
    /** True once any widget node exists — gates the destroy walk. */
    hasWidgets: false,
    /** First value a widget hook (`mount`/`update`/`unmount`) threw
     * this frame (§7), as a PRESENCE record — host code may legally
     * `throw null`/`throw undefined`, so the thrown value can never
     * double as the absence sentinel. The walk, the patch and the
     * mount flush always finish; the value surfaces BY IDENTITY after
     * the frame settles.
     * @type {{ value: unknown } | null} */
    frameError: null,
    /** Live poisoned widgets (§7.3). While non-zero, the `===` subtree
     * fast path is disabled so structural sharing (the JSLT memo
     * reusing a reference-equal vnode) can never leave a poisoned
     * widget permanently inert — every render revisits it until it is
     * replaced or removed. */
    poisonedCount: 0,
    /** True after `destroy()`: every later render is an exact no-op. */
    destroyed: false,
    /** Terminal-cleanup sink (see `teardown`): receives the first
     * VALUE a widget `unmount` threw during terminal teardown — by
     * identity, whatever it is — after every sibling cleaned up. */
    onCleanupError: options.onCleanupError ?? null,
    /** Frame-settlement sink: called once at the end of every
     * top-level render pass with `'live'` (a committed live frame —
     * possibly with a parked hook error, delivered afterwards) or
     * `'destroyed'` (the pass ended in terminal teardown). Called
     * BEFORE a parked hook error is thrown, so a committed frame's
     * host callback is never starved by error delivery. */
    onFrame: options.onFrame ?? null,
    /** The one `emit` every widget of this renderer receives. */
    emit: /** @type {WidgetEmit | null} */ (null),
  };
  ctx.emit = function emit(binding, nativeEvent) {
    if (ctx.onEvent !== null) ctx.onEvent(binding, nativeEvent);
  };
  /** @type {any} */
  let oldVnode = null;
  /** @type {any} */
  let rootNode = null;
  /** True while a patch/mount pass runs: the renderer boundary is
   * serialized — a render entered from inside a widget hook or event
   * callback never nests. */
  let rendering = false;
  /** The latest vnode a nested render asked for. Nested renders
   * COALESCE: intermediate trees are redundant because every call
   * carries the full desired tree; only the last one is applied. */
  let pendingVnode;
  let destroyPending = false;

  function render(vnode) {
    if (ctx.destroyed) return; // a scheduled flush after destroy is a no-op
    if (!isTextNode(vnode) && !isElementNode(vnode)) {
      throw new TypeError('view: the root vnode must be a text or element vnode');
    }
    if (rendering) {
      // re-entrant call (a widget mount/update emitted synchronously):
      // queue behind the current patch — it applies after this frame,
      // against the committed baseline, never against stale props
      pendingVnode = vnode;
      return;
    }
    rendering = true;
    try {
      let next = vnode;
      do {
        pendingVnode = undefined;
        if (rootNode === null) {
          container.textContent = '';
          rootNode = createNode(ctx, next, null);
          container.appendChild(rootNode);
        }
        else {
          rootNode = patchNode(ctx, container, rootNode, oldVnode, next, null);
        }
        oldVnode = next;
        // mount flush: after the patch completes every queued host is
        // connected; an emit during mount defers into pendingVnode
        flushMounts(ctx);
        next = pendingVnode;
      } while (next !== undefined && !ctx.destroyed);
      // Controlled-input reconciliation, once per settled pass. It runs here,
      // not inside the prop diff, so it survives every skip: a same-object
      // re-render, a shared subtree and an equal `memo` marker all return
      // before `patchProps`, but the control is still in the registry with
      // its intended value. Also the moment a select's options all exist.
      if (!ctx.destroyed && ctx.controlled.size > 0) {
        reconcileControlledSet(ctx, container);
      }
    }
    finally {
      rendering = false;
      pendingVnode = undefined;
    }
    if (destroyPending) {
      destroyPending = false;
      teardown();
    }
    // dual-failure settlement: the parked hook failure is copied and
    // CLEARED before the frame callback runs, so a throwing callback
    // can neither hide it nor push it into a later frame. The callback
    // is isolated; frame settlement still precedes parked-error
    // delivery (a committed live frame is real even when a widget hook
    // failed during it). When both fail, the parked hook failure is
    // primary; a host that must not lose its own callback failure
    // isolates that callback itself (`createApp` does exactly that).
    const parked = ctx.frameError;
    ctx.frameError = null;
    /** @type {{ value: unknown } | null} */
    let callbackFailure = null;
    if (ctx.onFrame !== null) {
      try {
        ctx.onFrame(ctx.destroyed ? 'destroyed' : 'live');
      }
      catch (err) {
        callbackFailure = { value: err };
      }
    }
    if (parked !== null) throw parked.value;
    if (callbackFailure !== null) throw callbackFailure.value;
  }

  /**
   * The destroy walk shared by `destroy()` and a deferred destroy.
   * Terminal-cleanup errors carry PROVENANCE: with an `onCleanupError`
   * sink registered (the app loop registers one to assign its stable
   * cleanup code) the first error routes there — after every sibling
   * cleaned up — instead of surfacing indistinguishably from a
   * mount/update/render failure; without a sink it surfaces after the
   * teardown, as before.
   */
  function teardown() {
    ctx.mountQueue.length = 0;
    if (rootNode !== null) {
      /** @type {unknown[]} */
      const failures = [];
      if (ctx.hasWidgets) {
        destroyDomWalk(ctx, rootNode, failures);
      }
      container.textContent = '';
      rootNode = null;
      oldVnode = null;
      if (failures.length > 0) {
        // one delivery: a single failure surfaces by identity; several
        // aggregate — the first is primary (errors[0]) and every later
        // one stays observable instead of silently vanishing
        const value = failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'multiple cleanup failures in one teardown');
        if (ctx.onCleanupError !== null) ctx.onCleanupError(value);
        else if (ctx.frameError === null) ctx.frameError = { value };
      }
    }
  }

  /**
   * Terminal teardown (VIEW-FORMAT §7.3.1): every mounted widget in the
   * rendered tree unmounts exactly once (pending mounts are canceled),
   * the container is left empty, and later `render` calls are exact
   * no-ops. Idempotent. Called from inside a widget hook or a nested
   * render it is still terminal: the active pass stops and the
   * teardown runs when that pass unwinds. A throwing widget `unmount`
   * never stops the walk; the first such error is thrown after the
   * teardown completes.
   */
  render.destroy = function destroy() {
    if (ctx.destroyed) return;
    ctx.destroyed = true;
    if (rendering) {
      // called from inside the active pass: the pass sees `destroyed`,
      // stops, and finishes the teardown as it unwinds
      destroyPending = true;
      return;
    }
    teardown();
    if (ctx.frameError !== null) {
      const { value } = ctx.frameError;
      ctx.frameError = null;
      throw value;
    }
  };

  return render;
}

/**
 * Mount every queued widget, in queue (document) order. A throwing
 * `mount` poisons that widget (§7 failure policy): the host stays
 * inert, siblings still mount, the first error parks on the frame, and
 * the next render that revisits the widget replaces it with a fresh
 * lifecycle. A poisoned-at-mount widget never receives `update` or
 * `unmount` — it holds no successfully acquired resources.
 * @param {any} ctx
 */
function flushMounts(ctx) {
  const queue = ctx.mountQueue;
  while (queue.length > 0) {
    if (ctx.destroyed) { queue.length = 0; return; }
    const node = queue.shift();
    const w = node.__jarenWidget;
    if (w.mounted || w.destroyed) continue;
    w.mounted = true;
    try {
      w.handle = w.def.mount(node, w.props, ctx.emit);
    }
    catch (err) {
      w.failed = 'mount';
      ctx.poisonedCount++;
      appendFrameFailure(ctx, err);
    }
  }
}

/**
 * Create a fresh DOM node for a vnode.
 * @param {any} ctx
 * @param {any} vnode
 * @param {string | null} ns
 * @returns {any}
 */
function createNode(ctx, vnode, ns) {
  vnode = resolveForPolicy(ctx, vnode, true);
  if (isTextNode(vnode)) {
    return ctx.doc.createTextNode(String(vnode));
  }
  const tag = vnode[0];
  if (tag === WIDGET_TAG) {
    // Only reachable in trusted mode: `resolveForPolicy` already turned a
    // safe-mode widget into an empty text node above.
    return createWidgetNode(ctx, vnode, ns);
  }
  if (tag === 'svg') ns = SVG_NS;
  const node = ns !== null
    ? ctx.doc.createElementNS(ns, tag)
    : ctx.doc.createElement(tag);
  const props = propsOf(vnode);
  for (const name in props) {
    setProp(ctx, node, name, undefined, props[name], ns);
  }
  const children = childrenOf(vnode);
  for (let i = 0; i < children.length; i++) {
    node.appendChild(createNode(ctx, children[i], ns));
  }
  registerControlled(ctx, node, props);
  return node;
}

/**
 * Map a vnode the safe policy rejects — a widget (imperative JS) or an
 * element whose tag is off the allow-list or is injection-shaped — to a
 * stable empty-text sentinel. Trusted mode returns the vnode untouched.
 *
 * This runs at the top of BOTH `createNode` and `patchNode`, which is what
 * closes the update-path escape: a rejected node has the identity of an empty
 * text node on every frame, so it can never reach `patchWidgetNode` or the
 * element patch — a stripped widget cannot mount on a later frame, and a
 * blocked element cannot be patched as if its placeholder were real.
 * @param {any} ctx
 * @param {any} vnode
 * @param {boolean} report - Whether to notify `onUnsafe` (the new side of a
 *   patch reports; the old side does not, so a persistently-rejected node is
 *   not reported twice per frame)
 * @returns {any} the vnode, or `''` when the policy rejects it
 */
function resolveForPolicy(ctx, vnode, report) {
  if (ctx.policy === null || !isElementNode(vnode)) return vnode;
  const tag = vnode[0];
  if (tag === WIDGET_TAG) {
    if (report && ctx.onUnsafe !== null) {
      ctx.onUnsafe({ kind: 'widget', name: String(propsOf(vnode).name ?? '') });
    }
    return '';
  }
  if (ctx.policy.tag(tag) === null) {
    if (report && ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'tag', name: String(tag) });
    return '';
  }
  return vnode;
}

/**
 * Patch `node` (rendered from `oldV`) to match `newV`; returns the node
 * now in the DOM (a replacement when patching in place was impossible).
 * @param {any} ctx
 * @param {any} parent
 * @param {any} node
 * @param {any} oldV
 * @param {any} newV
 * @param {string | null} ns
 * @returns {any}
 */
function patchNode(ctx, parent, node, oldV, newV, ns) {
  // a destroy() requested inside a widget hook stops the active pass:
  // no later sibling may observe another update in this frame
  if (ctx.destroyed) return node;
  // Normalize BEFORE the identity diff: a safe-rejected node has the identity
  // of an empty text node on both sides, so it can never enter the widget or
  // element patch path (the update-path escape). The old side does not report
  // — its strip was reported when it was first rendered.
  if (ctx.policy !== null) {
    oldV = resolveForPolicy(ctx, oldV, false);
    newV = resolveForPolicy(ctx, newV, true);
  }
  // the === fast path is sound only while no widget is poisoned: a
  // reference-equal subtree may hide a poisoned widget awaiting its
  // replacement (§7.3), so recovery must not depend on the producer
  // allocating a fresh vnode
  if (oldV === newV && ctx.poisonedCount === 0) return node;
  if (isTextNode(oldV) && isTextNode(newV)) {
    const text = String(newV);
    if (node.nodeValue !== text) node.nodeValue = text;
    return node;
  }
  if (isSameNode(oldV, newV)) {
    if (newV[0] === WIDGET_TAG) {
      return patchWidgetNode(ctx, parent, node, oldV, newV, ns);
    }
    if (newV[0] === 'svg') ns = SVG_NS;
    // the memo marker (§5.5): a producer-owned stability assertion —
    // equal `memo` values on same-identity vnodes promise an identical
    // subtree, so the diff skips it without touching props or
    // children. `key`'s sibling: an instruction, never markup. It
    // extends the `===` fast path across allocation boundaries (a
    // rebuilt tree can still skip its unchanged regions) and shares
    // its soundness condition — suspended while any widget is
    // poisoned, so a memo-stable subtree can never hide one
    const memo = propsOf(newV).memo;
    if (memo !== undefined && Object.is(memo, propsOf(oldV).memo)
      && ctx.poisonedCount === 0) {
      return node;
    }
    patchProps(ctx, node, propsOf(oldV), propsOf(newV), ns);
    patchChildren(ctx, node, childrenOf(oldV), childrenOf(newV), ns);
    return node;
  }
  destroyNode(ctx, node);
  const next = createNode(ctx, newV, ns);
  parent.replaceChild(next, node);
  return next;
}

/**
 * Diff two props objects onto a DOM node.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} oldProps
 * @param {Record<string, any>} newProps
 * @param {string | null} ns
 */
function patchProps(ctx, node, oldProps, newProps, ns) {
  if (oldProps !== newProps) {
    for (const name in oldProps) {
      if (!(name in newProps)) {
        setProp(ctx, node, name, oldProps[name], undefined, ns);
      }
    }
    for (const name in newProps) {
      if (oldProps[name] !== newProps[name]) {
        setProp(ctx, node, name, oldProps[name], newProps[name], ns);
      }
    }
  }
  // Record (or refresh) this control's authoritative value; the actual write
  // happens in the end-of-pass reconciliation so it survives the skip paths.
  registerControlled(ctx, node, newProps);
}

/**
 * Record a form control's authoritative `value`/`checked` so the end-of-pass
 * reconciliation can reassert it against the live DOM — even for a control
 * inside a subtree a later frame skips. Trusted mode only: a safe-mode view
 * strips events and is display-oriented, so there is no controlled state to
 * fight the user over. Stores the intended value on the DOM node (never the
 * vnode — §5.1) and keeps the node in `ctx.controlled`.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} props
 */
function registerControlled(ctx, node, props) {
  if (ctx.policy !== null) return;
  const kind = node.nodeName;
  if (kind !== 'INPUT' && kind !== 'TEXTAREA' && kind !== 'SELECT') return;
  const hasValue = 'value' in props;
  const hasChecked = kind === 'INPUT' && 'checked' in props;
  if (!hasValue && !hasChecked) {
    if (node.__jarenControlled !== undefined) {
      node.__jarenControlled = undefined;
      ctx.controlled.delete(node);
    }
    return;
  }
  node.__jarenControlled = {
    hasValue,
    hasChecked,
    value: hasValue ? props.value : undefined,
    checked: hasChecked ? props.checked === true : undefined,
  };
  ctx.controlled.add(node);
}

/** Reconcile every registered controlled node against the live DOM, once per
 * settled render pass. A node no longer connected to the container is dropped
 * from the registry here, which is why registration needs no destroy hook. */
function reconcileControlledSet(ctx, container) {
  for (const node of ctx.controlled) {
    if (!isConnectedTo(node, container)) {
      node.__jarenControlled = undefined;
      ctx.controlled.delete(node);
      continue;
    }
    reconcileControlled(node);
  }
}

/**
 * Reassert one control's authoritative value/checked. React's controlled
 * contract: the passed value wins over a user edit. Writes only on a genuine
 * divergence, which preserves the caret on an unchanged control. Runs after
 * the whole tree is built, so a `select` sees its options, and a `multiple`
 * select applies an array by marking each option `selected`.
 * @param {any} node
 */
function reconcileControlled(node) {
  const c = node.__jarenControlled;
  if (c === undefined) return;
  if (c.hasChecked) {
    const want = c.checked === true;
    if (node.checked !== want) node.checked = want;
  }
  if (!c.hasValue) return;
  const isMultiple = node.multiple === true
    || (typeof node.getAttribute === 'function' && node.getAttribute('multiple') != null);
  if (node.nodeName === 'SELECT' && isMultiple && Array.isArray(c.value)) {
    const want = new Set(c.value.map((v) => String(v)));
    const options = node.options ?? node.childNodes ?? [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const ov = opt.value != null ? opt.value
        : (typeof opt.getAttribute === 'function' ? opt.getAttribute('value') : null);
      const sel = ov != null && want.has(String(ov));
      if (opt.selected !== sel) opt.selected = sel;
    }
    return;
  }
  const want = c.value == null ? '' : String(c.value);
  if (node.value !== want) node.value = want;
}

/** Whether `node` is still attached beneath `root` (the render container).
 * A detached node's ancestor chain stops before the container. */
function isConnectedTo(node, root) {
  let n = node;
  while (n != null) {
    if (n === root) return true;
    n = n.parentNode;
  }
  return false;
}

/**
 * Write one prop change to the DOM.
 * @param {any} ctx
 * @param {any} node
 * @param {string} name
 * @param {any} oldValue
 * @param {any} newValue
 * @param {string | null} ns
 */
function setProp(ctx, node, name, oldValue, newValue, ns) {
  if (name === 'on') {
    // Safe mode strips event bindings: an untrusted document must not bind
    // the host's application actions. Never wires the listener.
    if (ctx.policy !== null && ctx.policy.dropsEvents) {
      if (ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'event', name: 'on' });
      return;
    }
    setEvents(ctx, node, oldValue, newValue);
    return;
  }
  if (name in SKIP_PROPS) return;
  if (ctx.policy !== null) {
    const decided = ctx.policy.prop(name, newValue);
    // A rejected NAME (scripting sink, inline `on*`, injection-shaped) is
    // dropped; a sanitized-away URL or dangerous style keeps its (safe) name
    // and clears the value.
    if (decided === null) {
      if (ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'prop', name });
      return;
    }
    name = decided.name;
    newValue = decided.value;
    if (newValue === null && ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'prop', name });
    // SAFE MODE IS ATTRIBUTE-ONLY. Never `node[name] = …`: a live DOM property
    // write can THROW (`input.files` is read-only) and it diverges from SSR
    // for a cleared value (an empty reflected attribute vs an omitted one).
    // Writing/removing the attribute matches exactly what the serializer does.
    if (name === 'style' && typeof newValue === 'object' && newValue !== null) {
      newValue = styleToString(newValue);
    }
    if (newValue == null || newValue === false) node.removeAttribute(name);
    else node.setAttribute(name, newValue === true ? '' : String(newValue));
    return;
  }
  // Trusted path (unchanged): a property where the node has one, else an
  // attribute — the equivalent of writing the DOM by hand.
  if (name === 'style' && typeof newValue === 'object' && newValue !== null) {
    newValue = styleToString(newValue);
  }
  if (ns === null && name in node && name !== 'list' && name !== 'form') {
    node[name] = newValue == null ? '' : newValue;
  }
  else if (newValue == null || newValue === false) {
    node.removeAttribute(name);
  }
  else {
    node.setAttribute(name, newValue === true ? '' : String(newValue));
  }
}

/**
 * The shared proxy listener: reads the current binding off the node, so
 * re-renders rebind by data alone.
 * @param {any} event
 */
function eventProxy(event) {
  const node = event.currentTarget;
  const binding = node.__jarenOn?.[event.type];
  if (binding !== undefined && node.__jarenEmit !== null) {
    node.__jarenEmit(binding, event);
  }
}

/**
 * Reconcile the `on` prop: `{ [eventType]: binding }`.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any> | undefined} oldOn
 * @param {Record<string, any> | undefined} newOn
 */
function setEvents(ctx, node, oldOn, newOn) {
  const prev = node.__jarenOn ?? EMPTY_PROPS;
  const next = newOn ?? EMPTY_PROPS;
  node.__jarenOn = next;
  node.__jarenEmit = ctx.onEvent;
  for (const type in prev) {
    if (!(type in next)) node.removeEventListener(type, eventProxy);
  }
  for (const type in next) {
    if (!(type in prev)) node.addEventListener(type, eventProxy);
  }
}

/**
 * Resolve and validate a widget vnode against the registry: a non-empty
 * registered `name`, and no vnode children — the widget owns the host's
 * subtree. Violations are configuration/producer errors, the same class
 * as the root-vnode check.
 * @param {any} ctx
 * @param {any} vnode
 * @param {Record<string, any>} props
 * @returns {WidgetDef}
 */
function widgetDef(ctx, vnode, props) {
  const name = props.name;
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('view: a jaren-widget vnode must have a non-empty "name" prop');
  }
  if (!Object.hasOwn(ctx.widgets, name)) {
    throw new TypeError(`view: unregistered widget '${name}'`);
  }
  if (childrenOf(vnode).length !== 0) {
    throw new TypeError(
      `view: widget '${name}' must not have vnode children — the widget owns the host's subtree`);
  }
  return ctx.widgets[name];
}

/**
 * Create a widget host element (VIEW-FORMAT §7): apply the host props,
 * store the widget bookkeeping on the DOM node (never on the vnode) and
 * queue the node for the post-patch mount flush.
 * @param {any} ctx
 * @param {any} vnode
 * @param {string | null} ns
 * @returns {any}
 */
function createWidgetNode(ctx, vnode, ns) {
  const props = propsOf(vnode);
  const def = widgetDef(ctx, vnode, props);
  const tag = props.tag ?? 'div';
  const node = ns !== null
    ? ctx.doc.createElementNS(ns, tag)
    : ctx.doc.createElement(tag);
  for (const name in props) {
    if (name in WIDGET_SKIP_PROPS) continue;
    setProp(ctx, node, name, undefined, props[name], ns);
  }
  node.__jarenWidget = {
    name: props.name,
    def,
    props: props.props ?? null,
    handle: undefined,
    mounted: false,
    destroyed: false,
    /** `false`, or the poisoning hook: `'mount'` (skip unmount — the
     * widget acquired nothing) or `'update'` (unmount still runs). A
     * poisoned widget is replaced on the next render that revisits it. */
    failed: /** @type {false | 'mount' | 'update'} */ (false),
  };
  ctx.hasWidgets = true;
  ctx.mountQueue.push(node);
  return node;
}

/**
 * Patch two widget vnodes under the same key: a `name` or host-`tag`
 * change replaces the widget (destroy old, create new, mount queued);
 * otherwise the host props diff normally, `childNodes` are never
 * touched, and a changed `props` *reference* reaches the widget through
 * `update` (or the unmount + fresh-mount fallback). Reference-equal
 * `props` never poke the widget — the JSLT memo option turns unchanged
 * state into exactly that.
 * @param {any} ctx
 * @param {any} parent
 * @param {any} node
 * @param {any} oldV
 * @param {any} newV
 * @param {string | null} ns
 * @returns {any}
 */
function patchWidgetNode(ctx, parent, node, oldV, newV, ns) {
  const oldProps = propsOf(oldV);
  const newProps = propsOf(newV);
  const w = node.__jarenWidget;
  if (newProps.name !== oldProps.name || (newProps.tag ?? 'div') !== (oldProps.tag ?? 'div')
    || w.failed !== false) {
    // a poisoned widget (a hook threw) is replaced, not patched: the
    // old lifecycle ends (unmount only if mount succeeded) and a fresh
    // one begins — half-mounted handles never receive updates
    destroyNode(ctx, node);
    const next = createWidgetNode(ctx, newV, ns);
    parent.replaceChild(next, node);
    return next;
  }
  widgetDef(ctx, newV, newProps);
  patchWidgetProps(ctx, node, oldProps, newProps, ns);
  const props = newProps.props ?? null;
  const prevProps = oldProps.props ?? null;
  if (props !== prevProps) {
    w.props = props;
    if (w.mounted) {
      // capability ACQUISITION is host-observable (an accessor or
      // proxy trap can throw): the `update` read shares the poison
      // boundary with its invocation — a lookup failure poisons the
      // widget exactly like an invocation failure, the frame settles,
      // and the next render replaces it
      let update;
      let acquired = true;
      try {
        update = w.def.update;
      }
      catch (err) {
        acquired = false;
        w.failed = 'update';
        ctx.poisonedCount++;
        appendFrameFailure(ctx, err);
      }
      if (acquired && update !== undefined) {
        try {
          update.call(w.def, w.handle, props, prevProps);
        }
        catch (err) {
          w.failed = 'update';
          ctx.poisonedCount++;
          appendFrameFailure(ctx, err);
        }
      }
      else if (acquired) {
        // no update hook: recycle the host with a fresh lifecycle.
        // The catch is PHASE-SENSITIVE: a failure before the old
        // instance's `unmount` had its exactly-once chance (a hostile
        // `unmount` lookup) leaves the OLD acquisition owned — poison
        // as 'update' so replacement and terminal destroy still
        // release it; only after the teardown attempt does a failure
        // take mount-failure semantics (nothing left to release).
        let unmountAttempted = false;
        try {
          const unmount = w.def.unmount;
          if (unmount !== undefined) {
            unmountAttempted = true;
            unmount.call(w.def, w.handle);
          }
          else {
            unmountAttempted = true; // nothing to run: teardown is complete
          }
          // the unmount may have requested terminal destroy: the old
          // acquisition has ENDED (record it, or deferred teardown
          // would unmount it a second time) and no fresh acquisition
          // may begin — a mount after a terminal request would run
          // brand-new host side effects on a destroyed renderer
          if (ctx.destroyed) {
            w.mounted = false;
            w.handle = undefined;
            w.destroyed = true;
            return node;
          }
          w.handle = w.def.mount(node, props, ctx.emit);
        }
        catch (err) {
          w.failed = unmountAttempted ? 'mount' : 'update';
          ctx.poisonedCount++;
          appendFrameFailure(ctx, err);
        }
      }
    }
    // not yet mounted (still queued): the pending mount reads w.props
  }
  return node;
}

/**
 * Diff a widget host's props: `patchProps` minus the widget-local
 * members (`name`/`props`/`tag`), which configure the widget, not the
 * DOM.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} oldProps
 * @param {Record<string, any>} newProps
 * @param {string | null} ns
 */
function patchWidgetProps(ctx, node, oldProps, newProps, ns) {
  if (oldProps === newProps) return;
  for (const name in oldProps) {
    if (name in WIDGET_SKIP_PROPS) continue;
    if (!(name in newProps)) {
      setProp(ctx, node, name, oldProps[name], undefined, ns);
    }
  }
  for (const name in newProps) {
    if (name in WIDGET_SKIP_PROPS) continue;
    if (oldProps[name] !== newProps[name]) {
      setProp(ctx, node, name, oldProps[name], newProps[name], ns);
    }
  }
}

/**
 * Notify every widget in a discarded subtree that it is leaving the
 * tree. A no-op until a widget has actually been created, so widget-free
 * documents keep O(1) removal. A throwing `unmount` must not stop the
 * walk or the patch — one broken widget must not leak its siblings — so
 * the first captured error parks on `ctx` and `render` rethrows it after
 * the frame settles.
 *
 * The walk is OWNERSHIP-based: it follows the live DOM and this
 * renderer's own widget-host marker, never a vnode. A vnode is a
 * *description* — old, new, or (after a mid-pass `destroy()`) only
 * partially committed — and pairing it with the DOM is exactly how a
 * teardown skips a mounted widget or indexes a missing node. What the
 * renderer actually acquired is recorded on the DOM nodes it owns, so
 * that is what teardown drains.
 * @param {any} ctx
 * @param {any} node - The root DOM node of the discarded subtree.
 */
function destroyNode(ctx, node) {
  if (!ctx.hasWidgets) return;
  /** @type {unknown[]} */
  const failures = [];
  destroyDomWalk(ctx, node, failures);
  for (let i = 0; i < failures.length; i++) appendFrameFailure(ctx, failures[i]);
}

/**
 * Park one more failure on the frame. EVERY failure of a frame stays
 * observable regardless of how many internal walks or hooks produced
 * them: the first surfaces by identity; from the second on, the frame
 * delivers one framework-owned AggregateError over the originals in
 * occurrence order (only the framework's OWN envelope is ever
 * extended — a host-thrown value, an AggregateError included, is
 * stored untouched as one element; nothing is inspected).
 * @param {any} ctx
 * @param {unknown} value
 */
function appendFrameFailure(ctx, value) {
  if (ctx.frameError === null) {
    ctx.frameError = { value, envelope: false };
    return;
  }
  const prior = ctx.frameError;
  const items = prior.envelope
    ? [.../** @type {AggregateError} */ (prior.value).errors, value]
    : [prior.value, value];
  ctx.frameError = {
    value: new AggregateError(items, 'multiple failures in one frame'),
    envelope: true,
  };
}

/**
 * The recursive half of `destroyNode`: unmount marked widget hosts,
 * recurse through ordinary DOM children, never descend into a widget's
 * host subtree (the widget's own DOM may contain anything — including a
 * nested renderer whose widgets it, not this renderer, owns). A
 * destroyed poisoned widget leaves the live-poison count — replacement
 * and subtree removal are the two ways a poisoned widget recovers,
 * after which the `===` fast path is sound again.
 * @param {any} ctx
 * @param {any} node
 * @param {unknown[]} failures - Collects EVERY cleanup failure, in
 *   document order — an array, never a thrown-value sentinel, so a
 *   hook that legally throws `null` still counts and a second failure
 *   is never hidden behind the first.
 */
function destroyDomWalk(ctx, node, failures) {
  const w = node.__jarenWidget;
  if (w !== undefined) {
    if (!w.destroyed) {
      w.destroyed = true;
      if (w.failed !== false) ctx.poisonedCount--;
      if (w.mounted && w.failed !== 'mount') {
        // the `unmount` READ shares the collection boundary with its
        // call: a hostile accessor is a cleanup failure like any
        // other — every sibling still unmounts, the container still
        // empties
        try {
          const unmount = w.def.unmount;
          if (unmount !== undefined) unmount.call(w.def, w.handle);
        }
        catch (err) {
          failures.push(err);
        }
      }
    }
    return; // the widget owns everything below its host
  }
  const children = node.childNodes;
  if (children !== undefined) {
    // snapshot before invoking hooks: `childNodes` is live, and an
    // `unmount` that detaches its own host would shift the indices and
    // silently skip a sibling's cleanup
    const snapshot = [];
    for (let i = 0; i < children.length; i++) snapshot.push(children[i]);
    for (let i = 0; i < snapshot.length; i++) {
      destroyDomWalk(ctx, snapshot[i], failures);
    }
  }
}

/**
 * Serialize a style object to a CSS declaration string. CamelCase keys
 * become kebab-case; `--custom-properties` pass through.
 * @param {Record<string, any>} style
 * @returns {string}
 */
export function styleToString(style) {
  let out = '';
  for (const name in style) {
    const value = style[name];
    if (value == null || value === false) continue;
    const cssName = name.startsWith('--') ? name : kebabCase(name);
    out += (out === '' ? '' : ';') + cssName + ':' + String(value);
  }
  return out;
}

/**
 * Reconcile an element's children with a head/tail sweep plus a key map
 * for the middle. `oldCh[i]` corresponds to the i-th DOM child at entry;
 * the parallel `oldDom` snapshot keeps that correspondence stable across
 * moves (arrays are positional only at snapshot time — afterwards they
 * are identity maps, index → node).
 * @param {any} ctx
 * @param {any} parent
 * @param {any[]} oldCh
 * @param {any[]} newCh
 * @param {string | null} ns
 */
function patchChildren(ctx, parent, oldCh, newCh, ns) {
  const oldDom = [];
  {
    const live = parent.childNodes;
    for (let i = 0; i < oldCh.length; i++) oldDom.push(live[i]);
  }
  let oldStart = 0;
  let oldEnd = oldCh.length - 1;
  let newStart = 0;
  let newEnd = newCh.length - 1;
  /** @type {Map<any, number> | null} */
  let keyMap = null;
  /** The DOM node currently sitting just after the unprocessed tail. */
  let tailRef = null;

  while (oldStart <= oldEnd && newStart <= newEnd) {
    if (ctx.destroyed) return; // a mid-pass destroy stops the traversal
    const oS = oldCh[oldStart];
    if (oS === undefined) { oldStart++; continue; } // consumed by a keyed move
    const oE = oldCh[oldEnd];
    if (oE === undefined) { oldEnd--; continue; }
    const nS = newCh[newStart];
    const nE = newCh[newEnd];

    if (isSameNode(oS, nS)) {
      patchNode(ctx, parent, oldDom[oldStart], oS, nS, ns);
      oldStart++; newStart++;
    }
    else if (isSameNode(oE, nE)) {
      patchNode(ctx, parent, oldDom[oldEnd], oE, nE, ns);
      tailRef = oldDom[oldEnd];
      oldEnd--; newEnd--;
    }
    else if (isSameNode(oS, nE)) {
      // old head moved to the tail
      const node = patchNode(ctx, parent, oldDom[oldStart], oS, nE, ns);
      parent.insertBefore(node, tailRef);
      tailRef = node;
      oldStart++; newEnd--;
    }
    else if (isSameNode(oE, nS)) {
      // old tail moved to the head
      const node = patchNode(ctx, parent, oldDom[oldEnd], oE, nS, ns);
      parent.insertBefore(node, oldDom[oldStart]);
      oldEnd--; newStart++;
    }
    else {
      if (keyMap === null) keyMap = buildKeyMap(oldCh, oldStart, oldEnd);
      const key = keyOf(nS);
      const idx = key !== undefined ? keyMap.get(key) : undefined;
      if (idx === undefined || oldCh[idx] === undefined || !isSameNode(oldCh[idx], nS)) {
        parent.insertBefore(createNode(ctx, nS, ns), oldDom[oldStart]);
      }
      else {
        const node = patchNode(ctx, parent, oldDom[idx], oldCh[idx], nS, ns);
        parent.insertBefore(node, oldDom[oldStart]);
        oldCh[idx] = undefined;
      }
      newStart++;
    }
  }

  if (oldStart > oldEnd) {
    // old range exhausted: mount the remaining new children before the tail
    for (let i = newStart; i <= newEnd; i++) {
      if (ctx.destroyed) return;
      parent.insertBefore(createNode(ctx, newCh[i], ns), tailRef);
    }
  }
  else {
    // new range exhausted: unmount the remaining old children
    for (let i = oldStart; i <= oldEnd; i++) {
      if (ctx.destroyed) return;
      if (oldCh[i] !== undefined) {
        destroyNode(ctx, oldDom[i]);
        parent.removeChild(oldDom[i]);
      }
    }
  }
}

/**
 * Key → index map over the unprocessed old range.
 * @param {any[]} oldCh
 * @param {number} start
 * @param {number} end
 * @returns {Map<any, number>}
 */
function buildKeyMap(oldCh, start, end) {
  const map = new Map();
  for (let i = start; i <= end; i++) {
    const key = keyOf(oldCh[i]);
    if (key !== undefined && !map.has(key)) map.set(key, i);
  }
  return map;
}
