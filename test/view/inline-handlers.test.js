//@ts-check
/**
 * @file An inline handler value (`onclick: 'alert(1)'`) is written by
 * neither renderer, in trusted mode: the property table has one rule and the
 * serializer, the DOM patcher and hydration all read it. A function is a
 * handler and stays one on the DOM path; a prop that only begins with `on`
 * is an ordinary prop; hydration drops the attribute the server wrote before
 * the rule and attaches the function.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';

import { createReflectingHost, createStubHost } from './dom.stub.js';

/** The attributes of a stub element, in insertion order. @param {any} node */
const attributesOf = (node) => [...node.attributes];

/** A renderer over a host whose elements carry the `onclick` IDL property
 * (`reflecting`) or over a plain stub that has no handler property at all.
 * @param {boolean} reflecting @param {{ hydrate?: boolean }} [options] */
function host(reflecting, options = {}) {
  const { document, container } = reflecting ? createReflectingHost() : createStubHost();
  return { document, container, render: createDomRenderer(container, { document, ...options }) };
}

describe('an inline handler string is dropped by both renderers', () => {
  const NAMES = ['onclick', 'onClick', 'ONCLICK', 'onfocus', 'onmouseover', 'onpointerdown',
    'ontouchstart', 'onanimationend', 'ontransitionend', 'onbeforeunload', 'ononline', 'onhashchange', 'onload',
    'onerror', 'oncut', 'onwebkitanimationend', 'onreadystatechange'];

  for (const name of NAMES) {
    it(`${name}: the markup omits it and so does the DOM, with or without a handler property`, () => {
      const vnode = ['button', { id: 'a', [name]: 'alert(1)', title: 't' }, 'x'];
      assert.strictEqual(renderToString(vnode), '<button id="a" title="t">x</button>');
      for (const reflecting of [true, false]) {
        const h = host(reflecting);
        h.render(vnode);
        assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a'], ['title', 't']], `reflecting ${reflecting}`);
        if (reflecting) assert.strictEqual(h.container.childNodes[0].onclick, null);
      }
    });
  }

  it('a name that only begins with on is an ordinary prop, written by the markup, the DOM and hydration', () => {
    const props = { online: 'a', one: 'b', only: 'c', once: 'd', onLabel: 'e', onboarding: 'f', 'on-x': 'g', on1: 'h', o: 'i' };
    const expected = Object.entries(props);
    const markup = '<div online="a" one="b" only="c" once="d" onLabel="e" onboarding="f" on-x="g" on1="h" o="i"></div>';
    assert.strictEqual(renderToString(['div', props]), markup);
    for (const reflecting of [true, false]) {
      const h = host(reflecting);
      h.render(['div', props]);
      assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), expected, `DOM ${reflecting}`);
      // patching to another value rewrites it, and dropping the prop removes it
      h.render(['div', { ...props, online: 'z' }]);
      assert.strictEqual(h.container.childNodes[0].getAttribute('online'), 'z');
      h.render(['div', {}]);
      assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), []);
    }
    const { document, container } = createReflectingHost();
    const div = document.createElement('div');
    for (const [name, value] of expected) div.setAttribute(name, value);
    container.appendChild(div);
    createDomRenderer(container, { document, hydrate: true })(['div', props]);
    assert.strictEqual(container.childNodes[0], div);
    assert.deepStrictEqual(attributesOf(div), expected);
  });

  it('a value that is not a function is dropped whatever its type, and null and false stay absent', () => {
    const values = [['alert(1)'], 5, 0, true, { a: 1 }, ''];
    for (const value of values) {
      const vnode = ['button', { onclick: value, id: 'a' }];
      assert.strictEqual(renderToString(vnode), '<button id="a"></button>', JSON.stringify(value));
      for (const reflecting of [true, false]) {
        const h = host(reflecting);
        h.render(vnode);
        assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a']], `${reflecting} ${JSON.stringify(value)}`);
        if (reflecting) assert.strictEqual(h.container.childNodes[0].onclick, null);
        h.render(['button', { onclick: 'x', id: 'a' }]);
        assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a']]);
      }
      const { document, container } = createReflectingHost();
      const button = document.createElement('button');
      button.setAttribute('onclick', 'alert(1)');
      button.setAttribute('id', 'a');
      container.appendChild(button);
      createDomRenderer(container, { document, hydrate: true })(vnode);
      assert.deepStrictEqual(attributesOf(button), [['id', 'a']], `hydrate ${JSON.stringify(value)}`);
    }
    for (const value of [null, false]) {
      assert.strictEqual(renderToString(['button', { onclick: value }]), '<button></button>');
    }
  });

  it('an attribute another owner set between two frames of dropped values is left alone', () => {
    for (const reflecting of [true, false]) {
      const h = host(reflecting);
      h.render(['button', { onclick: 'a' }]);
      const node = h.container.childNodes[0];
      node.setAttribute('onclick', 'x');
      h.render(['button', { onclick: 'b' }]);
      assert.strictEqual(node.getAttribute('onclick'), 'x', `string ${reflecting}`);
      h.render(['button', {}]);
      assert.strictEqual(node.getAttribute('onclick'), 'x', `removed ${reflecting}`);
    }
    // a prop that first appears, or turns from null or false, has written nothing to remove
    for (const first of [undefined, null, false]) {
      const h = host(true);
      h.render(['button', first === undefined ? {} : { onclick: first }]);
      const node = h.container.childNodes[0];
      node.setAttribute('onclick', 'x');
      h.render(['button', { onclick: 'b' }]);
      assert.strictEqual(node.getAttribute('onclick'), 'x', `first ${first}`);
    }
  });

  it('a handler string on a widget host is dropped by the markup', () => {
    const widgets = { w: { mount: () => 1, unmount: () => {}, ssr: () => ['b', {}, 'in'] } };
    assert.strictEqual(
      renderToString(['jaren-widget', { name: 'w', onclick: 'alert(1)', id: 'h' }], { widgets }),
      '<div id="h"><b>in</b></div>');
    const h = host(false);
    const render = createDomRenderer(h.container, { document: h.document, widgets });
    render(['jaren-widget', { name: 'w', onclick: 'alert(1)', id: 'h' }]);
    assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'h']]);
    render.destroy();
  });

  it('a patch from a string to a string, to null or to nothing writes nothing', () => {
    for (const reflecting of [true, false]) {
      const h = host(reflecting);
      for (const onclick of ['one()', 'two()', null, undefined, 'three()']) {
        h.render(['button', { id: 'a', onclick }]);
        assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a']], `${reflecting} ${onclick}`);
      }
    }
  });

  it('the safe profile is unchanged: the prop is stripped and reported in both', () => {
    /** @type {string[]} */
    const seen = [];
    const onUnsafe = (/** @type {any} */ r) => seen.push(`${r.kind}:${r.name}`);
    assert.strictEqual(renderToString(['div', { onclick: 'x', id: 'a' }], { safe: true, onUnsafe }), '<div id="a"></div>');
    const h = host(false);
    const render = createDomRenderer(h.container, { document: h.document, safe: true, onUnsafe });
    render(['div', { onclick: 'x', id: 'a' }]);
    assert.deepStrictEqual(seen, ['prop:onclick', 'prop:onclick']);
    assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a']]);
  });
});

