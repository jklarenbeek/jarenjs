//@ts-check
/**
 * @file The interactive render profile (`safe: 'interactive'`): the safe
 * profile's sanitizer, unchanged, plus data-only `on` bindings on an
 * allow-list of gesture events and the widgets the host granted by name.
 *
 * Three claims, each pinned on the DOM renderer AND the serializer:
 *  1. every document of the safe attack corpus renders to the same bytes and
 *     the same reports under both profiles, and the DOM agrees with the
 *     serializer — except the `textarea` and `select` values the profile
 *     controls, pinned to their exact bytes;
 *  2. a binding is kept only when it is JSON data on an allowed event, and the
 *     handler receives a frozen data projection, never the native Event or a
 *     node;
 *  3. a widget renders only when its name is granted, its host tag passes the
 *     tag allow-list and its props are data — and what it renders through the
 *     context it is handed stays under the same profile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDomRenderer, renderToString, createSafePolicy } from '@jarenjs/view';

import { bookkeeping, createStubHost, fire } from './dom.stub.js';
import { CONTROLLED_CORPUS, SAFE_CORPUS, childMarkup } from './interactive-corpus.js';

const INTERACTIVE = /** @type {const} */ ('interactive');

/**
 * A renderer over a fresh stub host, recording reports and fired bindings.
 * @param {Record<string, any>} [options]
 */
function host(options = {}) {
  const { document, container } = createStubHost();
  /** @type {string[]} */
  const seen = [];
  /** @type {Array<{ binding: any, event: any }>} */
  const events = [];
  const render = createDomRenderer(container, {
    document,
    onEvent: (binding, event) => events.push({ binding, event }),
    onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`),
    ...options,
  });
  return { render, container, seen, events, document };
}

/**
 * Serialize with a report sink.
 * @param {any} vnode
 * @param {Record<string, any>} [options]
 */
function ssr(vnode, options = {}) {
  /** @type {string[]} */
  const seen = [];
  const html = renderToString(vnode, { onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`), ...options });
  return { html, seen };
}

const sorted = (list) => [...list].sort();

/** Every event type a binding may name under the profile. */
const ALLOWED = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'keydown', 'keyup', 'input', 'change', 'submit', 'reset', 'blur', 'focusout'];

/** Event types a binding may not name: each fires with no deliberate gesture
 * (load, error, toggle, CSS animation and transition events, autofocus's
 * focus, hover and movement, scrolling), or is a spelling that is not the
 * event's. */
const DENIED = ['load', 'error', 'abort', 'focus', 'focusin', 'toggle', 'beforetoggle',
  'animationstart', 'animationend', 'animationiteration', 'transitionstart', 'transitionend', 'transitionrun',
  'mouseover', 'mouseenter', 'mouseleave', 'mouseout', 'mousemove', 'pointermove', 'pointerover',
  'pointerenter', 'pointerleave', 'pointerout', 'wheel', 'scroll', 'contextmenu', 'invalid', 'select',
  'selectionchange', 'paste', 'copy', 'cut', 'drop', 'dragover', 'dragstart', 'securitypolicyviolation',
  'Click', 'CLICK', 'click ', ' click', 'on', 'onclick', '__proto__', 'constructor', 'toString', 'hasOwnProperty'];

