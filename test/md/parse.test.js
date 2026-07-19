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

  it('nests blocks inside list items by indentation', function () {
    assert.equal(html('- a\n  - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
    assert.equal(html('- a\n\n  b'),
      '<ul><li><p>a</p><p>b</p></li></ul>');
    assert.equal(html('1. a\n   > q'),
      '<ol><li>a<blockquote><p>q</p></blockquote></li></ol>');
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
    assert.equal(html('[t](<u v>)'), '<p><a href="u v">t</a></p>');
    assert.equal(html('[*em* t](/u)'), '<p><a href="/u"><em>em</em> t</a></p>');
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
