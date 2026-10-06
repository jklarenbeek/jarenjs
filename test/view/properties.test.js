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

describe('a value the property would convert is written as the attribute the serializer writes', () => {
  const CASES = [
    [['a', { href: '/r.csv', download: true }], [['href', '/r.csv'], ['download', '']]],
    [['div', { title: true }], [['title', '']]],
    [['div', { popover: true }], [['popover', '']]],
    [['img', { src: '/x.png', width: '100px' }], [['src', '/x.png'], ['width', '100px']]],
    [['img', { width: '50%' }], [['width', '50%']]],
    [['canvas', { width: '300px' }], [['width', '300px']]],
    [['img', { width: '100' }], [['width', '100']]],
  ];

  it('true on a property that is not boolean is the empty attribute, a string on a number-typed one is that string, in the DOM and the markup', () => {
    for (const [vnode, expected] of CASES) {
      const h = host();
      h.render(vnode);
      assert.deepStrictEqual(attributesOf(h.node()), expected, `DOM ${JSON.stringify(vnode)}`);
      assert.deepStrictEqual(ssrAttributes(renderToString(vnode)), expected, `SSR ${JSON.stringify(vnode)}`);
    }
  });

  it('the element reads what the markup says: an unnamed download, the auto popover', () => {
    const a = host();
    a.render(['a', { href: '/r.csv', download: true }]);
    assert.strictEqual(a.node().download, '');
    const menu = host();
    menu.render(['div', { popover: true }]);
    assert.strictEqual(menu.node().popover, 'auto');
  });

  it('a patch moves between the property and the attribute, and a removal removes either', () => {
    const a = host();
    for (const [download, expected] of [[true, ''], ['r.csv', 'r.csv'], [true, ''], [undefined, null]]) {
      a.render(['a', download === undefined ? {} : { download }]);
      assert.strictEqual(a.node().getAttribute('download'), expected, JSON.stringify(download));
    }
    const img = host();
    for (const [width, expected] of [['100px', '100px'], [40, '40'], ['50%', '50%'], [null, null]]) {
      img.render(['img', { width }]);
      assert.strictEqual(img.node().getAttribute('width'), expected, JSON.stringify(width));
    }
  });

  it('hydration keeps the server markup it adopts', () => {
    const { document, container } = createReflectingHost();
    const link = document.createElement('a');
    link.setAttribute('href', '/r.csv');
    link.setAttribute('download', '');
    const image = document.createElement('img');
    image.setAttribute('width', '100px');
    container.appendChild(link);
    container.appendChild(image);
    createDomRenderer(container, { document, hydrate: true })([['a', { href: '/r.csv', download: true }], ['img', { width: '100px' }]]);
    assert.strictEqual(container.childNodes[0], link, 'adopted, not rebuilt');
    assert.deepStrictEqual(attributesOf(link), [['href', '/r.csv'], ['download', '']]);
    assert.deepStrictEqual(attributesOf(image), [['width', '100px']]);
  });

  it('numbers, strings on string properties, boolean properties and safe mode keep their writes', () => {
    const h = host();
    h.render(['img', { width: 40 }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['width', '40']]);
    h.render(['img', { width: 40, title: 'a photo' }]);
    assert.deepStrictEqual(attributesOf(h.node()), [['width', '40'], ['title', 'a photo']]);
    const button = host();
    button.render(['button', { disabled: true }]);
    assert.strictEqual(button.node().disabled, true);
    assert.deepStrictEqual(attributesOf(button.node()), [['disabled', '']]);
    for (const [vnode, expected] of CASES) {
      const safe = host(true);
      safe.render(vnode);
      assert.deepStrictEqual(attributesOf(safe.node()), expected, `safe ${JSON.stringify(vnode)}`);
    }
  });

  it('a style object with no declaration writes no style attribute, as the serializer omits it', () => {
    for (const safe of [false, true]) {
      const h = host(safe);
      h.render(['div', { style: {} }]);
      assert.deepStrictEqual(attributesOf(h.node()), [], safe ? 'safe' : 'trusted');
      assert.strictEqual(renderToString(['div', { style: {} }], { safe }), '<div></div>');
      h.render(['div', { style: { color: 'red' } }]);
      assert.deepStrictEqual(attributesOf(h.node()), [['style', 'color:red']]);
      h.render(['div', { style: { color: null } }]);
      assert.deepStrictEqual(attributesOf(h.node()), [], `${safe ? 'safe' : 'trusted'}: the emptied object removes it`);
    }
  });
});


describe('numeric and boolean reflections preserve the serialized attribute', () => {
  it('patches zero, negative and fractional reflected numbers without destroying the mounted node', () => {
    for (const [tag, name] of [['input', 'size'], ['img', 'width'], ['canvas', 'width'], ['progress', 'value']]) {
      const h = host();
      h.render([tag, { [name]: 5 }]);
      const mounted = h.node();
      for (const value of [0, -1, 2.5, null, 3]) {
        const vnode = [tag, { [name]: value }];
        h.render(vnode);
        assert.strictEqual(h.node(), mounted, `${tag}.${name}: ${value}`);
        assert.deepStrictEqual(attributesOf(h.node()), ssrAttributes(renderToString(vnode)), `${tag}.${name}: ${value}`);
      }
    }
  });

  it('a non-boolean disabled value stays present, including zero and the empty string', () => {
    const h = host();
    for (const value of [true, 0, '', 'false', 1, false, null]) {
      const vnode = ['button', { disabled: value }];
      h.render(vnode);
      assert.deepStrictEqual(attributesOf(h.node()), ssrAttributes(renderToString(vnode)), JSON.stringify(value));
      assert.strictEqual(h.node().disabled, value !== false && value !== null, JSON.stringify(value));
    }
  });

  it('live numeric properties still receive numbers without a content attribute', () => {
    const { document, container } = createReflectingHost();
    const create = document.createElement.bind(document);
    document.createElement = (tag) => {
      const node = create(tag);
      node.scrollTop = 0;
      return node;
    };
    const render = createDomRenderer(container, { document });
    for (const value of [10, 0, 2.5]) {
      render(['div', { scrollTop: value }]);
      assert.strictEqual(container.childNodes[0].scrollTop, value);
      assert.strictEqual(container.childNodes[0].getAttribute('scrollTop'), null);
    }
    render.destroy();
  });
});
