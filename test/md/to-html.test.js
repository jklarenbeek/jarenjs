//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, mdToVnode, toHtml, compileMarkdown } from '@jarenjs/md';
import { definePlugin, highlightPlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';

import { extractExamples, normalizeHtml } from '../../benchmark/lib/commonmark.js';

const html = (src, options) => toHtml(parseMarkdown(src), options);

describe('toHtml — the direct AST → HTML string emitter', function () {
  it('emits a bare fragment: one call, no wrapper', function () {
    assert.equal(html('# Hi'), '<h1>Hi</h1>');
    assert.equal(html('# Hi', { wrap: 'article class="md"' }),
      '<article class="md"><h1>Hi</h1></article>');
    assert.equal(html('# Hi', { wrap: 'main' }), '<main><h1>Hi</h1></main>');
  });

  it('takes a document, a compiled document, an AST array or a node', function () {
    const doc = parseMarkdown('# Hi');
    assert.equal(toHtml(doc), '<h1>Hi</h1>');
    assert.equal(toHtml(compileMarkdown('# Hi')), '<h1>Hi</h1>');
    assert.equal(toHtml(doc.ast), '<h1>Hi</h1>');
    assert.equal(toHtml(doc.ast[0]), '<h1>Hi</h1>');
  });

  it('escapes raw HTML by default — the markup is visible, not live', function () {
    const out = html('<b>x</b>\n');
    assert.match(out, /&lt;b&gt;/);
    assert.doesNotMatch(out, /<b>/);
    assert.equal(out, '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it("html: 'skip' drops raw HTML, as the vnode path does", function () {
    assert.equal(html('<b>x</b>\n', { html: 'skip' }), '<p>x</p>');
    assert.equal(html('<div>\nblock\n</div>\n', { html: 'skip' }), '');
  });

  it("html: 'raw' passes through what a vnode tree cannot hold", function () {
    // a lone end tag and a tag never closed: half an element each
    assert.equal(html('</div>\n', { html: 'raw' }), '</div>');
    assert.equal(html('foo <span>bar\n', { html: 'raw' }), '<p>foo <span>bar</p>');
    assert.equal(html('<bab>\n', { html: 'raw' }), '<bab>');
  });

  it('filters URLs in EVERY html mode — the two policies are orthogonal', function () {
    for (const mode of ['escape', 'skip', 'raw']) {
      const out = html('[x](javascript:alert(1))\n', { html: mode });
      assert.equal(out, '<p><a>x</a></p>', `mode ${mode} keeps the text and drops the href`);
    }
    assert.equal(html('![i](vbscript:x)\n', { html: 'raw' }), '<p><img alt="i"></p>');
  });

  it('percent-encodes a surviving destination and escapes the attribute', function () {
    assert.equal(html('[x](</a b?q=1&r=2> "t & u")\n'),
      '<p><a href="/a%20b?q=1&amp;r=2" title="t &amp; u">x</a></p>');
  });

  it('gives headings ids and anchors on the same terms as the vnode path', function () {
    assert.equal(html('## Setup\n\n## Setup\n', { headingIds: true }),
      '<h2 id="setup">Setup</h2><h2 id="setup-1">Setup</h2>');
    assert.equal(html('## Setup\n', { headingIds: true, slugPrefix: 'user-content-' }),
      '<h2 id="user-content-setup">Setup</h2>');
    assert.equal(html('## Setup\n', { headingIds: true, headingAnchors: true }),
      '<h2 id="setup">Setup<a class="md-anchor" href="#setup"'
      + ' aria-label="Permalink to Setup">#</a></h2>');
    assert.equal(html('## Setup\n', { headingAnchors: true }), '<h2>Setup</h2>');
  });
});

describe('toHtml — plugins', function () {
  const widget = definePlugin({
    name: 'widget',
    fences: ['widget'],
    node: 'widget',
    render: (node, h) => h('div', { class: 'widget' }, node.value),
    toHtml: (node, ctx) => '<div class="widget">' + ctx.html + ':' + node.value.trim() + '</div>',
  });
  const vnodeOnly = definePlugin({
    name: 'chartlet',
    fences: ['chartlet'],
    node: 'chartlet',
    render: (node, h) => h('div', { class: 'chartlet' }, node.value),
  });

  it("uses a plugin's toHtml, with the emission context", function () {
    const plugins = [widget];
    assert.equal(toHtml(parseMarkdown('```widget\nx\n```\n', { plugins }), { plugins }),
      '<div class="widget">escape:x</div>');
  });

  it('shows the gap for a plugin that only renders vnodes', function () {
    const plugins = [vnodeOnly];
    assert.equal(toHtml(parseMarkdown('```chartlet\nx\n```\n', { plugins }), { plugins }),
      '<!-- unsupported plugin node: chartlet -->');
  });

  it('falls back to the core emitter when the plugin shadows a core type', function () {
    // the highlight plugin claims `code`; without a toHtml the code block
    // still prints, just unhighlighted — content is never dropped
    const plugins = [highlightPlugin()];
    assert.equal(toHtml(parseMarkdown('```js\nlet x = 1;\n```\n', { plugins }), { plugins }),
      '<pre><code class="language-js">let x = 1;\n</code></pre>');
  });

  it('rejects a non-function toHtml at definition time', function () {
    assert.throws(() => definePlugin({ name: 'bad', node: 'bad', toHtml: 'nope' }),
      /toHtml must be a function/);
  });
});

describe('toHtml — unknown nodes degrade as honestly as the vnode path', function () {
  const p = (text) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] });

  it('shows a literal node as preformatted text, escaped', function () {
    const ast = [{ type: 'gizmo', value: 'a < b & c' }];
    assert.equal(toHtml(ast), '<pre class="md-gizmo">a &lt; b &amp; c</pre>');
    assert.equal(toHtml(ast), viaVnode(ast));
  });

  it('shows a container node by its children', function () {
    const ast = [{ type: 'gizmo', children: [p('inside')] }];
    assert.equal(toHtml(ast), '<div class="md-gizmo"><p>inside</p></div>');
    assert.equal(toHtml(ast), viaVnode(ast));
  });

  it('renders a `custom` interchange node by its children', function () {
    const ast = [{ type: 'custom', name: 'callout', data: { kind: 'warning' }, children: [p('mind')] }];
    assert.equal(toHtml(ast), '<div class="md-custom"><p>mind</p></div>');
    assert.equal(toHtml(ast), viaVnode(ast));
  });

  it('degrades unknown INLINE nodes the same way', function () {
    const literal = [{ type: 'paragraph', children: [{ type: 'zap', value: 'x<y' }] }];
    assert.equal(toHtml(literal), '<p><code class="md-zap">x&lt;y</code></p>');
    assert.equal(toHtml(literal), viaVnode(literal));
    const container = [{ type: 'paragraph', children: [{ type: 'zap', children: [{ type: 'text', value: 'in' }] }] }];
    assert.equal(toHtml(container), '<p><span class="md-zap">in</span></p>');
    assert.equal(toHtml(container), viaVnode(container));
  });

  it('emits nothing for a node with neither value nor children', function () {
    assert.equal(toHtml([{ type: 'gizmo' }]), '');
  });
});

