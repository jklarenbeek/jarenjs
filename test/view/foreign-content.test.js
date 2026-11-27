//@ts-check
/**
 * Elements inside an `svg`, where an HTML parser reads foreign content: the
 * markup the serializer writes there must read back as the tree the DOM
 * renderer builds (VIEW-FORMAT §5.4, §6). In foreign content no element is
 * void, so an end tag closes `<input>` as it closes `<circle>`; an element
 * whose start tag ends the `svg` for a parser (`br`, `div`, `p`, `span`,
 * `table`, ..., in any case, and `font` with a `color`, `face` or `size`
 * attribute) has no such markup: the trusted serializer refuses it and the
 * safe profiles drop it on both renderers. Under an SVG `desc`, `title` or
 * `foreignObject` a parser reads HTML again, and the DOM renderer builds
 * their children in the HTML namespace. A widget hosted on `svg` is built in
 * the SVG namespace, as an `svg` element is.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
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
    // the DOM renderer builds them as a parser reads them: HTML elements
    assert.equal(dom(['svg', {}, ['desc', {}, ['br', {}], 'x']]).shape, 'svg(svg)[desc(svg)[br,"x"]]');
    // under safe profiles they are kept
    for (const safe of PROFILES) {
      /** @type {string[]} */
      const seen = [];
      const onUnsafe = (/** @type {any} */ i) => seen.push(`${i.kind}:${i.name}`);
      assert.equal(renderToString(['svg', {}, ['desc', {}, ['br', {}], 'x']], { safe, onUnsafe }), '<svg><desc><br>x</desc></svg>');
      assert.equal(dom(['svg', {}, ['desc', {}, ['br', {}], 'x']], { safe, onUnsafe }).shape, 'svg(svg)[desc(svg)[br,"x"]]');
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

/** The parser the oracle tests read the serializer's markup with. */
const parser = new JSDOM('<!doctype html><body></body>').window.document;

/**
 * Whether an HTML parser reads `markup` (an `svg` whose last child is a
 * `circle`) with the `svg` ended early: anything but one `svg` holding the
 * `circle` as its last child.
 * @param {string} markup
 * @returns {boolean}
 */
function endsTheSvg(markup) {
  const holder = parser.createElement('div');
  holder.innerHTML = markup;
  const svg = holder.firstChild;
  return !(holder.childNodes.length === 1 && svg?.namespaceURI === SVG_NS
    && svg.lastChild?.localName === 'circle' && svg.lastChild.namespaceURI === SVG_NS);
}

/** Element names an `svg` may meet: HTML's, SVG's, the parser's list in other cases. */
const NAMES = [
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'big', 'blockquote',
  'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist',
  'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure',
  'font', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup',
  'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'listing', 'main',
  'map', 'mark', 'marquee', 'math', 'menu', 'meta', 'meter', 'nav', 'nobr', 'noembed', 'noframes', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'plaintext', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span',
  'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot',
  'th', 'thead', 'time', 'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr', 'xmp',
  'svg', 'g', 'defs', 'symbol', 'use', 'marker', 'mask', 'clipPath', 'pattern', 'path', 'rect', 'circle',
  'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'image', 'linearGradient', 'stop',
  'title', 'desc', 'foreignObject',
  'DIV', 'Span', 'TABLE', 'H1', 'Font', 'BR',
];

/** `font` with each attribute spelling: a parser reads `color`, `face` and `size` in any case. */
const FONT_PROPS = [{}, { color: 'red' }, { FACE: 'serif' }, { Size: 0 }, { size: true }, { size: null },
  { size: false }, { color: undefined }, { colour: 'red' }, { class: 'f' }];