describe('interactive profile — the safe attack corpus renders identically', () => {
  it('serializes every corpus document to the same bytes and the same reports as safe: true', () => {
    for (const { name, vnode } of SAFE_CORPUS) {
      const safe = ssr(vnode, { safe: true });
      const interactive = ssr(vnode, { safe: INTERACTIVE });
      assert.equal(interactive.html, safe.html, `${name}: markup`);
      assert.deepEqual(sorted(interactive.seen), sorted(safe.seen), `${name}: reports`);
    }
  });

  it('patches every corpus document to the same DOM as safe: true, through update, removal and reinsertion', () => {
    for (const { name, vnode } of SAFE_CORPUS) {
      const safe = host({ safe: true });
      const interactive = host({ safe: INTERACTIVE });
      for (const frame of [['div', { key: 'same' }, 'before'], vnode, ['span', {}, 'removed'], vnode]) {
        safe.render(frame);
        interactive.render(frame);
        assert.equal(childMarkup(interactive.container), childMarkup(safe.container), `${name}: DOM`);
        // and the DOM is what the serializer writes
        assert.equal(childMarkup(interactive.container), renderToString(frame, { safe: INTERACTIVE }), `${name}: DOM vs SSR`);
      }
      assert.deepEqual(sorted(interactive.seen), sorted(safe.seen), `${name}: reports`);
      assert.equal(interactive.events.length, 0);
    }
  });

  it('keeps the corpus inert: no binding listener anywhere, nothing reaches onEvent', () => {
    for (const { name, vnode } of SAFE_CORPUS) {
      const h = host({ safe: INTERACTIVE });
      h.render(vnode);
      const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
      for (const node of walk(h.container)) {
        // a controlled input listens for composition, which holds its
        // authoritative write back; that is the renderer's, never a binding
        const types = [...(node.listeners?.keys() ?? [])].sort();
        const expected = bookkeeping(node, 'controlled') === undefined ? [] : ['compositionend', 'compositionstart'];
        assert.deepEqual(types, expected, `${name}: a listener on <${node.tagName}>`);
      }
      assert.equal(h.events.length, 0);
    }
  });
});

describe('interactive profile — the controls it controls are written apart from safe: true', () => {
  it('serializes a textarea\'s and a select\'s value in the trusted form, with the same reports', () => {
    for (const { name, vnode, safe, ssr: expected } of CONTROLLED_CORPUS) {
      const strict = ssr(vnode, { safe: true });
      const interactive = ssr(vnode, { safe: INTERACTIVE });
      assert.equal(strict.html, safe, `${name}: safe markup`);
      assert.equal(interactive.html, expected, `${name}: interactive markup`);
      // the trusted serializer writes the same form (no fixed attribute here)
      assert.equal(renderToString(vnode), expected, `${name}: trusted markup`);
      assert.deepEqual(interactive.seen, strict.seen, `${name}: reports`);
    }
  });

  it('patches it with no value attribute and its live value controlled, through update, removal and reinsertion', () => {
    for (const { name, vnode, safe, dom, live } of CONTROLLED_CORPUS) {
      const strict = host({ safe: true });
      const interactive = host({ safe: INTERACTIVE });
      for (const frame of [['div', { key: 'same' }, 'before'], vnode, ['span', {}, 'removed'], vnode]) {
        strict.render(frame);
        interactive.render(frame);
        if (frame !== vnode) {
          assert.equal(childMarkup(interactive.container), childMarkup(strict.container), `${name}: DOM`);
          continue;
        }
        assert.equal(childMarkup(strict.container), safe, `${name}: safe DOM`);
        assert.equal(childMarkup(interactive.container), dom, `${name}: interactive DOM`);
        const node = interactive.container.childNodes[0];
        assert.deepEqual({ value: node.value, selected: (node.options ?? []).map((option) => option.selected ?? null) }, live, `${name}: live`);
      }
      assert.deepEqual(sorted(interactive.seen), sorted(strict.seen), `${name}: reports`);
      assert.equal(interactive.events.length, 0);
    }
  });

  it('listens for nothing but a textarea\'s composition', () => {
    for (const { name, vnode } of CONTROLLED_CORPUS) {
      const h = host({ safe: INTERACTIVE });
      h.render(vnode);
      const node = h.container.childNodes[0];
      assert.notEqual(bookkeeping(node, 'controlled'), undefined, `${name}: controlled`);
      const expected = node.tagName === 'textarea' ? ['compositionend', 'compositionstart'] : [];
      for (const option of node.childNodes) assert.equal(option.listeners?.size ?? 0, 0);
      assert.deepEqual([...node.listeners.keys()].sort(), expected, `${name}: listeners`);
      assert.equal(h.events.length, 0);
    }
  });
});

