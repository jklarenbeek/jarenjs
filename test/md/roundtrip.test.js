//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toMarkdown, compileMarkdown } from '@jarenjs/md';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';

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
    assert.equal(toMarkdown({ type: 'thematicBreak' }), '---\n');
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
