//@ts-check
/**
 * @file The optional tooltips on every diagram type's nodes and edges.
 *
 * The behaviour worth pinning is what a keyboard user and a mouse user are
 * each told, and that the wiring a screen reader needs (role, description
 * reference, focusable node) exists exactly while the tooltip does. The DOM
 * here is built from the renderer's real vnodes, so the test also proves the
 * markers the hydrate reads are the ones the render writes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { diagramToVnode } from '@jarenjs/mermaid';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';
import { attachDiagramTooltips } from '@jarenjs/mermaid/tooltips';

/** `tag.class[attr]` compound selectors: all this module and its tests use. */
function matches(node, selector) {
  const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(selector);
  assert.ok(m !== null, `the stub understands only compound selectors: ${selector}`);
  if (m[1] !== undefined && node.tagName !== m[1]) return false;
  for (const cls of m[2].split('.').filter(Boolean)) if (!node.classes.has(cls)) return false;
  for (const attr of m[3].split(/[[\]]/).filter(Boolean)) if (!node.attrs.has(attr)) return false;
  return true;
}

class Node {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = new Map();
    this.classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = new Map();
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.text = '';
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.text = String(v); this.children = []; }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'class') this.className = v;
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, selector)) found.push(c);
        walk(c);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let n = this; n !== null; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }
  addEventListener(type, fn, capture) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    if (capture !== undefined) (this.captures ??= []).push([type, capture]);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  getBoundingClientRect() { return this.rect; }
}

/** Build stub elements from the renderer's tagged-array vnodes. */
function build(vnode) {
  if (typeof vnode === 'string') { const t = new Node('#text'); t.text = vnode; return t; }
  const [tag, props, ...kids] = vnode;
  const node = new Node(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') node.setAttribute(k, v);
  }
  const add = (kid) => {
    if (kid === null || kid === undefined || kid === false) return;
    // A vnode starts with its tag; any other array is a list of children.
    if (Array.isArray(kid) && typeof kid[0] !== 'string') kid.forEach(add);
    else node.appendChild(build(kid));
  };
  kids.forEach(add);
  return node;
}

/** A figure element around the rendered diagram, as the md component has it. */
function figure(source, options = {}) {
  const el = new Node('div');
  el.appendChild(build(diagramToVnode(source, options)));
  const document = new Node('#document');
  document.createElement = (tag) => new Node(tag);
  document.documentElement = { clientWidth: 800, clientHeight: 600 };
  el.ownerDocument = document;
  el.clientWidth = 400;
  el.scrollWidth = 400;
  el.scrollHeight = 200;
  el.scrollLeft = 0;
  el.scrollTop = 0;
  const svg = el.querySelector('svg');
  const node = (id) => svg.querySelectorAll('.mm-node').find((n) => n.getAttribute('data-id') === id);
  const tip = () => el.children.find((c) => c.classes.has('mm-tooltip'));
  /** Dispatch bubbling from `target` up through its ancestors. */
  const fire = (target, type, props = {}) => {
    const event = { type, target, key: undefined, relatedTarget: null, ...props };
    for (let n = target; n !== null; n = n.parentNode)
      for (const fn of n.listeners.get(type) ?? []) fn(event);
  };
  return { el, svg, document, node, tip, fire };
}

const FLOW = 'flowchart LR\n  A["Start"] --> B{"Pick"}\n  B -->|yes| C[Done]\n  B -->|no| A';