describe('interactive profile — data-only on bindings are kept', () => {
  it('wires a data binding and delivers it verbatim; the serializer writes no trace of it', () => {
    const binding = { action: 'inc', with: { n: 1, tags: ['a', null, true, 2.5] }, event: ['shiftKey'] };
    const vnode = ['button', { type: 'button', on: { click: binding } }, '+'];
    const h = host({ safe: INTERACTIVE });
    h.render(vnode);
    const button = h.container.childNodes[0];
    assert.equal(button.listeners.size, 1);
    fire(button, 'click', { shiftKey: true });
    assert.equal(h.events.length, 1);
    assert.deepEqual(h.events[0].binding, binding);
    assert.deepEqual(h.seen, []);
    const out = ssr(vnode, { safe: INTERACTIVE });
    assert.equal(out.html, '<button type="button">+</button>');
    assert.equal(out.html, childMarkup(h.container));
    assert.deepEqual(out.seen, []);
  });

  it('keeps a string binding as the name it is: nothing in the renderer evaluates it', () => {
    const h = host({ safe: INTERACTIVE });
    const code = 'globalThis.attackedByBinding = true';
    h.render(['button', { on: { click: code } }, 'x']);
    fire(h.container.childNodes[0], 'click');
    assert.equal(h.events[0].binding, code);
    assert.equal(/** @type {any} */ (globalThis).attackedByBinding, undefined);
  });

  it('keeps each allowed event and drops each other type, reporting it by name', () => {
    const on = Object.fromEntries([...ALLOWED, ...DENIED].map((type) => [type, { action: type }]));
    const h = host({ safe: INTERACTIVE });
    h.render(['div', { on }]);
    const div = h.container.childNodes[0];
    assert.deepEqual(sorted(div.listeners.keys()), sorted(ALLOWED));
    assert.deepEqual(sorted(h.seen), sorted(DENIED.map((type) => `event:${type}`)));
    assert.deepEqual(sorted(ssr(['div', { on }], { safe: INTERACTIVE }).seen), sorted(h.seen));
  });

  it('a JSON document whose on carries __proto__ and constructor keys binds only its own allowed types', () => {
    const on = JSON.parse('{"__proto__":{"click":"polluted"},"constructor":"x","click":"ok"}');
    const h = host({ safe: INTERACTIVE });
    h.render(['div', { on }]);
    const div = h.container.childNodes[0];
    assert.deepEqual([...div.listeners.keys()], ['click']);
    fire(div, 'click');
    assert.equal(h.events[0].binding, 'ok');
    assert.deepEqual(sorted(h.seen), ['event:__proto__', 'event:constructor']);
    assert.equal(/** @type {any} */ ({}).click, undefined, 'no prototype was written');
  });

  it('binds no hidden event: a non-enumerable on member is dropped and reported', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['div', { on: Object.defineProperty({ input: 'ok' }, 'click', { value: 'hidden', enumerable: false }) }]);
    assert.deepEqual([...h.container.childNodes[0].listeners.keys()], ['input']);
    assert.deepEqual(h.seen, ['event:click']);
  });

  it('binds no inherited event: an on object with a prototype of its own is not data', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['div', { on: Object.create({ click: 'inherited' }) }]);
    assert.equal(h.container.childNodes[0].listeners.size, 0);
    assert.deepEqual(h.seen, ['event:on']);
  });
});

