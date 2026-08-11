//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, toMarkdown, compileMarkdown } from '@jarenjs/md';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';

import { extractExamples } from '../../benchmark/lib/commonmark.js';

/**
 * Assert the canonical round-trip: print, re-parse, deep-equal AST —
 * and that canonical form is a fixed point of printing.
 * @param {string} src
 */
function roundtrips(src) {
  const doc = parseMarkdown(src);
  const canonical = toMarkdown(doc);
  const doc2 = parseMarkdown(canonical);
  assert.deepEqual(doc2.ast, doc.ast, `AST drift for ${JSON.stringify(src)}`);
  assert.equal(toMarkdown(doc2), canonical, `not a fixed point: ${JSON.stringify(canonical)}`);
}

describe('toMarkdown: canonical round-trips', function () {
  it('round-trips every core construct', function () {
    roundtrips('# H1 *em* **strong** `code`\n');
    roundtrips('para one\n\npara two with [link](/u "T") and ![img](/i.png)\n');
    roundtrips('> quote\n>\n> - inner list\n');
    roundtrips('- a\n- b\n  - nested\n- c\n');
    roundtrips('1. one\n2. two\n\n3. loose\n');
    roundtrips('- [ ] open\n- [x] done\n');
    roundtrips('```js meta\nconst x = `tpl`;\n```\n');
    roundtrips('    indented code\n');
    roundtrips('| a | b |\n| :-- | --: |\n| *1* | `2` |\n');
    roundtrips('~~strike~~ and <https://auto.link/>\n');
    roundtrips('a  \nhard break\n');
    roundtrips('***\n');
    roundtrips('text with \\* escapes & `back\\`ticks`\n');
  });

  it('round-trips text that looks like syntax', function () {
    roundtrips('2 * 3 = 6 and _under_score\n');
    roundtrips('# H\n\n\\- not a list\n');
    roundtrips('[not][a-ref]\n');
    roundtrips('C# and F# stay text\n');
  });

  it('round-trips the GFM extensions', function () {
    roundtrips('A claim[^1] and another[^1].\n\n[^1]: The source.\n');
    roundtrips('A[^a] B[^b]\n\n[^a]: one\n\n[^b]: two\n\n    with a second block\n');
    roundtrips('Uncited.\n\n[^ghost]: never referenced\n');
    roundtrips('Cycle[^a]\n\n[^a]: see [^b]\n\n[^b]: see [^a]\n');
    roundtrips('Visit www.example.com/a?b=1&c=2 and https://x.test/p.\n');
    roundtrips('Mail a@b.test or hello+xyz@mail.example.\n');
    // an undefined reference is text, and prints as escaped text
    roundtrips('A claim[^nope] stays literal.\n');
  });

  it('prints a literal autolink bare, and re-reads it as the same link', function () {
    assert.equal(toMarkdown(parseMarkdown('Visit www.example.com today.\n')),
      'Visit www.example.com today.\n');
    assert.equal(toMarkdown(parseMarkdown('foo@bar.baz\n')), 'foo@bar.baz\n');
    // bare, but not unescaped: a destination carrying `_` or `&` has to
    // come back as the same characters, and only the escape guarantees it
    const doc = parseMarkdown('www.example.com/a_b_c?q=1&r=2\n');
    assert.equal(toMarkdown(doc), 'www.example.com/a\\_b\\_c?q=1\\&r=2\n');
    assert.deepEqual(parseMarkdown(toMarkdown(doc)).ast, doc.ast);
    roundtrips('www.example.com/a_b_c?q=1&r=2\n');
  });

  it('prints a footnote definition where the author put it', function () {
    // the AST is the document, not the rendering: moving every
    // definition to the end would be a different document
    assert.equal(toMarkdown(parseMarkdown('A[^1]\n\n[^1]: note\n\nAfter.\n')),
      'A[^1]\n\n[^1]: note\n\nAfter.\n');
  });

  it('re-emits frontmatter as an exact ---json block', function () {
    const doc = parseMarkdown('---\ntitle: T\nn: 3\ntags: [a, b]\n---\n# Body\n');
    const canonical = toMarkdown(doc);
    assert.match(canonical, /^---json\n/);
    const doc2 = parseMarkdown(canonical);
    assert.deepEqual(doc2.frontmatter, doc.frontmatter);
    assert.deepEqual(doc2.ast, doc.ast);
  });

  it('prints bare ASTs and single nodes', function () {
    assert.equal(toMarkdown([{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'x' }] }]),
      '## x\n');
    // `***`, not `---`: a `---` inside a `-` bullet item would re-parse
    // as a thematic break WITH the marker rather than an item holding one
    assert.equal(toMarkdown({ type: 'thematicBreak' }), '***\n');
    assert.equal(toMarkdown(parseMarkdown('- a\n- ***\n')), '- a\n- ***\n');
    assert.equal(toMarkdown([]), '');
  });

  it('prints unknown value nodes as claimable fences', function () {
    const md = toMarkdown([{ type: 'mermaid', value: 'graph TD; A-->B\n', meta: null }]);
    assert.equal(md, '```mermaid\ngraph TD; A-->B\n```\n');
    // Without the plugin the fence degrades to a code node.
    assert.deepEqual(parseMarkdown(md).ast[0],
      { type: 'code', lang: 'mermaid', meta: null, value: 'graph TD; A-->B\n' });
  });
});

