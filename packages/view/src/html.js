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
  isElementName,
  elementNameError,
  rawTextError,
  breaksOutOfSvg,
  foreignBelow,
  svgBreakoutError,
  propsOf,
  childrenOf,
  WIDGET_TAG,
} from './vnode.js';
import { styleToString } from './dom.js';
import { aliasOf, enumeratedAttribute, isInlineHandler, writingSpelling } from './properties.js';
import { createSafePolicy, grantedWidgets } from './safe.js';

/** Void elements per the HTML standard: no children, no end tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Whether an HTML element of `tag` is void. A parser reads a tag name in
 * any case, so `BR` is `br`: written with an end tag, `</br>` would read as
 * a second `<br>`.
 * @param {string} tag
 * @returns {boolean}
 */
function isHtmlVoid(tag) {
  return VOID_ELEMENTS.has(tag.toLowerCase());
}

/** Props that never serialize to markup. */
const SKIP_PROPS = new Set(['key', 'on', 'memo']);

/** Controlled textareas/selects express their value through their children. */
const VALUE_SKIP_PROPS = new Set([...SKIP_PROPS, 'value']);
const OPTION_SKIP_PROPS = new Set([...SKIP_PROPS, 'selected']);

/** Widget-vnode props that configure the widget, not the host element. */
const WIDGET_SKIP_PROPS = new Set(['key', 'on', 'memo', 'name', 'props', 'tag']);

/**
 * What raw text may not contain, per raw-text element: the element's own
 * end tag as an HTML tokenizer recognizes one (the name in any case, then
 * whitespace, `/` or `>`), and in a script `<!--`, which changes how the
 * tokenizer reads the end tag after it.
 * @type {Map<string, RegExp>}
 */
const RAW_TEXT_BREAKOUT = new Map([
  ['script', /<\/script[\t\n\f\r />]|<!--/i],
  ['style', /<\/style[\t\n\f\r />]/i],
]);

/** The text of an option whose value attribute is absent. @param {any} vnode */
function optionText(vnode) {
  if (isTextNode(vnode)) return String(vnode);
  if (!isElementNode(vnode) || vnode[0] === 'script') return '';
  return childrenOf(vnode).map(optionText).join('');
}

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
 * @param {((info: { kind: string, name: string }) => void) | null} onUnsafe - the
 *   safe-mode report sink, or null
 * @param {string} tag - the element the props belong to
 * @returns {string}
 */