describe('interactive profile — a binding that is not JSON data is dropped', () => {
  let getterRuns = 0;
  class Payload { constructor() { this.action = 'x'; } }
  const cyclic = { action: 'x', with: {} };
  cyclic.with.self = cyclic;
  /** a value nested deeper than any binding needs */
  let deep = /** @type {any} */ ('leaf');
  for (let i = 0; i < 100; i++) deep = [deep];
  const extraMember = Object.assign(['a'], { toJSON: () => 'x' });
  /** @type {Array<[string, any]>} */
  const cases = [
    ['a function', () => {}],
    ['a function payload', { action: 'x', with: () => {} }],
    ['a toJSON member', { action: 'x', with: { toJSON() { return 'x'; } } }],
    ['a toString member', { action: 'x', toString() { return 'x'; } }],
    ['a hidden toJSON member', Object.defineProperty({ action: 'x' }, 'toJSON', { value: () => 'x', enumerable: false })],
    ['a hidden data member', Object.defineProperty({ action: 'x' }, 'secret', { value: 1, enumerable: false })],
    ['a getter', { get action() { getterRuns++; return 'x'; } }],
    ['a symbol key', { action: 'x', [Symbol.toPrimitive]: () => 'x' }],
    ['a class instance', new Payload()],
    ['a Date', { action: 'x', with: new Date(0) }],
    ['a Map', { action: 'x', with: new Map() }],
    ['a RegExp', { action: 'x', with: /x/ }],
    ['NaN', { action: 'x', with: NaN }],
    ['Infinity', { action: 'x', with: Infinity }],
    ['a bigint', { action: 'x', with: 1n }],
    ['undefined in a list', { action: 'x', with: [undefined] }],
    ['a hole in a list', { action: 'x', with: [, 1] }], // eslint-disable-line no-sparse-arrays
    ['a list with an extra member', { action: 'x', with: extraMember }],
    ['a cycle', cyclic],
    ['nesting past the depth bound', { action: 'x', with: deep }],
    ['more values than the size bound', { action: 'x', with: new Array(70000).fill(0) }],
  ];

  for (const [name, binding] of cases) {
    it(`drops ${name}, in the DOM and in the report the serializer makes`, () => {
      const h = host({ safe: INTERACTIVE });
      const vnode = ['button', { on: { click: binding } }, 'x'];
      h.render(vnode);
      const button = h.container.childNodes[0];
      assert.equal(button.listeners.size, 0);
      fire(button, 'click');
      assert.equal(h.events.length, 0);
      assert.deepEqual(h.seen, ['event:click']);
      assert.deepEqual(ssr(vnode, { safe: INTERACTIVE }).seen, ['event:click']);
    });
  }

  it('never ran a getter while deciding', () => {
    assert.equal(getterRuns, 0);
  });

  it('drops an on member that is not an object, frame after frame', () => {
    const h = host({ safe: INTERACTIVE });
    for (const on of ['click', ['click', 'x'], 42, true, new Map([['click', 'x']])]) {
      h.render(['button', { on }, 'x']);
      assert.equal(h.container.childNodes[0].listeners.size, 0, `on: ${String(on)}`);
    }
    assert.deepEqual(h.seen, ['event:on', 'event:on', 'event:on', 'event:on', 'event:on']);
  });

  it('removes the listener when a data binding is replaced by one that is not data', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['button', { on: { click: 'ok' } }, 'x']);
    const button = h.container.childNodes[0];
    assert.equal(button.listeners.get('click')?.size, 1);
    h.render(['button', { on: { click: () => {} } }, 'x']);
    assert.equal(button.listeners.get('click')?.size ?? 0, 0);
    fire(button, 'click');
    assert.equal(h.events.length, 0);
    h.render(['button', { on: { click: 'again' } }, 'x']);
    fire(button, 'click');
    assert.deepEqual(h.events.map((e) => e.binding), ['again']);
    h.render(['button', {}, 'x']);
    assert.equal(button.listeners.get('click')?.size ?? 0, 0);
  });

  it('still rejects the inline-handler spellings of on as props, as safe does', () => {
    for (const name of ['On', 'ON', 'onclick', 'onClick']) {
      const vnode = ['button', { [name]: { click: 'x' } }, 'x'];
      assert.deepEqual(ssr(vnode, { safe: INTERACTIVE }), ssr(vnode, { safe: true }));
      const h = host({ safe: INTERACTIVE });
      h.render(vnode);
      assert.equal(h.container.childNodes[0].listeners.size, 0);
      assert.deepEqual(h.seen, [`prop:${name}`]);
    }
  });
});