describe('HTML start tags that end an svg', () => {
  it('refuses, in the trusted serializer, exactly the elements a parser reads outside the svg', () => {
    for (const name of NAMES) {
      for (const props of name.toLowerCase() === 'font' ? FONT_PROPS : [{}]) {
        // the markup the serializer would write, read by a parser
        const attributes = Object.entries(props).filter(([, v]) => v != null && v !== false)
          .map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${v}"`).join('');
        const ends = endsTheSvg(`<svg><${name}${attributes}>x</${name}><circle></circle></svg>`);
        const vnode = ['svg', {}, [name, props, 'x'], ['circle', {}]];
        const label = `${name} ${JSON.stringify(props)}`;
        if (ends) {
          assert.throws(() => renderToString(vnode), {
            name: 'TypeError', message: `view: the <${name}> at /2 sits inside an svg, where an HTML parser reads it as an HTML `
              + 'element that ends the svg: no markup keeps it inside. Move it out of the svg, or under a foreignObject',
          }, label);
        } else {
          const markup = renderToString(vnode);
          assert.equal(endsTheSvg(markup), false, label);
          assert.equal(markup, `<svg><${name}${attributes}>x</${name}><circle></circle></svg>`, label);
        }
        // the trusted DOM renderer builds it inside the svg, as before
        const built = dom(vnode).container.childNodes[0];
        assert.equal(built.childNodes.length, 2, label);
      }
    }
  });

  for (const safe of PROFILES) {
    it(`drops on both renderers what a parser reads outside the svg, and keeps what it reads inside (safe: ${JSON.stringify(safe)})`, () => {
      for (const name of NAMES) {
        for (const props of name.toLowerCase() === 'font' ? FONT_PROPS : [{}]) {
          const label = `${name} ${JSON.stringify(props)}`;
          const attributes = Object.entries(props).filter(([, v]) => v != null && v !== false)
            .map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${v}"`).join('');
          const ends = endsTheSvg(`<svg><${name}${attributes}>x</${name}><circle></circle></svg>`);
          // whether the profile keeps the element outside svg
          const kept = renderToString(['div', {}, [name, props]], { safe }) !== '<div></div>';
          /** @type {string[]} */
          const ssr = [];
          /** @type {string[]} */
          const live = [];
          const vnode = ['svg', {}, [name, props, 'x'], ['circle', {}]];
          const markup = renderToString(vnode, { safe, onUnsafe: (i) => ssr.push(`${i.kind}:${i.name}`) });
          const r = dom(vnode, { safe, onUnsafe: (/** @type {any} */ i) => live.push(`${i.kind}:${i.name}`) });
          if (ends || !kept) {
            assert.equal(markup, '<svg><circle></circle></svg>', label);
            assert.equal(r.shape, 'svg(svg)["",circle(svg)]', label);
            assert.deepEqual(ssr.filter((k) => k.startsWith('tag:')), [`tag:${name}`], label);
          } else {
            assert.match(markup, new RegExp(`^<svg><${name}[ >]`), label);
            assert.equal(endsTheSvg(markup), false, label);
            assert.equal(r.shape.startsWith(`svg(svg)[${name}(svg)`), true, label);
            assert.deepEqual(ssr, [], label);
          }
          assert.deepEqual(live, ssr, label);
        }
      }
    });
  }

  it('reads a widget host as its element: refused trusted, dropped under the interactive profile', () => {
    const widgets = { w: { mount() { return {}; }, ssr: () => 'f' } };
    for (const props of [{ tag: 'div' }, { tag: 'Span' }, { tag: 'font', props: { a: 1 }, color: 'red' }]) {
      assert.throws(() => renderToString(['svg', {}, ['jaren-widget', { name: 'w', ...props }]], { widgets }),
        { message: new RegExp(`^view: the <${props.tag}> at /2 sits inside an svg`) }, props.tag);
    }
    // a host on font writing no such attribute stays inside
    assert.equal(renderToString(['svg', {}, ['jaren-widget', { name: 'w', tag: 'font', size: null }]], { widgets }),
      '<svg><font>f</font></svg>');
    const options = { safe: /** @type {const} */ ('interactive'), widgets, capabilities: { widgets: ['w'] } };
    /** @type {string[]} */
    const ssr = [];
    /** @type {string[]} */
    const live = [];
    const vnode = ['svg', {}, ['jaren-widget', { name: 'w', tag: 'span' }], ['jaren-widget', { name: 'w', tag: 'g' }]];
    assert.equal(renderToString(vnode, { ...options, onUnsafe: (i) => ssr.push(`${i.kind}:${i.name}`) }), '<svg><g>f</g></svg>');
    const r = dom(vnode, { ...options, onUnsafe: (/** @type {any} */ i) => live.push(`${i.kind}:${i.name}`) });
    assert.equal(r.shape, 'svg(svg)["",g(svg)]');
    assert.deepEqual(ssr, ['tag:span']);
    assert.deepEqual(live, ssr);
  });
});

