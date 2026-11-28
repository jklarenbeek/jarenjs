//@ts-check
/**
 * @file How the DOM renderer reaches a node's DOM members. An element answers
 * a member looked up on it through its own named properties first: a `form`
 * answers through its controls' names and ids (`<input name="insertBefore">`
 * is the form's `insertBefore`, `<input id="childNodes">` its `childNodes`),
 * and in Chromium a lookup on a page `object` costs many times one through
 * the accessor. So the members the renderer reads, calls or writes on a form
 * (its children, attributes and listeners), and the parent of every node it
 * walks up from, are reached through the DOM's own accessors of the
 * document's realm ({@link domReaderOf}), which read and change the element
 * itself. Any other element answers no member through named properties and
 * is asked directly ({@link DIRECT_MEMBERS}); so is one where a member has
 * no such accessor (a DOM double). A `document` answers the names of some
 * of its elements over its own members the same way, so the members the
 * renderer calls on it are reached through its `Document` accessors
 * ({@link documentReaderOf}).
 */

/**
 * The DOM's own member accessors of a document's realm, each null where the
 * realm defines none.
 * @typedef {object} DomReader
 * @property {((this: any) => any) | null} parentNode
 * @property {((this: any) => any) | null} childNodes
 * @property {((this: any) => number) | null} nodeType
 * @property {((this: any, node: any, ref: any) => any) | null} insertBefore
 * @property {((this: any, node: any) => any) | null} removeChild
 * @property {((this: any, node: any, old: any) => any) | null} replaceChild
 * @property {((this: any) => string) | null} localName
 * @property {((this: any) => string | null) | null} namespaceURI
 * @property {((this: any, name: string) => string | null) | null} getAttribute
 * @property {((this: any) => string[]) | null} getAttributeNames
 * @property {((this: any, name: string, value: string) => void) | null} setAttribute
 * @property {((this: any, name: string) => void) | null} removeAttribute
 * @property {((this: any, ns: string, name: string, value: string) => void) | null} setAttributeNS
 * @property {((this: any, ns: string, name: string) => void) | null} removeAttributeNS
 * @property {((this: any, type: string, listener: any) => void) | null} addEventListener
 * @property {((this: any, type: string, listener: any) => void) | null} removeEventListener
 */

/**
 * The accessors of `doc`'s realm: the `Node`, `Element` and `EventTarget`
 * prototypes of its `defaultView`. A document without one (made by
 * `createHTMLDocument` or `DOMParser`) is read through the prototypes of the
 * `container`'s own chain that are those interfaces' (the realm that made
 * the container); a prototype chain is no named property of an element.
 * @param {any} doc
 * @param {any} container
 * @returns {DomReader}
 */
export function domReaderOf(doc, container) {
  const view = doc?.defaultView;
  const node = view?.Node?.prototype ?? interfaceOf(container, 'Node');
  const element = view?.Element?.prototype ?? interfaceOf(container, 'Element');
  const target = view?.EventTarget?.prototype ?? interfaceOf(container, 'EventTarget');
  return {
    parentNode: getterOf(node, 'parentNode'),
    childNodes: getterOf(node, 'childNodes'),
    nodeType: getterOf(node, 'nodeType'),
    insertBefore: methodOf(node, 'insertBefore'),
    removeChild: methodOf(node, 'removeChild'),
    replaceChild: methodOf(node, 'replaceChild'),
    localName: getterOf(element, 'localName'),
    namespaceURI: getterOf(element, 'namespaceURI'),
    getAttribute: methodOf(element, 'getAttribute'),
    getAttributeNames: methodOf(element, 'getAttributeNames'),
    setAttribute: methodOf(element, 'setAttribute'),
    removeAttribute: methodOf(element, 'removeAttribute'),
    setAttributeNS: methodOf(element, 'setAttributeNS'),
    removeAttributeNS: methodOf(element, 'removeAttributeNS'),
    addEventListener: methodOf(target, 'addEventListener'),
    removeEventListener: methodOf(target, 'removeEventListener'),
  };
}

/**
 * The prototype on `node`'s chain that is the interface `name`'s (its own
 * `constructor` is the function `name`), or undefined.
 * @param {any} node
 * @param {string} name
 * @returns {any}
 */
function interfaceOf(node, name) {
  for (let proto = node == null ? null : Object.getPrototypeOf(node); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (Object.getOwnPropertyDescriptor(proto, 'constructor')?.value?.name === name) return proto;
  }
  return undefined;
}

/**
 * The getter a prototype defines for `name`, or null.
 * @param {any} proto
 * @param {string} name
 * @returns {any}
 */
function getterOf(proto, name) {
  const get = proto == null ? undefined : Object.getOwnPropertyDescriptor(proto, name)?.get;
  return typeof get === 'function' ? get : null;
}

/**
 * The method a prototype defines for `name`, or null.
 * @param {any} proto
 * @param {string} name
 * @returns {any}
 */
function methodOf(proto, name) {
  const value = proto == null ? undefined : Object.getOwnPropertyDescriptor(proto, name)?.value;
  return typeof value === 'function' ? value : null;
}