describe('interactive profile — the handler receives a data projection, never the Event', () => {
  /** Assert a projected event holds no live object: every member is a
   * primitive, the frozen target slice, or one of the two native controls. */
  function assertProjection(event, native) {
    assert.notEqual(event, native);
    assert.ok(Object.isFrozen(event));
    for (const [name, value] of Object.entries(event)) {
      if (name === 'preventDefault' || name === 'stopPropagation') {
        assert.equal(typeof value, 'function');
        continue;
      }
      if (name === 'target') {
        assert.ok(Object.isFrozen(value));
        assert.deepEqual(Object.keys(value).sort(), ['checked', 'selectionEnd', 'selectionStart', 'value']);
        for (const member of Object.values(value)) assert.ok(member === null || typeof member !== 'object', 'a target member is an object');
        continue;
      }
      assert.ok(value === null || typeof value !== 'object', `${name} is an object`);
      assert.notEqual(typeof value, 'function', `${name} is a function`);
    }
  }

  it('projects the primitive fields and drops every live member', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { type: 'text', on: { keydown: 'k' } }]);
    const input = h.container.childNodes[0];
    input.value = 'typed';
    let prevented = 0, stopped = 0;
    const native = fire(input, 'keydown', {
      key: 'a', code: 'KeyA', shiftKey: true, repeat: false, clientX: 3, screenX: 9, screenY: 9,
      view: globalThis, srcElement: input, relatedTarget: input, composedPath: () => [input],
      preventDefault() { prevented++; }, stopPropagation() { stopped++; },
    });
    const event = h.events[0].event;
    assertProjection(event, native);
    assert.equal(event.type, 'keydown');
    assert.equal(event.key, 'a');
    assert.equal(event.code, 'KeyA');
    assert.equal(event.shiftKey, true);
    assert.equal(event.clientX, 3);
    assert.equal(event.target.value, 'typed');
    for (const live of ['view', 'srcElement', 'relatedTarget', 'currentTarget', 'composedPath', 'screenX', 'screenY']) {
      assert.equal(live in event, false, `${live} reached the handler`);
    }
    event.preventDefault();
    event.stopPropagation();
    assert.deepEqual([prevented, stopped], [1, 1]);
  });

  it('turns a member that is not a primitive into null', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['button', { on: { click: 'c' } }, 'x']);
    const button = h.container.childNodes[0];
    button.value = { node: button };
    fire(button, 'click', { key: { toString: () => 'x' }, detail: button, button: 0 });
    const event = h.events[0].event;
    assert.equal(event.key, null);
    assert.equal(event.detail, null);
    assert.equal(event.button, 0);
    assert.equal(event.target.value, null);
  });

  it('carries no key, code, value or selection for an event at a password field', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['form', { on: { keydown: 'form-key', input: 'form-input' } },
      ['input', { type: 'password', on: { keydown: 'own-key' } }]]);
    const form = h.container.childNodes[0];
    const field = form.childNodes[0];
    field.value = 'hunter2';
    field.selectionStart = 7;
    field.selectionEnd = 7;
    fire(field, 'keydown', { key: 'h', code: 'KeyH' });
    fire(form, 'input', { target: field });
    for (const { event } of h.events) {
      assert.equal(event.key, null);
      assert.equal(event.code, null);
      assert.deepEqual({ ...event.target }, { value: null, checked: null, selectionStart: null, selectionEnd: null });
    }
    assert.equal(h.events.length, 2);
  });

  it('keeps withholding a field that was a password field after a frame makes it text', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { key: 'f', type: 'password', on: { click: 'peek' } }]);
    const field = h.container.childNodes[0];
    field.value = 'autofilled'; // what a browser's autofill does
    h.render(['input', { key: 'f', type: 'text', on: { click: 'peek' } }]);
    assert.equal(field.getAttribute('type'), 'text');
    fire(field, 'click', { key: 'x' });
    assert.equal(h.events[0].event.target.value, null);
    assert.equal(h.events[0].event.key, null);
  });

  it('carries nothing of an event that rose from inside a granted widget', () => {
    const widgets = { secret: { mount(node) { const input = node.ownerDocument.createElement('input'); input.value = 'pin 1234'; node.appendChild(input); } } };
    const h = host({ safe: INTERACTIVE, widgets, capabilities: { widgets: ['secret'] } });
    h.render(['div', { on: { keydown: 'spy', input: 'spy' } }, ['span', {}, 'own'], ['jaren-widget', { name: 'secret' }]]);
    const div = h.container.childNodes[0];
    const own = div.childNodes[0];
    const inner = div.childNodes[1].childNodes[0];
    assert.equal(inner.value, 'pin 1234');
    fire(div, 'keydown', { target: inner, key: '1', code: 'Digit1' });
    fire(div, 'input', { target: inner });
    fire(div, 'keydown', { target: own, key: 'o', code: 'KeyO' });
    const [fromWidget, inputFromWidget, fromOwn] = h.events.map((e) => e.event);
    assert.equal(fromWidget.key, null);
    assert.equal(fromWidget.code, null);
    assert.equal(fromWidget.target.value, null);
    assert.equal(inputFromWidget.target.value, null);
    assert.equal(fromOwn.key, 'o', 'an event from the document\'s own node keeps its fields');
  });
});

