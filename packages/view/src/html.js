//@ts-check
/**
 * @file Server-side rendering: vnode JSON → HTML string.
 *
 * No DOM, no state — a pure fold over the vnode tree, usable anywhere
 * (Node, workers, edge runtimes). `on` bindings and `key`s are renderer
 * instructions and produce no markup; hydration is a client-side
 * re-render into the same container (see docs/VIEW-FORMAT.md §6). A
 * `jaren-widget` vnode serializes its host element around the widget's
 * declarative `ssr` fallback (§7) — still pure, no widget is mounted.
 */

import {
  isTextNode,
  isElementNode,
  propsOf,
  childrenOf,
  WIDGET_TAG,
} from './vnode.js';
import { styleToString } from './dom.js';
import { createSafePolicy } from './safe.js';

/** Void elements per the HTML standard: no children, no end tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Props that never serialize to markup. */
const SKIP_PROPS = new Set(['key', 'on', 'memo']);

/** Widget-vnode props that configure the widget, not the host element. */
const WIDGET_SKIP_PROPS = new Set(['key', 'on', 'memo', 'name', 'props', 'tag']);

/**
 * Escape text content: `&`, `<`, `>`.
 * @param {string} text
 * @returns {string}
 */
export function escapeText(text) {
  return text.replace(/[&<>]/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'
  ));
}

/**
 * Escape a double-quoted attribute value: `&`, `"`.
 * @param {string} value
 * @returns {string}
 */