describe('tooltips — what a node says', () => {
  it('names the node and what flows into and out of it, by label', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('B'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'Pick (B)\nfrom: Start\nto: Done (yes), Start (no)');
    f.fire(f.node('B'), 'focusout');
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'Start (A)\nfrom: Pick (no)\nto: Pick');
    f.fire(f.node('A'), 'focusout');
    f.fire(f.node('C'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'Done (C)\nfrom: Pick (yes)');
  });

  it('shows the bare id when the label is the id, and joins a multi-line label', () => {
    const f = figure('flowchart LR\n  A --> B["one<br/>two"]');
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'A\nto: one two');
    f.fire(f.node('A'), 'focusout');
    f.fire(f.node('B'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'one two (B)\nfrom: A');
  });

  it('reads HTML labels as it reads SVG text, one space between their lines', () => {
    for (const [source, id, text] of [
      [FLOW, 'B', 'Pick (B)\nfrom: Start\nto: Done (yes), Start (no)'],
      ['flowchart LR\n  A --> B["one<br/>two"]', 'B', 'one two (B)\nfrom: A'],
      ['flowchart LR\n  A --> B["one<br/>two"]', 'A', 'A\nto: one two'],
    ]) {
      for (const htmlLabels of [false, true]) {
        const f = figure(source, { htmlLabels });
        assert.equal(f.svg.querySelectorAll('div').length > 0, htmlLabels);
        attachDiagramTooltips(f.el, { document: f.document });
        f.fire(f.node(id), 'focusin');
        assert.strictEqual(f.tip().textContent, text, source);
      }
    }
  });

  it('reads a state diagram, naming the unlabelled start state as a word', () => {
    const f = figure('stateDiagram-v2\n  [*] --> S1\n  S1 --> S2');
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('__start'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'start\nto: S1');
    f.fire(f.node('__start'), 'focusout');
    f.fire(f.node('S1'), 'focusin');
    assert.strictEqual(f.tip().textContent, 'S1\nfrom: start\nto: S2');
  });
});

describe('tooltips — focus, hover and the wiring a screen reader reads', () => {
  it('makes every node focusable and named', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    for (const id of ['A', 'B', 'C']) {
      assert.strictEqual(f.node(id).getAttribute('tabindex'), '0');
      assert.strictEqual(f.node(id).getAttribute('role'), 'img');
    }
    assert.strictEqual(f.node('B').getAttribute('aria-label'), 'Pick (B)');
    assert.ok(f.el.classes.has('mm-has-tooltips'));
  });

  it('shows on focus and points the node at the tooltip only while shown', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    const tip = f.tip();
    assert.strictEqual(tip.getAttribute('role'), 'tooltip');
    assert.ok(tip.attrs.has('hidden'), 'hidden until a node is focused or hovered');
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), null);

    f.fire(f.node('A'), 'focusin');
    assert.ok(!tip.attrs.has('hidden'));
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), tip.id);
    assert.match(tip.id, /^mm-tooltip-\d+$/);

    f.fire(f.node('A'), 'focusout', { relatedTarget: null });
    assert.ok(tip.attrs.has('hidden'));
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), null);
  });

  it('moves the description when focus moves node to node', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    f.fire(f.node('A'), 'focusout', { relatedTarget: f.node('B') });
    f.fire(f.node('B'), 'focusin');
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), null);
    assert.strictEqual(f.node('B').getAttribute('aria-describedby'), f.tip().id);
    assert.match(f.tip().textContent, /^Pick \(B\)/);
  });

  it('shows on mouse hover, stays while the pointer moves inside the node, hides on leaving', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    const shape = f.node('A').children[0];
    const label = f.node('A').children[1];
    f.fire(shape, 'pointerover', { pointerType: 'mouse' });
    assert.ok(!f.tip().attrs.has('hidden'));
    // Crossing from the shape to the label is still the same node.
    f.fire(shape, 'pointerout', { pointerType: 'mouse', relatedTarget: label });
    assert.ok(!f.tip().attrs.has('hidden'), 'leaving the shape for its own label is not leaving');
    f.fire(label, 'pointerover', { pointerType: 'mouse' });
    assert.ok(!f.tip().attrs.has('hidden'), 'moving within a node must not flicker');
    f.fire(label, 'pointerout', { pointerType: 'mouse', relatedTarget: f.svg });
    assert.ok(f.tip().attrs.has('hidden'));
  });

  it('never hovers for touch', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'pointerover', { pointerType: 'touch' });
    assert.ok(f.tip().attrs.has('hidden'), 'a tap is the page\'s');
  });

  it('is dismissed by Escape and ignores other keys', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    f.fire(f.document, 'keydown', { key: 'ArrowRight' });
    assert.ok(!f.tip().attrs.has('hidden'));
    f.fire(f.document, 'keydown', { key: 'Escape' });
    assert.ok(f.tip().attrs.has('hidden'));
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), null);
  });

  it('dismisses a hover-shown tooltip with Escape even though focus is elsewhere', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'pointerover', { pointerType: 'mouse' });
    assert.ok(!f.tip().attrs.has('hidden'));
    // The key goes to the document (focus is on the body), not into the figure.
    f.fire(f.document, 'keydown', { key: 'Escape' });
    assert.ok(f.tip().attrs.has('hidden'));
    assert.strictEqual(f.node('A').getAttribute('aria-describedby'), null);
  });

  it('keeps a focus-shown tooltip when a touch pointer leaves the node', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    // A tap focuses the node and then the finger lifts: pointerout is synthetic.
    f.fire(f.node('A'), 'pointerout', { pointerType: 'touch', relatedTarget: null });
    assert.ok(!f.tip().attrs.has('hidden'), 'a touch pointerout must not hide the focus tooltip');
    f.fire(f.node('A'), 'pointerout', { pointerType: 'mouse', relatedTarget: null });
    assert.ok(f.tip().attrs.has('hidden'), 'a mouse pointerout does');
  });

  it('gives two diagrams on one page two tooltip ids', () => {
    const a = figure(FLOW);
    const b = figure(FLOW);
    attachDiagramTooltips(a.el, { document: a.document });
    attachDiagramTooltips(b.el, { document: b.document });
    assert.notStrictEqual(a.tip().id, b.tip().id);
  });
});