describe('interactive profile — widgets render only when the host granted them', () => {
  /** A registry recording every hook, so a test sees what ran. */
  function registry() {
    /** @type {string[]} */
    const calls = [];
    /** @type {any[]} */
    const contexts = [];
    /** @type {any[]} */
    const mounted = [];
    const def = (name) => ({
      mount(node, props, emit, context) { calls.push(`mount:${name}`); mounted.push({ node, props, emit }); contexts.push(context); return name; },
      update(handle) { calls.push(`update:${handle}`); },
      unmount(handle) { calls.push(`unmount:${handle}`); },
      ssr: (props) => ['a', { href: props?.url ?? '/' }, props?.label ?? name],
    });
    return { calls, contexts, mounted, widgets: { chart: def('chart'), other: def('other') } };
  }

  it('mounts a granted widget with its data props, and serializes it through the policy', () => {
    const r = registry();
    const h = host({ safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } });
    const vnode = ['jaren-widget', { name: 'chart', class: 'c', props: { url: 'javascript:alert(1)', label: 'go', points: [1, 2] } }];
    h.render(vnode);
    assert.deepEqual(r.calls, ['mount:chart']);
    assert.deepEqual(r.mounted[0].props, { url: 'javascript:alert(1)', label: 'go', points: [1, 2] });
    // the widget's own fallback markup passes the same policy: the script URL
    // a hostile prop fed it is dropped
    const out = ssr(vnode, { safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } });
    assert.equal(out.html, '<div class="c"><a>go</a></div>');
    assert.deepEqual(out.seen, ['prop:href']);
  });

  it('drops a registered widget the host did not grant, and an unregistered one, without throwing', () => {
    const r = registry();
    const options = { safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } };
    for (const name of ['other', 'missing', '', 7, undefined, '__proto__', 'constructor']) {
      const h = host(options);
      const vnode = ['jaren-widget', { name }];
      assert.doesNotThrow(() => h.render(vnode));
      assert.equal(childMarkup(h.container), '');
      assert.deepEqual(h.seen, [`widget:${String(name ?? '')}`]);
      const out = ssr(vnode, options);
      assert.equal(out.html, '');
      assert.deepEqual(out.seen, h.seen);
    }
    assert.deepEqual(r.calls, []);
  });

  it('grants nothing when no list is given', () => {
    const r = registry();
    const h = host({ safe: INTERACTIVE, widgets: r.widgets });
    h.render(['jaren-widget', { name: 'chart' }]);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(h.seen, ['widget:chart']);
    assert.equal(ssr(['jaren-widget', { name: 'chart' }], { safe: INTERACTIVE, widgets: r.widgets }).html, '');
  });

  it('holds a granted widget\'s host tag to the tag allow-list', () => {
    const r = registry();
    const options = { safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } };
    for (const tag of ['script', 'iframe', 'object', 'style', 'foreignObject', 'div><img src=x onerror=alert(1)', 7]) {
      const h = host(options);
      const vnode = ['jaren-widget', { name: 'chart', tag }];
      assert.doesNotThrow(() => h.render(vnode));
      assert.equal(childMarkup(h.container), '');
      assert.deepEqual(h.seen, [`tag:${String(tag)}`]);
      assert.deepEqual(ssr(vnode, options), { html: '', seen: h.seen });
    }
    assert.deepEqual(r.calls, []);
    const h = host(options);
    h.render(['jaren-widget', { name: 'chart', tag: 'section' }]);
    assert.equal(childMarkup(h.container), '<section></section>');
  });

  it('drops a granted widget whose props are not data, or that carries children', () => {
    const r = registry();
    const options = { safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } };
    for (const vnode of [
      ['jaren-widget', { name: 'chart', props: { draw: () => {} } }],
      ['jaren-widget', { name: 'chart', props: new Map() }],
      ['jaren-widget', { name: 'chart', props: { get x() { return 1; } } }],
      ['jaren-widget', { name: 'chart' }, ['p', {}, 'child']],
    ]) {
      const h = host(options);
      assert.doesNotThrow(() => h.render(vnode));
      assert.deepEqual(h.seen, ['widget:chart']);
      assert.deepEqual(ssr(vnode, options), { html: '', seen: ['widget:chart'] });
    }
    assert.deepEqual(r.calls, []);
  });

  it('runs the host-element props of a granted widget through the policy', () => {
    const r = registry();
    const options = { safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } };
    const vnode = ['jaren-widget', { name: 'chart', innerHTML: '<img src=x onerror=alert(1)>', onclick: 'x', style: 'width:expression(1)', title: 't', on: { click: 'ok', load: 'auto' } }];
    const h = host(options);
    h.render(vnode);
    assert.equal(childMarkup(h.container), '<div title="t"></div>');
    assert.deepEqual([...h.container.childNodes[0].listeners.keys()], ['click']);
    // the serializer writes the same host element around the widget's fallback
    const out = ssr(vnode, options);
    assert.equal(out.html, '<div title="t"><a href="/">chart</a></div>');
    assert.deepEqual(sorted(out.seen), sorted(h.seen));
    assert.deepEqual(sorted(h.seen), ['event:load', 'prop:innerHTML', 'prop:onclick', 'prop:style']);
  });

  it('never mounts across frames what was not granted, and unmounts a granted widget replaced by an ungranted one', () => {
    const r = registry();
    const h = host({ safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } });
    h.render(['jaren-widget', { key: 'w', name: 'chart' }]);
    h.render(['jaren-widget', { key: 'w', name: 'other' }]);
    h.render(['jaren-widget', { key: 'w', name: 'other', props: { n: 2 } }]);
    h.render(['jaren-widget', { key: 'w', name: 'chart', props: { n: 3 } }]);
    assert.deepEqual(r.calls, ['mount:chart', 'unmount:chart', 'mount:chart']);
  });

  it('hands a mounted widget a context that keeps the profile and only the granted registry', () => {
    const r = registry();
    const report = () => {};
    const { document, container } = createStubHost();
    createDomRenderer(container, { document, safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] }, onUnsafe: report })(
      ['jaren-widget', { name: 'chart' }]);
    const context = r.contexts[0];
    assert.ok(Object.isFrozen(context));
    assert.equal(context.safe, INTERACTIVE);
    assert.deepEqual(Object.keys(context.widgets), ['chart']);
    assert.deepEqual(context.capabilities, { widgets: ['chart'] });
    assert.equal(context.onUnsafe, report);
    // a renderer the widget builds from that context renders under the profile
    const nested = createStubHost();
    createDomRenderer(nested.container, { document: nested.document, ...context })(['div', { innerHTML: 'x' }, ['jaren-widget', { name: 'other' }]]);
    assert.equal(childMarkup(nested.container), '<div></div>');
  });

  it('holds a widget emit to the binding decision and projects its event', () => {
    const r = registry();
    const h = host({ safe: INTERACTIVE, widgets: r.widgets, capabilities: { widgets: ['chart'] } });
    h.render(['jaren-widget', { name: 'chart' }]);
    const { emit, node } = r.mounted[0];
    emit(() => {});
    emit({ action: 'x', with: new Date(0) });
    assert.equal(h.events.length, 0);
    assert.deepEqual(h.seen, ['event:emit', 'event:emit']);
    emit({ action: 'pick', with: 2 }, { type: 'click', target: node, clientX: 4, view: globalThis });
    emit('plain');
    assert.deepEqual(h.events.map((e) => e.binding), [{ action: 'pick', with: 2 }, 'plain']);
    assert.equal(h.events[0].event.clientX, 4);
    assert.equal('view' in h.events[0].event, false);
    assert.ok(Object.isFrozen(h.events[0].event));
    assert.equal(h.events[1].event, undefined);
    // a password field of the widget's own, which the renderer never typed
    emit('typed', { type: 'input', target: { type: 'password', value: 'hunter2' }, key: 'h' });
    assert.equal(h.events[2].event.target.value, null);
    assert.equal(h.events[2].event.key, null);
  });

  it('refuses a grant that names no registered widget, and a grant that is not a list of names', () => {
    const r = registry();
    // an absent grant, or an absent list, grants nothing
    for (const capabilities of [undefined, null, {}, { widgets: null }]) {
      const { document, container } = createStubHost();
      assert.doesNotThrow(() => createDomRenderer(container, { document, safe: INTERACTIVE, widgets: r.widgets, capabilities }));
    }
    for (const capabilities of [{ widgets: ['missing'] }, { widgets: ['toString'] }, { widgets: 'chart' }, { widgets: [1] }, 'chart', ['chart']]) {
      const { document, container } = createStubHost();
      assert.throws(() => createDomRenderer(container, { document, safe: INTERACTIVE, widgets: r.widgets, capabilities }), TypeError);
      assert.throws(() => renderToString(['p', {}], { safe: INTERACTIVE, widgets: r.widgets, capabilities }), TypeError);
    }
  });
});