function serializeProps(props, skip, policy, onUnsafe, tag) {
  let out = '';
  for (const name in props) {
    if (skip.has(name)) continue;
    // an attribute spelled twice is written once, by its later spelling
    const other = aliasOf(name);
    if (other !== undefined && writingSpelling(props, name, other) !== name) continue;
    let attr = name;
    let value = props[name];
    if (policy !== null) {
      const decided = policy.prop(attr, value, tag);
      // Omit a rejected NAME or a cleared VALUE. Omission — not an empty
      // attribute — is what the DOM renderer's `removeAttribute` also does in
      // safe mode, so the two outputs match.
      if (decided === null || decided.value === null) {
        // a prop the author left empty (`null`) was not stripped by anything
        if (onUnsafe !== null && value != null) onUnsafe({ kind: 'prop', name });
        continue;
      }
      attr = decided.name;
      value = decided.value;
    }
    // an inline handler value that is not a function is written by no renderer
    // (the property table)
    if (isInlineHandler(attr, value)) continue;
    // an enumerated attribute is written with its keyword, exactly as the
    // DOM renderer writes it (the property table)
    const enumerated = enumeratedAttribute(attr, value);
    if (enumerated !== undefined) {
      if (enumerated.value !== null) out += ' ' + enumerated.name + '="' + escapeAttribute(enumerated.value) + '"';
      continue;
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
 *   when the widget is registered and has one, else empty; a host on a
 *   void element is written alone, with no end tag (VIEW-FORMAT §7.4).
 * @property {boolean | 'interactive'} [safe=false] - Serialize under the
 *   SAFE policy ({@link createSafePolicy}): treat the vnode as untrusted.
 *   Disallowed tags, scripting-sink and inline `on*` properties,
 *   injection-shaped tag and attribute names, and unsafe URLs are stripped,
 *   and widget vnodes are dropped. This is the SAME policy
 *   {@link createDomRenderer} applies, so a document renders to the same safe
 *   markup on the server as on the client. `'interactive'` serializes a
 *   widget `capabilities.widgets` grants (its host element, around its `ssr`
 *   fallback, both through the policy), writes a `textarea`'s and a
 *   `select`'s `value` in the trusted form (the text, `selected` options),
 *   and reports the `on` bindings the DOM renderer would drop; no binding
 *   is ever markup. Any other truthy value is `true`.
 * @property {{ widgets?: string[] }} [capabilities] - Under
 *   `safe: 'interactive'`, the registered widget names the document may
 *   render, exactly as {@link createDomRenderer} reads it.
 * @property {string} [idPrefix='jaren-u-'] - Under either safe profile, the
 *   render's id namespace, exactly as {@link createDomRenderer} reads it: the
 *   same prefix on both sides gives the same markup. Absent, `jaren-u-`, the
 *   namespace the first live safe DOM root of a page takes; a page holding
 *   several untrusted documents serializes each with its own prefix.
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
  const policy = options.safe === 'interactive'
    ? createSafePolicy({ interactive: true, widgets: grantedWidgets(options.capabilities, options.widgets), idPrefix: options.idPrefix })
    : options.safe ? createSafePolicy({ idPrefix: options.idPrefix }) : null;
  const onUnsafe = typeof options.onUnsafe === 'function' ? options.onUnsafe : null;
  return renderNode(vnode, options.widgets, policy, onUnsafe, null, vnode, false, false);
}

/**
 * The attributes the safe policy gives every element of `tag` (a `form`'s
 * `method="dialog"`), written before its props as the DOM renderer writes
 * them first; empty in trusted mode.
 * @param {import('./safe.js').SafePolicy | null} policy
 * @param {string} tag
 * @returns {string}
 */
function fixedAttributes(policy, tag) {
  const fixed = policy === null ? null : policy.fixed(tag);
  if (fixed === null) return '';
  let out = '';
  for (const [name, value] of fixed) out += ' ' + name + '="' + escapeAttribute(value) + '"';
  return out;
}

/**
 * Report the `on` bindings the interactive profile drops, as the DOM
 * renderer reports them: the same decision, so the same names.
 * @param {import('./safe.js').SafePolicy} policy
 * @param {any} on
 * @param {(info: { kind: string, name: string }) => void} onUnsafe
 */
function reportEvents(policy, on, onUnsafe) {
  for (const name of policy.events(on).dropped) onUnsafe({ kind: 'event', name });
}

/**
 * The recursive fold. The policy (or null) and the report sink are carried
 * rather than rebuilt per node, so a `safe: true` document constructs one
 * policy for the whole tree.
 * @param {any} vnode
 * @param {Record<string, { ssr?: (props: any) => any }> | undefined} widgets
 * @param {import('./safe.js').SafePolicy | null} policy
 * @param {((info: { kind: string, name: string }) => void) | null} onUnsafe
 * @param {{values: Set<string>, multiple: boolean, matched: boolean} | null} selection
 * @param {any} root - the document `renderToString` was handed, where a
 *   refused tag is located
 * @param {boolean} svg - inside an `svg` element (and not back in HTML
 *   under a `foreignObject`), where the DOM renderer builds SVG elements
 * @param {boolean} foreign - where an HTML parser reads the markup written
 *   here as foreign content: inside an `svg`, but not under its `desc` or
 *   `title` ({@link foreignBelow}), where it reads HTML
 * @returns {string}
 */
function renderNode(vnode, widgets, policy, onUnsafe, selection, root, svg, foreign) {
  if (isTextNode(vnode)) {
    return escapeText(String(vnode));
  }
  if (!isElementNode(vnode)) {
    if (Array.isArray(vnode)) return childrenOf(['root', {}, vnode])
      .map((child) => renderNode(child, widgets, policy, onUnsafe, selection, root, svg, foreign)).join('');
    return '';
  }
  const tag = vnode[0];
  const props = propsOf(vnode);
  if (tag === WIDGET_TAG) {
    // A widget is arbitrary imperative JS. In safe mode an untrusted document
    // must not mount one, so it drops to nothing — the same nothing the DOM
    // renderer produces for a widget in safe mode. The interactive profile
    // keeps one the host granted, fed data, with no children, in a host
    // element the tag allow-list admits: the DOM renderer's very decision.
    if (policy !== null) {
      if (!policy.widget(props.name, props.props) || childrenOf(vnode).length !== 0) {
        if (onUnsafe !== null) onUnsafe({ kind: 'widget', name: String(props.name ?? '') });
        return '';
      }
      if (policy.tag(props.tag ?? 'div', foreign) === null) {
        if (onUnsafe !== null) onUnsafe({ kind: 'tag', name: String(props.tag ?? 'div') });
        return '';
      }
      if (onUnsafe !== null) reportEvents(policy, props.on, onUnsafe);
    }
    const hostTag = props.tag ?? 'div';
    if (!isElementName(hostTag)) throw elementNameError(root, vnode, hostTag);
    if (foreign && breaksOutOfSvg(hostTag)) throw svgBreakoutError(root, vnode, hostTag);
    // An HTML void host holds no content and takes no end tag, so the
    // fallback a parser would read as the host's next siblings is not
    // written, and `ssr` is not read: the host as the DOM renderer builds it
    // before the widget mounts. In foreign content the element is not void.
    const voidHost = !foreign && isHtmlVoid(hostTag);
    const def = !voidHost && widgets !== undefined && typeof props.name === 'string'
      && Object.hasOwn(widgets, props.name) ? widgets[props.name] : undefined;
    // one read: acquisition and invocation are one boundary here too —
    // renderToString is pure and offers no isolation, so a hostile
    // `ssr` accessor propagates to the caller exactly like a throwing
    // `ssr()` (the documented behavior for both)
    const ssr = def !== undefined ? def.ssr : undefined;
    const inner = ssr !== undefined
      ? renderNode(ssr.call(def, props.props ?? null), widgets, policy, onUnsafe, selection, root,
        hostTag === 'foreignObject' ? false : svg || hostTag === 'svg', foreignBelow(hostTag, foreign))
      : '';
    const open = '<' + hostTag + fixedAttributes(policy, hostTag) + serializeProps(props, WIDGET_SKIP_PROPS, policy, onUnsafe, hostTag) + '>';
    return voidHost ? open : open + inner + '</' + hostTag + '>';
  }
  // Safe mode: a disallowed or injection-shaped tag drops to the empty
  // string, matching the DOM renderer's empty text node.
  if (policy !== null && policy.tag(tag, foreign) === null) {
    if (onUnsafe !== null) onUnsafe({ kind: 'tag', name: String(tag) });
    return '';
  }
  // Trusted mode holds a tag to the same grammar and refuses, as the DOM
  // renderer does, rather than writing `<Total:>` or `< >` into markup.
  if (!isElementName(tag)) throw elementNameError(root, vnode, tag);
  // An element whose start tag ends the `svg` for a parser has no markup
  // there: refused, as the trusted renderer refuses raw text it cannot carry.
  if (foreign && breaksOutOfSvg(tag)) throw svgBreakoutError(root, vnode, tag);
  // Report a stripped `on` binding for observability parity with the DOM
  // renderer — SSR never emits `on`, but a host still wants to know an
  // untrusted document tried to bind an action.
  if (policy !== null && onUnsafe !== null && props.on !== undefined) {
    if (policy.dropsEvents) onUnsafe({ kind: 'event', name: 'on' });
    else reportEvents(policy, props.on, onUnsafe);
  }
  // A controlled textarea or select is written in the form a parser reads
  // its value from: trusted, and under the interactive profile, which
  // controls the value the policy keeps (`control`); `safe: true` keeps the
  // attribute.
  const control = policy !== null && (tag === 'textarea' || tag === 'select') ? policy.control(tag, props) : null;
  const controlledTextarea = tag === 'textarea' && (policy === null ? 'value' in props : control !== null);
  const controlledSelect = tag === 'select' && (policy === null ? 'value' in props : control !== null);
  const controlValue = control !== null ? control.value : props.value;
  // the value the DOM renderer's `setProp` reports stripped before it drops
  // the attribute, reported alike
  if (control !== null && onUnsafe !== null && props.value != null && policy?.prop('value', props.value, tag)?.value == null)
    onUnsafe({ kind: 'prop', name: 'value' });
  if (tag === 'select') {
    const multiple = props.multiple != null && props.multiple !== false;
    selection = controlledSelect ? {
      values: new Set(multiple && Array.isArray(controlValue)
        ? controlValue.map(String) : [controlValue == null ? '' : String(controlValue)]),
      multiple: multiple && Array.isArray(controlValue), matched: false,
    } : null;
  }
  const controlledOption = tag === 'option' && selection !== null;
  let out = '<' + tag + fixedAttributes(policy, tag) + serializeProps(props,
    controlledTextarea || controlledSelect ? VALUE_SKIP_PROPS
      : controlledOption ? OPTION_SKIP_PROPS : SKIP_PROPS, policy, onUnsafe, tag);
  if (controlledOption) {
    // the option's value as its markup says it: the attribute the policy
    // writes, else the option's text
    const own = policy === null ? props.value : policy.prop('value', props.value, tag)?.value;
    const value = own == null || own === false
      ? optionText(vnode).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '')
      : own === true ? '' : String(own);
    if (selection.values.has(value) && (selection.multiple || !selection.matched)) {
      out += ' selected';
      selection.matched = true;
    }
  }
  // a parser lower-cases a tag name; in foreign content (inside `svg`) no
  // element is void, and an end tag closes `<input>` as `</circle>` does
  if (!foreign && isHtmlVoid(tag)) {
    return out + '>';
  }
  out += '>';
  if (controlledTextarea) {
    const value = controlValue == null ? '' : String(controlValue);
    // HTML normalizes CR/CRLF to LF and consumes one leading LF in a
    // textarea. Protect an authored newline with an extra LF.
    return out + (/^[\r\n]/.test(value) ? '\n' : '') + escapeText(value) + '</' + tag + '>';
  }
  const children = childrenOf(vnode);
  // the namespace the DOM renderer builds the children in: SVG from an
  // `svg` element down, HTML again under a `foreignObject`
  const inSvg = tag === 'foreignObject' ? false : svg || tag === 'svg';
  const inForeign = foreignBelow(tag, foreign);
  const breakout = svg ? undefined : RAW_TEXT_BREAKOUT.get(tag.toLowerCase());
  if (breakout !== undefined) {
    // An HTML `style` or `script` holds raw text: a parser decodes no
    // character reference in it, so its text is written as the DOM
    // renderer's text node holds it — and refused when it holds what
    // would end the element early.
    let inner = '';
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      inner += isTextNode(child)
        ? String(child)
        : renderNode(child, widgets, policy, onUnsafe, selection, root, inSvg, inForeign);
    }
    const found = breakout.exec(inner);
    if (found !== null) throw rawTextError(root, vnode, tag, found[0]);
    return out + inner + '</' + tag + '>';
  }
  for (let i = 0; i < children.length; i++) {
    out += renderNode(children[i], widgets, policy, onUnsafe, selection, root, inSvg, inForeign);
  }
  return out + '</' + tag + '>';
}
