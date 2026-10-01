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
    this.nodeType = 3;
  }
}

/** Tags the controlled-input reconciliation reasserts against (§3): the stub
 * gives them live `value`/`checked` properties so a test can simulate a user
 * edit by writing `node.value`/`node.checked` directly. `option` is
 * deliberately absent — the renderer writes its value through the attribute
 * path, exactly as the real DOM leaves the value *attribute* independent of
 * the value property. */
const FORM_CONTROLS = new Set(['input', 'textarea', 'select']);

export class StubElement extends StubNode {
  /**
   * @param {StubDocument} doc
   * @param {string} tag
   * @param {string | null} [ns]
   */
  constructor(doc, tag, ns = null) {
    super(doc);
    this.tagName = tag;
    this.nodeType = 1;
    this.namespaceURI = ns;
    /** @type {(StubElement | StubText)[]} */
    this.childNodes = [];
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    // Form controls carry live value/checked properties, exactly the surface
    // the renderer writes and reconciles against. A plain element has neither,
    // so `'value' in node` stays false for a div — matching the real DOM.
    const lower = String(tag).toLowerCase();
    if (FORM_CONTROLS.has(lower)) {
      this.value = '';
      if (lower === 'input') {
        this.checked = false;
        // `files` is a read-only FileList in the browser: assigning to it
        // throws. Modeling that is how the safe-mode attribute-only write is
        // shown to avoid a first-render crash that the trusted property write
        // would hit.
        Object.defineProperty(this, 'files', {
          get() { return null; },
          enumerable: false,
          configurable: true,
        });
      }
    }
  }

  /** The uppercase tag, as the DOM reports it — how the renderer tells a
   * form control apart when reconciling a controlled value. */
  get nodeName() {
    return String(this.tagName).toUpperCase();
  }

