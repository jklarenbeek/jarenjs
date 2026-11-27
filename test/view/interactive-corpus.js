//@ts-check
/**
 * @file The attack corpus the safe profile neutralizes, gathered in one place
 * so the interactive profile can be held to it: every document here carries no
 * `on` binding and no widget, so the two profiles must render it to the same
 * bytes, report the same strips, and agree between the DOM and the
 * serializer. The vectors are the ones the safe-profile tests pin one by one
 * (safe.test.js, safe-update.test.js, safe-values.test.js and the browser
 * corpus), plus the neighbours of each: other spellings of a scheme, other
 * casings of a sink, other carriers of a document. The controls the
 * interactive profile controls, and so writes apart from `safe: true`, are
 * in {@link CONTROLLED_CORPUS}.
 */
import { escapeAttribute, escapeText } from '@jarenjs/view';

/** A select whose `value` is the one list a safe prop may carry. */
const OPTIONS = [['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B'], ['option', { value: 'c' }, 'C']];

/** @type {Array<{ name: string, vnode: any }>} */
export const SAFE_CORPUS = [
  // HTML-parsing sinks, in every casing a host might see
  { name: 'innerHTML sink', vnode: ['div', { innerHTML: '<img src=x onerror=alert(1)>' }] },
  { name: 'sink casings', vnode: ['div', { innerhtml: 'x', OUTERHTML: 'y', SrcDoc: 'z', insertAdjacentHTML: 'w', dangerouslySetInnerHTML: 'v' }] },
  // script, style and document carriers
  { name: 'script element', vnode: ['script', {}, 'alert(1)'] },
  { name: 'iframe srcdoc', vnode: ['iframe', { srcdoc: '<script>alert(1)</script>' }] },
  { name: 'object data', vnode: ['object', { data: 'https://evil.test/x.swf' }] },
  { name: 'embed src', vnode: ['embed', { src: 'https://evil.test/x' }] },
  { name: 'style element', vnode: ['style', {}, 'body{background:url(https://evil.test/)}'] },
  { name: 'link stylesheet', vnode: ['link', { rel: 'stylesheet', href: 'https://evil.test/x.css' }] },
  { name: 'base href', vnode: ['base', { href: 'https://evil.test/' }] },
  { name: 'meta refresh', vnode: ['meta', { 'http-equiv': 'refresh', content: '0;url=https://evil.test/' }] },
  { name: 'template', vnode: ['template', {}, ['script', {}, 'alert(1)']] },
  { name: 'area href', vnode: ['map', {}, ['area', { href: 'javascript:alert(1)' }]] },
  { name: 'foreignObject', vnode: ['svg', {}, ['foreignObject', {}, ['div', { innerHTML: 'x' }]]] },
  { name: 'svg animate', vnode: ['svg', {}, ['a', {}, ['animate', { attributeName: 'href', to: 'javascript:alert(1)' }]]] },
  { name: 'svg set', vnode: ['svg', {}, ['set', { attributeName: 'onmouseover', to: 'alert(1)' }]] },
  { name: 'svg script', vnode: ['svg', {}, ['script', {}, 'alert(1)']] },
  // structural injection through a name
  { name: 'tag-name injection', vnode: ['div><img src=x onerror=alert(1)', {}, 'x'] },
  { name: 'attribute-name injection', vnode: ['input', { 'x onfocus': 'alert(1)' }] },
  { name: 'attribute-name quote', vnode: ['div', { 'a"b': 'x', 'c=d': 'y', 'e/f': 'z' }, 'x'] },
  { name: 'is attribute', vnode: ['button', { is: 'evil-button', IS: 'evil' }, 'x'] },
  // inline handlers in every casing
  { name: 'inline on* handler', vnode: ['div', { onclick: 'alert(1)' }, 'x'] },
  { name: 'on* casings', vnode: ['img', { src: '/a.png', onError: 'alert(1)', ONLOAD: 'alert(1)', On: 'x' }] },
  // URL schemes, spellings and carriers
  { name: 'javascript: url', vnode: ['a', { href: 'javascript:alert(1)' }, 'go'] },
  { name: 'javascript: with a newline', vnode: ['a', { href: 'java\nscript:alert(1)' }, 'link'] },
  { name: 'javascript: casing and space', vnode: ['a', { href: ' JaVaScRiPt:alert(1)' }, 'link'] },
  { name: 'vbscript: url', vnode: ['a', { href: 'vbscript:msgbox(1)' }, 'go'] },
  { name: 'file: url', vnode: ['a', { href: 'file:///etc/passwd' }, 'go'] },
  { name: 'data: document', vnode: ['a', { href: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }, 'go'] },
  { name: 'data: svg image', vnode: ['img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }] },
  { name: 'data: html in src and srcset', vnode: ['img', { src: 'data:text/html,<script>alert(1)</script>', srcset: 'javascript:evil 1x, https://example.invalid/a 2x' }] },
  { name: 'srcset with a comma-bearing data image', vnode: ['img', { srcset: 'data:image/png;base64,iVBORw0KGgo= 1x, /b.png 2x' }] },
  { name: 'ping list', vnode: ['a', { href: '/ok', ping: 'https://ok.test/ javascript:alert(1)' }, 'p'] },
  { name: 'form action and formaction', vnode: ['form', { action: 'javascript:alert(1)' }, ['button', { formaction: 'javascript:alert(1)', formAction: 'vbscript:x' }, 'go']] },
  { name: 'svg xlink:href', vnode: ['svg', {}, ['a', { 'xlink:href': 'javascript:evil' }, ['text', {}, 'svg']]] },
  { name: 'svg use href', vnode: ['svg', {}, ['use', { href: 'data:image/svg+xml,<svg/onload=alert(1)>' }]] },
  { name: 'media poster and track', vnode: ['video', { poster: 'javascript:x', src: '/v.mp4' }, ['track', { src: 'javascript:x' }]] },
  { name: 'blockquote cite', vnode: ['blockquote', { cite: 'javascript:x' }, 'q'] },
  // inline style vectors
  { name: 'style expression', vnode: ['div', { style: 'width: expression(alert(1))' }, 'x'] },
  { name: 'style url(javascript:)', vnode: ['div', { style: 'background:url( "javascript:alert(1)")' }, 'x'] },
  { name: 'style key injection', vnode: ['div', { style: { 'color:red;background': 'url(javascript:evil)', color: 'red' } }, 'style'] },
  { name: 'style list value', vnode: ['div', { style: { background: ['url(javascript:alert(1))'] } }] },
  { name: 'style list expression', vnode: ['div', { style: { width: ['expression(alert(1))'] } }] },
  { name: 'style object value', vnode: ['div', { style: { color: { toString: 'x' } } }] },
  // values that are not attribute values
  { name: 'list and object values', vnode: ['div', { title: ['a', 'b'], 'data-o': { a: 1 }, href: ['javascript:x'], id: 'k' }] },
  { name: 'read-only property name', vnode: ['input', { files: 'readonly', is: 'evil-widget' }] },
  { name: 'stray object child', vnode: ['div', {}, { foo: 'bar' }, 'x'] },
  // shapes a safe document keeps, which the interactive one must keep alike
  { name: 'ordinary document', vnode: ['main', { class: 'app' }, ['h1', {}, 'Title'], ['a', { href: '/x', title: 'T' }, 'link'], ['input', { value: 'v', type: 'text' }]] },
  { name: 'safe image', vnode: ['img', { src: 'https://x.test/y.png', alt: 'y', srcset: '/a.png 1x, /b.png 2x' }] },
  { name: 'scalar values', vnode: ['p', { title: 'a', tabindex: 3, hidden: true, lang: null, 'data-n': 0, 'data-f': false, style: { color: 'red', width: 10, margin: null } }, 'x'] },
  { name: 'aria and role', vnode: ['div', { role: 'button', tabindex: 0, 'aria-label': 'x', 'aria-pressed': 'false' }, 'x'] },
  // vectors the safe profile does NOT close (the record's open questions):
  // pinned here so the interactive profile is shown to keep them EXACTLY as
  // safe does, no wider and no narrower
  { name: 'external link with an opener', vnode: ['a', { href: 'https://evil.test/', target: '_top', rel: 'opener' }, 'x'] },
  { name: 'autofocus', vnode: ['input', { autofocus: true, type: 'text' }] },
  { name: 'host form reference', vnode: ['button', { form: 'host-form', formaction: 'https://evil.test/', type: 'submit' }, 'x'] },
  { name: 'host label reference', vnode: ['label', { for: 'host-input' }, 'x'] },
  { name: 'external style url', vnode: ['div', { style: 'background:url(https://evil.test/beacon)' }, 'x'] },
  { name: 'fixed overlay', vnode: ['div', { style: { position: 'fixed', inset: 0, 'z-index': 2147483647 } }, 'x'] },
  { name: 'popover', vnode: ['div', {}, ['button', { popovertarget: 'p' }, 'x'], ['div', { popover: 'auto', id: 'p' }, 'y']] },
];

/**
 * The documents the two profiles write apart: a `textarea`'s and a
 * `select`'s `value`, which `safe: true` keeps as an attribute a parser
 * ignores and the interactive profile controls. `safe` is the markup both
 * renderers write under `safe: true`; under the interactive profile `ssr` is
 * the serializer's trusted form and `dom` the DOM renderer's markup (no
 * `value` attribute, the authored children), whose live `value`, and each
 * option's `selected`, is `live`. The DOM's markup and the serializer's
 * differ, as they do in trusted mode: the live selection and a textarea's
 * live value are properties, not markup.
 * @type {Array<{ name: string, vnode: any, safe: string, ssr: string, dom: string, live: { value: string, selected: Array<boolean | null> } }>}
 */
export const CONTROLLED_CORPUS = [
  {
    name: 'multiple select', vnode: ['select', { multiple: true, value: ['b', 'c'] }, ...OPTIONS],
    safe: '<select multiple value="b,c"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    ssr: '<select multiple><option value="a">A</option><option value="b" selected>B</option><option value="c" selected>C</option></select>',
    dom: '<select multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    live: { value: '', selected: [false, true, true] },
  },
  {
    name: 'select value', vnode: ['select', { value: 'b' }, ...OPTIONS],
    safe: '<select value="b"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    ssr: '<select><option value="a">A</option><option value="b" selected>B</option><option value="c">C</option></select>',
    dom: '<select><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    live: { value: 'b', selected: [null, null, null] },
  },
  {
    name: 'textarea value', vnode: ['textarea', { value: 'x' }, 'y'],
    safe: '<textarea value="x">y</textarea>',
    ssr: '<textarea>x</textarea>',
    dom: '<textarea>y</textarea>',
    live: { value: 'x', selected: [] },
  },
];

/** The elements a parser closes by itself: serialized without an end tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * The markup a stub DOM subtree stands for, spelled as the serializer spells
 * it: attributes in insertion order, values and text escaped, void elements
 * without an end tag. What lets a node test compare the DOM renderer with
 * `renderToString` byte for byte.
 * @param {any} node - a stub element or text node
 * @returns {string}
 */
export function markupOf(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  let out = '<' + node.tagName;
  for (const [name, value] of node.attributes) {
    out += value === '' ? ' ' + name : ' ' + name + '="' + escapeAttribute(value) + '"';
  }
  out += '>';
  if (VOID.has(node.tagName)) return out;
  for (const child of node.childNodes) out += markupOf(child);
  return out + '</' + node.tagName + '>';
}

/**
 * The markup of every child of a container.
 * @param {any} container
 * @returns {string}
 */
export function childMarkup(container) {
  let out = '';
  for (const child of container.childNodes) out += markupOf(child);
  return out;
}
