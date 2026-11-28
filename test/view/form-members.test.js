//@ts-check
/**
 * @file A `form` answers a member looked up on it through its controls'
 * names and ids first (`<input name="insertBefore">` is the form's
 * `insertBefore`), and a write to a name a control holds throws. The DOM
 * renderer reaches a form's members through the DOM's own accessors, so a
 * document whose form controls are named after the members the renderer
 * calls renders, patches, hydrates and binds as the serializer writes it, in
 * every mode, with or without a `defaultView`. Pinned here on a DOM double
 * whose members live on `EventTarget`/`Node`/`Element` prototypes and whose
 * forms shadow them as a browser's do; the browser suite pins the same in
 * three engines.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDomRenderer, renderToString } from '@jarenjs/view';
import { findByRef } from '@jarenjs/view/helpers/focus';

/** Reads a shadowed form makes before a walk counts as never ending. */
const READ_LIMIT = 10_000;

/** The getter `proto` defines for `name`. @param {object} proto @param {string} name @returns {Function} */
const getter = (proto, name) => /** @type {Function} */ (Object.getOwnPropertyDescriptor(proto, name)?.get);

/**
 * A DOM double: the members live on the prototypes of classes named after
 * the DOM's interfaces, state in private fields, and a `form` answers every
 * name or id a control in it holds as a read-only property of its own (a
 * `parentNode` control as a getter that throws once read past
 * {@link READ_LIMIT} times, so a walk that keeps reading it fails instead of
 * hanging the run). The double's own algorithms never read a member through
 * an element, as a browser's do not.
 * @param {{ view: boolean }} options - whether the document has a
 *   `defaultView` holding the interfaces
 */
