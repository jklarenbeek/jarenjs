//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileMarkdown, createMdRenderer, hashContent, mdToVnode, parseMarkdown } from '@jarenjs/md';
import { highlightPlugin, definePlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';
import { StubElement, createStubHost, serialize } from '../view/dom.stub.js';

// The md renderer needs two DOM members the view stub does not model.
/** @type {any} */ (StubElement.prototype).getAttribute = function (name) {
  return this.attributes.get(name) ?? null;
};
/** @type {any} */ (StubElement.prototype).querySelectorAll = function (selector) {
  const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
  const out = [];
  const walk = (node) => {
    if (!(node instanceof StubElement)) return;
    if (attr !== undefined && node.attributes.has(attr)) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(this);
  return out;
};

/** Serialize a stub tree like the SSR renderer would (text unescaped). */
function domHtml(container) {
  let out = '';
  for (const child of container.childNodes) out += serialize(child);
  return out;
}

describe('mdToVnode: heading ids and anchors', function () {
  /** The rendered HTML of a document, minus the article wrapper. */
  const html = (src, options) => {
    const out = renderToString(mdToVnode(parseMarkdown(src), options));
    return out.slice('<article class="md">'.length, -'</article>'.length);
  };
  /** Every `id` attribute value, in document order. */
  const ids = (markup) => [...markup.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
  /** The block `key` props of a rendered document, in document order. */
  const keys = (src, options) =>
    mdToVnode(parseMarkdown(src), options)[2].map((block) => block[1].key);

  const SETUPS = '# Doc\n\n## Setup\n\ntext\n\n## Setup\n\nmore\n\n## Setup\n';

  it('emits no id by default — CommonMark says <h1>Foo</h1>', function () {
    const src = '# Hello, World!\n\n## Setup\n';
    assert.equal(html(src), '<h1>Hello, World!</h1><h2>Setup</h2>');
    // and passing the option off explicitly is the same document
    assert.equal(html(src, { headingIds: false }), html(src));
  });

  it('slugs heading text the way GitHub does', function () {
    assert.equal(
      html('# Hello, World!\n', { headingIds: true }),
      '<h1 id="hello-world">Hello, World!</h1>');
  });

  it('numbers repeated headings from a counter of its own', function () {
    assert.deepEqual(ids(html(SETUPS, { headingIds: true })),
      ['doc', 'setup', 'setup-1', 'setup-2']);
  });

  it('gives a heading with no slug-worthy text a landing place', function () {
    assert.deepEqual(ids(html('## ***\n\n## !!!\n', { headingIds: true })),
      ['section', 'section-1']);
  });

  it('prefixes every id and every anchor href with slugPrefix', function () {
    const markup = html('## Setup\n', {
      headingIds: true, headingAnchors: true, slugPrefix: 'user-content-',
    });
    assert.match(markup, /<h2 id="user-content-setup">/);
    assert.match(markup, /href="#user-content-setup"/);
  });

  it('appends a keyboard-reachable anchor with an accessible name', function () {
    const markup = html('## Setup\n', { headingIds: true, headingAnchors: true });
    assert.equal(markup,
      '<h2 id="setup">Setup<a class="md-anchor" href="#setup"'
      + ' aria-label="Permalink to Setup">#</a></h2>');
  });

  it('emits no anchor without ids to point at', function () {
    assert.equal(html('## Setup\n', { headingAnchors: true }), '<h2>Setup</h2>');
  });

  it('leaves block keys identical — keying hashes the node, not the props', function () {
    const plain = keys(SETUPS);
    assert.deepEqual(keys(SETUPS, { headingIds: true }), plain);
    assert.deepEqual(
      keys(SETUPS, { headingIds: true, headingAnchors: true, slugPrefix: 'user-content-' }),
      plain);
    assert.equal(plain.every((key) => typeof key === 'string'), true);
  });
});

describe('createMdRenderer', function () {
  it('mounts and patches through the view DOM renderer', function () {
    const { document, container } = createStubHost();
    const render = createMdRenderer({ container, document });
    render(compileMarkdown('# A\n\nfirst\n'));
    assert.match(domHtml(container), /<h1[^>]*>A<\/h1><p[^>]*>first<\/p>/);
    render(compileMarkdown('# A\n\nsecond\n'));
    assert.match(domHtml(container), /<p[^>]*>second<\/p>/);
  });

  it('SSR string and DOM render agree for a representative document', function () {
    const src = '# T *em*\n\n- a\n- b\n\n| h |\n| --- |\n| 1 |\n\n```txt\nx < y\n```\n';
    const compiled = compileMarkdown(src);
    const { document, container } = createStubHost();
    const render = createMdRenderer({ container, document });
    render(compiled);
    // The stub serializer does not escape text; compare on a document
    // without markup-significant characters after normalizing.
    const ssr = renderToString(compiled.toVnode()).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.equal(domHtml(container), ssr);
  });

  it('runs hydrate hooks after mount, once per content hash', async function () {
    const rendered = [];
    // A synthetic hydratable plugin; the native mermaid no longer
    // hydrates (its render is complete).
    const widget = definePlugin({
      name: 'widget', fences: ['widget'], node: 'widget',
      render: (node, hh) => hh('div', { class: 'widget', 'data-md-hydrate': 'widget', 'data-md-hash': hashContent(node.value) }),
      hydrate: async (el, node) => { rendered.push(node.value); el.innerHTML = '<svg>ok</svg>'; },
    });
    const plugins = [widget, highlightPlugin()];
    const src = '# D\n\n```widget\ngraph TD; A-->B\n```\n';
    const { document, container } = createStubHost();
    const render = createMdRenderer({ container, document, plugins });
    render(compileMarkdown(src, { plugins }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rendered, ['graph TD; A-->B\n']);
    const target = container.querySelectorAll('[data-md-hydrate]')[0];
    assert.equal(target.innerHTML, '<svg>ok</svg>');
    // Re-render with the same content: hydrate does not run again.
    render(compileMarkdown(src, { plugins }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rendered, ['graph TD; A-->B\n']);
  });

  it('contains hydrate failures per element', async function () {
    const errors = [];
    const widget = definePlugin({
      name: 'widget', fences: ['widget'], node: 'widget',
      render: (node, hh) => hh('div', { class: 'widget', 'data-md-hydrate': 'widget', 'data-md-hash': hashContent(node.value) }),
      hydrate: async () => { throw new Error('diagram exploded'); },
    });
    const plugins = [widget];
    const { document, container } = createStubHost();
    const render = createMdRenderer({
      container, document, plugins,
      onHydrateError: (err) => errors.push(err.message),
    });
    render(compileMarkdown('```widget\nboom\n```\n', { plugins }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(errors, ['diagram exploded']);
  });
});
