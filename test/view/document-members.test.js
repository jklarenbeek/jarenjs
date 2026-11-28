//@ts-check
/**
 * @file `document` answers the `name` of its `img`, `form`, `embed`, `object`
 * and `iframe` elements (and an `img`'s or `object`'s id) over its own
 * members: `<img name="createElement">` is `document.createElement`. The DOM
 * renderer and the dialog helper reach the document's members through its own
 * `Document` accessors, so a document naming an element after one renders as
 * it does under any other name. Pinned on a DOM double whose document's class
 * is named `Document` and answers its named elements as read-only properties
 * of its own; the browser suite pins the same in three engines.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDomRenderer } from '@jarenjs/view';
import { createDialog } from '@jarenjs/view/helpers/dialog';
import { StubDocument, serialize } from './dom.stub.js';

/** The elements whose `name` is a name of `document`. */
const NAMED = new Set(['img', 'form', 'embed', 'object', 'iframe']);

/**
 * A DOM double: the document's members live on the prototype of a class
 * named `Document`, and the document answers the name of each of its named
 * elements (and an `img`'s or `object`'s id) as a read-only property of its
 * own once {@link refresh} has looked, as a browser's does at once. Enough
 * of the dialog surface for a dialog to open and close.
 */
function namedDocument() {
  /** @type {any} */
  let active = null;
  /** @type {any} */
  let body = null;
  /** @type {Set<string>} */
  let named = new Set();
  const walk = (/** @type {any} */ node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
  const view = { getComputedStyle: () => ({ visibility: 'visible' }) };
  const decorate = (/** @type {any} */ node) => {
    node.contains = (/** @type {any} */ other) => walk(node).includes(other);
    node.closest = (/** @type {string} */ selector) => {
      for (let n = node; n !== null; n = n.parentNode) if (n.tagName === selector) return n;
      return null;
    };
    node.matches = () => false;
    // the double's own focus never reads the document's members
    node.focus = () => { active = node; };
    node.getClientRects = () => [{}];
    node.tabIndex = node.tagName === 'button' ? 0 : -1;
    node.querySelectorAll = () => walk(node).filter((n) => n !== node && n.tagName === 'button');
    Object.defineProperty(node, 'isConnected', { get: () => body !== null && walk(body).includes(node) });
    if (node.tagName === 'dialog') {
      node.open = false;
      node.showModal = () => { node.open = true; };
      node.close = () => { node.open = false; };
    }
    return node;
  };
  class Document extends StubDocument {
    get activeElement() { return active; }
    set activeElement(node) { active = node; }
    get body() { return body; }
    get defaultView() { return view; }
    /** @param {string} tag */
    createElement(tag) { return decorate(super.createElement(tag)); }
    /** @param {string} ns @param {string} tag */
    createElementNS(ns, tag) { return decorate(super.createElementNS(ns, tag)); }
    /** @param {string} text */
    createTextNode(text) { return super.createTextNode(text); }
    /** @param {string} id */
    getElementById(id) { return walk(body).find((n) => n.getAttribute?.('id') === id) ?? null; }
    /** The renderer's one selector: the elements holding a name of the document. */
    querySelectorAll() {
      return walk(body).filter((n) => n.getAttribute !== undefined
        && ((NAMED.has(n.tagName) && n.getAttribute('name') !== null) || (n.tagName === 'object' && n.getAttribute('id') !== null)));
    }
    /** Answer every name the document's elements hold, as a browser's document does. */
    refresh() {
      /** @type {Map<string, any>} */
      const held = new Map();
      for (const n of walk(body)) {
        if (n.getAttribute === undefined) continue;
        const name = NAMED.has(n.tagName) ? n.getAttribute('name') : null;
        const id = n.tagName === 'img' || n.tagName === 'object' ? n.getAttribute('id') : null;
        for (const key of [name, id]) if (key && !held.has(key)) held.set(key, n);
      }
      for (const key of named) if (!held.has(key)) delete (/** @type {any} */ (this))[key];
      for (const [key, element] of held) Object.defineProperty(this, key, { value: element, writable: false, configurable: true });
      named = new Set(held.keys());
    }
  }
  const document = new Document();
  body = document.createElement('body');
  const container = document.createElement('main');
  body.appendChild(container);
  return { document, container, focused: () => active };
}

/** The `document` members the renderer calls as it builds a frame. */
const BUILDING = ['createElement', 'createElementNS', 'createTextNode'];

describe('a document element named after a document member', () => {
  it('leaves every later frame building as under any other name', () => {
    for (const tag of NAMED) {
      for (const member of ['x', ...BUILDING]) {
        const { document, container } = namedDocument();
        const render = createDomRenderer(container, { document });
        render(['div', {}, [tag, { name: member }]]);
        document.refresh();
        assert.equal(/** @type {any} */ (document)[member].tagName, tag, `${tag} ${member}: the document answers the name`);
        render(['div', {}, [tag, { name: member }], ['p', {}, 'x'], ['svg', {}, ['g', {}]]]);
        assert.equal(serialize(container),
          `<main><div><${tag} name="${member}"></${tag}><p>x</p><svg><g></g></svg></div></main>`, `${tag} ${member}`);
      }
    }
  });

  it('leaves a safe root of the same document building, in every profile', () => {
    for (const safe of /** @type {const} */ ([true, 'interactive'])) {
      for (const member of BUILDING) {
        const { document, container } = namedDocument();
        createDomRenderer(container, { document })(['div', {}, ['img', { name: member }], ['section', {}]]);
        document.refresh();
        const section = container.childNodes[0].childNodes[1];
        createDomRenderer(section, { document, safe })(['p', { class: 'c' }, 'safe']);
        assert.equal(serialize(section), '<section><p class="c">safe</p></section>', `${member}, safe: ${safe}`);
      }
    }
  });

  it('reports a prefixed id the page holds beside an img named getElementById', () => {
    for (const member of ['x', 'getElementById']) {
      const { document, container } = namedDocument();
      createDomRenderer(container, { document })(['div', {}, ['img', { name: member }], ['p', { id: 'jaren-u-a' }], ['section', {}]]);
      document.refresh();
      /** @type {unknown[]} */
      const reports = [];
      createDomRenderer(container.childNodes[0].childNodes[2], { document, safe: true, onUnsafe: (r) => reports.push(r) })(['p', { id: 'a' }]);
      assert.deepEqual(reports, [{ kind: 'id', name: 'jaren-u-a' }], member);
    }
  });

  it('reports a prefixed name the page holds beside an img named querySelectorAll', () => {
    for (const member of ['x', 'querySelectorAll']) {
      const { document, container } = namedDocument();
      createDomRenderer(container, { document })(['div', {}, ['img', { name: member }], ['form', { name: 'jaren-u-f' }], ['section', {}]]);
      document.refresh();
      /** @type {unknown[]} */
      const reports = [];
      createDomRenderer(container.childNodes[0].childNodes[2], { document, safe: true, onUnsafe: (r) => reports.push(r) })(['form', { name: 'f' }]);
      assert.deepEqual(reports, [{ kind: 'name', name: 'jaren-u-f' }], member);
    }
  });

  it('holds a focused edit back under controlled: focus beside an img named activeElement', () => {
    for (const member of ['x', 'activeElement']) {
      const { document, container } = namedDocument();
      const render = createDomRenderer(container, { document, controlled: 'focus' });
      render(['div', {}, ['img', { name: member }], ['input', { value: 'a' }]]);
      document.refresh();
      const input = /** @type {any} */ (container.childNodes[0].childNodes[1]);
      input.focus();
      input.value = 'typed';
      render(['div', {}, ['img', { name: member }], ['input', { value: 'b' }]]);
      assert.equal(input.value, 'typed', member);
    }
  });

  it('opens and closes a dialog on a page whose elements are named after the members it calls', () => {
    /** @type {Record<string, string>} */
    const answers = {};
    for (const member of ['x', 'createElement', 'activeElement', 'getElementById', 'body', 'defaultView']) {
      const { document, container, focused } = namedDocument();
      createDomRenderer(container, { document })(['div', {}, ['img', { name: member }], ['button', { 'data-ref': 'back' }, 'b'], ['div', {}]]);
      document.refresh();
      const host = /** @type {any} */ (container.childNodes[0].childNodes[2]);
      try {
        const owner = createDialog(host, { id: 'd', title: 'T', open: true, content: ['p', {}, 'c'], fallbackFocusRef: 'back' });
        const dialog = host.childNodes[0];
        const opened = [dialog.open, focused() === dialog.childNodes[2]];
        owner.update({ id: 'd', title: 'T', open: false, fallbackFocusRef: 'back' });
        answers[member] = JSON.stringify([...opened, dialog.open, focused() === container.childNodes[0].childNodes[1], serialize(host)]);
      }
      catch (error) {
        answers[member] = String(error);
      }
    }
    // open, the close button focused; closed, the fallback focused; the markup
    const want = JSON.stringify([true, true, false, true, '<div><dialog class="jaren-dialog" role="dialog" aria-modal="true" id="d" aria-labelledby="d-title">'
      + '<h2 tabindex="-1" id="d-title">T</h2><div></div><button type="button" data-dialog-close>Close</button></dialog></div>']);
    assert.deepEqual(answers, Object.fromEntries(Object.keys(answers).map((member) => [member, want])));
  });
});

describe('the document\'s own creators', () => {
  it('are called first: a patch set on the document object reaches the renderer', () => {
    const { document, container } = namedDocument();
    /** @type {string[]} */
    const calls = [];
    const own = document.createElement.bind(document);
    /** @type {any} */ (document).createElement = (/** @type {string} */ tag) => { calls.push(tag); return own(tag); };
    createDomRenderer(container, { document })(['div', {}, ['b', {}, 'x']]);
    assert.deepEqual(calls, ['div', 'b']);
  });

  it('rethrow what they throw on their own, unshadowed', () => {
    const { document, container } = namedDocument();
    const own = Object.getPrototypeOf(document).createElement;
    let refused = 0;
    Object.getPrototypeOf(document).createElement = function (/** @type {string} */ tag) {
      if (tag === 'x-refused') { refused++; throw new RangeError('refused'); }
      return own.call(this, tag);
    };
    try {
      assert.throws(() => createDomRenderer(container, { document })(['div', {}, ['x-refused', {}]]), RangeError);
      assert.equal(refused, 1, 'called once, not again through the interface');
    }
    finally {
      Object.getPrototypeOf(document).createElement = own;
    }
  });

  it('a double with no Document interface whose creator is taken over rethrows the call\'s error', () => {
    const document = new StubDocument();
    const container = document.createElement('main');
    Object.defineProperty(document, 'createElement', { value: container, configurable: true });
    assert.throws(() => createDomRenderer(container, { document })(['div', {}]), TypeError);
  });
});

describe('a document double with no Document interface', () => {
  it('is asked for every member directly, as before', () => {
    const document = new StubDocument();
    /** @type {string[]} */
    const calls = [];
    for (const member of BUILDING) {
      const own = /** @type {any} */ (document)[member].bind(document);
      /** @type {any} */ (document)[member] = (/** @type {any[]} */ ...args) => { calls.push(member); return own(...args); };
    }
    const container = document.createElement('main');
    calls.length = 0;
    createDomRenderer(container, { document })(['div', {}, 'x', ['svg', {}]]);
    assert.deepEqual(calls.sort(), ['createElement', 'createElementNS', 'createTextNode']);
  });
});