describe('tooltips — the scrolling figure never clips or grows from them', () => {
  it('is fixed to the viewport and placed from the node\'s client rectangle alone', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    assert.strictEqual(f.tip().style.position, 'fixed');
    // The frame is scrolled and offset; none of that may enter the answer.
    f.el.rect = { left: 10, top: 20, right: 410, bottom: 220, width: 400, height: 200 };
    f.el.scrollLeft = 5;
    f.el.scrollTop = 7;
    f.node('A').rect = { left: 50, top: 60, right: 90, bottom: 90, width: 40, height: 30 };
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().style.left, '50px');
    assert.strictEqual(f.tip().style.top, '96px');
  });

  it('leaves the frame\'s scroll area alone when a last-row node is focused', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    const before = [f.el.scrollWidth, f.el.scrollHeight, f.el.clientWidth];
    // The node sits on the frame's bottom edge, where an in-flow tooltip would
    // spill below it.
    f.node('C').rect = { left: 300, top: 170, right: 360, bottom: 200, width: 60, height: 30 };
    f.fire(f.node('C'), 'focusin');
    assert.deepStrictEqual([f.el.scrollWidth, f.el.scrollHeight, f.el.clientWidth], before);
    assert.strictEqual(f.tip().style.position, 'fixed', 'out of flow, so it adds no scroll height');
    assert.ok(f.tip().style.left !== undefined && f.tip().style.top === '206px');
  });

  it('promotes the tooltip to the top layer where the browser has popovers', () => {
    const f = figure(FLOW);
    const calls = [];
    const make = f.document.createElement;
    f.document.createElement = (tag) => {
      const node = make(tag);
      if (tag === 'div') {
        node.showPopover = () => calls.push('show');
        node.hidePopover = () => calls.push('hide');
      }
      return node;
    };
    attachDiagramTooltips(f.el, { document: f.document });
    assert.strictEqual(f.tip().getAttribute('popover'), 'manual');
    f.fire(f.node('A'), 'focusin');
    f.fire(f.node('A'), 'focusin');
    assert.deepStrictEqual(calls, ['show'], 'the same node is not shown twice');
    f.fire(f.node('B'), 'focusin');
    assert.deepStrictEqual(calls, ['show', 'hide', 'show']);
    f.fire(f.document, 'keydown', { key: 'Escape' });
    assert.deepStrictEqual(calls, ['show', 'hide', 'show', 'hide']);
  });

  it('has no popover attribute without the API, and survives a figure outside the document', () => {
    const plain = figure(FLOW);
    attachDiagramTooltips(plain.el, { document: plain.document });
    assert.strictEqual(plain.tip().getAttribute('popover'), null);

    const f = figure(FLOW);
    const make = f.document.createElement;
    f.document.createElement = (tag) => {
      const node = make(tag);
      if (tag === 'div') {
        node.showPopover = () => { throw new Error('InvalidStateError'); };
        node.hidePopover = () => {};
      }
      return node;
    };
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    assert.ok(!f.tip().attrs.has('hidden'), 'a declined top layer does not take the tooltip down');
  });

  it('flips above the node when there is no room below, and stays inside the viewport', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    f.tip().offsetWidth = 100;
    f.tip().offsetHeight = 50;
    f.node('A').rect = { left: 780, top: 560, right: 800, bottom: 590, width: 20, height: 30 };
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().style.left, '700px');
    assert.strictEqual(f.tip().style.top, '504px');
    f.fire(f.node('A'), 'focusout');
    // No room above either: below it stays.
    f.node('B').rect = { left: 10, top: 5, right: 30, bottom: 590, width: 20, height: 585 };
    f.fire(f.node('B'), 'focusin');
    assert.strictEqual(f.tip().style.top, '596px');
    assert.strictEqual(f.tip().style.left, '10px');
    f.fire(f.node('B'), 'focusout');
    // A node scrolled half out of the viewport still gets a tooltip on screen.
    f.node('C').rect = { left: -30, top: 100, right: 10, bottom: 130, width: 40, height: 30 };
    f.fire(f.node('C'), 'focusin');
    assert.strictEqual(f.tip().style.left, '0px');
  });

  it('is placed again when the viewBox changes or anything scrolls, and stops watching on teardown', () => {
    const f = figure(FLOW);
    let watched = null;
    let disconnected = false;
    class Observer {
      constructor(callback) { this.callback = callback; watched = this; }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { disconnected = true; }
    }
    const detach = attachDiagramTooltips(f.el, { document: f.document, MutationObserver: Observer });
    assert.strictEqual(watched.target, f.svg);
    assert.deepStrictEqual(watched.options, { attributes: true, attributeFilter: ['viewBox'] });
    f.node('A').rect = { left: 20, top: 10, right: 60, bottom: 40, width: 40, height: 30 };
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().style.top, '46px');
    // A zoom moves the node; the observer is what tells the tooltip.
    f.node('A').rect = { left: 120, top: 100, right: 200, bottom: 160, width: 80, height: 60 };
    watched.callback();
    assert.strictEqual(f.tip().style.left, '120px');
    assert.strictEqual(f.tip().style.top, '166px');
    // A scroll of the page or of the frame moves it too; scroll does not bubble,
    // so the listener has to be a capturing one on the document.
    f.node('A').rect = { left: 130, top: 90, right: 210, bottom: 150, width: 80, height: 60 };
    for (const fn of f.document.listeners.get('scroll')) fn({});
    assert.strictEqual(f.tip().style.top, '156px');
    assert.deepStrictEqual(f.document.captures, [['scroll', true]]);
    detach();
    assert.ok(disconnected);
    assert.strictEqual(f.document.listeners.get('scroll').length, 0);
  });
});