describe('the HTML namespace under an SVG desc and title', () => {
  it('builds the children of desc and title as HTML elements, and a nested svg as SVG again', () => {
    const vnode = ['svg', {}, ['desc', {}, ['b', {}, 'x'], ['svg', {}, ['circle', {}]]], ['title', {}, ['span', {}, 't']],
      ['g', {}, ['circle', {}]]];
    const expected = 'svg(svg)[desc(svg)[b["x"],svg(svg)[circle(svg)]],title(svg)[span["t"]],g(svg)[circle(svg)]]';
    assert.equal(dom(vnode).shape, expected);
    for (const safe of PROFILES) assert.equal(dom(vnode, { safe }).shape, expected);
    // the serializer's markup, read by a parser, builds the same tree
    const holder = parser.createElement('div');
    holder.innerHTML = renderToString(vnode);
    assert.equal(holder.innerHTML, renderToString(vnode));
    /** @param {any} node @returns {string} */
    const read = (node) => node.nodeType === 3 ? JSON.stringify(node.nodeValue)
      : node.localName + (node.namespaceURI === SVG_NS ? '(svg)' : '')
        + (node.childNodes.length === 0 ? '' : `[${[...node.childNodes].map(read).join(',')}]`);
    assert.equal(read(holder.firstChild), expected);
    // an HTML title (outside svg) is unchanged
    assert.equal(dom(['title', {}, 'x']).shape, 'title["x"]');
  });

  it('builds them as HTML on a patch, and a widget host there in the HTML namespace', () => {
    /** @type {string[]} */
    const mounted = [];
    const widgets = { w: { mount(/** @type {any} */ host) { mounted.push(`${host.tagName}:${host.namespaceURI}`); return {}; } } };
    const r = dom(['svg', {}, ['desc', {}]], { widgets });
    r.render(['svg', {}, ['desc', {}, ['b', {}, 'x'], ['jaren-widget', { name: 'w', tag: 'span' }]]]);
    assert.equal(r.container.childNodes.map(shape).join(','), 'svg(svg)[desc(svg)[b["x"],span]]');
    r.render(['svg', {}, ['desc', {}, ['b', {}, 'y'], ['i', {}]]]);
    assert.equal(r.container.childNodes.map(shape).join(','), 'svg(svg)[desc(svg)[b["y"],i]]');
    assert.equal(mounted[0].split(':')[1], 'null');
  });

  it('adopts server markup under desc on hydration, without rebuilding it', () => {
    const window = new JSDOM('<!doctype html><body></body>').window;
    const container = window.document.createElement('div');
    const vnode = ['svg', {}, ['desc', {}, ['b', {}, 'x']], ['circle', {}]];
    container.innerHTML = renderToString(vnode);
    const b = container.querySelector('b');
    createDomRenderer(container, { document: window.document, hydrate: true })(vnode);
    assert.equal(container.querySelector('b'), b);
    assert.equal(b.namespaceURI, 'http://www.w3.org/1999/xhtml');
    assert.equal(container.innerHTML, '<svg><desc><b>x</b></desc><circle></circle></svg>');
  });

  it('writes a style under desc or title as raw text, as a parser reads it, and refuses an end tag in it', () => {
    assert.equal(renderToString(['svg', {}, ['desc', {}, ['style', {}, 'a>b{}']]]), '<svg><desc><style>a>b{}</style></desc></svg>');
    assert.equal(renderToString(['svg', {}, ['title', {}, ['script', {}, 'a&&b']]]), '<svg><title><script>a&&b</script></title></svg>');
    assert.throws(() => renderToString(['svg', {}, ['desc', {}, ['style', {}, '</style>']]]),
      { message: /^view: the text of the <style> at \/2\/2 contains "<\/style>"/ });
    // directly inside svg, a parser decodes a style's text: it stays escaped
    assert.equal(renderToString(['svg', {}, ['style', {}, 'a>b{}']]), '<svg><style>a&gt;b{}</style></svg>');
    // a widget host on desc: its fallback reads as HTML too
    const widgets = { w: { mount() { return {}; }, ssr: () => ['style', {}, 'a>b{}'] } };
    assert.equal(renderToString(['svg', {}, ['jaren-widget', { name: 'w', tag: 'desc' }]], { widgets }),
      '<svg><desc><style>a>b{}</style></desc></svg>');
    const holder = parser.createElement('div');
    holder.innerHTML = '<svg><desc><style>a>b{}</style></desc></svg>';
    assert.equal(holder.querySelector('style')?.textContent, 'a>b{}');
  });
});
