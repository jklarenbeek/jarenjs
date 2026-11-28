//@ts-check
/**
 * @file The DOM renderer — a keyed vnode-JSON patcher.
 *
 * This module owns vnode reconciliation with the DOM. It follows the
 * repository philosophy at the render level: decide once,
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
 * (under {@link WIDGET}), never on the vnode — §5.1 forbids annotating vnodes
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
  isSkippedNode,
  isElementName,
  elementNameError, foreignBelow,
  EMPTY_PROPS,
  WIDGET_TAG,
} from './vnode.js';
import { ENUMERATED_ALIASES, attributePresent, attributeText, enumeratedAttribute, isAliased, isInlineHandler, removeProperty, writeProperty, writingSpelling } from './properties.js';
import { NAMED_TAGS, createSafePolicy, grantedWidgets, idPrefixOf, projectEvent } from './safe.js';
import {
  DIRECT_MEMBERS, activeElementOf, appendChild, attributeNamesOf, attributeOf, childNodesOf, createShadowed,
  documentReaderOf, domReaderOf, elementById, elementsMatching, insertChild, listen, localNameOf, namespaceOf,
  nodeTypeOf, parentOf, removeAttribute, removeAttributeNS, removeChild, replaceChild, setAttribute, setAttributeNS,
  unlisten,
} from './members.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The renderer's bookkeeping on a DOM node lives under these module-private
// symbols: a `form` answers a string key through a control of that name or
// id, and a write to it throws (VIEW-FORMAT §5.6), so a document could take
// any string key over; it can name no symbol.
/** An element's `on` bindings: `{ [eventType]: binding }`. */
const ON = Symbol('jaren.on');
/** What an element's fired binding is delivered to (`ctx.eventSink`). */
const EMIT = Symbol('jaren.emit');
/** A widget host's lifecycle record ({@link createWidgetNode}). */
const WIDGET = Symbol('jaren.widget');
/** A controlled control's authoritative value and checkedness. */
const CONTROLLED = Symbol('jaren.controlled');
/** A controlled control's composition and focus listeners. */
const COMPOSITION = Symbol('jaren.composition');
/** True while a composition is in progress on the control. */
const COMPOSING = Symbol('jaren.composing');
/** True while the control's authoritative write is held back. */
const DEFERRED = Symbol('jaren.deferred');
/** Whether a focused text control's write waits for its blur. */
const DEFER_FOCUSED = Symbol('jaren.deferFocused');
/** True once the field was a password field (the event projection). */
const SECRET = Symbol('jaren.secret');

/** Props that are renderer instructions, never written to the DOM. A Set,
 * so a prop named like an `Object.prototype` member (`constructor`,
 * `toString`) is an ordinary prop. */
const SKIP_PROPS = new Set(['key', 'on', 'memo']);

/**
 * Widget-vnode props that configure the widget instead of the host
 * element. Every other prop (`key`/`on` included) flows through
 * `setProp` exactly as on any element vnode.
 */
const WIDGET_SKIP_PROPS = new Set(['name', 'props', 'tag']);

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
 * @property {(host: any, props: any, emit: WidgetEmit, context: WidgetContext) => any} mount -
 *   Called with the host element after it is connected to the rendered
 *   tree; returns an opaque handle threaded to `update`/`unmount`. The
 *   fourth argument is the renderer's {@link WidgetContext}.
 * @property {(handle: any, props: any, prevProps: any) => void} [update]
 *   Called when the vnode's `props` reference changed. Absent: the
 *   renderer falls back to `unmount` + fresh `mount` into the same host.
 * @property {(handle: any) => void} [unmount] - Called exactly once when
 *   the widget leaves the tree; timers, listeners and observers die here.
 * @property {(props: any) => any} [ssr] - A vnode for `renderToString`.
 */

/**
 * What a widget's `mount` receives as its fourth argument: the renderer's
 * own registry and document, frozen, one object per renderer. A widget
 * that renders vnodes of its own (a dialog's content) renders them with
 * the registry it was mounted from.
 * Under the interactive profile it also carries the profile itself —
 * `safe: 'interactive'`, the granted `capabilities`, the `idPrefix` and the
 * `onUnsafe` sink — and `widgets` holds only the granted widgets, so a widget that
 * renders vnode content of its own (a dialog) hands these members to its
 * renderer and the content renders under the same profile and grants.
 * @typedef {Readonly<{ widgets: Record<string, WidgetDef>, document: any, controlled?: 'focus',
 *   safe?: 'interactive', capabilities?: Readonly<{ widgets: readonly string[] }>, idPrefix?: string,
 *   onUnsafe?: (info: { kind: 'tag' | 'prop' | 'event' | 'widget' | 'id' | 'name', name: string }) => void }>} WidgetContext
 */

