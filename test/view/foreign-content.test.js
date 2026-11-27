//@ts-check
/**
 * Elements inside an `svg`, where an HTML parser reads foreign content: the
 * markup the serializer writes there must read back as the tree the DOM
 * renderer builds (VIEW-FORMAT §5.4, §6). In foreign content no element is
 * void, so an end tag closes `<input>` as it closes `<circle>`; an element
 * whose start tag ends the `svg` for a parser (`br`, `embed`, `hr`, `img`,
 * `meta`, in any case) has no such markup: the trusted serializer refuses
 * it and the safe profiles drop it on both renderers. Under an SVG `desc`,
 * `title` or `foreignObject` a parser reads HTML again. A widget hosted on
 * `svg` is built in the SVG namespace, as an `svg` element is.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createDomRenderer, renderToString } from '@jarenjs/view';
import { StubDocument, createStubHost } from './dom.stub.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROFILES = /** @type {const} */ ([true, 'interactive']);

/**
 * A stub subtree as `tag(ns)[children]`, text as JSON: the tree a test
 * compares with what a parser builds from the serializer's markup.
 * @param {any} node
 * @returns {string}
 */
function shape(node) {
  if (node.nodeType === 3) return JSON.stringify(node.nodeValue);
  const children = node.childNodes.map(shape).join(',');
  return node.tagName + (node.namespaceURI === SVG_NS ? '(svg)' : '') + (children === '' ? '' : `[${children}]`);
}

/**
 * Render with the DOM renderer into a fresh stub container.
 * @param {any} vnode
 * @param {object} [options]
 */
function dom(vnode, options = {}) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, ...options });
  render(vnode);
  return { container, render, shape: container.childNodes.map(shape).join(',') };
}

const CLOSED_BY_END_TAG = ['area', 'base', 'col', 'input', 'link', 'param', 'source', 'track', 'wbr'];
const BREAKS_OUT = ['br', 'embed', 'hr', 'img', 'meta'];