describe('a function handler stays a handler on the DOM path', () => {
  it('is assigned to the property, replaced by another function and cleared by a string', () => {
    const h = host(true);
    const one = () => 1;
    const two = () => 2;
    h.render(['button', { onclick: one }]);
    const node = h.container.childNodes[0];
    assert.strictEqual(node.onclick, one);
    h.render(['button', { onclick: two }]);
    assert.strictEqual(node.onclick, two);
    // the string is never written, and the function the frame before wrote is gone
    h.render(['button', { onclick: 'alert(1)' }]);
    assert.strictEqual(node.onclick, null);
    assert.deepStrictEqual(attributesOf(node), []);
    h.render(['button', { onclick: one }]);
    assert.strictEqual(node.onclick, one);
    h.render(['button', {}]);
    assert.strictEqual(node.onclick, null);
  });
});

describe('a function handler replaced by a string', () => {
  it('leaves no attribute on a node that has no handler property', () => {
    const h = host(false);
    h.render(['button', { id: 'a', onclick: () => 1 }]);
    h.render(['button', { id: 'a', onclick: 'alert(1)' }]);
    assert.deepStrictEqual(attributesOf(h.container.childNodes[0]), [['id', 'a']]);
  });

  it('writes the handler property only for a function and its removal, never for a string', () => {
    const { document, container } = createReflectingHost();
    /** @type {any[]} */
    const writes = [];
    const create = document.createElement.bind(document);
    document.createElement = (tag) => {
      const node = create(tag);
      Object.defineProperty(node, 'onclick', { get: () => null, set: (value) => { writes.push(value); }, configurable: true });
      return node;
    };
    const render = createDomRenderer(container, { document });
    const click = () => 1;
    for (const onclick of ['one()', 'two()', null, undefined, 'three()']) render(['button', { onclick }]);
    assert.deepStrictEqual(writes, []);
    render(['button', { onclick: click }]);
    render(['button', {}]);
    assert.deepStrictEqual(writes, [click, '']);
    render.destroy();
  });
});

describe('hydration', () => {
  it('removes the inline handler attribute server markup written before the rule and attaches a function', () => {
    const { document, container } = createReflectingHost();
    const button = document.createElement('button');
    button.setAttribute('onclick', 'alert(1)');
    button.setAttribute('id', 'a');
    container.appendChild(button);
    const render = createDomRenderer(container, { document, hydrate: true });
    render(['button', { id: 'a', onclick: 'alert(1)' }]);
    assert.strictEqual(container.childNodes[0], button);
    assert.deepStrictEqual(attributesOf(button), [['id', 'a']]);
    const click = () => 1;
    render(['button', { id: 'a', onclick: click }]);
    assert.strictEqual(button.onclick, click);
    render.destroy();
  });

  it('adopts server markup the rule now writes and attaches the function handler on the same node', () => {
    const click = () => 1;
    const vnode = ['button', { id: 'a', onclick: click }, 'x'];
    // the serializer is handed JSON, so the markup of the document without the function
    const markup = renderToString(['button', { id: 'a', onclick: 'alert(1)' }, 'x']);
    assert.strictEqual(markup, '<button id="a">x</button>');
    const { document, container } = createReflectingHost();
    const button = document.createElement('button');
    button.setAttribute('id', 'a');
    button.appendChild(document.createTextNode('x'));
    container.appendChild(button);
    const render = createDomRenderer(container, { document, hydrate: true });
    render(vnode);
    assert.strictEqual(container.childNodes[0], button);
    assert.strictEqual(button.onclick, click);
    assert.deepStrictEqual(attributesOf(button), [['id', 'a']]);
    render.destroy();
  });
});
