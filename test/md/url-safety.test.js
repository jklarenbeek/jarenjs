//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, compileMarkdown } from '@jarenjs/md';
import { definePlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';

const TAB = String.fromCharCode(0x09);

/** Render Markdown the way a consumer does: parse, emit vnodes, serialize. */
const html = (src, options) => renderToString(mdToVnode(parseMarkdown(src), options));

describe('md — link and image URLs are filtered at the vnode boundary', function () {

  it('drops an executable scheme from a link, keeping the text readable', function () {
    assert.equal(html('[x](javascript:alert(1))'),
      '<article class="md"><p><a>x</a></p></article>');
    assert.equal(html('[x](vbscript:msgbox(1))'),
      '<article class="md"><p><a>x</a></p></article>');
  });

  it('drops a document-smuggling scheme from a link', function () {
    assert.equal(html('[x](data:text/html,<script>1</script>)'),
      '<article class="md"><p><a>x</a></p></article>');
    assert.equal(html('[x](file:///etc/passwd)'),
      '<article class="md"><p><a>x</a></p></article>');
  });

  it('is not fooled by case or by the noise a browser strips', function () {
    assert.equal(html('[x](JaVaScRiPt:alert(1))'),
      '<article class="md"><p><a>x</a></p></article>');
    assert.equal(html('[x](<java' + TAB + 'script:alert(1)>)'),
      '<article class="md"><p><a>x</a></p></article>');
  });

  it('drops the src of a dangerous image but keeps its alt text', function () {
    assert.equal(html('![y](javascript:alert(2))'),
      '<article class="md"><p><img alt="y"></p></article>');
    assert.equal(html('![y](data:text/html,x)'),
      '<article class="md"><p><img alt="y"></p></article>');
  });

  it('keeps the title when the destination is dropped', function () {
    assert.equal(html('[x](javascript:alert(1) "T")'),
      '<article class="md"><p><a title="T">x</a></p></article>');
  });

  it('filters a reference-style destination too', function () {
    assert.equal(html('[ref][r]\n\n[r]: javascript:alert(1)'),
      '<article class="md"><p><a>ref</a></p></article>');
  });

  it('leaves ordinary destinations untouched, relative ones included', function () {
    assert.equal(html('[x](https://ok.test)'),
      '<article class="md"><p><a href="https://ok.test">x</a></p></article>');
    // A scheme-less relative reference is the common case in prose, and an
    // allow-list policy would silently strip it.
    assert.equal(html('[x](image.png)'),
      '<article class="md"><p><a href="image.png">x</a></p></article>');
    assert.equal(html('[x](docs/guide.md)'),
      '<article class="md"><p><a href="docs/guide.md">x</a></p></article>');
    assert.equal(html('![y](/i.png)'),
      '<article class="md"><p><img src="/i.png" alt="y"></p></article>');
    assert.equal(html('<https://ok.test>'),
      '<article class="md"><p><a href="https://ok.test">https://ok.test</a></p></article>');
  });

  it('allows a raster data: image but not an svg or html one', function () {
    assert.equal(html('![y](data:image/png;base64,AAA)'),
      '<article class="md"><p><img src="data:image/png;base64,AAA" alt="y"></p></article>');
    assert.equal(html('![y](data:image/svg+xml,<svg/>)'),
      '<article class="md"><p><img alt="y"></p></article>');
  });

  it('keeps the AST verbatim so toMarkdown still round-trips', function () {
    const compiled = compileMarkdown('[x](javascript:alert(1))');
    assert.equal(compiled.ast[0].children[0].url, 'javascript:alert(1)');
    assert.equal(compiled.toMarkdown().trim(), '[x](<javascript:alert(1)>)');
    assert.equal(renderToString(compiled.toVnode()),
      '<article class="md"><p><a>x</a></p></article>');
  });

  it('lets a host widen the policy for trusted content', function () {
    const passThrough = (url) => url;
    assert.equal(html('[x](javascript:alert(1))', { sanitizeUrl: passThrough }),
      '<article class="md"><p><a href="javascript:alert(1)">x</a></p></article>');
  });

  it('makes the policy part of the memo identity', function () {
    // The per-node memo outlives one emission, so re-rendering the same
    // compiled document under a different policy must not serve the vnode
    // the previous policy produced.
    const compiled = compileMarkdown('[x](https://ok.test)');
    const dropAll = () => null;
    const withHref = '<article class="md"><p><a href="https://ok.test">x</a></p></article>';
    const withoutHref = '<article class="md"><p><a>x</a></p></article>';

    assert.equal(renderToString(compiled.toVnode()), withHref);
    assert.equal(renderToString(mdToVnode(compiled, { sanitizeUrl: dropAll })), withoutHref);
    assert.equal(renderToString(mdToVnode(compiled, {})), withHref);
    assert.equal(renderToString(mdToVnode(compiled, { sanitizeUrl: dropAll })), withoutHref);
  });

  it('hands the active policy to plugin renders, which shadow the core emitter', function () {
    // PLUGINS.md §5 makes this a MUST for plugins that emit an href/src
    // from document content, so the hook has to actually be reachable.
    const seen = [];
    const linkish = definePlugin({
      name: 'linkish', fences: ['linkish'], node: 'linkish',
      render: (node, hh, ctx) => {
        const href = ctx.sanitizeUrl(node.value.trim());
        seen.push(href);
        return hh('a', href === null ? {} : { href }, 'go');
      },
    });
    const plugins = [linkish];
    const render = (src) => renderToString(
      mdToVnode(parseMarkdown(src, { plugins }), { plugins }));

    assert.equal(render('```linkish\njavascript:alert(1)\n```\n'),
      '<article class="md"><a>go</a></article>');
    assert.equal(render('```linkish\nhttps://ok.test\n```\n'),
      '<article class="md"><a href="https://ok.test">go</a></article>');
    assert.deepEqual(seen, [null, 'https://ok.test']);
  });

  it('still returns a reference-equal vnode under an unchanged policy', function () {
    // The patcher's O(1) skip depends on this; widening the memo key must
    // not cost the identity guarantee.
    const compiled = compileMarkdown('[x](https://ok.test)');
    const first = mdToVnode(compiled, {});
    const second = mdToVnode(compiled, {});
    assert.equal(first[2][0], second[2][0]);
  });
});