describe('void element names inside svg', () => {
  it('writes an end tag for a void name in foreign content, so the next sibling is not read as its child', () => {
    for (const tag of CLOSED_BY_END_TAG) {
      assert.equal(renderToString(['svg', {}, [tag, {}], ['circle', {}]]), `<svg><${tag}></${tag}><circle></circle></svg>`, tag);
      assert.equal(dom(['svg', {}, [tag, {}], ['circle', {}]]).shape, `svg(svg)[${tag}(svg),circle(svg)]`, tag);
    }
    // its own children stay inside it, as the DOM renderer builds them
    assert.equal(renderToString(['svg', {}, ['g', {}, ['input', { x: 1 }, ['title', {}, 't']], ['circle', {}]]]),
      '<svg><g><input x="1"><title>t</title></input><circle></circle></g></svg>');
    assert.equal(dom(['svg', {}, ['g', {}, ['input', { x: 1 }, ['title', {}, 't']], ['circle', {}]]]).shape,
      'svg(svg)[g(svg)[input(svg)[title(svg)["t"]],circle(svg)]]');
    // a widget host in foreign content is not void either
    const widgets = { w: { mount() { return {}; }, ssr: () => ['circle', {}] } };
    assert.equal(renderToString(['svg', {}, ['jaren-widget', { name: 'w', tag: 'wbr' }], ['circle', {}]], { widgets }),
      '<svg><wbr><circle></circle></wbr><circle></circle></svg>');
    // the fallback of a host on svg is foreign content too
    const drawn = { w: { mount() { return {}; }, ssr: () => ['g', {}, ['input', {}], ['circle', {}]] } };
    assert.equal(renderToString(['jaren-widget', { name: 'w', tag: 'svg' }], { widgets: drawn }),
      '<svg><g><input></input><circle></circle></g></svg>');
  });

  it('reads HTML again under desc, title and foreignObject: a void name there takes no end tag, in any case', () => {
    assert.equal(renderToString(['svg', {}, ['desc', {}, ['br', {}], 'x', ['BR', {}], ['input', {}]], ['circle', {}]]),
      '<svg><desc><br>x<BR><input></desc><circle></circle></svg>');
    assert.equal(renderToString(['svg', {}, ['title', {}, ['img', { src: 'a.png' }], 't']]), '<svg><title><img src="a.png">t</title></svg>');
    assert.equal(renderToString(['svg', {}, ['foreignObject', {}, ['hr', {}], ['p', {}, 'x']]]),
      '<svg><foreignObject><hr><p>x</p></foreignObject></svg>');
    // a widget host under desc is an HTML void element as outside svg
    const widgets = { w: { mount() { return {}; }, ssr: () => ['b', {}, 'f'] } };
    assert.equal(renderToString(['svg', {}, ['desc', {}, ['jaren-widget', { name: 'w', tag: 'br' }], 'x']], { widgets }),
      '<svg><desc><br>x</desc></svg>');
    // the DOM renderer builds them as it did
    assert.equal(dom(['svg', {}, ['desc', {}, ['br', {}], 'x']]).shape, 'svg(svg)[desc(svg)[br(svg),"x"]]');
    // under safe profiles they are kept
    for (const safe of PROFILES) {
      /** @type {string[]} */
      const seen = [];
      const onUnsafe = (/** @type {any} */ i) => seen.push(`${i.kind}:${i.name}`);
      assert.equal(renderToString(['svg', {}, ['desc', {}, ['br', {}], 'x']], { safe, onUnsafe }), '<svg><desc><br>x</desc></svg>');
      assert.equal(dom(['svg', {}, ['desc', {}, ['br', {}], 'x']], { safe, onUnsafe }).shape, 'svg(svg)[desc(svg)[br(svg),"x"]]');
      assert.deepEqual(seen, []);
    }
  });

  it('refuses, in the trusted serializer, an element whose start tag ends the svg, and the DOM renderer builds it as before', () => {
    for (const tag of [...BREAKS_OUT, 'BR', 'Img']) {
      assert.throws(() => renderToString(['div', {}, ['svg', {}, ['g', {}, [tag, {}]], ['circle', {}]]]),
        { name: 'TypeError', message: `view: the <${tag}> at /2/2/2 sits inside an svg, where an HTML parser reads it as an HTML element `
          + 'that ends the svg: no markup keeps it inside. Move it out of the svg, or under a foreignObject' }, tag);
      assert.equal(dom(['svg', {}, [tag, {}], ['circle', {}]]).shape, `svg(svg)[${tag}(svg),circle(svg)]`, tag);
    }
    // a widget host, and an element inside an svg nested under desc
    const widgets = { w: { mount() { return {}; } } };
    assert.throws(() => renderToString(['svg', {}, ['jaren-widget', { name: 'w', tag: 'img' }]], { widgets }),
      { message: /^view: the <img> at \/2 sits inside an svg/ });
    assert.throws(() => renderToString(['svg', {}, ['desc', {}, ['svg', {}, ['br', {}]]]]),
      { message: /^view: the <br> at \/2\/2\/2 sits inside an svg/ });
    // outside svg, and under foreignObject, they are written as before
    assert.equal(renderToString(['div', {}, ['br', {}], ['svg', {}, ['foreignObject', {}, ['img', {}]]], ['hr', {}]]),
      '<div><br><svg><foreignObject><img></foreignObject></svg><hr></div>');
  });

  for (const safe of PROFILES) {
    it(`drops, on both renderers alike, an element whose start tag ends the svg (safe: ${JSON.stringify(safe)})`, () => {
      /** @type {string[]} */
      const ssr = [];
      /** @type {string[]} */
      const live = [];
      const vnode = ['svg', {}, ['br', {}], ['g', {}, ['hr', {}], ['img', { src: 'a.png' }]], ['circle', {}]];
      assert.equal(renderToString(vnode, { safe, onUnsafe: (i) => ssr.push(`${i.kind}:${i.name}`) }),
        '<svg><g></g><circle></circle></svg>');
      const r = dom(vnode, { safe, onUnsafe: (/** @type {any} */ i) => live.push(`${i.kind}:${i.name}`) });
      assert.equal(r.shape, 'svg(svg)["",g(svg)["",""],circle(svg)]');
      assert.deepEqual(ssr, ['tag:br', 'tag:hr', 'tag:img']);
      assert.deepEqual(live, ssr);
      // a later frame patching one in is dropped too, and reported once
      r.render(['svg', {}, ['br', {}], ['g', {}, ['hr', {}], ['img', { src: 'a.png' }], ['br', {}]], ['circle', {}]]);
      assert.equal(r.container.childNodes.map(shape).join(','), 'svg(svg)["",g(svg)["","",""],circle(svg)]');
      assert.deepEqual(live, [...ssr, 'tag:br', 'tag:hr', 'tag:img', 'tag:br']);
      // the elements the entry's first set names are kept, with an end tag
      assert.equal(renderToString(['svg', {}, ['input', {}], ['circle', {}]], { safe }), '<svg><input></input><circle></circle></svg>');
      assert.equal(dom(['svg', {}, ['input', {}], ['circle', {}]], { safe }).shape, 'svg(svg)[input(svg),circle(svg)]');
    });
  }

  it('drops a granted widget hosted on such an element inside svg, and keeps one on input, under the interactive profile', () => {
    const widgets = { w: { mount() { return {}; } } };
    const options = { safe: /** @type {const} */ ('interactive'), widgets, capabilities: { widgets: ['w'] } };
    /** @type {string[]} */
    const ssr = [];
    /** @type {string[]} */
    const live = [];
    const vnode = ['svg', {}, ['jaren-widget', { name: 'w', tag: 'br' }], ['jaren-widget', { name: 'w', tag: 'input' }], ['circle', {}]];
    assert.equal(renderToString(vnode, { ...options, onUnsafe: (i) => ssr.push(`${i.kind}:${i.name}`) }),
      '<svg><input></input><circle></circle></svg>');
    assert.equal(dom(vnode, { ...options, onUnsafe: (/** @type {any} */ i) => live.push(`${i.kind}:${i.name}`) }).shape,
      'svg(svg)["",input(svg),circle(svg)]');
    assert.deepEqual(ssr, ['tag:br']);
    assert.deepEqual(live, ssr);
    // outside svg the host on br is the void host it was
    assert.equal(renderToString(['div', {}, ['jaren-widget', { name: 'w', tag: 'br' }], 'x'], options), '<div><br>x</div>');
  });
});