// ------------------------------------------------------------------
// The two emitters agree wherever a vnode can express the markup
// ------------------------------------------------------------------

/** Documents covering every core node type the emitters share. */
const CORPUS = [
  '# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n',
  'A paragraph with **bold**, *em*, `code`, ~~struck~~ and a [link](https://e.com "t").\n',
  'An ![image](/img.png "title") and a bare ![one](/x.png).\n',
  'soft\nwrapped and a hard  \nbreak.\n',
  '- a\n- b\n  - nested\n\n1. one\n2. two\n\n5. five\n6. six\n',
  '- [x] done\n- [ ] todo\n',
  '- loose\n\n- list\n',
  '> quoted **text**\n>\n> two paragraphs\n',
  '---\n\n***\n',
  '```js\nlet x = 1 < 2 && 3 > 2;\n```\n\n    indented code\n',
  '| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n',
  '| only |\n| --- |\n',
  '<https://auto.link/> and <mailto:a@b.c>\n',
  'A & B < C > D "quoted" \'apostrophe\'\n',
  '[bad](javascript:alert(1)) and [ok](./rel/path.md)\n',
  // GFM literal autolinks and footnotes: both emitters learned them in
  // one order, and this is the table that holds them to it
  'Visit www.example.com/a?b=1&c=2, mail a@b.test or read https://x.test/p.\n',
  'A claim[^1] and another[^1] and a third[^two].\n\n'
    + '[^1]: The source, cited twice.\n\n[^two]: A note with\n\n    two blocks.\n',
  'Uncited[^gone] stays literal.\n\n[^ghost]: never cited, never rendered\n',
  'Cycle[^a]\n\n[^a]: see [^b]\n\n[^b]: see [^a]\n',
];

