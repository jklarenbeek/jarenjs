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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Props that are renderer instructions, never written to the DOM. */
const SKIP_PROPS = { key: true, on: true };

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
 */

/**
 * Create a renderer bound to a container element. The returned function
 * patches the container's single root node to match the given vnode.
 *
 * @example
 * const render = createDomRenderer(document.getElementById('app'), {
 *   onEvent: (binding, event) => dispatch(binding, event),
 * });
 * render(['main', {}, ['h1', {}, 'Hello']]);
 *
 * @param {any} container - The DOM element to render into (emptied on
 *   first render).
 * @param {DomRendererOptions} [options]
 * @returns {(vnode: any) => void}
 */
export function createDomRenderer(container, options = {}) {
  const ctx = {
    doc: options.document ?? container.ownerDocument,
    onEvent: options.onEvent ?? null,
    widgets: options.widgets ?? EMPTY_PROPS,
    /** Widget host nodes created this patch, awaiting `mount` (§7). */
    mountQueue: [],
    /** True once any widget node exists — gates the destroy walk. */
    hasWidgets: false,
    /** First error a widget `unmount` threw this render (§7): the walk
     * and the patch always finish; the error surfaces after them. */
    destroyError: /** @type {Error | null} */ (null),
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

  return function render(vnode) {
    if (!isTextNode(vnode) && !isElementNode(vnode)) {
      throw new TypeError('view: the root vnode must be a text or element vnode');
    }
    if (rootNode === null) {
      container.textContent = '';
      rootNode = createNode(ctx, vnode, null);
      container.appendChild(rootNode);
    }
    else {
      rootNode = patchNode(ctx, container, rootNode, oldVnode, vnode, null);
    }
    oldVnode = vnode;
    // mount flush: after the patch completes every queued host is
    // connected. Mount may dispatch synchronously through `emit`; the
    // shift-drain stays correct under the re-entrant render that a
    // synchronous scheduler turns that into.
    flushMounts(ctx);
    if (ctx.destroyError !== null) {
      const err = ctx.destroyError;
      ctx.destroyError = null;
      throw err;
    }
  };
}

/**
 * Mount every queued widget, in queue (document) order.
 * @param {any} ctx
 */
function flushMounts(ctx) {
  const queue = ctx.mountQueue;
  while (queue.length > 0) {
    const node = queue.shift();
    const w = node.__jarenWidget;
    if (w.mounted || w.destroyed) continue;
    w.mounted = true;
    w.handle = w.def.mount(node, w.props, ctx.emit);
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
  if (isTextNode(vnode)) {
    return ctx.doc.createTextNode(String(vnode));
  }
  const tag = vnode[0];
  if (tag === WIDGET_TAG) {
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
  return node;
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
  if (oldV === newV) return node;
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
    patchProps(ctx, node, propsOf(oldV), propsOf(newV), ns);
    patchChildren(ctx, node, childrenOf(oldV), childrenOf(newV), ns);
    return node;
  }
  destroyNode(ctx, node, oldV);
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
  if (oldProps === newProps) return;
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
    setEvents(ctx, node, oldValue, newValue);
    return;
  }
  if (name in SKIP_PROPS) return;
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
  if (newProps.name !== oldProps.name || (newProps.tag ?? 'div') !== (oldProps.tag ?? 'div')) {
    destroyNode(ctx, node, oldV);
    const next = createWidgetNode(ctx, newV, ns);
    parent.replaceChild(next, node);
    return next;
  }
  const w = node.__jarenWidget;
  widgetDef(ctx, newV, newProps);
  patchWidgetProps(ctx, node, oldProps, newProps, ns);
  const props = newProps.props ?? null;
  const prevProps = oldProps.props ?? null;
  if (props !== prevProps) {
    w.props = props;
    if (w.mounted) {
      if (w.def.update !== undefined) {
        w.def.update(w.handle, props, prevProps);
      }
      else {
        // no update hook: recycle the host with a fresh lifecycle
        if (w.def.unmount !== undefined) w.def.unmount(w.handle);
        w.handle = w.def.mount(node, props, ctx.emit);
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
 * @param {any} ctx
 * @param {any} node - The DOM node rendered from `vnode`.
 * @param {any} vnode
 */
function destroyNode(ctx, node, vnode) {
  if (!ctx.hasWidgets) return;
  const err = destroyWalk(node, vnode, null);
  if (err !== null && ctx.destroyError === null) ctx.destroyError = err;
}

/**
 * The recursive half of `destroyNode`: unmount widget nodes, recurse
 * through ordinary element children, never descend into a widget's host
 * subtree (the widget's own DOM may contain anything).
 * @param {any} node
 * @param {any} vnode
 * @param {Error | null} firstError
 * @returns {Error | null}
 */
function destroyWalk(node, vnode, firstError) {
  if (!isElementNode(vnode)) return firstError;
  if (vnode[0] === WIDGET_TAG) {
    const w = node.__jarenWidget;
    if (w !== undefined && !w.destroyed) {
      w.destroyed = true;
      if (w.mounted && w.def.unmount !== undefined) {
        try {
          w.def.unmount(w.handle);
        }
        catch (err) {
          if (firstError === null) firstError = /** @type {Error} */ (err);
        }
      }
    }
    return firstError;
  }
  const children = childrenOf(vnode);
  for (let i = 0; i < children.length; i++) {
    firstError = destroyWalk(node.childNodes[i], children[i], firstError);
  }
  return firstError;
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
    const cssName = name.startsWith('--')
      ? name
      : name.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
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
      parent.insertBefore(createNode(ctx, newCh[i], ns), tailRef);
    }
  }
  else {
    // new range exhausted: unmount the remaining old children
    for (let i = oldStart; i <= oldEnd; i++) {
      if (oldCh[i] !== undefined) {
        destroyNode(ctx, oldDom[i], oldCh[i]);
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