describe('a widget hosted on svg', () => {
  it('is built in the SVG namespace on create, patch, replacement and hydration, as an svg element is', () => {
    /** @type {string[]} */
    const mounted = [];
    const widgets = { w: { mount(/** @type {any} */ host) { mounted.push(`${host.tagName}:${host.namespaceURI}`); return {}; } } };
    const r = dom(['jaren-widget', { name: 'w', tag: 'svg', class: 'a' }], { widgets });
    const node = /** @type {any} */ (r.container.childNodes[0]);
    // a host prop change patches the same host
    r.render(['jaren-widget', { name: 'w', tag: 'svg', class: 'b' }]);
    assert.equal(r.container.childNodes[0], node);
    assert.equal(node.getAttribute('class'), 'b');
    // a host tag change replaces it, into the namespace of the new tag
    r.render(['jaren-widget', { name: 'w', tag: 'div' }]);
    r.render(['jaren-widget', { name: 'w', tag: 'svg' }]);
    // inside an svg subtree, a host is in the SVG namespace as before
    dom(['svg', {}, ['jaren-widget', { name: 'w', tag: 'g' }]], { widgets });
    // hydration builds a widget a fresh host
    const { document, container } = createStubHost();
    container.appendChild(document.createElementNS(SVG_NS, 'svg'));
    createDomRenderer(container, { document, widgets, hydrate: true })(['jaren-widget', { name: 'w', tag: 'svg' }]);
    assert.deepEqual(mounted, [`svg:${SVG_NS}`, 'div:null', `svg:${SVG_NS}`, `g:${SVG_NS}`, `svg:${SVG_NS}`]);
    // an SVG element's `width` is a read-only object, not the attribute: a
    // host patched as an HTML element would assign it, which throws
    class SvgDocument extends StubDocument {
      /** @param {string} ns @param {string} tag */
      createElementNS(ns, tag) {
        const node = super.createElementNS(ns, tag);
        Object.defineProperty(node, 'width', { get: () => ({ baseVal: node.getAttribute('width') }) });
        return node;
      }
    }
    const svgDocument = new SvgDocument();
    const svgContainer = svgDocument.createElement('div');
    const sized = createDomRenderer(svgContainer, { document: svgDocument, widgets });
    sized(['jaren-widget', { name: 'w', tag: 'svg', width: 5 }]);
    sized(['jaren-widget', { name: 'w', tag: 'svg', width: 10 }]);
    assert.equal(/** @type {any} */ (svgContainer.childNodes[0]).getAttribute('width'), '10');
    // the serializer's markup, which a parser builds as an SVG element
    assert.equal(renderToString(['jaren-widget', { name: 'w', tag: 'svg' }], { widgets: { w: { ssr: () => ['circle', {}] } } }),
      '<svg><circle></circle></svg>');
  });
});