describe('tooltips — attach and teardown', () => {
  it('removes everything it added', () => {
    const f = figure(FLOW);
    const detach = attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    detach();
    assert.strictEqual(f.tip(), undefined, 'the tooltip element is removed');
    for (const id of ['A', 'B', 'C']) {
      for (const attr of ['tabindex', 'role', 'aria-label', 'aria-describedby'])
        assert.strictEqual(f.node(id).getAttribute(attr), null, `${id} ${attr}`);
    }
    assert.ok(!f.el.classes.has('mm-has-tooltips'));
    for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout'])
      assert.strictEqual(f.svg.listeners.get(type).length, 0, type);
    assert.strictEqual(f.document.listeners.get('keydown').length, 0);
    assert.strictEqual(f.document.listeners.get('scroll').length, 0);
  });

  it('attaches once per element: a second call returns the same teardown', () => {
    const f = figure(FLOW);
    const first = attachDiagramTooltips(f.el, { document: f.document });
    const second = attachDiagramTooltips(f.el, { document: f.document });
    assert.strictEqual(second, first);
    assert.strictEqual(f.el.children.filter((c) => c.classes.has('mm-tooltip')).length, 1);
    first();
    // Torn down, it can be attached afresh.
    const third = attachDiagramTooltips(f.el, { document: f.document });
    assert.notStrictEqual(third, first);
    assert.strictEqual(f.el.children.filter((c) => c.classes.has('mm-tooltip')).length, 1);
  });

  it('declines what it cannot drive, leaving the element untouched', () => {
    assert.strictEqual(attachDiagramTooltips({ querySelector: () => null }), undefined);

    const noDocument = figure(FLOW);
    delete noDocument.el.ownerDocument;
    assert.strictEqual(attachDiagramTooltips(noDocument.el, { document: null }), undefined);
    assert.strictEqual(noDocument.node('A').getAttribute('tabindex'), null);

    const noEvents = figure(FLOW);
    noEvents.document.addEventListener = undefined;
    assert.strictEqual(attachDiagramTooltips(noEvents.el, { document: noEvents.document }), undefined,
      'Escape and scroll need a document to listen on');
    assert.strictEqual(noEvents.node('A').getAttribute('tabindex'), null);

    // A placeholder, a pie without its renderer and a parse error draw no
    // marked node or edge: nothing to point at.
    for (const source of ['journey\n  title J\n  section S\n    a: 5: me', 'pie\n  "a" : 1', 'flowchart LR\n  A["x']) {
      const none = figure(source);
      const before = none.el.children.length;
      assert.strictEqual(attachDiagramTooltips(none.el, { document: none.document }), undefined, source);
      assert.strictEqual(none.el.children.length, before, source);
      assert.ok(!none.el.classes.has('mm-has-tooltips'), source);
    }
  });
});

