//@ts-check
/**
 * @file A minimal DOM stub for exercising the @jarenjs/view renderer
 * under the Node test runner: exactly the surface `createDomRenderer`
 * touches, plus `fire()` and `serialize()` helpers for assertions.
 * Deliberately not a DOM implementation — no bubbling, no namespaces
 * beyond bookkeeping, no live collections.
 */

class StubNode {
  /** @param {StubDocument} doc */
  constructor(doc) {
    this.ownerDocument = doc;
    /** @type {StubElement | null} */
    this.parentNode = null;
  }
}

export class StubText extends StubNode {
  /**
   * @param {StubDocument} doc
   * @param {string} text
   */
  constructor(doc, text) {
    super(doc);
    this.nodeValue = text;
  }
}

export class StubElement extends StubNode {
  /**
   * @param {StubDocument} doc
   * @param {string} tag
   * @param {string | null} [ns]
   */
  constructor(doc, tag, ns = null) {
    super(doc);
    this.tagName = tag;
    this.namespaceURI = ns;
    /** @type {(StubElement | StubText)[]} */
    this.childNodes = [];
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /** @param {StubElement | StubText} node */
  appendChild(node) {
    this.insertBefore(node, null);
    return node;
  }

  /**
   * @param {StubElement | StubText} node
   * @param {StubElement | StubText | null} ref
   */
  insertBefore(node, ref) {
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    const index = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
    if (index < 0) throw new Error('insertBefore: reference node not found');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  /** @param {StubElement | StubText} node */
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('removeChild: node not found');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  /**
   * @param {StubElement | StubText} next
   * @param {StubElement | StubText} old
   */
  replaceChild(next, old) {
    this.insertBefore(next, old);
    this.removeChild(old);
    return old;
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** Focus tracking: the document records the active element. */
  focus() {
    this.ownerDocument.activeElement = this;
  }

  /** Text-control selection: focuses and marks the selection. */
  select() {
    this.focus();
    this.selected = true;
  }

  /** A fixed layout box, enough for measurement plumbing tests. */
  getBoundingClientRect() {
    return { x: 1, y: 2, width: 30, height: 40, top: 2, left: 1, right: 31, bottom: 42 };
  }

  /**
   * @param {string} type
   * @param {Function} listener
   */
  addEventListener(type, listener) {
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, set = new Set());
    set.add(listener);
  }

  /**
   * @param {string} type
   * @param {Function} listener
   */
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value !== '') this.appendChild(new StubText(this.ownerDocument, String(value)));
  }
}

export class StubDocument {
  constructor() {
    /** @type {StubElement | null} The last focused element. */
    this.activeElement = null;
  }

  /** @param {string} tag */
  createElement(tag) {
    return new StubElement(this, tag);
  }

  /**
   * @param {string} ns
   * @param {string} tag
   */
  createElementNS(ns, tag) {
    return new StubElement(this, tag, ns);
  }

  /** @param {string} text */
  createTextNode(text) {
    return new StubText(this, text);
  }
}

/**
 * Fire an event on a stub node: calls its own listeners for `type` with
 * a minimal event object (no bubbling).
 * @param {StubElement} node
 * @param {string} type
 * @param {Record<string, any>} [props] - Extra event members (e.g. `key`)
 *   or a `target` override for input events.
 */
export function fire(node, type, props = {}) {
  const event = { type, target: node, currentTarget: node, ...props };
  for (const listener of node.listeners.get(type) ?? []) {
    listener(event);
  }
  return event;
}

/**
 * Serialize a stub tree to markup for easy assertions. Attributes render
 * in insertion order; no escaping (tests control their own text).
 * @param {StubElement | StubText} node
 * @returns {string}
 */
export function serialize(node) {
  if (node instanceof StubText) return node.nodeValue;
  let out = '<' + node.tagName;
  for (const [name, value] of node.attributes) {
    out += value === '' ? ' ' + name : ` ${name}="${value}"`;
  }
  out += '>';
  for (const child of node.childNodes) out += serialize(child);
  return out + '</' + node.tagName + '>';
}

/** A fresh `{ document, container }` pair for one test. */
export function createStubHost() {
  const document = new StubDocument();
  const container = document.createElement('div');
  return { document, container };
}