describe('toMarkdown: the corpus is a fixed point', function () {
  // The oracle for every dialect change: a rule that alters block
  // structure (empty items, tight/loose, container continuation) shows
  // up here as an AST that no longer survives its own canonical form.
  it('round-trips every CommonMark spec example', function (t) {
    const spec = fileURLToPath(new URL('../../benchmark/commonmark-spec/spec.txt', import.meta.url));
    if (!existsSync(spec)) {
      t.skip('commonmark-spec submodule not initialized');
      return;
    }
    let checked = 0;
    for (const example of extractExamples(readFileSync(spec, 'utf8'))) {
      const src = example.markdown;
      const doc = parseMarkdown(src, { gfm: false, frontmatter: false });
      const canonical = toMarkdown(doc);
      const reparsed = parseMarkdown(canonical, { gfm: false, frontmatter: false });
      // both halves of the MD-FORMAT §5 guarantee: the canonical form
      // re-parses to the SAME AST, and printing it again changes nothing
      assert.deepEqual(reparsed.ast, doc.ast,
        `AST drift for example ${checked + 1}: ${JSON.stringify(src)} → ${JSON.stringify(canonical)}`);
      assert.equal(toMarkdown(reparsed), canonical,
        `not a fixed point for example ${checked + 1}: ${JSON.stringify(src)}`);
      checked++;
    }
    assert.equal(checked, 655, 'the whole corpus was checked');
  });

  it('round-trips every GFM spec example, extensions on', function (t) {
    // The same oracle over the GFM corpus, with `gfm: true` — which is
    // the only place tables, task lists, strikethrough, footnotes and
    // literal autolinks are printed at corpus scale. A printer that
    // cannot write one of them down shows up here as an AST that does
    // not survive its own canonical form.
    const spec = fileURLToPath(new URL('../../benchmark/gfm-spec/test/spec.txt', import.meta.url));
    if (!existsSync(spec)) {
      t.skip("run 'git submodule update --init benchmark/gfm-spec' to enable the GFM corpus");
      return;
    }
    let checked = 0;
    for (const example of extractExamples(readFileSync(spec, 'utf8'))) {
      const src = example.markdown;
      const doc = parseMarkdown(src, { frontmatter: false });
      const canonical = toMarkdown(doc);
      const reparsed = parseMarkdown(canonical, { frontmatter: false });
      assert.deepEqual(reparsed.ast, doc.ast,
        `AST drift for GFM example ${example.number}: ${JSON.stringify(src)} → ${JSON.stringify(canonical)}`);
      assert.equal(toMarkdown(reparsed), canonical,
        `not a fixed point for GFM example ${example.number}: ${JSON.stringify(src)}`);
      checked++;
    }
    assert.equal(checked, 672, 'the whole GFM corpus was checked');
  });

  it('round-trips a document of every construct at size', function () {
    let src = '';
    for (let i = 0; i < 8; i++) {
      src += `## Section ${i}: *typical* content\n\n`
        + `A paragraph with **bold**, \`code\`, a [link](https://example.com/${i} "t"), `
        + 'an ![image](/img.png) and ~~struck~~ text.\n\n'
        + `- item one\n- item two\n  - nested\n- [x] a task\n\n`
        + '> A blockquote with `code`.\n\n'
        + '```js\nlet x = 1;\n```\n\n'
        + `| a | b |\n| :-- | --: |\n| ${i} | y |\n\n`;
    }
    const canonical = toMarkdown(parseMarkdown(src));
    const doc2 = parseMarkdown(canonical);
    assert.deepEqual(doc2.ast, parseMarkdown(src).ast);
    assert.equal(toMarkdown(doc2), canonical);
  });
});

describe('round-trip with the JSON stack', function () {
  it('JTLT output → parseMarkdown → identity JSLT → canonical Markdown', function () {
    // JTLT: JSON → Markdown text (the forward arrow).
    const render = compileJtltStylesheet([
      { match: '$', body: ['# Books\n', { $apply: '$.store.book[*]' }] },
      { match: '$.store.book[*]', body: ['- ', '$.title', ' (', '$.price', ')\n'] },
    ]);
    const data = { store: { book: [{ title: 'A', price: 8.95 }, { title: 'B', price: 12.99 }] } };
    const mdText = render(data);
    assert.equal(mdText, '# Books\n- A (8.95)\n- B (12.99)\n');

    // md: Markdown text → JSON AST (the inverse arrow).
    const doc = parseMarkdown(mdText);
    assert.equal(doc.ast[0].type, 'heading');
    assert.equal(doc.ast[1].type, 'list');
    assert.equal(doc.ast[1].children.length, 2);

    // Identity JSLT returns the AST by reference (proof-of-no-change).
    const identity = compileJsltStylesheet([]);
    const same = identity(doc.ast);
    assert.equal(same, doc.ast);

    // And the canonical print re-parses to a deep-equal AST.
    const again = parseMarkdown(toMarkdown(doc));
    assert.deepEqual(again.ast, doc.ast);
  });

  it('exposes frontmatter as JSLT externals', function () {
    const md = compileMarkdown('---\ntitle: Hello\ncount: 3\nroot: shadowed\n---\ntext\n');
    assert.deepEqual(md.externals(), { title: 'Hello', count: 3 });
    const transform = compileJsltStylesheet([
      { match: '$', body: { title: '$title', n: '$count' } },
    ]);
    assert.deepEqual(transform(md.ast, md.externals()), { title: 'Hello', n: 3 });
  });

  it('the AST is a transformable JSLT input document', function () {
    const doc = parseMarkdown('# One\n\n# Two\n\npara\n');
    // Reshape: collect heading texts with an RFC 9535 filter leaf.
    const transform = compileJsltStylesheet([
      { match: '$', body: { titles: ["$.ast[?@.type=='heading'].children[0].value"] } },
    ]);
    assert.deepEqual(transform(doc), { titles: ['One', 'Two'] });
  });
});