/** Every element of `selector` whose `attr` is `value`. */
const all = (f, selector, attr, value) => f.svg.querySelectorAll(selector).filter((n) => n.getAttribute(attr) === String(value));
/** Focus `target`, read the tooltip, and move focus away again. */
const say = (f, target) => {
  f.fire(target, 'focusin');
  const text = f.tip().textContent;
  f.fire(target, 'focusout', { relatedTarget: null });
  return text;
};

describe('tooltips — every type that draws something to point at', () => {
  const SEQUENCE = 'sequenceDiagram\n  participant A as Alice\n  A->>B: hi\n  B-->>A: ok\n  A->>A: self';

  it('names a sequence actor, on both of its boxes, by the messages that reach and leave it', () => {
    const f = figure(SEQUENCE);
    attachDiagramTooltips(f.el, { document: f.document });
    const alice = all(f, '.mm-node', 'data-id', 'A');
    assert.strictEqual(alice.length, 2, 'the head box and the foot box');
    for (const box of alice) {
      assert.strictEqual(box.getAttribute('tabindex'), '0');
      assert.strictEqual(box.getAttribute('role'), 'img');
      assert.strictEqual(box.getAttribute('aria-label'), 'Alice (A)');
      assert.strictEqual(say(f, box), 'Alice (A)\nfrom: B (ok), Alice (self)\nto: B (hi), Alice (self)');
    }
    assert.strictEqual(say(f, all(f, '.mm-node', 'data-id', 'B')[1]), 'B\nfrom: Alice (hi)\nto: Alice (ok)');
  });

  it('names a sequence message by its two ends and its text', () => {
    const f = figure(SEQUENCE);
    attachDiagramTooltips(f.el, { document: f.document });
    const message = (i) => all(f, '.mm-edge', 'data-edge', i)[0];
    assert.strictEqual(say(f, message(0)), 'Alice → B (hi)');
    assert.strictEqual(say(f, message(1)), 'B → Alice (ok)');
    assert.strictEqual(say(f, message(2)), 'Alice → Alice (self)');
    assert.strictEqual(message(0).getAttribute('aria-label'), 'Alice → B (hi)');
    assert.strictEqual(message(0).getAttribute('tabindex'), '0');
  });

  it('names a class and an entity by its box, and its relations by their rows', () => {
    const cls = figure('classDiagram\n  class Animal {\n    +name\n  }\n  Animal <|-- Dog : extends\n  Animal <|-- Cat');
    attachDiagramTooltips(cls.el, { document: cls.document });
    assert.strictEqual(say(cls, cls.node('Animal')), 'Animal\nto: Dog, Cat');
    assert.strictEqual(say(cls, cls.node('Dog')), 'Dog\nfrom: Animal');
    assert.strictEqual(say(cls, all(cls, '.mm-edge', 'data-edge', 0)[0]), 'Animal → Dog');
    assert.strictEqual(cls.svg.querySelectorAll('.mm-node').length, 3, 'the relations box is not a class');

    const er = figure('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string name PK\n  }');
    attachDiagramTooltips(er.el, { document: er.document });
    assert.strictEqual(say(er, er.node('CUSTOMER')), 'CUSTOMER\nto: ORDER');
    assert.strictEqual(say(er, er.node('ORDER')), 'ORDER\nfrom: CUSTOMER');
    assert.strictEqual(say(er, all(er, '.mm-edge', 'data-edge', 0)[0]), 'CUSTOMER → ORDER');
  });

  const GANTT = 'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  A task :a1, 2024-01-01, 3d\n  B task :after a1, 2d';

  it('names a gantt row by the dependencies that reach and leave it, and a connector by its ends', () => {
    const f = figure(GANTT);
    attachDiagramTooltips(f.el, { document: f.document });
    assert.strictEqual(say(f, f.node('a1')), 'A task (a1)\nto: B task');
    assert.strictEqual(say(f, f.node('task1')), 'B task (task1)\nfrom: A task');
    const link = all(f, '.mm-edge', 'data-edge', 0)[0];
    assert.ok(link.classes.has('mm-gantt-link'));
    assert.strictEqual(say(f, link), 'A task → B task');
  });

  it('reaches a linked gantt row through its link, and leaves the link a link', () => {
    const f = figure(`${GANTT}\n  click a1 href "https://x.test/a"`);
    attachDiagramTooltips(f.el, { document: f.document });
    const row = f.node('a1');
    const link = row.querySelector('a');
    for (const attr of ['tabindex', 'role', 'aria-label'])
      assert.strictEqual(row.getAttribute(attr), null, `the row gains no ${attr}`);
    f.fire(link, 'focusin');
    assert.strictEqual(f.tip().textContent, 'A task (a1)\nto: B task');
    assert.strictEqual(link.getAttribute('aria-describedby'), f.tip().id, 'the link is what the tooltip describes');
    assert.strictEqual(row.getAttribute('aria-describedby'), null);
    f.fire(f.document, 'keydown', { key: 'Escape' });
    assert.ok(f.tip().attrs.has('hidden'));
    assert.strictEqual(link.getAttribute('aria-describedby'), null);
    // the unlinked row is reached as every other node is
    assert.strictEqual(f.node('task1').getAttribute('tabindex'), '0');
  });

  it('names a flowchart link by its two ends and its label', () => {
    const f = figure(FLOW);
    attachDiagramTooltips(f.el, { document: f.document });
    const edge = (i) => all(f, '.mm-edge', 'data-edge', i)[0];
    assert.strictEqual(say(f, edge(0)), 'Start → Pick');
    assert.strictEqual(say(f, edge(1)), 'Pick → Done (yes)');
    assert.strictEqual(say(f, edge(2)), 'Pick → Start (no)');
    assert.strictEqual(edge(1).getAttribute('role'), 'img');
  });

  it('shows, hides and dismisses the same way on every type', () => {
    for (const [source, pick] of [
      [SEQUENCE, (f) => all(f, '.mm-edge', 'data-edge', 0)[0]],
      ['classDiagram\n  Animal <|-- Dog', (f) => f.node('Dog')],
      [GANTT, (f) => f.node('a1')],
    ]) {
      const f = figure(source);
      const detach = attachDiagramTooltips(f.el, { document: f.document });
      const target = pick(f);
      f.fire(target, 'pointerover', { pointerType: 'touch' });
      assert.ok(f.tip().attrs.has('hidden'), `${source}: touch never hovers`);
      f.fire(target, 'pointerover', { pointerType: 'mouse' });
      assert.ok(!f.tip().attrs.has('hidden'), source);
      assert.strictEqual(target.getAttribute('aria-describedby'), f.tip().id, source);
      f.fire(f.document, 'keydown', { key: 'Escape' });
      assert.ok(f.tip().attrs.has('hidden'), `${source}: Escape`);
      assert.strictEqual(target.getAttribute('aria-describedby'), null, source);
      f.fire(target, 'focusin');
      assert.ok(!f.tip().attrs.has('hidden'), `${source}: focus`);
      f.fire(target, 'pointerout', { pointerType: 'mouse', relatedTarget: f.svg });
      assert.ok(f.tip().attrs.has('hidden'), `${source}: leaving`);
      detach();
      assert.strictEqual(target.getAttribute('tabindex'), null, `${source}: torn down`);
      assert.strictEqual(target.getAttribute('role'), null, source);
    }
  });
});