/**
 * `node`'s parent.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {any}
 */
export function parentOf(dom, node) {
  const get = dom.parentNode;
  return get !== null ? get.call(node) : node.parentNode;
}

/**
 * `node`'s live child list.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {any}
 */
export function childNodesOf(dom, node) {
  const get = dom.childNodes;
  return get !== null ? get.call(node) : node.childNodes;
}

/**
 * `node`'s node type.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {number}
 */
export function nodeTypeOf(dom, node) {
  const get = dom.nodeType;
  return get !== null ? get.call(node) : node.nodeType;
}

/**
 * Insert `node` into `parent` before `ref` (at the end when `ref` is null).
 * @param {DomReader} dom
 * @param {any} parent
 * @param {any} node
 * @param {any} ref
 */
export function insertChild(dom, parent, node, ref) {
  const call = dom.insertBefore;
  if (call !== null) call.call(parent, node, ref);
  else parent.insertBefore(node, ref);
}

/**
 * Append `node` to `parent`.
 * @param {DomReader} dom
 * @param {any} parent
 * @param {any} node
 */
export function appendChild(dom, parent, node) {
  const call = dom.insertBefore;
  if (call !== null) call.call(parent, node, null);
  else parent.appendChild(node);
}

/**
 * Remove `node` from `parent`.
 * @param {DomReader} dom
 * @param {any} parent
 * @param {any} node
 */
export function removeChild(dom, parent, node) {
  const call = dom.removeChild;
  if (call !== null) call.call(parent, node);
  else parent.removeChild(node);
}

/**
 * Replace `parent`'s child `old` with `node`.
 * @param {DomReader} dom
 * @param {any} parent
 * @param {any} node
 * @param {any} old
 */
export function replaceChild(dom, parent, node, old) {
  const call = dom.replaceChild;
  if (call !== null) call.call(parent, node, old);
  else parent.replaceChild(node, old);
}

/**
 * `node`'s lower-case tag name.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {string}
 */
export function localNameOf(dom, node) {
  const get = dom.localName;
  return get !== null ? get.call(node) : node.localName ?? String(node.tagName).toLowerCase();
}

/**
 * `node`'s namespace.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {string | null}
 */
export function namespaceOf(dom, node) {
  const get = dom.namespaceURI;
  return get !== null ? get.call(node) : node.namespaceURI;
}

/**
 * `node`'s attribute `name`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} name
 * @returns {string | null}
 */
export function attributeOf(dom, node, name) {
  const call = dom.getAttribute;
  return call !== null ? call.call(node, name) : node.getAttribute(name);
}

/**
 * The names of `node`'s attributes.
 * @param {DomReader} dom
 * @param {any} node
 * @returns {string[]}
 */
export function attributeNamesOf(dom, node) {
  const call = dom.getAttributeNames;
  return call !== null ? call.call(node) : node.getAttributeNames();
}

/**
 * Write `node`'s attribute `name`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} name
 * @param {string} value
 */
export function setAttribute(dom, node, name, value) {
  const call = dom.setAttribute;
  if (call !== null) call.call(node, name, value);
  else node.setAttribute(name, value);
}

/**
 * Remove `node`'s attribute `name`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} name
 */
export function removeAttribute(dom, node, name) {
  const call = dom.removeAttribute;
  if (call !== null) call.call(node, name);
  else node.removeAttribute(name);
}

/**
 * Write `node`'s attribute `name` in the namespace `ns`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} ns
 * @param {string} name - the qualified name
 * @param {string} value
 */
export function setAttributeNS(dom, node, ns, name, value) {
  const call = dom.setAttributeNS;
  if (call !== null) call.call(node, ns, name, value);
  else node.setAttributeNS(ns, name, value);
}

/**
 * Remove `node`'s attribute `name` in the namespace `ns`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} ns
 * @param {string} name - the local name
 */
export function removeAttributeNS(dom, node, ns, name) {
  const call = dom.removeAttributeNS;
  if (call !== null) call.call(node, ns, name);
  else node.removeAttributeNS(ns, name);
}

/**
 * Listen for `type` on `node`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} type
 * @param {any} listener
 */
export function listen(dom, node, type, listener) {
  const call = dom.addEventListener;
  if (call !== null) call.call(node, type, listener);
  else node.addEventListener(type, listener);
}

/**
 * Stop listening for `type` on `node`.
 * @param {DomReader} dom
 * @param {any} node
 * @param {string} type
 * @param {any} listener
 */
export function unlisten(dom, node, type, listener) {
  const call = dom.removeEventListener;
  if (call !== null) call.call(node, type, listener);
  else node.removeEventListener(type, listener);
}