function formDom({ view }) {
  class EventTarget {
    /** @type {Map<string, Set<Function>>} */
    #listeners = new Map();
    /** @param {string} type @param {Function} listener */
    addEventListener(type, listener) {
      let set = this.#listeners.get(type);
      if (set === undefined) this.#listeners.set(type, set = new Set());
      set.add(listener);
    }
    /** @param {string} type @param {Function} listener */
    removeEventListener(type, listener) { this.#listeners.get(type)?.delete(listener); }
    /** @param {any} event */
    static fire(/** @type {EventTarget} */ node, event) {
      for (const listener of [...(node.#listeners.get(event.type) ?? [])]) listener(event);
    }
  }
  const fire = EventTarget.fire;
  class Node extends EventTarget {
    /** @type {Node | null} */
    #parent = null;
    /** @type {Node[]} */
    #children = [];
    #type;
    /** @param {any} doc @param {number} type */
    constructor(doc, type) { super(); this.ownerDocument = doc; this.#type = type; }
    get parentNode() { return this.#parent; }
    get childNodes() { return this.#children; }
    get nodeType() { return this.#type; }
    /** @param {Node} node @param {Node | null} ref */
    insertBefore(node, ref) {
      if (node.#parent !== null) Node.detach(node.#parent, node);
      const index = ref == null ? this.#children.length : this.#children.indexOf(ref);
      if (index < 0) throw new Error('insertBefore: the reference is no child');
      this.#children.splice(index, 0, node);
      node.#parent = this;
      Node.changed(this);
      return node;
    }
    /** @param {Node} node */
    appendChild(node) { return Node.prototype.insertBefore.call(this, node, null); }
    /** @param {Node} node */
    removeChild(node) { Node.detach(this, node); Node.changed(this); return node; }
    /** @param {Node} next @param {Node} old */
    replaceChild(next, old) {
      Node.prototype.insertBefore.call(this, next, old);
      Node.prototype.removeChild.call(this, old);
      return old;
    }
    set textContent(_value) {
      for (const child of [...this.#children]) Node.detach(this, child);
      Node.changed(this);
    }
    /** @param {Node} parent @param {Node} node */
    static detach(parent, node) {
      const index = parent.#children.indexOf(node);
      if (index < 0) throw new Error('removeChild: no child');
      parent.#children.splice(index, 1);
      node.#parent = null;
    }
    /** Refresh the names of the form at or around `node`. @param {Node} node */
    static changed(node) {
      for (let n = /** @type {Node | null} */ (node); n !== null; n = n.#parent) if (n instanceof Form) n.refresh();
    }
  }
  class Text extends Node {
    /** @param {any} doc @param {string} text */
    constructor(doc, text) { super(doc, 3); this.nodeValue = text; }
  }
  class Element extends Node {
    /** @type {Map<string, string>} */
    #attributes = new Map();
    #tag;
    #ns;
    /** @param {any} doc @param {string} tag @param {string | null} ns */
    constructor(doc, tag, ns) { super(doc, 1); this.#tag = tag; this.#ns = ns ?? 'http://www.w3.org/1999/xhtml'; }
    get localName() { return this.#tag; }
    get tagName() { return this.#tag.toUpperCase(); }
    get nodeName() { return this.#tag.toUpperCase(); }
    get namespaceURI() { return this.#ns; }
    /** @param {string} name */
    getAttribute(name) { return this.#attributes.get(name.toLowerCase()) ?? null; }
    getAttributeNames() { return [...this.#attributes.keys()]; }
    /** @param {string} name @param {string} value */
    setAttribute(name, value) { this.#attributes.set(name.toLowerCase(), String(value)); Node.changed(this); }
    /** @param {string} name */
    removeAttribute(name) { this.#attributes.delete(name.toLowerCase()); Node.changed(this); }
    /** @param {string} _ns @param {string} name @param {string} value */
    setAttributeNS(_ns, name, value) { Element.prototype.setAttribute.call(this, name, value); }
    /** @param {string} _ns @param {string} local */
    removeAttributeNS(_ns, local) {
      for (const name of [...this.#attributes.keys()]) if (name === local || name.endsWith(`:${local}`)) this.#attributes.delete(name);
      Node.changed(this);
    }
  }
  class Form extends Element {
    /** @type {Set<string>} */
    #named = new Set();
    #reads = 0;
    /** Answer every name and id a control holds, as a browser's form does. */
    refresh() {
      /** @type {Map<string, Node>} */
      const held = new Map();
      const walk = (/** @type {Node} */ node) => {
        for (const child of getter(Node.prototype, 'childNodes').call(node)) {
          if (!(child instanceof Element)) continue;
          for (const attr of ['name', 'id']) {
            const key = Element.prototype.getAttribute.call(child, attr);
            if (key && !held.has(key)) held.set(key, child);
          }
          walk(child);
        }
      };
      walk(this);
      for (const key of this.#named) if (!held.has(key)) delete (/** @type {any} */ (this))[key];
      for (const [key, control] of held) {
        const form = this;
        Object.defineProperty(this, key, key === 'parentNode'
          ? { get() { if (++form.#reads > READ_LIMIT) throw new Error('read the form\'s parentNode through its control'); return control; }, configurable: true }
          : { value: control, writable: false, enumerable: false, configurable: true });
      }
      this.#named = new Set(held.keys());
    }
  }
  const document = {
    /** @param {string} tag */
    createElement: (tag) => tag.toLowerCase() === 'form' ? new Form(document, tag.toLowerCase(), null) : new Element(document, tag.toLowerCase(), null),
    /** @param {string} ns @param {string} tag */
    createElementNS: (ns, tag) => new Element(document, tag, ns),
    /** @param {string} text */
    createTextNode: (text) => new Text(document, text),
    defaultView: view ? { EventTarget, Node, Element } : null,
  };
  const container = document.createElement('main');
  const childNodes = /** @type {(node: any) => any[]} */ ((node) => getter(Node.prototype, 'childNodes').call(node));
  /** The markup of `node`'s children, read through the prototypes. @param {any} node @returns {string} */
  const markup = (node) => childNodes(node).map((child) => {
    if (child instanceof Text) return child.nodeValue;
    const tag = getter(Element.prototype, 'localName').call(child);
    const attrs = Element.prototype.getAttributeNames.call(child)
      .map((/** @type {string} */ name) => {
        const value = Element.prototype.getAttribute.call(child, name);
        return value === '' ? ` ${name}` : ` ${name}="${value}"`;
      }).join('');
    return tag === 'input' ? `<${tag}${attrs}>` : `<${tag}${attrs}>${markup(child)}</${tag}>`;
  }).join('');
  /** Dispatch `type` at `target`, bubbling through the parents. @param {any} target @param {string} type */
  const dispatch = (target, type) => {
    for (let node = target; node !== null; node = getter(Node.prototype, 'parentNode').call(node)) {
      fire(node, { type, target, currentTarget: node });
    }
  };
  /** The first descendant of `node` of `tag`. @param {any} node @param {string} tag @returns {any} */
  const find = (node, tag) => {
    for (const child of childNodes(node)) {
      if (child instanceof Element && child.localName === tag) return child;
      const found = child instanceof Element ? find(child, tag) : null;
      if (found) return found;
    }
    return null;
  };
  return { document, container, markup, dispatch, find };
}

/** The members the renderer reaches on an element it patches. */
const MEMBERS = ['insertBefore', 'appendChild', 'removeChild', 'replaceChild', 'childNodes', 'nodeType', 'localName',
  'namespaceURI', 'setAttribute', 'removeAttribute', 'getAttribute', 'getAttributeNames', 'setAttributeNS',
  'removeAttributeNS', 'addEventListener', 'removeEventListener', 'parentNode'];

/** The string keys the renderer once kept its bookkeeping under on a node;
 * it keeps it under symbols, which no control's name or id can be. */
const OLD_BOOKKEEPING = ['__jarenOn', '__jarenEmit', '__jarenWidget', '__jarenControlled', '__jarenComposition',
  '__jarenComposing', '__jarenDeferred', '__jarenDeferFocused', '__jarenSecret'];

/** Frames that reach each member on the form: mount, insert, append, remove, move, replace and attributes. */
const FRAMES = (/** @type {any} */ c) => [
  ['form', { class: 'a' }, c, ['b', { key: 1 }, '1'], ['b', { key: 2 }, '2']],
  ['form', { class: 'b', title: 't' }, c, ['i', {}, 'new'], ['b', { key: 2 }, '2'], ['b', { key: 1 }, '1']],
  ['form', {}, c, ['b', { key: 1 }, '1'], ['b', { key: 3 }, '3']],
  ['form', { 'aria-label': 'x' }, c],
  ['form', { lang: 'en' }, c, ['s', {}, 'end']],
];

for (const view of [true, false]) {
  describe(`a form control named after a DOM member (${view ? 'with' : 'without'} a defaultView)`, () => {
    for (const safe of /** @type {const} */ ([false, true, 'interactive'])) {
      for (const attr of safe ? ['name'] : ['name', 'id']) {
        it(`renders and patches as the serializer writes it, safe: ${JSON.stringify(safe)}, by ${attr}`, () => {
          for (const member of MEMBERS) {
            const { document, container, markup } = formDom({ view });
            const render = createDomRenderer(container, { document, safe: safe || undefined });
            for (const frame of FRAMES(['input', { [attr]: member }])) {
              render(frame);
              assert.equal(markup(container), renderToString(frame, { safe: safe || undefined }), `${member}, frame ${JSON.stringify(frame)}`);
            }
          }
        });
      }
    }

    it('writes the exact markup of a moved, inserted and removed child beside an insertBefore control', () => {
      const { document, container, markup } = formDom({ view });
      const render = createDomRenderer(container, { document });
      const c = ['input', { name: 'insertBefore' }];
      render(['form', {}, c, ['b', { key: 1 }, '1'], ['b', { key: 2 }, '2']]);
      render(['form', {}, c, ['i', {}, 'new'], ['b', { key: 2 }, '2'], ['b', { key: 1 }, '1']]);
      assert.equal(markup(container), '<form><input name="insertBefore"><i>new</i><b>2</b><b>1</b></form>');
      render(['form', {}, c]);
      assert.equal(markup(container), '<form><input name="insertBefore"></form>');
    });

    it('hydrates a form whose controls are named after the members adoption reads', () => {
      for (const member of ['childNodes', 'nodeType', 'localName', 'namespaceURI', 'getAttributeNames', 'removeAttribute', 'replaceChild', 'appendChild', 'removeChild']) {
        const { document, container, markup } = formDom({ view });
        const form = document.createElement('form');
        form.setAttribute('data-server', '');
        const control = document.createElement('input');
        for (const node of [control, document.createElement('b'), document.createElement('u'), document.createElement('q')]) form.appendChild(node);
        // named last: from here on the form answers `member` through the control
        control.setAttribute('name', member);
        container.appendChild(form);
        const vnode = ['form', { class: 'k' }, ['input', { name: member }], ['i', {}, 'x']];
        createDomRenderer(container, { document, hydrate: true })(vnode);
        assert.equal(markup(container), renderToString(vnode), member);
        assert.equal(container.childNodes[0], form, `${member}: the server form is adopted`);
      }
    });

    it('binds, fires and unbinds a form\'s `on` beside controls named after the listener members', () => {
      for (const member of ['addEventListener', 'removeEventListener']) {
        const { document, container, dispatch, find } = formDom({ view });
        /** @type {unknown[]} */
        const seen = [];
        const render = createDomRenderer(container, { document, onEvent: (binding) => seen.push(binding) });
        const c = ['input', { name: member }];
        render(['form', { on: { click: 'save' } }, c, ['button', {}, 'go']]);
        dispatch(find(container, 'button'), 'click');
        render(['form', {}, c, ['button', {}, 'go']]);
        dispatch(find(container, 'button'), 'click');
        assert.deepEqual(seen, ['save'], member);
      }
    });

    it('delivers an interactive binding from inside a form whose control is named parentNode', () => {
      const { document, container, dispatch, find } = formDom({ view });
      /** @type {unknown[]} */
      const seen = [];
      const render = createDomRenderer(container, { document, safe: 'interactive', onEvent: (binding) => seen.push(binding) });
      render(['div', { on: { click: 'pick' } }, ['form', {}, ['input', { name: 'parentNode' }], ['button', { type: 'button' }, 'go']]]);
      dispatch(find(container, 'button'), 'click');
      assert.deepEqual(seen, ['pick']);
    });

    it('unmounts a widget inside a form whose control is named childNodes, when the form leaves', () => {
      const { document, container } = formDom({ view });
      /** @type {unknown[]} */
      const log = [];
      const widgets = { w: { mount: () => { log.push('mount'); return 1; }, unmount: () => { log.push('unmount'); } } };
      const render = createDomRenderer(container, { document, widgets });
      render(['div', {}, ['form', {}, ['input', { name: 'childNodes' }], ['jaren-widget', { name: 'w' }]]]);
      render(['p', {}, 'gone']);
      assert.deepEqual(log, ['mount', 'unmount']);
    });

    it('writes and removes a namespaced attribute through the accessors on a form', () => {
      const { document, container, markup } = formDom({ view });
      const render = createDomRenderer(container, { document });
      const c = ['input', { name: 'setAttributeNS' }];
      render(['form', { 'xml:lang': 'en' }, c, ['input', { name: 'removeAttributeNS' }]]);
      assert.equal(markup(container), '<form xml:lang="en"><input name="setAttributeNS"><input name="removeAttributeNS"></form>');
      render(['form', {}, c, ['input', { name: 'removeAttributeNS' }]]);
      assert.equal(markup(container), '<form><input name="setAttributeNS"><input name="removeAttributeNS"></form>');
    });

    it('finds a data-ref inside a form whose controls are named childNodes and getAttribute', () => {
      for (const member of ['childNodes', 'getAttribute', 'nodeType']) {
        const { document, container, find } = formDom({ view });
        createDomRenderer(container, { document })(['form', {}, ['input', { name: member }], ['b', { 'data-ref': 'target' }, 't']]);
        assert.equal(findByRef(container, 'target'), find(container, 'b'), member);
        assert.equal(findByRef(container, 'other'), null, member);
      }
    });

    it('writes a prop named like a control as the form\'s attribute', () => {
      const { document, container, markup } = formDom({ view });
      const render = createDomRenderer(container, { document });
      for (const [props, want] of /** @type {const} */ ([
        [{ foo: 'a' }, '<form foo="a"><input name="foo"></form>'],
        [{ foo: 'b' }, '<form foo="b"><input name="foo"></form>'],
        [{}, '<form><input name="foo"></form>'],
      ])) {
        render(['form', props, ['input', { name: 'foo' }]]);
        assert.equal(markup(container), want);
      }
    });

    it('binds a form\'s on beside a control named after any key the renderer once kept on the node', () => {
      for (const safe of /** @type {const} */ ([false, 'interactive'])) {
        for (const key of OLD_BOOKKEEPING) {
          const { document, container, markup, dispatch, find } = formDom({ view });
          /** @type {unknown[]} */
          const seen = [];
          const render = createDomRenderer(container, { document, safe: safe || undefined, onEvent: (binding) => seen.push(binding) });
          const frames = [
            ['form', { on: { click: 'save' } }, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
            ['form', { on: { click: 'again' } }, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
            ['form', {}, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
          ];
          for (const frame of frames) {
            render(frame);
            dispatch(find(container, 'button'), 'click');
          }
          assert.deepEqual(seen, ['save', 'again'], `${key}, safe: ${safe}`);
          assert.equal(markup(container), renderToString(frames[2], { safe: safe || undefined }), key);
        }
      }
    });

    it('unmounts the widgets inside a form whose control is named after any key the renderer once kept', () => {
      for (const key of OLD_BOOKKEEPING) {
        const { document, container, find } = formDom({ view });
        /** @type {unknown[]} */
        const log = [];
        const widgets = { w: { mount: () => { log.push('mount'); return 1; }, unmount: () => { log.push('unmount'); } } };
        const render = createDomRenderer(container, { document, widgets });
        render(['div', {}, ['form', {}, ['input', { name: key }], ['jaren-widget', { name: 'w' }]]]);
        render(['div', {}, ['form', { title: 'b' }, ['input', { name: key }], ['jaren-widget', { name: 'w' }]]]);
        const control = find(container, 'input');
        render(['p', {}, 'gone']);
        assert.deepEqual(log, ['mount', 'unmount'], key);
        assert.deepEqual(Object.keys(control), ['ownerDocument'], `${key}: nothing is written on the control`);
      }
    });

    it('keeps a form widget host a host when its widget names a control after its old bookkeeping key', () => {
      const { document, container } = formDom({ view });
      /** @type {unknown[]} */
      const log = [];
      const widgets = { f: {
        mount: (/** @type {any} */ host) => {
          log.push('mount');
          const control = document.createElement('input');
          control.setAttribute('name', '__jarenWidget');
          host.appendChild(control);
          return 1;
        },
        update: () => { log.push('update'); },
        unmount: () => { log.push('unmount'); },
      } };
      const render = createDomRenderer(container, { document, widgets });
      render(['div', {}, ['jaren-widget', { name: 'f', tag: 'form', props: { n: 1 } }]]);
      render(['div', {}, ['jaren-widget', { name: 'f', tag: 'form', props: { n: 2 } }]]);
      render(['p', {}, 'gone']);
      assert.deepEqual(log, ['mount', 'update', 'unmount']);
    });
  });
}