describe('tooltips — the text a click statement gives a node', () => {
  const HOSTILE = '<img src=x onerror=alert(1)> & <b>bold</b>';

  it('shows the author text instead of the derived text, as text', () => {
    const f = figure(`flowchart LR\n  A["Start"] --> B\n  click A "https://x.test" "${HOSTILE}"`);
    attachDiagramTooltips(f.el, { document: f.document });
    f.fire(f.node('A'), 'focusin');
    assert.strictEqual(f.tip().textContent, HOSTILE);
    assert.strictEqual(f.tip().children.length, 0, 'set as text: no element was built from it');
    assert.strictEqual(f.node('A').getAttribute('aria-label'), 'Start (A)', 'the name stays the node\'s');
    f.fire(f.node('A'), 'focusout');
    assert.strictEqual(say(f, f.node('B')), 'B\nfrom: Start', 'a node without one keeps the derived text');
  });

  it('shows a class click tooltip on its box', () => {
    const f = figure('classDiagram\n  class Foo\n  click Foo call show() "Shows <it>"');
    attachDiagramTooltips(f.el, { document: f.document });
    assert.strictEqual(say(f, f.node('Foo')), 'Shows <it>');
  });
});

describe('tooltips — the plugin opts in, and only then', () => {
  const node = { value: FLOW };

  it('leaves server output and the hydrate hook alone unless asked', () => {
    const plain = mermaidPlugin();
    const expected = JSON.stringify(plain.render(node));
    assert.strictEqual(plain.hydrate, undefined);
    assert.strictEqual(plain.render(node)[1]['data-md-hydrate'], undefined);
    assert.strictEqual(plain.render(node)[1]['data-md-hash'], undefined);
    for (const options of [{ tooltips: false }, { tooltips: 'yes' }, { tooltips: 1 }]) {
      const plugin = mermaidPlugin(options);
      assert.strictEqual(plugin.hydrate, undefined, JSON.stringify(options));
      assert.strictEqual(JSON.stringify(plugin.render(node)), expected, JSON.stringify(options));
    }
  });

  it('marks the block for hydration and keeps the SVG byte-identical', () => {
    for (const value of [
      FLOW, 'sequenceDiagram\n  A->>B: hi', 'classDiagram\n  Animal <|-- Dog', 'erDiagram\n  A ||--o{ B : has',
      'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  A :a1, 2024-01-01, 3d\n  click a1 href "https://x.test"',
      'flowchart LR\n  A --> B\n  click A cb "tip"',
    ]) {
      const plain = mermaidPlugin().render({ value });
      for (const options of [{ tooltips: true }, { interactive: true }, { interactive: true, tooltips: true }]) {
        const live = mermaidPlugin(options);
        const out = live.render({ value });
        assert.strictEqual(out[1]['data-md-hydrate'], 'mermaid', JSON.stringify(options));
        assert.strictEqual(typeof live.hydrate, 'function');
        assert.strictEqual(JSON.stringify(out[2]), JSON.stringify(plain[2]),
          `${JSON.stringify(options)}: the SVG is the same with and without hydration\n${value}`);
      }
    }
  });

  it('hydrates tooltips alone without pan, zoom or controls', async () => {
    const f = figure(FLOW);
    await mermaidPlugin({ tooltips: true }).hydrate(f.el);
    assert.ok(f.el.classes.has('mm-has-tooltips'));
    assert.strictEqual(f.node('A').getAttribute('tabindex'), '0');
    assert.strictEqual(f.el.getAttribute('tabindex'), null, 'the figure is not made a pan/zoom surface');
    assert.ok(!f.el.classes.has('mm-interactive'));
    assert.ok(!f.el.children.some((c) => c.classes.has('mm-controls')));
  });

  it('hydrates pan/zoom alone without tooltips', async () => {
    const f = figure(FLOW);
    await mermaidPlugin({ interactive: true }).hydrate(f.el);
    assert.ok(f.el.classes.has('mm-interactive'));
    assert.ok(!f.el.classes.has('mm-has-tooltips'));
    assert.strictEqual(f.tip(), undefined);
    assert.strictEqual(f.node('A').getAttribute('tabindex'), null);
  });

  it('hydrates both together', async () => {
    const f = figure(FLOW);
    await mermaidPlugin({ interactive: true, tooltips: true }).hydrate(f.el);
    assert.ok(f.el.classes.has('mm-interactive'));
    assert.ok(f.el.classes.has('mm-has-tooltips'));
    f.fire(f.node('B'), 'focusin');
    assert.ok(!f.tip().attrs.has('hidden'));
  });
});

describe('markers — one contract, and no type reaches another type\'s code', () => {
  it('marks every type through the one module, which no renderer passes another renderer through', () => {
    const read = (file) => readFileSync(new URL(`../../components/mermaid/src/${file}`, import.meta.url), 'utf8');
    for (const file of ['flowchart', 'sequence', 'gantt', 'misc']) {
      const siblings = [...read(`render/${file}.js`).matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => m[1]);
      assert.deepStrictEqual(siblings, ['marks'], `render/${file}.js imports no other renderer`);
    }
    assert.ok(!/^import /m.test(read('render/marks.js')), 'the marker module imports nothing');
    assert.ok(!/^import /m.test(read('tooltips.js')), 'the tooltip module reads the DOM, never a renderer');
  });
});