/**
 * The DOM's own `Document` members a renderer calls on its document, each
 * null where the document's prototype chain defines none (a document double,
 * which is asked directly).
 * @typedef {object} DocumentReader
 * @property {((this: any, tag: string) => any) | null} createElement
 * @property {((this: any, ns: string, tag: string) => any) | null} createElementNS
 * @property {((this: any, data: string) => any) | null} createTextNode
 * @property {((this: any, id: string) => any) | null} getElementById
 * @property {((this: any, selectors: string) => any) | null} querySelectorAll
 * @property {((this: any) => any) | null} activeElement
 * @property {((this: any) => any) | null} body
 * @property {((this: any) => any) | null} defaultView
 */

/**
 * The accessors of `doc`'s own `Document` interface. A `document` answers
 * the `name` of its `img`, `form`, `embed`, `object` and `iframe` elements
 * (and an `img`'s or `object`'s id) over its own members: `<img
 * name="createElement">` is `document.createElement`. They are read from the
 * document's prototype chain, which is no named property, rather than from
 * its `defaultView`, which such an element takes over as well and which a
 * document `createHTMLDocument` makes has none.
 * @param {any} doc
 * @returns {DocumentReader}
 */
export function documentReaderOf(doc) {
  const proto = interfaceOf(doc, 'Document');
  return {
    createElement: methodOf(proto, 'createElement'),
    createElementNS: methodOf(proto, 'createElementNS'),
    createTextNode: methodOf(proto, 'createTextNode'),
    getElementById: methodOf(proto, 'getElementById'),
    querySelectorAll: methodOf(proto, 'querySelectorAll'),
    activeElement: getterOf(proto, 'activeElement'),
    body: getterOf(proto, 'body'),
    defaultView: getterOf(proto, 'defaultView'),
  };
}

/**
 * A new HTML element `tag` of `doc`, made by `doc`'s own `createElement`
 * ({@link createShadowed} where a named element holds its name).
 * @param {DocumentReader} reader
 * @param {any} doc
 * @param {string} tag
 * @returns {any}
 */
export function createElementIn(reader, doc, tag) {
  try { return doc.createElement(tag); }
  catch (error) { return createShadowed(doc, error, 'createElement', reader.createElement, tag, undefined); }
}

/**
 * `doc`'s own creator `name` threw. Where a named element of the document
 * holds that name (`<img name="createElement">`; a named property is never a
 * function), make the node through the `Document` interface's creator
 * `make` instead; anything else the creator threw is rethrown, as it is for
 * a document double, which has no interface (`make` null).
 * @param {any} doc
 * @param {unknown} error
 * @param {string} name
 * @param {((this: any, a: any, b?: any) => any) | null} make
 * @param {any} a
 * @param {any} b
 * @returns {any}
 */
export function createShadowed(doc, error, name, make, a, b) {
  if (make === null || typeof doc[name] === 'function') throw error;
  return b === undefined ? make.call(doc, a) : make.call(doc, a, b);
}

/**
 * The element of `doc` whose id is `id`, or null; null too in a document
 * with no `getElementById`.
 * @param {DocumentReader} reader
 * @param {any} doc
 * @param {string} id
 * @returns {any}
 */
export function elementById(reader, doc, id) {
  const call = reader.getElementById;
  if (call !== null) return call.call(doc, id);
  return typeof doc?.getElementById === 'function' ? doc.getElementById(id) : null;
}

/**
 * The elements of `doc` that match `selectors`, in document order; none in
 * a document with no `querySelectorAll`.
 * @param {DocumentReader} reader
 * @param {any} doc
 * @param {string} selectors
 * @returns {Iterable<any>}
 */
export function elementsMatching(reader, doc, selectors) {
  const call = reader.querySelectorAll;
  if (call !== null) return call.call(doc, selectors);
  return typeof doc?.querySelectorAll === 'function' ? doc.querySelectorAll(selectors) : [];
}

/**
 * The element of `doc` that has the focus.
 * @param {DocumentReader} reader
 * @param {any} doc
 * @returns {any}
 */
export function activeElementOf(reader, doc) {
  const get = reader.activeElement;
  return get !== null && doc != null ? get.call(doc) : doc?.activeElement;
}

/**
 * `doc`'s `body`.
 * @param {DocumentReader} reader
 * @param {any} doc
 * @returns {any}
 */
export function bodyOf(reader, doc) {
  const get = reader.body;
  return get !== null ? get.call(doc) : doc.body;
}

/**
 * `doc`'s window.
 * @param {DocumentReader} reader
 * @param {any} doc
 * @returns {any}
 */
export function windowOf(reader, doc) {
  const get = reader.defaultView;
  return get !== null ? get.call(doc) : doc.defaultView;
}

/**
 * A reader that asks the element itself for every member: for an element
 * that answers no member through named properties (any but a `form`).
 * @type {DomReader}
 */
export const DIRECT_MEMBERS = Object.freeze({
  parentNode: null,
  childNodes: null,
  nodeType: null,
  insertBefore: null,
  removeChild: null,
  replaceChild: null,
  localName: null,
  namespaceURI: null,
  getAttribute: null,
  getAttributeNames: null,
  setAttribute: null,
  removeAttribute: null,
  setAttributeNS: null,
  removeAttributeNS: null,
  addEventListener: null,
  removeEventListener: null,
});