/**
 * @typedef {Object} DomRendererOptions
 * @property {EventBindingHandler} [onEvent] - Receives every fired `on`
 *   binding; without it, `on` props are stored but never fired.
 * @property {Record<string, WidgetDef>} [widgets] - Registered widget
 *   definitions by name (VIEW-FORMAT §7).
 * @property {any} [document] - The document to create nodes with
 *   (defaults to `container.ownerDocument`).
 * @property {boolean} [hydrate=false] - Adopt matching server DOM on the
 *   first render. Mismatches are replaced locally. Safe mode rebuilds
 *   existing markup because the renderer cannot trust its provenance.
 * @property {'focus'} [controlled] - `'focus'`: while a controlled text
 *   control is the document's active element, an authoritative `value`
 *   write is deferred and reconciled when the control loses focus — the
 *   operator's typing survives a background refresh until blur
 *   (VIEW-FORMAT §3). Absent, the controlled value always wins.
 * @property {boolean | 'interactive'} [safe=false] - Render under the SAFE
 *   policy ({@link createSafePolicy}): treat the vnode as untrusted. Tags are
 *   restricted to an inert HTML/SVG allow-list, scripting-sink and inline
 *   `on*` properties are dropped, injection-shaped names are rejected, URL
 *   attributes are sanitized, and `on` event bindings are stripped. The
 *   default is trusted rendering — the equivalent of writing the DOM by
 *   hand — so a source-authored view is unaffected. Client and server share
 *   the one policy, so they neutralize an attack identically.
 *   `'interactive'` is the same sanitizer keeping two things: `on` bindings
 *   that are JSON data on a gesture event (`onEvent` then receives a frozen
 *   data projection of the event, never the native event), and the widgets
 *   `capabilities.widgets` grants. Any other truthy value is `true`.
 * @property {{ widgets?: string[] }} [capabilities] - Under
 *   `safe: 'interactive'`, the registered widget names the document may
 *   render; absent, none. A name that is not registered in `widgets` is a
 *   `TypeError`. Read by no other profile.
 * @property {string} [idPrefix] - Under either safe profile, the
 *   render's id namespace ({@link createSafePolicy}): every id the document
 *   declares and every id reference it makes is prefixed with it, so the
 *   document's references resolve among its own elements and never reach or
 *   shadow the host's. Absent: the first of `jaren-u-`, `jaren-u2-`, … no
 *   other live safe root of the document holds, until `destroy()` (the
 *   serializer writes `jaren-u-`; VIEW-FORMAT §8 rule 7). Never read in trusted mode.
 * @property {(info: { kind: 'tag' | 'prop' | 'event' | 'widget' | 'id' | 'name', name: string }) => void}
 *   [onUnsafe] - In safe mode, called for everything stripped: a disallowed `tag`, a rejected or
 *   sanitized-away `prop`, a stripped `on` binding (`event`; under the interactive profile named by
 *   its event type, `on` when the member is not an object, `emit` for a widget's) or a `widget`; and,
 *   nothing stripped, once per prefixed `id`, and per prefixed name of `document` (a `form`'s or an
 *   `img`'s `name`, an `img` id beside a name), that the page holds outside the root.
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
  if (options.controlled !== undefined && options.controlled !== 'focus') {
    throw new TypeError(`view: the controlled option is 'focus' or absent, got ${JSON.stringify(options.controlled) ?? String(options.controlled)}`);
  }
  const interactive = options.safe === 'interactive';
  const granted = interactive ? grantedWidgets(options.capabilities, options.widgets) : null;
  const doc = options.document ?? container.ownerDocument;
  // a safe render's ids live in a namespace no other live safe root of the
  // same document holds unless the host gave both the same prefix
  const ids = options.safe
    ? claimIdPrefix(doc, container, options.idPrefix === undefined ? undefined : idPrefixOf(options.idPrefix))
    : null;
  const docMembers = documentReaderOf(doc);
  const ctx = {
    doc,
    /** How the renderer reaches an element's DOM members, which a `form`'s
     * controls shadow by their names and ids (members.js). */
    dom: domReaderOf(doc, container),
    /** How the renderer reaches its document's members, which the names of
     * the document's `img`, `form`, ... elements shadow (members.js). */
    docMembers,
    /** The `Document` interface's `createElement`, `createElementNS` and
     * `createTextNode`, resolved once (null for a document double), which a
     * creator falls back to where a named element of the document holds its
     * name ({@link createShadowed} in members.js). */
    makeElement: docMembers.createElement,
    makeElementNS: docMembers.createElementNS,
    makeText: docMembers.createTextNode,
    /** The creators each node a frame builds is made by, one call each,
     * resolved once per renderer: the document's own, with that fallback
     * where the document has the interface. */
    text: docMembers.createTextNode === null ? (/** @type {string} */ t) => doc.createTextNode(t)
      : (/** @type {string} */ t) => createTextOf(ctx, t),
    element: docMembers.createElement === null ? (/** @type {string} */ t) => doc.createElement(t)
      : (/** @type {string} */ t) => createElementOf(ctx, null, t),
    elementNS: docMembers.createElementNS === null
      ? (/** @type {string} */ n, /** @type {string} */ t) => doc.createElementNS(n, t)
      : (/** @type {string} */ n, /** @type {string} */ t) => createElementOf(ctx, n, t),
    onEvent: options.onEvent ?? null,
    /** Under the interactive profile, only the granted widgets. */
    widgets: granted === null ? options.widgets ?? EMPTY_PROPS
      : Object.freeze(Object.fromEntries(granted.map((name) => [name, options.widgets?.[name]]))),
    /** The safe render policy, or null for trusted (default) rendering.
     * Consulted for every tag and prop; the same object the SSR serializer
     * uses, so client and server strip an attack identically. */
    policy: ids === null ? null
      : createSafePolicy({ interactive, widgets: granted ?? [], idPrefix: ids.prefix }),
    /** What a fired `on` binding is delivered to: `onEvent` itself, or under
     * the interactive profile `onEvent` handed the event's data projection. */
    eventSink: /** @type {EventBindingHandler | null} */ (null),
    /** Reports everything safe mode strips — a tag, a property, an `on`
     * binding or a widget — so a host can observe a hostile document rather
     * than have it silently vanish. The policy stays a pure decision; the
     * renderer reports at the point it acts. */
    onUnsafe: typeof options.onUnsafe === 'function' ? options.onUnsafe : null,
    /** The render's container and its id claim, which a prefixed id the
     * page already holds is looked for outside of. */
    container,
    ids,
    /** The prefixed ids reported as held outside the root, each once.
     * @type {Set<string>} */
    heldIds: new Set(),
    /** The prefixed names of `document` (a `form`'s, an `img`'s, ... `name`,
     * an `object`'s id) reported as held outside the root, each once; the
     * names this pass wrote, and the `img` and `object` elements whose id it
     * wrote or exposed, looked up as it ends.
     * @type {Set<string>} */
    heldNames: new Set(),
    /** @type {Set<string>} */
    writtenNames: new Set(),
    /** @type {Set<any>} */
    writtenOwners: new Set(),
    /** Controlled form-control nodes (`value`/`checked`), reconciled against
     * the live DOM at the END of every render pass — so an authoritative
     * value is reasserted even when the `===`/`memo` fast paths skip the
     * subtree the control lives in. Under a safe profile only the
     * interactive profile's controls join it (the policy's `control`).
     * @type {Set<any>} */
    controlled: new Set(),
    /** `controlled: 'focus'`: a focused text control's value write waits
     * for its blur, through the same deferral composition uses. */
    deferFocused: options.controlled === 'focus',
    /** The document the pass in progress renders: where a refused tag is
     * located, by identity, when one is met. */
    root: /** @type {any} */ (null),
    /** The fourth `mount` argument, one frozen object per renderer.
     * @type {WidgetContext | null} */
    widgetContext: null,
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
  ctx.eventSink = interactive ? interactiveSink(ctx) : ctx.onEvent;
  ctx.emit = interactive ? interactiveEmit(ctx) : function emit(binding, nativeEvent) {
    if (ctx.onEvent !== null) ctx.onEvent(binding, nativeEvent);
  };
  // a widget that renders a vnode tree of its own (a dialog's content)
  // renders it under the same controlled mode as this renderer's, and under
  // the interactive profile with the same grants
  ctx.widgetContext = Object.freeze({
    widgets: ctx.widgets, document: ctx.doc,
    ...(ctx.deferFocused ? { controlled: /** @type {'focus'} */ ('focus') } : {}),
    ...(granted === null ? {} : {
      safe: /** @type {'interactive'} */ ('interactive'),
      capabilities: Object.freeze({ widgets: Object.freeze([...granted]) }),
      idPrefix: /** @type {{ prefix: string }} */ (ids).prefix,
      ...(ctx.onUnsafe === null ? {} : { onUnsafe: ctx.onUnsafe }),
    }),
  });
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
  /** Hydration adopts the server's markup once, on the first pass: a tree
   * rebuilt after a failed pass is created. */
  let adopt = Boolean(options.hydrate);

  function render(vnode) {
    if (ctx.destroyed) return; // a scheduled flush after destroy is a no-op
    if (!isTextNode(vnode) && !Array.isArray(vnode) && !isSkippedNode(vnode)) {
      throw new TypeError('view: the root must be a vnode or a list of vnodes');
    }
    if (isSkippedNode(vnode)) vnode = [];
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
        ctx.root = next;
        if (rootNode === null) {
          const hydrating = adopt && ctx.policy === null;
          adopt = false;
          if (hydrating) {
            adoptChildren(ctx, container, childrenOf(['root', {}, next]), null);
          }
          else {
            container.textContent = '';
            for (const child of childrenOf(['root', {}, next])) appendChild(ctx.dom, container, createNode(ctx, child, null, false));
          }
          rootNode = container;
        }
        else {
          patchChildren(ctx, container, childrenOf(['root', {}, oldVnode]), childrenOf(['root', {}, next]), null, false, ctx.dom);
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
      if (!ctx.destroyed && (ctx.writtenNames.size > 0 || ctx.writtenOwners.size > 0)) reportHeldNames(ctx);
    }
    catch (error) {
      // A pass that threw part-way (a refused tag, an unregistered widget)
      // left writes no baseline records: the next frame would diff against
      // the frame before it and keep them. The tree is torn down — every
      // mounted widget unmounts, the container empties — so the next frame
      // builds from its own vnode.
      // The failed pass delivers every failure of its own, in occurrence
      // order: a hook failure parked before the throw, the throw, and an
      // unmount failure of the teardown with no cleanup sink to take it.
      // Left parked, they would surface after the next, healthy frame.
      const parked = ctx.frameError;
      ctx.frameError = null;
      ctx.writtenNames.clear();
      ctx.writtenOwners.clear();
      teardown();
      container.textContent = '';
      destroyPending = false;
      const cleanup = ctx.frameError;
      ctx.frameError = parked;
      appendFrameFailure(ctx, error);
      if (cleanup !== null) appendFrameFailure(ctx, cleanup.value);
      const delivered = /** @type {{ value: unknown }} */ (ctx.frameError);
      ctx.frameError = null;
      throw delivered.value;
    }
    finally {
      rendering = false;
      pendingVnode = undefined;
      ctx.root = null;
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
    // Release the controlled-node registry: a destroyed renderer must not
    // retain detached form controls (nor their stored values) past teardown.
    for (const node of ctx.controlled) releaseControlled(ctx, node);
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
    if (ids !== null) releaseIdPrefix(container, ids);
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

  if (ids !== null) RENDER_PREFIXES.set(render, ids.prefix);
  return render;
}

/**
 * The id namespaces the live safe renderers of each document hold: per
 * document, the claim each container's latest safe renderer made. A render
 * that names no `idPrefix` takes the first namespace no other container of
 * its document holds: `jaren-u-`, then `jaren-u2-`, `jaren-u3-`, … — no two
 * of them a prefix of another, so no id of one namespace can spell an id of
 * another. A host-supplied prefix is taken as given and occupies its
 * namespace too. A claim is released by `destroy()`, and lapses once its
 * container is out of the page (`isConnected` false) when another root
 * claims; a new safe renderer on the same container replaces its claim (it
 * replaces the content), keeping the default namespace that container held.
 * @type {WeakMap<object, Map<any, { prefix: string, given: boolean }>>}
 */
const ID_CLAIMS = new WeakMap();

/** The namespace each renderer's content lives in, for the helpers that
 * write ids of their own beside it (a dialog's).
 * @type {WeakMap<Function, string>} */
const RENDER_PREFIXES = new WeakMap();

/**
 * @typedef {{ prefix: string, claims: Map<any, { prefix: string, given: boolean }> | null,
 *   claim: { prefix: string, given: boolean } }} IdClaim
 */

/**
 * Claim the id namespace a safe renderer's content lives in.
 * @param {any} doc - The document the renderer creates nodes with.
 * @param {any} container
 * @param {string | undefined} given - The host's prefix, already checked.
 * @returns {IdClaim}
 */
function claimIdPrefix(doc, container, given) {
  const base = idPrefixOf(undefined);
  if (doc === null || typeof doc !== 'object') {
    const prefix = given ?? base;
    return { prefix, claims: null, claim: { prefix, given: given !== undefined } };
  }
  let claims = ID_CLAIMS.get(doc);
  if (claims === undefined) ID_CLAIMS.set(doc, claims = new Map());
  // a root the host took out of the page without `destroy()` holds no id
  // of the page: its claim lapses, so a dropped root is not retained and the
  // namespaces of the roots that follow do not drift
  for (const other of claims.keys()) if (other !== container && other.isConnected === false) claims.delete(other);
  const prior = claims.get(container);
  let prefix = given;
  if (prefix === undefined && prior !== undefined && !prior.given) prefix = prior.prefix;
  if (prefix === undefined) {
    const held = new Set();
    for (const [other, claim] of claims) if (other !== container) held.add(claim.prefix);
    prefix = base;
    for (let n = 2; held.has(prefix); n++) prefix = `${base.slice(0, -1)}${n}-`;
  }
  const claim = { prefix, given: given !== undefined };
  claims.set(container, claim);
  return { prefix, claims, claim };
}

/**
 * Release a claim on `destroy()`, unless a later renderer on the same
 * container has replaced it.
 * @param {any} container
 * @param {IdClaim} ids
 */
function releaseIdPrefix(container, ids) {
  if (ids.claims !== null && ids.claims.get(container) === ids.claim) ids.claims.delete(container);
}

/**
 * The id namespace a renderer's content lives in: its claimed prefix under a
 * safe profile, `''` for a trusted renderer.
 * @param {Function} render - A renderer {@link createDomRenderer} returned.
 * @returns {string}
 */
export function idPrefixOfRenderer(render) {
  return RENDER_PREFIXES.get(render) ?? '';
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
    const w = node[WIDGET];
    if (w.mounted || w.destroyed) continue;
    w.mounted = true;
    try {
      w.handle = w.def.mount(node, w.props, ctx.emit, ctx.widgetContext);
    }
    catch (err) {
      w.failed = 'mount';
      ctx.poisonedCount++;
      appendFrameFailure(ctx, err);
    }
  }
}