export function escapeAttribute(value) {
  return value.replace(/[&"]/g, (ch) => (ch === '&' ? '&amp;' : '&quot;'));
}

/**
 * Serialize a props object to an attribute string over a skip set.
 *
 * The attribute NAME is trusted here: in the default (trusted) mode it comes
 * from a source-authored stylesheet, so it is emitted as written. Under a
 * safe `policy` it is not trusted — the policy rejects an injection-shaped
 * name and sanitizes a URL value, which is what stops `{ 'x onfocus': … }`
 * from breaking out of the attribute list. The policy is the same object the
 * DOM renderer uses, so the two strip an attack identically.
 * @param {Record<string, any>} props
 * @param {Set<string>} skip
 * @param {import('./safe.js').SafePolicy | null} policy
 * @returns {string}
 */
function serializeProps(props, skip, policy, onUnsafe) {
  let out = '';
  for (const name in props) {
    if (skip.has(name)) continue;
    let attr = name;
    let value = props[name];
    if (policy !== null) {
      const decided = policy.prop(attr, value);
      // Omit a rejected NAME or a cleared VALUE. Omission — not an empty
      // attribute — is what the DOM renderer's `removeAttribute` also does in
      // safe mode, so the two outputs match.
      if (decided === null || decided.value === null) {
        if (onUnsafe !== null) onUnsafe({ kind: 'prop', name });
        continue;
      }
      attr = decided.name;
      value = decided.value;
    }
    if (value == null || value === false) continue;
    if (attr === 'style' && typeof value === 'object') {
      value = styleToString(value);
      if (value === '') continue;
    }
    out += value === true
      ? ' ' + attr
      : ' ' + attr + '="' + escapeAttribute(String(value)) + '"';
  }
  return out;
}

/**
 * @typedef {Object} RenderToStringOptions
 * @property {Record<string, { ssr?: (props: any) => any }>} [widgets] -
 *   Registered widget definitions by name: a `jaren-widget` vnode
 *   serializes its host element around the widget's `ssr(props)` vnode
 *   when the widget is registered and has one, else empty
 *   (VIEW-FORMAT §7).
 * @property {boolean} [safe=false] - Serialize under the SAFE policy
 *   ({@link createSafePolicy}): treat the vnode as untrusted. Disallowed
 *   tags, scripting-sink and inline `on*` properties, injection-shaped tag
 *   and attribute names, and unsafe URLs are stripped, and widget vnodes are
 *   dropped. This is the SAME policy {@link createDomRenderer} applies, so a
 *   document renders to the same safe markup on the server as on the client.
 * @property {(info: { kind: 'tag' | 'prop' | 'event' | 'widget', name: string }) => void}
 *   [onUnsafe] - In safe mode, called for everything stripped: a `tag`, a
 *   `prop`, an `on` binding (`event`) or a `widget`.
 */

/**
 * Render a vnode JSON document to an HTML string.
 *
 * @example
 * renderToString(['p', { class: 'note' }, 'a < b'])
 * // -> '<p class="note">a &lt; b</p>'
 *
 * @param {any} vnode
 * @param {RenderToStringOptions} [options]
 * @returns {string}
 */
export function renderToString(vnode, options = {}) {
  const policy = options.safe ? createSafePolicy() : null;
  const onUnsafe = typeof options.onUnsafe === 'function' ? options.onUnsafe : null;
  return renderNode(vnode, options.widgets, policy, onUnsafe);
}

/**
 * The recursive fold. The policy (or null) and the report sink are carried
 * rather than rebuilt per node, so a `safe: true` document constructs one
 * policy for the whole tree.
 * @param {any} vnode
 * @param {Record<string, { ssr?: (props: any) => any }> | undefined} widgets
 * @param {import('./safe.js').SafePolicy | null} policy
 * @param {((info: { kind: string, name: string }) => void) | null} onUnsafe
 * @returns {string}
 */
function renderNode(vnode, widgets, policy, onUnsafe) {
  if (isTextNode(vnode)) {
    return escapeText(String(vnode));
  }
  if (!isElementNode(vnode)) {
    return '';
  }
  const tag = vnode[0];
  const props = propsOf(vnode);
  if (tag === WIDGET_TAG) {
    // A widget is arbitrary imperative JS. In safe mode an untrusted document
    // must not mount one, so it drops to nothing — the same nothing the DOM
    // renderer produces for a widget in safe mode.
    if (policy !== null) {
      if (onUnsafe !== null) onUnsafe({ kind: 'widget', name: String(props.name ?? '') });
      return '';
    }
    const hostTag = typeof props.tag === 'string' && props.tag !== '' ? props.tag : 'div';
    const def = widgets !== undefined && typeof props.name === 'string'
      && Object.hasOwn(widgets, props.name) ? widgets[props.name] : undefined;
    // one read: acquisition and invocation are one boundary here too —
    // renderToString is pure and offers no isolation, so a hostile
    // `ssr` accessor propagates to the caller exactly like a throwing
    // `ssr()` (the documented behavior for both)
    const ssr = def !== undefined ? def.ssr : undefined;
    const inner = ssr !== undefined
      ? renderNode(ssr.call(def, props.props ?? null), widgets, policy, onUnsafe)
      : '';
    return '<' + hostTag + serializeProps(props, WIDGET_SKIP_PROPS, policy, onUnsafe) + '>'
      + inner + '</' + hostTag + '>';
  }
  // Safe mode: a disallowed or injection-shaped tag drops to the empty
  // string, matching the DOM renderer's empty text node.
  if (policy !== null && policy.tag(tag) === null) {
    if (onUnsafe !== null) onUnsafe({ kind: 'tag', name: String(tag) });
    return '';
  }
  // Report a stripped `on` binding for observability parity with the DOM
  // renderer — SSR never emits `on`, but a host still wants to know an
  // untrusted document tried to bind an action.
  if (policy !== null && onUnsafe !== null && props.on !== undefined) {
    onUnsafe({ kind: 'event', name: 'on' });
  }
  let out = '<' + tag + serializeProps(props, SKIP_PROPS, policy, onUnsafe);
  if (VOID_ELEMENTS.has(tag)) {
    return out + '>';
  }
  out += '>';
  const children = childrenOf(vnode);
  for (let i = 0; i < children.length; i++) {
    out += renderNode(children[i], widgets, policy, onUnsafe);
  }
  return out + '</' + tag + '>';
}
