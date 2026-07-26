//@ts-check
/**
 * Raw HTML parsed to vnodes: what the allow-list keeps, what it drops,
 * and the structural safety property that makes the mode offerable at
 * all — the output is a vnode tree, so nothing an author writes can
 * become markup the tree cannot represent.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, parseHtmlFragment, parseHtmlTag } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

/** Render a document through the vnode HTML mode, without the wrapper. */
function html(source, options = {}) {
  return renderToString(mdToVnode(parseMarkdown(source, { frontmatter: false }),
    { html: 'vnode', ...options }))
    .slice('<article class="md">'.length, -'</article>'.length);
}

describe('parseHtmlFragment', function () {
  it('keeps allow-listed elements with their allow-listed attributes', function () {
    assert.deepEqual(parseHtmlFragment('<details open><summary>More</summary>text</details>'), [
      ['details', { open: '' }, ['summary', {}, 'More'], 'text'],
    ]);
    assert.deepEqual(parseHtmlFragment('<td colspan="2" bogus="x">c</td>'), [
      ['td', { colspan: '2' }, 'c'],
    ]);
  });

  it('drops an unknown element but keeps what it wrapped', function () {
    assert.deepEqual(parseHtmlFragment('<unknown>kept <b>text</b></unknown>'),
      ['kept ', ['b', {}, 'text']]);
  });

  it('drops event handlers, styles and everything else unlisted', function () {
    assert.deepEqual(parseHtmlFragment('<b onclick="evil()" style="x" class="k">t</b>'),
      [['b', { class: 'k' }, 't']]);
  });

  it('drops the whole subtree of an element whose content is not prose', function () {
    for (const source of ['<script>alert(1)</script>', '<style>body{}</style>',
      '<noscript>x</noscript>', '<template><b>t</b></template>']) {
      assert.deepEqual(parseHtmlFragment(source + 'after'), ['after'], source);
    }
  });

  it('filters URLs with the same policy as Markdown links', function () {
    assert.deepEqual(parseHtmlFragment('<a href="javascript:evil()">x</a>'), [['a', {}, 'x']]);
    assert.deepEqual(parseHtmlFragment('<a href="/ok">x</a>'), [['a', { href: '/ok' }, 'x']]);
    assert.deepEqual(parseHtmlFragment('<img src="data:text/html,x" alt="a">'),
      [['img', { alt: 'a' }]]);
    // an injected policy replaces it wholesale
    assert.deepEqual(parseHtmlFragment('<a href="/ok">x</a>', { sanitizeUrl: () => null }),
      [['a', {}, 'x']]);
  });

  it('drops comments, doctypes and processing instructions entirely', function () {
    // the text around them joins up: dropping one leaves no boundary
    assert.deepEqual(parseHtmlFragment('<!-- secret -->a<!DOCTYPE html>b<?pi?>c'), ['abc']);
  });

  it('closes what is left open and drops what closes nothing', function () {
    assert.deepEqual(parseHtmlFragment('<p>unclosed'), [['p', {}, 'unclosed']]);
    assert.deepEqual(parseHtmlFragment('</div>after'), ['after']);
  });

  it('decodes character references in text and attributes', function () {
    assert.deepEqual(parseHtmlFragment('<b title="f&ouml;&ouml;">a &amp; b</b>'),
      [['b', { title: 'föö' }, 'a & b']]);
  });

  it('treats a lone `<` as text, not as a tag', function () {
    assert.deepEqual(parseHtmlFragment('a < b'), ['a < b']);
    assert.deepEqual(parseHtmlFragment('<3'), ['<3']);
  });

  it('classifies one tag for the inline path', function () {
    assert.deepEqual(parseHtmlTag('<b>'), { name: 'b', closing: false, complete: false, drop: false, props: {} });
    assert.deepEqual(parseHtmlTag('</b>'), { name: 'b', closing: true, complete: false, drop: false, props: {} });
    assert.equal(parseHtmlTag('<br>').complete, true, 'a void element needs no end tag');
    assert.equal(parseHtmlTag('<x/>').complete, true);
    assert.equal(parseHtmlTag('<script>').drop, true);
    assert.equal(parseHtmlTag('<b>text</b>'), null, 'not a lone tag');
    assert.equal(parseHtmlTag('not a tag'), null);
  });
});

describe("mdToVnode html: 'vnode'", function () {
  it('renders a raw HTML block as elements', function () {
    assert.equal(html('<div class="note">\ntext\n</div>'),
      '<div class="note">\ntext\n</div>');
  });

  it('pairs inline tags that arrive one at a time', function () {
    // CommonMark's inline phase emits `<b>`, the text, and `</b>` as
    // three siblings — the renderer has to put them back together
    assert.equal(html('Text with <b>bold</b> and <img src="a.png" alt="A">.'),
      '<p>Text with <b>bold</b> and <img src="a.png" alt="A">.</p>');
    assert.equal(html('A <span class="x">span <em>with</em> markdown</span> here.'),
      '<p>A <span class="x">span <em>with</em> markdown</span> here.</p>');
  });

  it('closes an unclosed inline tag at the end of its run', function () {
    assert.equal(html('Unclosed <b>tag.'), '<p>Unclosed <b>tag.</b></p>');
  });

  it('never lets a handler or a script through', function () {
    assert.equal(html('Evil <b onclick="x()">b</b> and <script>alert(1)</script>.'),
      '<p>Evil <b>b</b> and .</p>');
  });

  it('leaves the other two modes exactly as they were', function () {
    const source = 'a <b>c</b>';
    const render = (mode) => renderToString(
      mdToVnode(parseMarkdown(source, { frontmatter: false }), { html: mode }));
    assert.match(render('skip'), /<p>a c<\/p>/);
    assert.match(render('text'), /&lt;b&gt;/);
  });

  it('takes an injected parser instead of the built-in one', function () {
    // the contract is a LIST of vnodes — a vnode is itself an array, so
    // a bare one would be indistinguishable from a list of three children
    assert.equal(
      html('<div>x</div>', { parseHtml: () => [['mark', {}, 'replaced']] }),
      '<mark>replaced</mark>');
    // a parser that keeps nothing renders nothing, like 'skip'
    assert.equal(html('<div>x</div>', { parseHtml: () => [] }), '');
  });

  it('keeps the AST untouched — only the projection changes', function () {
    const doc = parseMarkdown('<div>x</div>', { frontmatter: false });
    assert.equal(doc.ast[0].type, 'html');
    assert.equal(doc.ast[0].value, '<div>x</div>');
  });
});

describe('escapes and references outside inline content', function () {
  const md = (source) => parseMarkdown(source, { frontmatter: false }).ast;

  it('resolves both in a fence info string', function () {
    assert.equal(md('``` foo\\+bar\ncode\n```')[0].lang, 'foo+bar');
    assert.equal(md('``` f&ouml;&ouml;\ncode\n```')[0].lang, 'föö');
  });

  it('resolves both in a link destination and title', function () {
    const [para] = md('[t](/a\\)b "f&ouml;&ouml;")');
    assert.equal(para.children[0].url, '/a)b', 'the escaped paren is content, not the closer');
    assert.equal(para.children[0].title, 'föö');
  });

  it('leaves a backslash before a non-punctuation character alone', function () {
    assert.equal(md('[t](/a\\zb)')[0].children[0].url, '/a\\zb');
  });
});