  /** A `<select>`'s option children, as the DOM exposes them — enough for the
   * multiple-select reconciliation to mark each option `selected`. */
  get options() {
    return this.childNodes.filter((c) => c instanceof StubElement
      && String(c.tagName).toLowerCase() === 'option');
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

  getAttributeNames() { return [...this.attributes.keys()]; }

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
    /** @type {Map<string, Set<Function>>} document-level listeners (e.g.
     * a drag widget's window-of-drag pointermove/up) — `fire()`-able. */
    this.listeners = new Map();
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

/** ToUint32, the conversion an `unsigned long` IDL setter applies. @param {any} value */
const toUint32 = (value) => Number(value) >>> 0;

/**
 * Define one IDL property on a stub element.
 * @param {StubElement} node
 * @param {string} name
 * @param {() => any} get
 * @param {(value: any) => void} set
 */
function idl(node, name, get, set) {
  Object.defineProperty(node, name, { get, set, enumerable: false, configurable: true });
}

/**
 * An element carrying the IDL properties the HTML Standard gives it, for the
 * properties whose reflection decides what a renderer writes:
 *  - `spellcheck`, `draggable`, `translate`, `autocorrect` — BOOLEAN IDL
 *    properties reflecting enumerated attributes: the setter converts its
 *    argument with ToBoolean, so the string `'false'` turns the setting on;
 *  - `contentEditable` — a DOMString that refuses anything but its keywords;
 *  - `className` and a label's `htmlFor` — strings reflecting `class` and `for`;
 *  - `disabled` — a boolean attribute;
 *  - `size` on an input (ToUint32; 0 throws `IndexSizeError`), `width` on an
 *    image or a canvas (ToUint32), `href` and `download` on an anchor and
 *    `title` on every element (strings), `value` on a progress (ToNumber) —
 *    non-boolean properties whose setter always writes the attribute, so
 *    assigning `''` writes `0`, `""` or `0`, `true` writes `"true"` and
 *    `'100px'` writes `0`;
 *  - `popover` — a nullable string reflecting the enumerated attribute:
 *    `null` removes it, anything else is written as its string, and it reads
 *    back the state (`''` and `'auto'` are `auto`, an invalid value `manual`).
 */
class ReflectingElement extends StubElement {
  /**
   * @param {StubDocument} doc
   * @param {string} tag
   * @param {string | null} [ns]
   */
  constructor(doc, tag, ns = null) {
    super(doc, tag, ns);
    const lower = String(tag).toLowerCase();
    const attr = (/** @type {string} */ name) => this.getAttribute(name);
    // the empty string is the yes state, except for draggable, where it is
    // invalid and falls to the default
    const enumerated = (/** @type {string} */ name, /** @type {string} */ yes, /** @type {string} */ no,
      /** @type {boolean} */ fallback, emptyIsYes = true) => idl(this, name,
      () => (attr(name) === yes || (emptyIsYes && attr(name) === '') ? true : attr(name) === no ? false : fallback),
      (value) => this.setAttribute(name, value ? yes : no));
    enumerated('spellcheck', 'true', 'false', lower === 'textarea' || lower === 'input');
    enumerated('draggable', 'true', 'false', lower === 'img', false);
    enumerated('translate', 'yes', 'no', true);
    enumerated('autocorrect', 'on', 'off', true);
    idl(this, 'contentEditable', () => (attr('contenteditable') === null ? 'inherit' : attr('contenteditable') || 'true'),
      (value) => {
        const keyword = String(value).toLowerCase();
        if (keyword === 'inherit') this.removeAttribute('contenteditable');
        else if (['true', 'false', 'plaintext-only'].includes(keyword)) this.setAttribute('contenteditable', keyword);
        else throw new DOMException(`'${value}' is not one of 'true', 'false', 'plaintext-only' or 'inherit'`, 'SyntaxError');
      });
    idl(this, 'className', () => attr('class') ?? '', (value) => this.setAttribute('class', String(value)));
    if (lower === 'label') idl(this, 'htmlFor', () => attr('for') ?? '', (value) => this.setAttribute('for', String(value)));
    idl(this, 'disabled', () => attr('disabled') !== null,
      (value) => { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); });
    if (lower === 'input') {
      idl(this, 'size', () => toUint32(attr('size') ?? 20), (value) => {
        const size = toUint32(value);
        if (size === 0) throw new DOMException('the value provided is 0, which is an invalid size', 'IndexSizeError');
        this.setAttribute('size', String(size));
      });
    }
    if (lower === 'img') idl(this, 'width', () => toUint32(attr('width') ?? 0), (value) => this.setAttribute('width', String(toUint32(value))));
    if (lower === 'canvas') idl(this, 'width', () => toUint32(attr('width') ?? 300), (value) => this.setAttribute('width', String(toUint32(value))));
    if (lower === 'a') {
      idl(this, 'href', () => attr('href') ?? '', (value) => this.setAttribute('href', String(value)));
      idl(this, 'download', () => attr('download') ?? '', (value) => this.setAttribute('download', String(value)));
    }
    idl(this, 'title', () => attr('title') ?? '', (value) => this.setAttribute('title', String(value)));
    idl(this, 'popover', () => {
      const state = attr('popover');
      if (state === null) return null;
      const keyword = state.toLowerCase();
      return keyword === '' || keyword === 'auto' ? 'auto' : keyword === 'hint' ? 'hint' : 'manual';
    }, (value) => {
      if (value === null) this.removeAttribute('popover');
      else this.setAttribute('popover', String(value));
    });
    if (lower === 'progress') {
      idl(this, 'value', () => Number(attr('value') ?? 0), (value) => this.setAttribute('value', String(Number(value))));
    }
  }
}

/** A stub document whose elements reflect as a browser's do (see
 * {@link ReflectingElement}). */
export class ReflectingDocument extends StubDocument {
  /** @param {string} tag */
  createElement(tag) {
    return new ReflectingElement(this, tag);
  }

  /** @param {string} ns @param {string} tag */
  createElementNS(ns, tag) {
    return new ReflectingElement(this, tag, ns);
  }
}

/** A fresh `{ document, container }` pair whose elements reflect. */
export function createReflectingHost() {
  const document = new ReflectingDocument();
  const container = document.createElement('div');
  return { document, container };
}
