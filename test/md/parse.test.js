//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

/**
 * Render a source through parse → vnode → SSR and strip the article
 * wrapper, for compact conformance assertions.
 * @param {string} src
 * @param {any} [options]
 */
function html(src, options) {
  const out = renderToString(mdToVnode(parseMarkdown(src, options)));
  return out.slice('<article class="md">'.length, -'</article>'.length);
}

describe('parseMarkdown: CommonMark core', function () {
  it('parses ATX headings at every depth', function () {
    assert.equal(html('# h1'), '<h1>h1</h1>');
    assert.equal(html('###### h6'), '<h6>h6</h6>');
    assert.equal(html('####### not a heading'), '<p>####### not a heading</p>');
    assert.equal(html('#no space'), '<p>#no space</p>');
    assert.equal(html('## closed ##'), '<h2>closed</h2>');
  });

  it('parses setext headings under paragraphs', function () {
    assert.equal(html('title\n====='), '<h1>title</h1>');
    assert.equal(html('title\n-----'), '<h2>title</h2>');
  });

  it('parses thematic breaks and precedence over lists', function () {
    assert.equal(html('***'), '<hr>');
    assert.equal(html('- - -'), '<hr>');
    assert.equal(html('___'), '<hr>');
    assert.equal(html('--'), '<p>--</p>');
  });

  it('parses paragraphs with lazy continuation', function () {
    assert.equal(html('one\ntwo'), '<p>one\ntwo</p>');
    assert.equal(html('a\n\nb'), '<p>a</p><p>b</p>');
  });

  it('parses blockquotes, nested and lazy', function () {
    assert.equal(html('> quote'), '<blockquote><p>quote</p></blockquote>');
    assert.equal(html('> a\nlazy'), '<blockquote><p>a\nlazy</p></blockquote>');
    assert.equal(html('> > deep'),
      '<blockquote><blockquote><p>deep</p></blockquote></blockquote>');
  });

  it('parses tight and loose lists', function () {
    assert.equal(html('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(html('- a\n\n- b'),
      '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    assert.equal(html('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
    assert.equal(html('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  });

  // The blocks of a list item are separated by a newline — with a tight
  // item's paragraphs unwrapped, nothing else marks the boundary
  // (CommonMark §List items, e.g. `- Bar\n  ---\n  baz` renders as
  // `<li>\n<h2>Bar</h2>\nbaz</li>`).
  it('nests blocks inside list items by indentation', function () {
    assert.equal(html('- a\n  - b'), '<ul><li>a\n<ul><li>b</li></ul></li></ul>');
    assert.equal(html('- a\n\n  b'),
      '<ul><li><p>a</p>\n<p>b</p></li></ul>');
    assert.equal(html('1. a\n   > q'),
      '<ol><li>a\n<blockquote><p>q</p></blockquote></li></ol>');
    assert.equal(html('- Bar\n  ---\n  baz'),
      '<ul><li><h2>Bar</h2>\nbaz</li></ul>');
  });

  // §List items, "an empty list item": a marker followed by nothing but
  // whitespace opens an item with no content. It cannot INTERRUPT a
  // paragraph, but inside a list that is already open it starts the
  // next item like any other marker.
  it('opens empty list items', function () {
    assert.equal(html('- foo\n-\n- bar'), '<ul><li>foo</li><li></li><li>bar</li></ul>');
    assert.equal(html('1. foo\n2.\n3. bar'), '<ol><li>foo</li><li></li><li>bar</li></ol>');
    // trailing whitespace after the marker is still an empty item, and
    // it does not make the list loose
    assert.equal(html('- foo\n-   \n- bar'), '<ul><li>foo</li><li></li><li>bar</li></ul>');
    // an item may begin with at most one blank line: the second ends it
    assert.equal(html('-\n\n  foo'), '<ul><li></li></ul><p>foo</p>');
    // …but a bare `-` under a paragraph is still a setext underline
    assert.equal(html('foo\n-\n'), '<h2>foo</h2>');
  });

  // §Lists, tight vs loose: looseness is a property of a list's OWN
  // items. A blank line inside a sublist or a blockquote belongs to that
  // container and must not leak outward.
  it('decides tightness from a list\'s own items', function () {
    assert.equal(html('- a\n  - b\n\n    c\n- d'),
      '<ul><li>a\n<ul><li><p>b</p>\n<p>c</p></li></ul></li><li>d</li></ul>');
    assert.equal(html('* a\n  > b\n  >\n* c'),
      '<ul><li>a\n<blockquote><p>b</p></blockquote></li><li>c</li></ul>');
    // a blank line BETWEEN two items is the loose case
    assert.equal(html('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });

  // §Lists: changing the delimiter (or the bullet) starts a new list,
  // even where the old one's paragraph was still open.
  it('starts a new list when the marker changes', function () {
    assert.equal(html('1. foo\n2. bar\n3) baz'),
      '<ol><li>foo</li><li>bar</li></ol><ol start="3"><li>baz</li></ol>');
    assert.equal(html('- a\n+ b'), '<ul><li>a</li></ul><ul><li>b</li></ul>');
  });

  // §List items: a blank container line closes the paragraph, so what
  // follows opens a second block inside the same item — it is not a lazy
  // continuation of the first.
  it('reopens after a blank line inside nested containers', function () {
    assert.equal(html('   > > 1.  one\n>>\n>>     two'),
      '<blockquote><blockquote><ol><li><p>one</p>\n<p>two</p></li></ol></blockquote></blockquote>');
    assert.equal(html('>>- one\n>>\n  >  > two'),
      '<blockquote><blockquote><ul><li>one</li></ul><p>two</p></blockquote></blockquote>');
  });

  it('parses fenced code with info strings', function () {
    const doc = parseMarkdown('```js meta info\nlet x;\n```');
    assert.deepEqual(doc.ast[0],
      { type: 'code', lang: 'js', meta: 'meta info', value: 'let x;\n' });
    assert.equal(html('```\nplain\n```'), '<pre><code>plain\n</code></pre>');
    assert.equal(html('~~~\ntildes\n~~~'), '<pre><code>tildes\n</code></pre>');
  });

  it('keeps unterminated fences to end of input', function () {
    assert.equal(html('```\nno close'), '<pre><code>no close\n</code></pre>');
  });

  it('parses indented code blocks', function () {
    assert.equal(html('    a\n    b'), '<pre><code>a\nb\n</code></pre>');
    assert.equal(html('para\n    not code'), '<p>para\nnot code</p>');
  });

  it('parses inline emphasis and strong with the flanking rules', function () {
    assert.equal(html('*em*'), '<p><em>em</em></p>');
    assert.equal(html('**strong**'), '<p><strong>strong</strong></p>');
    assert.equal(html('***both***'), '<p><em><strong>both</strong></em></p>');
    assert.equal(html('a *b **c** d* e'), '<p>a <em>b <strong>c</strong> d</em> e</p>');
    assert.equal(html('foo_bar_baz'), '<p>foo_bar_baz</p>');
    assert.equal(html('a * b * c'), '<p>a * b * c</p>');
    // the flanking rules are defined over UNICODE classes: a no-break
    // space is whitespace, and a currency SYMBOL counts as punctuation
    assert.equal(html('* a *'), '<p>* a *</p>');
    assert.equal(html('*£*bravo.'), '<p>*£*bravo.</p>');
    assert.equal(html('*𞋿*delta.'), '<p>*𞋿*delta.</p>');
  });

  it('parses code spans with space stripping and backtick runs', function () {
    assert.equal(html('`code`'), '<p><code>code</code></p>');
    assert.equal(html('`` a`b ``'), '<p><code>a`b</code></p>');
    assert.equal(html('` `` `'), '<p><code>``</code></p>');
    assert.equal(html('`not closed'), '<p>`not closed</p>');
  });

  it('parses inline links with titles', function () {
    assert.equal(html('[t](/u)'), '<p><a href="/u">t</a></p>');
    assert.equal(html('[t](/u "T")'), '<p><a href="/u" title="T">t</a></p>');
    // a space is legal inside an angle-bracketed destination and illegal
    // in the attribute it lands in, so it percent-encodes on the way out
    assert.equal(html('[t](<u v>)'), '<p><a href="u%20v">t</a></p>');
    assert.equal(html('[*em* t](/u)'), '<p><a href="/u"><em>em</em> t</a></p>');
  });

  // §Link reference definitions: a definition is shed from the
  // paragraph BEFORE a setext underline can turn what is left into a
  // heading, `<>` is a valid empty destination, and a title has to be
  // separated from the destination by whitespace.
  it('sheds link reference definitions ahead of the setext rule', function () {
    assert.equal(html('[foo]: /url\nbar\n===\n[foo]'),
      '<h1>bar</h1><p><a href="/url">foo</a></p>');
    assert.equal(html('[foo]: /url\n===\n[foo]'),
      '<p>===\n<a href="/url">foo</a></p>');
  });

  it('accepts an empty <> destination and rejects a jammed title', function () {
    assert.equal(html('[foo]: <>\n\n[foo]'), '<p><a href="">foo</a></p>');
    assert.equal(html('[foo]: <bar>(baz)\n\n[foo]'),
      '<p>[foo]: (baz)</p><p>[foo]</p>');
  });

  // §Links: labels match on the text as WRITTEN — an escape delimits
  // but does not resolve — and matching case-folds (`ẞ` meets `SS`).
  it('matches reference labels on raw text, case-folded', function () {
    assert.equal(html('[bar][foo\\!]\n\n[foo!]: /url'), '<p>[bar][foo!]</p>');
    assert.equal(html('[foo][ref\\[]\n\n[ref\\[]: /uri'), '<p><a href="/uri">foo</a></p>');
    assert.equal(html('[ẞ]\n\n[SS]: /url'), '<p><a href="/url">ẞ</a></p>');
  });

  it('closes the most recent bracket, never an outer one', function () {
    assert.equal(html('![[[foo](uri1)](uri2)](uri3)'),
      '<p><img src="uri3" alt="[foo](uri2)"></p>');
  });

  it('parses reference links: full, collapsed and shortcut', function () {
    assert.equal(html('[t][r]\n\n[r]: /u "T"'), '<p><a href="/u" title="T">t</a></p>');
    assert.equal(html('[r][]\n\n[r]: /u'), '<p><a href="/u">r</a></p>');
    assert.equal(html('[r]\n\n[r]: /u'), '<p><a href="/u">r</a></p>');
    assert.equal(html('[none][missing]'), '<p>[none][missing]</p>');
  });

  it('parses images with alt text flattening', function () {
    assert.equal(html('![alt](/i.png)'), '<p><img src="/i.png" alt="alt"></p>');
    assert.equal(html('![*em* alt](/i.png "T")'),
      '<p><img src="/i.png" alt="em alt" title="T"></p>');
  });

  it('parses autolinks', function () {
    assert.equal(html('<https://x.y/z>'),
      '<p><a href="https://x.y/z">https://x.y/z</a></p>');
    assert.equal(html('<user@example.com>'),
      '<p><a href="mailto:user@example.com">user@example.com</a></p>');
  });

  it('handles backslash escapes and entities', function () {
    assert.equal(html('\\*not em\\*'), '<p>*not em*</p>');
    assert.equal(html('&amp; &lt; &#65; &#x42;'), '<p>&amp; &lt; A B</p>');
    assert.equal(html('&notanentity'), '<p>&amp;notanentity</p>');
  });

  it('parses hard and soft breaks', function () {
    assert.equal(html('a  \nb'), '<p>a<br>b</p>');
    assert.equal(html('a\\\nb'), '<p>a<br>b</p>');
    assert.equal(html('a\nb'), '<p>a\nb</p>');
  });

  it('keeps raw HTML in the AST and drops it from vnodes by default', function () {
    const doc = parseMarkdown('<div class="x">\nraw\n</div>\n\npara');
    assert.equal(doc.ast[0].type, 'html');
    assert.equal(doc.ast[0].value, '<div class="x">\nraw\n</div>');
    assert.equal(html('<div>\nx\n</div>'), '');
    const inline = parseMarkdown('a <b>c</b> d').ast[0];
    assert.deepEqual(inline.children.map((n) => n.type),
      ['text', 'html', 'text', 'html', 'text']);
  });

  it('link reference definitions produce no output', function () {
    assert.equal(html('[r]: /u "T"'), '');
    assert.equal(html('[r]: /u\npara after'), '<p>para after</p>');
  });
});

describe('parseMarkdown: GFM extensions', function () {
  it('parses tables with alignment', function () {
    const doc = parseMarkdown('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
    assert.equal(doc.ast[0].type, 'table');
    assert.deepEqual(doc.ast[0].align, ['left', 'center', 'right']);
    assert.equal(doc.ast[0].children.length, 2);
    assert.equal(
      html('| a |\n| --- |\n| 1 |'),
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
  });

  it('requires the delimiter row to match the header width', function () {
    assert.equal(html('| a | b |\n| --- |'), '<p>| a | b |\n| --- |</p>');
  });

  it('breaks tables on blank lines and new blocks', function () {
    const doc = parseMarkdown('| a |\n| --- |\n| 1 |\n\npara');
    assert.deepEqual(doc.ast.map((n) => n.type), ['table', 'paragraph']);
  });

  it('honors pipes inside code spans and escaped pipes', function () {
    const doc = parseMarkdown('| a | b |\n| --- | --- |\n| `x\\|y` | \\| |');
    const cells = doc.ast[0].children[1].children;
    assert.equal(cells.length, 2);
  });

  it('parses strikethrough', function () {
    assert.equal(html('~~gone~~'), '<p><del>gone</del></p>');
    assert.equal(html('~single~'), '<p>~single~</p>');
    assert.equal(html('~~a~~', { gfm: false }), '<p>~~a~~</p>');
  });

  it('parses task lists', function () {
    const doc = parseMarkdown('- [ ] open\n- [x] done\n- plain');
    const items = doc.ast[0].children;
    assert.equal(items[0].checked, false);
    assert.equal(items[1].checked, true);
    assert.equal(items[2].checked, null);
    assert.equal(items[1].children[0].children[0].value, 'done');
  });

  it('gfm: false disables tables and task lists', function () {
    const doc = parseMarkdown('| a |\n| --- |', { gfm: false });
    assert.equal(doc.ast[0].type, 'paragraph');
    const task = parseMarkdown('- [x] x', { gfm: false });
    assert.equal(task.ast[0].children[0].checked, null);
  });
});

describe('parseMarkdown: document envelope', function () {
  it('carries version, hash and sourceUrl', function () {
    const doc = parseMarkdown('# x', { sourceUrl: 'https://a.b/c.md' });
    assert.equal(doc.$md, '0.1');
    assert.equal(doc.meta.sourceUrl, 'https://a.b/c.md');
    assert.equal(typeof doc.meta.hash, 'string');
    assert.equal(doc.meta.hash, parseMarkdown('# x').meta.hash);
    assert.notEqual(doc.meta.hash, parseMarkdown('# y').meta.hash);
  });

  it('never throws on adversarial input', function () {
    const nasty = [
      '', '\n\n\n', '>', '> > >', '- ', '1. ', '```', '***a**', '[',
      '[]()', '![', '| |', '|---|', '    ', '\\', '&', '<', '`',
      '- [ ]', '# \n> \n- \n', '*a _b* c_',
    ];
    for (const src of nasty) parseMarkdown(src);
  });
});