/**
 * The namespace the children of an element `tag` built in `ns` are built
 * in: the element's own, and HTML again under an SVG `foreignObject`,
 * `desc` or `title`, where an HTML parser reads the serializer's markup as
 * HTML (VIEW-FORMAT §5.4).
 * @param {string} tag
 * @param {string | null} ns
 * @returns {string | null}
 */
function childNamespace(tag, ns) {
  return ns !== null && (tag === 'foreignObject' || tag === 'desc' || tag === 'title') ? null : ns;
}

/**
 * A new element `tag` of the renderer's document, in namespace `ns` or HTML
 * ({@link createShadowed} in members.js where a named element holds the
 * creator's name).
 * @param {any} ctx
 * @param {string | null} ns
 * @param {string} tag
 * @returns {any}
 */
function createElementOf(ctx, ns, tag) {
  try { return ns !== null ? ctx.doc.createElementNS(ns, tag) : ctx.doc.createElement(tag); }
  catch (error) {
    return ns !== null ? createShadowed(ctx.doc, error, 'createElementNS', ctx.makeElementNS, ns, tag)
      : createShadowed(ctx.doc, error, 'createElement', ctx.makeElement, tag, undefined);
  }
}

/**
 * A new text node of the renderer's document ({@link createShadowed} in
 * members.js where a named element holds the creator's name).
 * @param {any} ctx
 * @param {string} text
 * @returns {any}
 */
function createTextOf(ctx, text) {
  try { return ctx.doc.createTextNode(text); }
  catch (error) { return createShadowed(ctx.doc, error, 'createTextNode', ctx.makeText, text, undefined); }
}

/**
 * Create a fresh DOM node for a vnode.
 * @param {any} ctx
 * @param {any} vnode
 * @param {string | null} ns
 * @param {boolean} foreign - where an HTML parser reads the serializer's
 *   markup for this node as foreign content ({@link foreignBelow}): the
 *   safe policy drops there what that markup cannot keep inside the `svg`
 * @returns {any}
 */