describe('interactive profile — safe: true and trusted rendering are untouched by it', () => {
  it('safe: true still strips every binding and every widget, granted or not', () => {
    const r = { chart: { mount() { throw new Error('must not mount'); }, ssr: () => ['p', {}, 'x'] } };
    const h = host({ safe: true, widgets: r, capabilities: { widgets: ['chart'] } });
    h.render(['div', { on: { click: 'x' } }, ['jaren-widget', { name: 'chart' }]]);
    assert.equal(h.container.childNodes[0].listeners.size, 0);
    assert.deepEqual(sorted(h.seen), ['event:on', 'widget:chart']);
    assert.equal(renderToString(['jaren-widget', { name: 'chart' }], { safe: true, widgets: r, capabilities: { widgets: ['chart'] } }), '');
  });

  it('any other truthy safe value is the safe profile, never the interactive one', () => {
    for (const safe of ['Interactive', 'yes', 1, {}]) {
      const h = host({ safe });
      h.render(['button', { on: { click: 'x' } }, 'x']);
      assert.equal(h.container.childNodes[0].listeners.size, 0, `safe: ${JSON.stringify(safe)}`);
      assert.deepEqual(h.seen, ['event:on']);
    }
  });

  it('createSafePolicy() keeps its shape; the interactive policy answers the two decisions it adds', () => {
    const plain = createSafePolicy();
    assert.equal(plain.dropsEvents, true);
    assert.equal(plain.widget('chart'), false);
    const policy = createSafePolicy({ interactive: true, widgets: ['chart'] });
    assert.equal(policy.dropsEvents, false);
    assert.equal(policy.widget('chart'), true);
    assert.equal(policy.widget('other'), false);
    assert.equal(policy.widget('toString'), false);
    const decided = policy.events({ click: 'a', load: 'b', input: () => {} });
    assert.deepEqual({ ...decided.kept }, { click: 'a' });
    assert.deepEqual(decided.dropped, ['load', 'input']);
    assert.deepEqual(policy.events(undefined), { kept: null, dropped: [] });
    assert.deepEqual(policy.events('click'), { kept: null, dropped: ['on'] });
    assert.equal(policy.binding({ action: 'a', with: [1] }), true);
    assert.equal(policy.binding(() => {}), false);
    // the sanitizing decisions are the same functions' answers
    for (const [name, value] of [['href', 'javascript:x'], ['style', 'width:expression(1)'], ['innerHTML', 'x'], ['class', 'a'], ['srcset', '/a 1x']]) {
      assert.deepEqual(policy.prop(name, value), plain.prop(name, value));
    }
    for (const tag of ['div', 'script', 'svg', 'foreignObject', 'div><img']) assert.equal(policy.tag(tag), plain.tag(tag));
  });
});
