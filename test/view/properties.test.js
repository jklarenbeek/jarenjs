//@ts-check
/**
 * @file The property table (VIEW-FORMAT §3): the DOM renderer and the
 * serializer write the same attributes for every kind of property.
 *
 * The DOM half runs over {@link createReflectingHost}, whose elements carry
 * the IDL properties the HTML Standard gives them — a plain stub writes
 * attributes for everything and would agree with the serializer whatever
 * the renderer did. `packages/website/e2e/view-runtime.spec.js` runs the
 * same matrix in real browsers.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';

import { createReflectingHost } from './dom.stub.js';

/** A trusted (or safe) renderer over a reflecting host. @param {boolean} [safe] */
function host(safe = false) {
  const { document, container } = createReflectingHost();
  const render = createDomRenderer(container, { document, safe });
  return { render, node: () => container.childNodes[0] };
}

/** The attributes of a stub element, in insertion order. @param {any} node */
const attributesOf = (node) => [...node.attributes];

/** The attributes the serializer wrote on its one element. @param {string} markup */
const ssrAttributes = (markup) => [...markup.matchAll(/ ([^\s=>]+)(?:="([^"]*)")?/g)]
  .map((m) => [m[1], m[2] ?? '']);

/** Each enumerated attribute, the keywords `true` and `false` name. */
const ENUMERATED = {
  spellcheck: ['true', 'false'],
  draggable: ['true', 'false'],
  translate: ['yes', 'no'],
  autocorrect: ['on', 'off'],
  contenteditable: ['true', 'false'],
  writingsuggestions: ['true', 'false'],
};
const SPELLINGS = [true, false, 'true', 'false', null];

describe('enumerated attributes — one spelling in both renderers', () => {
  for (const [name, [yes, no]] of Object.entries(ENUMERATED)) {
    for (const safe of [false, true]) {
      it(`${name}${safe ? ' (safe)' : ''}: every spelling writes the attribute's keyword, the same in the DOM and the markup`, () => {
        for (const value of SPELLINGS) {
          const vnode = ['textarea', { [name]: value }];
          const expected = value === null ? [] : [[name, value === true || value === 'true' ? yes : no]];
          const h = host(safe);
          h.render(vnode);
          assert.deepStrictEqual(attributesOf(h.node()), expected, `DOM ${JSON.stringify(value)}`);
          assert.deepStrictEqual(ssrAttributes(renderToString(vnode, { safe })), expected, `SSR ${JSON.stringify(value)}`);
        }
      });
    }
  }

  it('a patch moves between the spellings without a property write the platform reads as true', () => {
    const h = host();
    for (const value of [true, 'false', null, false, 'true', 'false']) {
      h.render(['textarea', { spellcheck: value }]);
      const expected = value === null ? null : value === true || value === 'true' ? 'true' : 'false';
      assert.strictEqual(h.node().getAttribute('spellcheck'), expected, JSON.stringify(value));
      if (value !== null) assert.strictEqual(h.node().spellcheck, expected === 'true', `the IDL reads ${expected}`);
    }
  });

  it("any other value is written as its string; the IDL spellings write the attribute they reflect", () => {
    const h = host();
    h.render(['div', { translate: 'yes', contentEditable: false, writingSuggestions: true }]);
    assert.deepStrictEqual(attributesOf(h.node()),
      [['translate', 'yes'], ['contenteditable', 'false'], ['writingsuggestions', 'true']]);
    assert.strictEqual(renderToString(['div', { translate: 'yes', contentEditable: false, writingSuggestions: true }]),
      '<div translate="yes" contenteditable="false" writingsuggestions="true"></div>');
    h.render(['div', { contenteditable: 'plaintext-only' }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['contenteditable', 'plaintext-only']]);
  });
});

describe('non-boolean properties — null, false and removal remove the attribute', () => {
  /** Render `from`, then `to`; answer the attributes and what SSR wrote for `to`. */
  function transition(from, to) {
    const h = host();
    h.render(from);
    h.render(to);
    return { dom: attributesOf(h.node()), ssr: ssrAttributes(renderToString(to)) };
  }

  it('a removed size throws nothing and leaves no size', () => {
    const { dom, ssr } = transition(['input', { size: 5 }], ['input', {}]);
    assert.deepStrictEqual(dom, []);
    assert.deepStrictEqual(dom, ssr);
  });

  it('a removed width is no width, not width="0"', () => {
    const { dom, ssr } = transition(['img', { width: 40 }], ['img', {}]);
    assert.deepStrictEqual(dom, []);
    assert.deepStrictEqual(dom, ssr);
  });

  it('a removed, false or null href leaves no href — never href="" or href="false"', () => {
    for (const to of [['a', {}], ['a', { href: false }], ['a', { href: null }]]) {
      const { dom, ssr } = transition(['a', { href: '/x' }], to);
      assert.deepStrictEqual(dom, [], JSON.stringify(to));
      assert.deepStrictEqual(dom, ssr, JSON.stringify(to));
    }
  });

  it('a removed progress value leaves the progress indeterminate', () => {
    const { dom, ssr } = transition(['progress', { value: 3, max: 10 }], ['progress', { max: 10 }]);
    assert.deepStrictEqual(dom, [['max', '10']]);
    assert.deepStrictEqual(dom, ssr);
  });

  it('a property reflecting an attribute of another name removes that attribute', () => {
    for (const [from, to, attribute] of [[['p', { className: 'x' }], ['p', {}], 'class'],
      [['label', { htmlFor: 'f' }], ['label', { htmlFor: null }], 'for']]) {
      const h = host();
      h.render(from);
      assert.strictEqual(h.node().getAttribute(attribute), from[1].className ?? from[1].htmlFor);
      h.render(to);
      assert.deepStrictEqual(attributesOf(h.node()), [], `${attribute} removed, not left empty`);
    }
  });

  it('a null on a fresh element writes nothing at all', () => {
    for (const vnode of [['input', { size: null }], ['img', { width: null }], ['a', { href: null }]]) {
      const h = host();
      h.render(vnode);
      assert.deepStrictEqual(attributesOf(h.node()), [], JSON.stringify(vnode));
    }
  });

  it('boolean properties are unchanged, and a property with no attribute of its name still clears', () => {
    const h = host();
    h.render(['button', { disabled: true }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['disabled', '']]);
    h.render(['button', { disabled: false }]);
    assert.deepStrictEqual(attributesOf(h.node()), []);
    h.render(['button', { disabled: true }]);
    h.render(['button', { disabled: null }]);
    assert.deepStrictEqual(attributesOf(h.node()), []);
    const p = host();
    p.render(['p', { textContent: 'written' }]);
    assert.strictEqual(p.node().childNodes.length, 1);
    p.render(['p', {}]);
    assert.strictEqual(p.node().childNodes.length, 0, 'textContent was cleared');
  });

  it('an attribute spelled both ways is written once, by the later spelling, in the markup and in the DOM', () => {
    for (const props of [{ contenteditable: true, contentEditable: false }, { contentEditable: false, contenteditable: true },
      { writingSuggestions: true, writingsuggestions: false }]) {
      const markup = renderToString(['div', props]);
      const attribute = 'contenteditable' in props ? 'contenteditable' : 'writingsuggestions';
      const later = Object.values(props).at(-1) ? 'true' : 'false';
      assert.deepStrictEqual(ssrAttributes(markup), [[attribute, later]], `${JSON.stringify(props)}: ${markup}`);
      const h = host();
      h.render(['div', props]);
      assert.deepStrictEqual(attributesOf(h.node()), [[attribute, later]], JSON.stringify(props));
    }
  });

  it('a patch writes what an aliased attribute ends up with: one spelling leaving, or the two swapping', () => {
    const h = host();
    h.render(['div', { contenteditable: true, contentEditable: true }]);
    h.render(['div', { contenteditable: true }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['contenteditable', 'true']], 'the remaining spelling keeps it');
    h.render(['div', { contentEditable: false, contenteditable: true }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['contenteditable', 'true']]);
    h.render(['div', { contenteditable: true, contentEditable: false }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['contenteditable', 'false']], 'the order swapped, so did the value');
    h.render(['div', {}]);
    assert.deepStrictEqual(attributesOf(h.node()), [], 'both left: removed');
  });
});