/** The benchmark's document shape, at a size worth folding over. */
function buildDocument(sections) {
  let out = '';
  for (let i = 0; i < sections; i++) {
    out += `## Section ${i}: *typical* content\n\n`
      + `A paragraph with **bold**, *emphasis*, \`inline code\`, a [link](https://example.com/${i} "t"), `
      + 'an ![image](/img.png), some ~~struck~~ text and an autolink <https://example.org/>.\n'
      + 'It wraps across lines\nwith soft breaks and a hard one.  \nDone.\n\n'
      + `- item one of section ${i}\n- item two with *emphasis*\n  - nested item\n- [x] a task\n\n`
      + '> A blockquote with `code` and **bold** content.\n\n'
      + '```js\nfunction demo(n) {\n  return n * 2; // doubled\n}\n```\n\n'
      + `| col a | col b | col c |\n| :---- | :---: | ----: |\n| a${i} | b${i} | c${i} |\n| x | y | z |\n\n`;
  }
  return out;
}

const WRAP_OPEN = '<article class="md">';
const viaVnode = (doc, options) =>
  renderToString(mdToVnode(doc, options)).slice(WRAP_OPEN.length, -'</article>'.length);

describe('toHtml — byte-identical to the vnode path where a vnode can hold the markup', function () {
  it('agrees on every core construct', function () {
    for (const src of CORPUS) {
      const doc = parseMarkdown(src);
      assert.equal(toHtml(doc), viaVnode(doc), `differs for: ${JSON.stringify(src)}`);
    }
  });

  it('agrees on the benchmark document, wrapper included', function () {
    const doc = parseMarkdown(buildDocument(16));
    assert.equal(toHtml(doc, { wrap: 'article class="md"' }), renderToString(mdToVnode(doc)));
  });

  it('agrees with heading ids and anchors on', function () {
    const options = { headingIds: true, headingAnchors: true, slugPrefix: 'user-content-' };
    const doc = parseMarkdown(buildDocument(4));
    assert.equal(toHtml(doc, options), viaVnode(doc, options));
  });

  it('agrees over the CommonMark corpus for every example free of raw HTML', function (t) {
    const spec = fileURLToPath(new URL('../../benchmark/commonmark-spec/spec.txt', import.meta.url));
    if (!existsSync(spec)) {
      t.skip('commonmark-spec submodule not initialized');
      return;
    }
    let compared = 0;
    for (const example of extractExamples(readFileSync(spec, 'utf8'))) {
      const src = example.markdown;
      const doc = parseMarkdown(src, { gfm: false, frontmatter: false });
      // raw HTML is exactly where the two are MEANT to differ
      let raw = false;
      const scan = (nodes) => {
        for (const node of nodes) {
          if (node.type === 'html') raw = true;
          if (Array.isArray(node.children)) scan(node.children);
        }
      };
      scan(doc.ast);
      if (raw) continue;
      compared++;
      assert.equal(toHtml(doc), viaVnode(doc), `differs for example: ${JSON.stringify(src)}`);
    }
    assert.equal(compared > 500, true, `compared ${compared} examples`);
  });

  it('every example the vnode path misses is a raw-HTML one', function (t) {
    // The package publishes two conformance numbers and one reason for
    // the gap between them. This is that reason, checked: a vnode tree
    // has no way to hold half an element, and NOTHING ELSE is missing.
    const spec = fileURLToPath(new URL('../../benchmark/commonmark-spec/spec.txt', import.meta.url));
    if (!existsSync(spec)) {
      t.skip('commonmark-spec submodule not initialized');
      return;
    }
    const parseOptions = { gfm: false, frontmatter: false };
    const unexplained = [];
    for (const example of extractExamples(readFileSync(spec, 'utf8'))) {
      const doc = parseMarkdown(example.markdown, parseOptions);
      let passes = false;
      try {
        // the SAME comparison the published scorecard uses, so this
        // assertion and that number cannot drift apart
        passes = normalizeHtml(viaVnode(doc, { html: 'vnode' })) === normalizeHtml(example.html);
      }
      catch { passes = false; }
      if (passes) continue;
      let raw = false;
      const scan = (nodes) => {
        for (const node of nodes) {
          if (node.type === 'html') raw = true;
          if (Array.isArray(node.children)) scan(node.children);
        }
      };
      scan(doc.ast);
      if (!raw) unexplained.push(example.number);
    }
    assert.deepEqual(unexplained, [],
      'a vnode-path failure with no raw HTML in it is a real dialect gap');
  });
});
