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
 * no such accessor (a DOM double).
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
