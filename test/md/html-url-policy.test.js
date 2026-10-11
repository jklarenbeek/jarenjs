//@ts-check
/**
 * `html: 'vnode'` keeps the allow-listed raw-HTML elements, and every URL
 * it keeps goes through the URL policy — the host's own when it gives
 * one. The host's `sanitizeUrl` used to reach Markdown links and images
 * only: a raw `<a href>` or `<img src>` was judged by the default policy
 * whatever the host had said. And `srcset` carries a list of URLs and went
 * through unread, so a policy that refused `src` was bypassed by naming
 * the same image in `srcset`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

/** @param {string} source @param {any} [options] */
const html = (source, options) => renderToString(mdToVnode(parseMarkdown(source), { html: 'vnode', ...options }))
  .replace(/^<article[^>]*>|<\/article>$/g, '');

const own = (/** @type {string} */ url) => (url.startsWith('https://ok.test/') || url.startsWith('/') ? url : null);

describe('html: vnode — srcset candidates go through the URL policy', function () {
  it('drops a candidate the default policy refuses and keeps the rest', () => {
    assert.equal(html('<img src="a.png" srcset="a.png 1x, javascript:alert(1) 2x">'),
      '<img src="a.png" srcset="a.png 1x">');
  });

  it('omits the attribute when no candidate survives', () => {
    assert.equal(html('<img src="a.png" srcset="javascript:alert(1) 1x, data:text/html,x 2x">'),
      '<img src="a.png">');
  });

  it('applies a host policy to every candidate, and to a source element', () => {
    assert.equal(html('<img src="/a.png" srcset="/a.png 1x, https://ok.test/b.png 2x, https://evil.test/c.png 3x">', { sanitizeUrl: own }),
      '<img src="/a.png" srcset="/a.png 1x, https://ok.test/b.png 2x">');
    assert.equal(html('<picture><source srcset="https://evil.test/c.png"><img src="/a.png"></picture>', { sanitizeUrl: own }),
      '<p><picture><source><img src="/a.png"></picture></p>');
  });

  it('reads the candidate list as the specification does', () => {
    assert.equal(html('<img src="a.png" srcset="a.png 1x,b.png 2x">'), '<img src="a.png" srcset="a.png 1x, b.png 2x">');
    assert.equal(html('<img src="a.png" srcset="  a.png,  b.png   480w ,  ">'), '<img src="a.png" srcset="a.png, b.png 480w">');
    assert.equal(html('<img src="a.png" srcset="a.png">'), '<img src="a.png" srcset="a.png">');
    // a comma inside parentheses belongs to the descriptor, not the list
    assert.equal(html('<img src="a.png" srcset="a.png (x, y) 2x, b.png 3x">'),
      '<img src="a.png" srcset="a.png (x, y) 2x, b.png 3x">');
  });
});

describe('html: vnode — the host URL policy judges raw HTML as it judges Markdown', function () {
  it('a narrowing policy drops a raw href and src the default would keep', () => {
    assert.equal(html('<a href="https://evil.test/x">x</a>\n', { sanitizeUrl: own }), '<p><a>x</a></p>');
    assert.equal(html('<a href="https://ok.test/x">x</a>\n', { sanitizeUrl: own }), '<p><a href="https://ok.test/x">x</a></p>');
    assert.equal(html('<img src="https://evil.test/p.png" alt="p">\n', { sanitizeUrl: own }), '<img alt="p">');
  });

  it('judges the same way inside a paragraph, where each tag is its own node', () => {
    assert.equal(html('see <a href="https://evil.test/x">x</a> and [y](https://evil.test/y)', { sanitizeUrl: own }),
      '<p>see <a>x</a> and <a>y</a></p>');
  });

  it('a widening policy is honoured in raw HTML too', () => {
    const everything = (/** @type {string} */ url) => url;
    assert.equal(html('<a href="javascript:void(0)">x</a>\n', { sanitizeUrl: everything }),
      '<p><a href="javascript:void(0)">x</a></p>');
    assert.equal(html('<a href="javascript:void(0)">x</a>\n'), '<p><a>x</a></p>');
  });

  it('an injected parseHtml still owns the raw HTML it is given', () => {
    const seen = [];
    html('<a href="https://evil.test/x">x</a>\n', { parseHtml: (/** @type {string} */ source) => { seen.push(source); return []; } });
    assert.deepEqual(seen, ['<a href="https://evil.test/x">', '</a>']);
  });
});
