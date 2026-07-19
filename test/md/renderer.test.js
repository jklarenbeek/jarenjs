//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileMarkdown, createMdRenderer } from '@jarenjs/md';
import { mermaidPlugin, highlightPlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';
import { StubElement, StubText, createStubHost, serialize } from '../view/dom.stub.js';

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
    const fake = {
      initialize() {},
      render: async (id, source) => {
        rendered.push(source);
        return { svg: '<svg>ok</svg>' };
      },
    };
    const plugins = [mermaidPlugin({ mermaid: fake }), highlightPlugin()];
    const src = '# D\n\n```mermaid\ngraph TD; A-->B\n```\n';
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
    const fake = {
      initialize() {},
      render: async () => { throw new Error('diagram exploded'); },
    };
    const plugins = [mermaidPlugin({ mermaid: fake })];
    const { document, container } = createStubHost();
    const render = createMdRenderer({
      container, document, plugins,
      onHydrateError: (err) => errors.push(err.message),
    });
    render(compileMarkdown('```mermaid\nboom\n```\n', { plugins }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(errors, ['diagram exploded']);
  });
});