function createNode(ctx, vnode, ns, foreign) {
  vnode = resolveForPolicy(ctx, vnode, true, foreign);
  if (isTextNode(vnode)) {
    return ctx.text(String(vnode));
  }
  // Fail closed: a value that is neither text nor a valid element vnode (a
  // stray object, say `{foo:'bar'}`, that slipped in as a child) renders as
  // nothing — matching the serializer, and never reaching `createElement`
  // with an undefined tag, which would build an `<undefined>` element without
  // consulting the safe allow-list. Lists and skipped values were already
  // resolved by `childrenOf`, so only a malformed node reaches here.
  if (!isElementNode(vnode)) return createTextOf(ctx, '');
  const tag = vnode[0];
  if (tag === WIDGET_TAG) {
    // Only reachable in trusted mode and for a widget the interactive
    // profile granted: `resolveForPolicy` already turned every other
    // safe-mode widget into an empty text node above.
    return createWidgetNode(ctx, vnode, ns);
  }
  // Trusted mode only, too: the safe policy dropped a tag outside the
  // grammar above. A mistyped tag is a producer error, refused loudly
  // rather than built (`['Total:', 3]`) or left to the platform's own
  // exception (`[' ', …]`).
  if (!isElementName(tag)) throw elementNameError(ctx.root, vnode, tag);
  if (tag === 'svg') ns = SVG_NS;
  const node = ns !== null ? ctx.elementNS(ns, tag) : ctx.element(tag);
  const dom = ns === null && tag.length === 4 ? membersOf(ctx, tag, ns) : DIRECT_MEMBERS;
  if (ctx.policy !== null) writeFixed(ctx, node, tag, dom);
  const props = propsOf(vnode);
  for (const name in props) {
    setProp(ctx, node, name, undefined, props[name], ns, dom);
  }
  const children = childrenOf(vnode);
  // only a policy reads the parser's state, so a trusted root never computes it
  const below = ctx.policy !== null && foreignBelow(tag, foreign);
  for (let i = 0; i < children.length; i++) {
    const child = createNode(ctx, children[i], childNamespace(tag, ns), below);
    if (dom === DIRECT_MEMBERS) node.appendChild(child);
    else appendChild(dom, node, child);
  }
  registerControlled(ctx, node, props);
  return node;
}

/** Adopt matching nodes positionally once; subsequent keyed reconciliation
 * has the same vnode baseline as a fresh mount. Browser parser repairs and
 * missing/extra nodes are local mismatches, never a second tree of state. */
function adoptChildren(ctx, parent, children, ns) {
  const dom = ctx.dom;
  const live = childNodesOf(dom, parent);
  for (let i = 0; i < children.length; i++) {
    const vnode = children[i];
    const node = live[i];
    if (node && isTextNode(vnode) && nodeTypeOf(dom, node) === 3) {
      if (node.nodeValue !== String(vnode)) node.nodeValue = String(vnode);
      continue;
    }
    const tag = isElementNode(vnode) ? vnode[0] : null;
    if (tag !== null && tag !== WIDGET_TAG && !isElementName(tag)) throw elementNameError(ctx.root, vnode, tag);
    const namespace = tag === 'svg' ? SVG_NS : ns;
    if (node && tag && tag !== WIDGET_TAG && nodeTypeOf(dom, node) === 1 && localNameOf(dom, node) === tag
      && (namespace === null ? isHtmlNamespace(namespaceOf(dom, node)) : namespaceOf(dom, node) === namespace)) {
      const props = propsOf(vnode);
      // the attributes the vnode writes: an inline handler value writes none,
      // so the one server markup carried from before that rule is removed
      const names = new Set(Object.keys(props).filter((name) => !isInlineHandler(name, props[name]))
        .map((name) => name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name.toLowerCase()));
      for (const name of attributeNamesOf(dom, node)) {
        if (!names.has(name.toLowerCase())) removeAttribute(dom, node, name);
      }
      const members = membersOf(ctx, tag, namespace);
      for (const name in props) setProp(ctx, node, name, undefined, props[name], namespace, members);
      // A textarea's server text is its default value, not a vnode child
      // when `value` supplies the authoritative content.
      if (!(tag === 'textarea' && Object.hasOwn(props, 'value')))
        adoptChildren(ctx, node, childrenOf(vnode), childNamespace(tag, namespace));
      registerControlled(ctx, node, props);
    }
    else {
      // hydration adopts in trusted mode only, where nothing reads `foreign`
      const fresh = createNode(ctx, vnode, ns, false);
      if (node) replaceChild(dom, parent, fresh, node);
      else appendChild(dom, parent, fresh);
    }
  }
  while (live.length > children.length) removeChild(dom, parent, live[live.length - 1]);
}

/**
 * Map a vnode the safe policy rejects — a widget (imperative JS) the
 * interactive profile did not grant, or an element whose tag is off the
 * allow-list or is injection-shaped — to a stable empty-text sentinel.
 * Trusted mode returns the vnode untouched.
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
 * @param {boolean} foreign - the node sits where a parser reads foreign
 *   content (the policy's `tag`)
 * @returns {any} the vnode, or `''` when the policy rejects it
 */
function resolveForPolicy(ctx, vnode, report, foreign) {
  if (ctx.policy === null || !isElementNode(vnode)) return vnode;
  const tag = vnode[0];
  if (tag === WIDGET_TAG) {
    const props = propsOf(vnode);
    // the interactive profile renders a granted widget fed data, with no
    // children, in a host element the tag allow-list admits; safe: true
    // renders none
    if (ctx.policy.widget(props.name, props.props) && childrenOf(vnode).length === 0) {
      const host = props.tag ?? 'div';
      if (ctx.policy.tag(host, foreign) !== null) return vnode;
      if (report && ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'tag', name: String(host) });
      return '';
    }
    if (report && ctx.onUnsafe !== null) {
      ctx.onUnsafe({ kind: 'widget', name: String(props.name ?? '') });
    }
    return '';
  }
  if (ctx.policy.tag(tag, foreign) === null) {
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
 * @param {boolean} foreign - as {@link createNode} takes it
 * @returns {any}
 */
function patchNode(ctx, parent, node, oldV, newV, ns, foreign) {
  // a destroy() requested inside a widget hook stops the active pass:
  // no later sibling may observe another update in this frame
  if (ctx.destroyed) return node;
  // Normalize BEFORE the identity diff: a safe-rejected node has the identity
  // of an empty text node on both sides, so it can never enter the widget or
  // element patch path (the update-path escape). The old side does not report
  // — its strip was reported when it was first rendered.
  if (ctx.policy !== null) {
    oldV = resolveForPolicy(ctx, oldV, false, foreign);
    newV = resolveForPolicy(ctx, newV, true, foreign);
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
    // only a four-letter HTML tag can be a form: the rest skip the call
    const dom = ns === null && newV[0].length === 4 ? membersOf(ctx, newV[0], ns) : DIRECT_MEMBERS;
    patchProps(ctx, node, propsOf(oldV), propsOf(newV), ns, dom);
    patchChildren(ctx, node, childrenOf(oldV), childrenOf(newV), childNamespace(newV[0], ns),
      ctx.policy !== null && foreignBelow(newV[0], foreign), dom);
    return node;
  }
  destroyNode(ctx, node);
  const next = createNode(ctx, newV, ns, foreign);
  replaceChild(ctx.dom, parent, next, node);
  return next;
}

/**
 * Diff two props objects onto a DOM node.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} oldProps
 * @param {Record<string, any>} newProps
 * @param {string | null} ns
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function patchProps(ctx, node, oldProps, newProps, ns, dom) {
  if (oldProps !== newProps) {
    let aliased = false;
    for (const name in oldProps) {
      if (!Object.hasOwn(newProps, name)) {
        if (isAliased(name)) aliased = true;
        else setProp(ctx, node, name, oldProps[name], undefined, ns, dom);
      }
    }
    for (const name in newProps) {
      if (isAliased(name)) aliased = true;
      else if (oldProps[name] !== newProps[name]) setProp(ctx, node, name, oldProps[name], newProps[name], ns, dom);
    }
    if (aliased) patchAliased(ctx, node, oldProps, newProps, ns, dom);
  }
  // Record (or refresh) this control's authoritative value; the actual write
  // happens in the end-of-pass reconciliation so it survives the skip paths.
  registerControlled(ctx, node, newProps);
}

/**
 * An attribute two props can spell, diffed by the value it ends up with —
 * the later spelling's, as `serializeProps` writes it — so one spelling
 * leaving, or the two swapping order, writes what remains.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} oldProps
 * @param {Record<string, any>} newProps
 * @param {string | null} ns
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function patchAliased(ctx, node, oldProps, newProps, ns, dom) {
  for (const [a, b] of ENUMERATED_ALIASES) {
    const was = writingSpelling(oldProps, a, b);
    const now = writingSpelling(newProps, a, b);
    if (now === undefined) {
      if (was !== undefined) setProp(ctx, node, was, oldProps[was], undefined, ns, dom);
    }
    else if (was === undefined || was !== now || oldProps[was] !== newProps[now]) {
      setProp(ctx, node, now, was === undefined ? undefined : oldProps[was], newProps[now], ns, dom);
    }
  }
}

/**
 * Record a form control's authoritative `value`/`checked` so the end-of-pass
 * reconciliation can reassert it against the live DOM — even for a control
 * inside a subtree a later frame skips. Under a safe profile the policy
 * decides (`control`): the interactive profile's `input` is reasserted to
 * what its attributes say, its `textarea` and `select` to the text and the
 * selection the serializer writes, and every `safe: true` control stays
 * attribute-only.
 * Stores the intended value on the DOM node (never the vnode — §5.1) and
 * keeps the node in `ctx.controlled`.
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any>} props
 */
function registerControlled(ctx, node, props) {
  const kind = node.nodeName;
  if (kind !== 'INPUT' && kind !== 'TEXTAREA' && kind !== 'SELECT') return;
  const decided = ctx.policy === null ? null : ctx.policy.control(node.localName ?? kind.toLowerCase(), props);
  const hasValue = ctx.policy === null ? 'value' in props : decided !== null && decided.hasValue;
  const hasChecked = ctx.policy === null ? kind === 'INPUT' && 'checked' in props : decided !== null && decided.hasChecked;
  if (!hasValue && !hasChecked) {
    if (node[CONTROLLED] !== undefined) {
      releaseControlled(ctx, node);
    }
    return;
  }
  if (node[COMPOSITION] === undefined && kind !== 'SELECT') {
    // One deferral for two causes: a composition in progress, and — with
    // `controlled: 'focus'` — a control the operator is typing into. A
    // write either one holds back marks the node, and settles one task
    // after the composition ends or the focus leaves.
    let settlement;
    let ending = false;
    const settle = () => {
      clearTimeout(settlement);
      // Engines can checkpoint microtasks between compositionend and the
      // final input, and a focus loss dispatches change before focusout.
      // Keep writes deferred through either sequence, or the stale value
      // clears Firefox's dirty flag and loses change-on-blur, and a render
      // the change event scheduled lands after the stale write.
      settlement = setTimeout(() => {
        if (ending) { ending = false; node[COMPOSING] = false; }
        if (node[DEFERRED] && !ctx.destroyed && ctx.controlled.has(node) && node.parentNode !== null)
          reconcileControlled(ctx, node);
      }, 0);
    };
    const start = () => {
      clearTimeout(settlement);
      ending = false;
      node[COMPOSING] = true;
    };
    const end = () => { ending = true; settle(); };
    const blur = ctx.deferFocused ? settle : null;
    node[COMPOSITION] = { start, end, blur, cancel: () => clearTimeout(settlement) };
    node[DEFER_FOCUSED] = ctx.deferFocused;
    node.addEventListener('compositionstart', start, true);
    node.addEventListener('compositionend', end, true);
    if (blur !== null) node.addEventListener('focusout', blur, true);
  }
  // An `input` reads its props as the attributes the serializer writes
  // (`checked: 0` is present, `value: true` the empty value), so the live
  // control shows what server markup shows; a `textarea`'s and a `select`'s
  // value is the text and the selection the serializer writes.
  node[CONTROLLED] = decided !== null ? { ...decided, safe: true } : {
    hasValue,
    hasChecked,
    value: hasValue ? (kind === 'INPUT' ? attributeText(props.value) : props.value) : undefined,
    checked: hasChecked ? attributePresent(props.checked) : undefined,
    safe: false,
  };
  ctx.controlled.add(node);
}

/** Release listeners as well as registry ownership, including detached nodes. */
function releaseControlled(ctx, node) {
  const listeners = node[COMPOSITION];
  if (listeners !== undefined) {
    listeners.cancel();
    node.removeEventListener('compositionstart', listeners.start, true);
    node.removeEventListener('compositionend', listeners.end, true);
    if (listeners.blur !== null) node.removeEventListener('focusout', listeners.blur, true);
  }
  node[COMPOSITION] = undefined;
  node[COMPOSING] = false;
  node[DEFERRED] = false;
  node[DEFER_FOCUSED] = false;
  node[CONTROLLED] = undefined;
  ctx.controlled.delete(node);
}

/** Reconcile every registered controlled node against the live DOM, once per
 * settled render pass. A node no longer connected to the container is dropped
 * from the registry here, which is why registration needs no destroy hook. */
function reconcileControlledSet(ctx, container) {
  for (const node of ctx.controlled) {
    if (!isConnectedTo(ctx, node, container)) {
      releaseControlled(ctx, node);
      continue;
    }
    reconcileControlled(ctx, node);
  }
}

/** The input types an operator types into (VIEW-FORMAT §3); a missing or
 * unknown type is `text`, as the platform reads it. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/**
 * Whether a control is a text control: a `textarea`, or an `input` of a
 * type the operator types into. Read at reconcile time — a `type` can
 * change.
 * @param {any} node
 * @returns {boolean}
 */
function isTextControl(node) {
  if (node.nodeName === 'TEXTAREA') return true;
  if (node.nodeName !== 'INPUT') return false;
  const type = inputType(node);
  return type === '' || TEXT_INPUT_TYPES.has(type);
}

/**
 * An `input`'s type, lowercased, as the live node reports it (`''` when it
 * has none).
 * @param {any} node
 * @returns {string}
 */
function inputType(node) {
  const type = typeof node.type === 'string' ? node.type
    : (typeof node.getAttribute === 'function' ? node.getAttribute('type') : null) ?? '';
  return type.toLowerCase();
}

/**
 * Reassert one control's authoritative value/checked. React's controlled
 * contract: the passed value wins over a user edit — after a composition,
 * and with `controlled: 'focus'` after the operator's focus leaves. Writes
 * only on a genuine divergence, which preserves the caret on an unchanged
 * control. Runs after the whole tree is built, so a `select` sees its
 * options, and a `multiple` select applies an array by marking each option
 * `selected`.
 * @param {any} ctx
 * @param {any} node
 */
function reconcileControlled(ctx, node) {
  const c = node[CONTROLLED];
  if (c === undefined) return;
  if (c.hasChecked) {
    const want = c.checked === true;
    if (node.checked !== want) node.checked = want;
  }
  if (!c.hasValue) return;
  // A file input's value is the user's file choice: a script may only clear
  // it, and assigning anything else throws. An untrusted document's value
  // stays its attribute, so it can neither abort the render nor touch the
  // choice (read at reconcile time — a `type` can change).
  if (c.safe && node.nodeName === 'INPUT' && inputType(node) === 'file') return;
  // a composition in progress, or (opted in) the operator's focused edit
  // of a text control, holds the authoritative write back until it
  // settles (§3); a focused range, colour or date takes its value at once
  if (node[COMPOSING]
    || (node[DEFER_FOCUSED] === true && isTextControl(node) && activeElementOf(ctx.docMembers, node.ownerDocument) === node)) {
    node[DEFERRED] = true;
    return;
  }
  node[DEFERRED] = false;
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
  if (node.value !== want) {
    // Preserve a live edit's caret. A newly created or unfocused control
    // keeps the browser's normal assignment behavior (caret at the end).
    const focused = activeElementOf(ctx.docMembers, node.ownerDocument) === node;
    const start = focused ? node.selectionStart : null;
    const end = focused ? node.selectionEnd : null;
    const direction = node.selectionDirection;
    node.value = want;
    if (typeof start === 'number' && typeof end === 'number' && typeof node.setSelectionRange === 'function')
      node.setSelectionRange(Math.min(start, want.length), Math.min(end, want.length), direction ?? 'none');
  }
}

/** Whether `node` is still attached beneath `root` (the render container).
 * A detached node's ancestor chain stops before the container. The chain is
 * read through {@link parentOf}: a `form` holding `<input name="parentNode">`
 * answers that input as its `parentNode`, and the walk would never end. */
function isConnectedTo(ctx, node, root) {
  let n = node;
  while (n != null) {
    if (n === root) return true;
    n = parentOf(ctx.dom, n);
  }
  return false;
}

/**
 * Report a prefixed id the page already holds outside the root, once per id:
 * a host element whose id starts with the namespace (`jaren-u-name` beside a
 * document declaring `name`) or another root given the same prefix. The
 * document's references to it resolve to whichever element the page holds
 * first. Nothing is refused or changed: the id is written as VIEW-FORMAT §8
 * rule 7 says. Looked up before the write, so the element being written never
 * hides a holder later in the page; an element of the root itself is no
 * holder, nor one of a root around it in the same namespace (the content a
 * granted widget renders there, a dialog's, is the document's own), and a
 * document without `getElementById` is not looked in.
 * @param {any} ctx
 * @param {string} id
 */
function reportHeldId(ctx, id) {
  if (ctx.heldIds.has(id)) return;
  const held = elementById(ctx.docMembers, ctx.doc, id);
  if (held == null || !isHeldOutside(ctx, held)) return;
  ctx.heldIds.add(id);
  ctx.onUnsafe({ kind: 'id', name: id });
}

/**
 * Whether `held` is an element of the page outside the root: neither the
 * root's own nor one of a root around it in the same namespace.
 * @param {any} ctx
 * @param {any} held
 * @returns {boolean}
 */
function isHeldOutside(ctx, held) {
  if (isConnectedTo(ctx, held, ctx.container)) return false;
  const { claims, prefix } = /** @type {IdClaim} */ (ctx.ids);
  if (claims !== null) for (const [other, claim] of claims) {
    if (other !== ctx.container && claim.prefix === prefix && isConnectedTo(ctx, ctx.container, other) && isConnectedTo(ctx, held, other)) return false;
  }
  return true;
}

/**
 * Whether an element of namespace `namespace` is an HTML element: in the
 * HTML namespace, or in none (a document that keeps no namespaces).
 * @param {string | null | undefined} namespace
 * @returns {boolean}
 */
function isHtmlNamespace(namespace) {
  return namespace == null || namespace === 'http://www.w3.org/1999/xhtml';
}

/**
 * The id an element gives `document` as a named property: an `object`'s
 * non-empty id, and an `img`'s when it has a non-empty `name` too. Any other
 * element's id is no property of `document`.
 * @param {any} ctx
 * @param {any} node
 * @param {string | null} name - The element's `name`.
 * @returns {string | null}
 */
function documentIdOf(ctx, node, name) {
  const tag = localNameOf(ctx.dom, node);
  if (tag !== 'object' && (tag !== 'img' || !name)) return null;
  return attributeOf(ctx.dom, node, 'id') || null;
}

/**
 * Report a prefixed name of `document` the pass wrote that an HTML element
 * outside the root already holds, once per name, as {@link reportHeldId}
 * reports an id: the page's `document[name]` then answers a collection
 * holding both. A name of `document` is the `name` of a `form`, `img`,
 * `embed`, `object` or `iframe`, and the id {@link documentIdOf} reads, so a
 * written name is looked for among the page's names and those ids, and a
 * written `img` id among the page's names (an id the page holds as an id is
 * the id report's). Looked up once as the pass ends, in one scan of the page,
 * so a pass writing many names walks the page once; an element the host adds
 * later is not seen, and a document without `querySelectorAll` is not looked
 * in.
 * @param {any} ctx
 */
function reportHeldNames(ctx) {
  const names = ctx.writtenNames;
  const owners = ctx.writtenOwners;
  ctx.writtenNames = new Set();
  ctx.writtenOwners = new Set();
  /** @type {Set<string>} */
  const ids = new Set();
  for (const owner of owners) {
    const id = documentIdOf(ctx, owner, attributeOf(ctx.dom, owner, 'name'));
    if (id !== null && !ctx.heldNames.has(id)) ids.add(id);
  }
  if (names.size === 0 && ids.size === 0) return;
  for (const held of elementsMatching(ctx.docMembers, ctx.doc, 'form[name], img[name], embed[name], object[name], iframe[name], object[id]')) {
    const name = attributeOf(ctx.dom, held, 'name');
    const id = documentIdOf(ctx, held, name);
    const byName = name !== null && (names.has(name) || ids.has(name)) && !ctx.heldNames.has(name) ? name : null;
    const byId = id !== null && id !== name && names.has(id) && !ctx.heldNames.has(id) ? id : null;
    if ((byName === null && byId === null) || !isHtmlNamespace(namespaceOf(ctx.dom, held))
      || !isHeldOutside(ctx, held)) continue;
    for (const key of [byName, byId]) {
      if (key === null) continue;
      ctx.heldNames.add(key);
      ctx.onUnsafe({ kind: 'name', name: key });
    }
  }
}

/**
 * Write one prop change to the DOM.
 * @param {any} ctx
 * @param {any} node
 * @param {string} name
 * @param {any} oldValue
 * @param {any} newValue
 * @param {string | null} ns
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function setProp(ctx, node, name, oldValue, newValue, ns, dom) {
  if (name === 'on') {
    // Safe mode strips event bindings: an untrusted document must not bind
    // the host's application actions. Never wires the listener.
    if (ctx.policy !== null && ctx.policy.dropsEvents) {
      if (ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'event', name: 'on' });
      return;
    }
    // The interactive profile wires only the data bindings on allowed events
    // — a fresh object of them, never the document's own `on`.
    if (ctx.policy !== null) {
      const decided = ctx.policy.events(newValue);
      if (ctx.onUnsafe !== null) for (const dropped of decided.dropped) ctx.onUnsafe({ kind: 'event', name: dropped });
      setEvents(ctx, node, decided.kept ?? undefined, dom);
      return;
    }
    setEvents(ctx, node, newValue, dom);
    return;
  }
  if (SKIP_PROPS.has(name)) return;
  if (ctx.policy !== null) {
    // read through the DOM's own accessor: a form holding a control named
    // `localName` would otherwise reach the policy as some other tag
    const tag = localNameOf(dom, node);
    const decided = ctx.policy.prop(name, newValue, tag);
    // A rejected NAME (scripting sink, inline `on*`, injection-shaped) is
    // dropped; a sanitized-away URL or dangerous style keeps its (safe) name
    // and clears the value.
    // A prop with no value (the author's `null`, or one this frame drops)
    // was not stripped by anything, so it is not reported.
    if (decided === null) {
      if (ctx.onUnsafe !== null && newValue != null) ctx.onUnsafe({ kind: 'prop', name });
      return;
    }
    name = decided.name;
    const given = newValue;
    newValue = decided.value;
    // a field that was ever a password field stays one to the event
    // projection: a later frame switching its type to text must not let a
    // binding read what the browser filled in
    if (typeof newValue === 'string' && name.toLowerCase() === 'type' && newValue.trim().toLowerCase() === 'password') node[SECRET] = true;
    if (newValue === null && given != null && ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'prop', name });
    // The interactive profile controls a textarea's and a select's value
    // (the policy's `control`): a parser ignores their `value` attribute, so
    // none is written, and the serializer writes the text and the selection
    // the reconciliation reasserts. A widget's host keeps the attribute.
    if (name === 'value' && (tag === 'textarea' || tag === 'select') && node[WIDGET] === undefined
      && ctx.policy.control(tag, { value: given }) !== null) return;
    // SAFE MODE IS ATTRIBUTE-ONLY. Never `node[name] = …`: a live DOM property
    // write can THROW (`input.files` is read-only) and it diverges from SSR
    // for a cleared value (an empty reflected attribute vs an omitted one).
    // Writing/removing the attribute matches exactly what the serializer does.
    // (The interactive profile's controlled `input` keeps this attribute and
    // has its live value/checked reasserted to it at the end of the pass.)
    if (ctx.onUnsafe !== null && typeof newValue === 'string') {
      const lower = name.toLowerCase();
      if (lower === 'id') {
        reportHeldId(ctx, newValue);
        if (tag === 'img' || tag === 'object') ctx.writtenOwners.add(node);
      }
      else if (lower === 'name' && NAMED_TAGS.has(tag)) {
        if (newValue !== '' && !ctx.heldNames.has(newValue)) ctx.writtenNames.add(newValue);
        // a name on an `img` makes its id a name of `document` too
        if (tag === 'img') ctx.writtenOwners.add(node);
      }
    }
    if (name === 'style' && typeof newValue === 'object' && newValue !== null) {
      // an object with no declaration is no attribute, as the serializer omits it
      newValue = styleToString(newValue) || null;
    }
    if (writeEnumerated(dom, node, name, newValue)) return;
    if (newValue == null || newValue === false) removeAttribute(dom, node, name);
    else setAttribute(dom, node, name, newValue === true ? '' : String(newValue));
    return;
  }
  // A handler prop that is not a function is written by no renderer (the
  // property table), so it is as good as absent: what the frame before
  // assigned (a function) is cleared, and nothing else was written.
  if (isInlineHandler(name, newValue)) {
    if (isInlineHandler(name, oldValue)) return;
    newValue = null;
  }
  // Trusted path: a property where the node has one, else an attribute —
  // the equivalent of writing the DOM by hand — with the property table's
  // exceptions (VIEW-FORMAT §3): enumerated attributes, removal, and a
  // value the property would convert into markup the serializer never
  // writes.
  // Controlled values settle after children and never interrupt composition.
  // A widget's host is the widget's: its `value`/`checked` is the attribute
  // the serializer writes, and the widget owns the live value.
  if ((name === 'value' || name === 'checked')
    && (node.nodeName === 'INPUT' || node.nodeName === 'TEXTAREA' || node.nodeName === 'SELECT')) {
    if (node[WIDGET] === undefined) return;
    if (newValue == null || newValue === false) removeAttribute(dom, node, name);
    else setAttribute(dom, node, name, newValue === true ? '' : String(newValue));
    return;
  }
  const attrNs = name.startsWith('xlink:') ? 'http://www.w3.org/1999/xlink'
    : name.startsWith('xml:') ? 'http://www.w3.org/XML/1998/namespace' : null;
  if (attrNs !== null && (dom.setAttributeNS !== null || typeof node.setAttributeNS === 'function')) {
    if (newValue == null || newValue === false) removeAttributeNS(dom, node, attrNs, name.slice(name.indexOf(':') + 1));
    else setAttributeNS(dom, node, attrNs, name, String(newValue));
    return;
  }
  if (writeEnumerated(dom, node, name, newValue)) return;
  if (name === 'style' && typeof newValue === 'object' && newValue !== null) {
    newValue = styleToString(newValue);
    // an object with no declaration is no attribute, as the serializer omits it
    if (newValue === '') {
      removeAttribute(dom, node, 'style');
      return;
    }
  }
  // A name every object inherits (`constructor`, `toString`) is never a DOM
  // property to write: the write would shadow the method, where the markup
  // writes an attribute.
  // A form answers a control's name or id as a property of its own that no
  // write can change: an attribute of that name is no property of the form.
  if (ns === null && name in node && name !== 'list' && name !== 'form' && !(name in Object.prototype)
    && !isFormControlName(dom, node, name)) {
    if (newValue == null || newValue === false) removeProperty(dom, node, name, oldValue);
    else writeProperty(dom, node, name, newValue);
  }
  else if (newValue == null || newValue === false) {
    removeAttribute(dom, node, name);
  }
  else {
    setAttribute(dom, node, name, newValue === true ? '' : String(newValue));
  }
}

/**
 * Whether `node`, a `form` ({@link membersOf}), answers `name` through a
 * control of that name or id (a read-only property of its own) and has no
 * property of that name besides: a write to it can never change the form
 * (it throws), so `name` is the form's attribute. A name the form has as a property of its own (`action`,
 * `title`) is still written through the property, which a control shadows
 * only on reads.
 * @param {import('./members.js').DomReader} dom
 * @param {any} node
 * @param {string} name
 * @returns {boolean}
 */
function isFormControlName(dom, node, name) {
  return dom !== DIRECT_MEMBERS && !(name in Object.getPrototypeOf(node))
    && Object.getOwnPropertyDescriptor(node, name)?.writable === false;
}

/**
 * How the renderer reaches the members of an element of `tag` in the
 * namespace `ns`: an HTML `form` (in any case: the document lowercases it)
 * through the DOM's own accessors (`ctx.dom`), which its controls cannot
 * shadow; any other element, which answers no member through named
 * properties, by asking it, which costs nothing on the patch path.
 * @param {any} ctx
 * @param {string} tag
 * @param {string | null} ns
 * @returns {import('./members.js').DomReader}
 */
function membersOf(ctx, tag, ns) {
  return ns === null && (tag === 'form' || (tag.length === 4 && tag.toLowerCase() === 'form')) ? ctx.dom : DIRECT_MEMBERS;
}

/**
 * Write the attributes the safe policy gives every element of `tag`
 * whatever the document says (a `form`'s `method="dialog"`), before its
 * props, as the serializer writes them first.
 * @param {any} ctx
 * @param {any} node
 * @param {string} tag
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function writeFixed(ctx, node, tag, dom) {
  const fixed = ctx.policy.fixed(tag);
  if (fixed !== null) for (const [name, value] of fixed) setAttribute(dom, node, name, value);
}

/**
 * An enumerated attribute (the property table) is an attribute in every
 * mode, written with its keyword: never through the boolean property that
 * reads `'false'` as true. Answers whether `name` was one.
 * @param {import('./members.js').DomReader} dom
 * @param {any} node
 * @param {string} name
 * @param {any} value
 * @returns {boolean}
 */
function writeEnumerated(dom, node, name, value) {
  const attribute = enumeratedAttribute(name, value);
  if (attribute === undefined) return false;
  if (attribute.value === null) removeAttribute(dom, node, attribute.name);
  else setAttribute(dom, node, attribute.name, attribute.value);
  return true;
}

/**
 * The shared proxy listener: reads the current binding off the node, so
 * re-renders rebind by data alone.
 * @param {any} event
 */
function eventProxy(event) {
  const node = event.currentTarget;
  const binding = node[ON]?.[event.type];
  if (binding !== undefined && node[EMIT] !== null) {
    node[EMIT](binding, event);
  }
}

/**
 * The interactive profile's event delivery: `onEvent` receives the event's
 * data projection, never the native event. An event that rose from inside a
 * widget's subtree (the host's DOM, not the document's) is projected with
 * what was typed withheld.
 * @param {any} ctx
 * @returns {EventBindingHandler | null}
 */
function interactiveSink(ctx) {
  const onEvent = ctx.onEvent;
  if (onEvent === null) return null;
  return (binding, event) => {
    // a submission reaches the app through its binding alone: the form's
    // own default never runs (its `method="dialog"` would send nothing, but
    // inside a dialog it would close it behind the app's back)
    if (event?.type === 'submit' && typeof event.preventDefault === 'function') event.preventDefault();
    onEvent(binding, projectEvent(event, event?.target?.[SECRET] === true
      || risesFromWidget(ctx.dom, event?.target, event?.currentTarget)));
  };
}

/**
 * Whether an event's target lies inside a widget host, at or below the node
 * whose binding fired: the path from the target up to that node crosses a
 * node this renderer made a widget host. The path is read through the DOM's
 * own `parentNode`: a form holding `<input name="parentNode">` answers that
 * input as its parent, and the walk would never end.
 * @param {import('./members.js').DomReader} dom
 * @param {any} target
 * @param {any} bound
 * @returns {boolean}
 */
function risesFromWidget(dom, target, bound) {
  for (let node = target; node != null; node = parentOf(dom, node)) {
    if (node[WIDGET] !== undefined) return true;
    if (node === bound) return false;
  }
  return false;
}

/**
 * The interactive profile's widget `emit`: the binding a widget emits is
 * held to the same data rule as an `on` binding (a widget's bindings come
 * from the document's props), and the event it hands on is projected.
 * @param {any} ctx
 * @returns {WidgetEmit}
 */
function interactiveEmit(ctx) {
  return function emit(binding, nativeEvent) {
    if (!ctx.policy.binding(binding)) {
      if (ctx.onUnsafe !== null) ctx.onUnsafe({ kind: 'event', name: 'emit' });
      return;
    }
    if (ctx.onEvent !== null) ctx.onEvent(binding, projectEvent(nativeEvent, false));
  };
}

/**
 * Reconcile the `on` prop: `{ [eventType]: binding }`, against the
 * bindings the node holds (the node, not the old vnode, is what carries
 * the listeners).
 * @param {any} ctx
 * @param {any} node
 * @param {Record<string, any> | undefined} newOn
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function setEvents(ctx, node, newOn, dom) {
  const prev = node[ON] ?? EMPTY_PROPS;
  const next = newOn ?? EMPTY_PROPS;
  node[ON] = next;
  node[EMIT] = ctx.eventSink;
  for (const type in prev) {
    if (!(type in next)) unlisten(dom, node, type, eventProxy);
  }
  for (const type in next) {
    if (!(type in prev)) listen(dom, node, type, eventProxy);
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
  if (!isElementName(tag)) throw elementNameError(ctx.root, vnode, tag);
  // a host is built in the namespace an element of its tag is (`createNode`)
  if (tag === 'svg') ns = SVG_NS;
  const node = createElementOf(ctx, ns, tag);
  const dom = membersOf(ctx, tag, ns);
  if (ctx.policy !== null) writeFixed(ctx, node, tag, dom);
  // the bookkeeping first: it is what marks the node a host to `setProp`
  node[WIDGET] = {
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
  for (const name in props) {
    if (WIDGET_SKIP_PROPS.has(name)) continue;
    setProp(ctx, node, name, undefined, props[name], ns, dom);
  }
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
  const w = node[WIDGET];
  if (newProps.name !== oldProps.name || (newProps.tag ?? 'div') !== (oldProps.tag ?? 'div')
    || w.failed !== false) {
    // a poisoned widget (a hook threw) is replaced, not patched: the
    // old lifecycle ends (unmount only if mount succeeded) and a fresh
    // one begins — half-mounted handles never receive updates
    destroyNode(ctx, node);
    const next = createWidgetNode(ctx, newV, ns);
    replaceChild(ctx.dom, parent, next, node);
    return next;
  }
  widgetDef(ctx, newV, newProps);
  const hostNs = (newProps.tag ?? 'div') === 'svg' ? SVG_NS : ns;
  patchWidgetProps(ctx, node, oldProps, newProps, hostNs, membersOf(ctx, newProps.tag ?? 'div', hostNs));
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
          w.handle = w.def.mount(node, props, ctx.emit, ctx.widgetContext);
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
 * @param {import('./members.js').DomReader} dom - how `node`'s members are reached ({@link membersOf})
 */
function patchWidgetProps(ctx, node, oldProps, newProps, ns, dom) {
  if (oldProps === newProps) return;
  for (const name in oldProps) {
    if (WIDGET_SKIP_PROPS.has(name)) continue;
    if (!Object.hasOwn(newProps, name)) {
      setProp(ctx, node, name, oldProps[name], undefined, ns, dom);
    }
  }
  for (const name in newProps) {
    if (WIDGET_SKIP_PROPS.has(name)) continue;
    if (oldProps[name] !== newProps[name]) {
      setProp(ctx, node, name, oldProps[name], newProps[name], ns, dom);
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
  const w = node[WIDGET];
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
  const children = childNodesOf(ctx.dom, node);
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
 * @param {boolean} foreign - as {@link createNode} takes it, for the children
 * @param {import('./members.js').DomReader} dom - how `parent`'s members are reached ({@link membersOf})
 */
function patchChildren(ctx, parent, oldCh, newCh, ns, foreign, dom) {
  const oldDom = [];
  {
    // the read every patched parent makes, asked directly where it can be
    const live = dom.childNodes === null ? parent.childNodes : childNodesOf(dom, parent);
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
      patchNode(ctx, parent, oldDom[oldStart], oS, nS, ns, foreign);
      oldStart++; newStart++;
    }
    else if (isSameNode(oE, nE)) {
      // A widget may replace its host while keeping its vnode key/tag.
      // Future insertions must anchor to the live replacement.
      tailRef = patchNode(ctx, parent, oldDom[oldEnd], oE, nE, ns, foreign);
      oldEnd--; newEnd--;
    }
    else if (isSameNode(oS, nE)) {
      // old head moved to the tail
      const node = patchNode(ctx, parent, oldDom[oldStart], oS, nE, ns, foreign);
      insertChild(dom, parent, node, tailRef);
      tailRef = node;
      oldStart++; newEnd--;
    }
    else if (isSameNode(oE, nS)) {
      // old tail moved to the head
      const node = patchNode(ctx, parent, oldDom[oldEnd], oE, nS, ns, foreign);
      insertChild(dom, parent, node, oldDom[oldStart]);
      oldEnd--; newStart++;
    }
    else {
      if (keyMap === null) keyMap = buildKeyMap(oldCh, oldStart, oldEnd);
      const key = keyOf(nS);
      const idx = key !== undefined ? keyMap.get(key) : undefined;
      if (idx === undefined || oldCh[idx] === undefined || !isSameNode(oldCh[idx], nS)) {
        insertChild(dom, parent, createNode(ctx, nS, ns, foreign), oldDom[oldStart]);
      }
      else {
        const node = patchNode(ctx, parent, oldDom[idx], oldCh[idx], nS, ns, foreign);
        insertChild(dom, parent, node, oldDom[oldStart]);
        oldCh[idx] = undefined;
      }
      newStart++;
    }
  }

  if (oldStart > oldEnd) {
    // old range exhausted: mount the remaining new children before the tail
    for (let i = newStart; i <= newEnd; i++) {
      if (ctx.destroyed) return;
      insertChild(dom, parent, createNode(ctx, newCh[i], ns, foreign), tailRef);
    }
  }
  else {
    // new range exhausted: unmount the remaining old children
    for (let i = oldStart; i <= oldEnd; i++) {
      if (ctx.destroyed) return;
      if (oldCh[i] !== undefined) {
        destroyNode(ctx, oldDom[i]);
        removeChild(dom, parent, oldDom[i]);
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
