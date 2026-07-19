//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, definePlugin, toMarkdown } from '@jarenjs/md';
import { highlightPlugin, mermaidPlugin, tokenizeCode } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';

describe('definePlugin', function () {
  it('validates and freezes the spec', function () {
    const plugin = definePlugin({ name: 'my-thing', fences: ['thing'] });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(Object.isFrozen(plugin.fences), true);
    assert.throws(() => definePlugin({ name: 'NotKebab' }), TypeError);
    assert.throws(() => definePlugin({ name: 'x', fences: [1] }), TypeError);
    assert.throws(() => definePlugin({ name: 'x', blocks: [{ chars: ':' }] }), TypeError);
    assert.throws(() => definePlugin({ name: 'x', inlines: [{ char: 'ab', scan() {} }] }), TypeError);
  });
});

describe('fence claims', function () {
  const mermaid = mermaidPlugin();

  it('a claimed fence emits the plugin node', function () {
    const doc = parseMarkdown('```mermaid extra meta\ngraph TD; A-->B\n```\n', { plugins: [mermaid] });
    assert.deepEqual(doc.ast[0], { type: 'mermaid', value: 'graph TD; A-->B\n', meta: 'extra meta' });
  });

  it('degrades to a code node without the plugin', function () {
    const doc = parseMarkdown('```mermaid\ngraph TD; A-->B\n```\n');
    assert.deepEqual(doc.ast[0], { type: 'code', lang: 'mermaid', meta: null, value: 'graph TD; A-->B\n' });
  });

  it('the first plugin in the array wins a contested fence', function () {
    const a = definePlugin({ name: 'a-plug', fences: ['x'], node: 'a-node' });
    const b = definePlugin({ name: 'b-plug', fences: ['x'], node: 'b-node' });
    const doc = parseMarkdown('```x\nv\n```\n', { plugins: [a, b] });
    assert.equal(doc.ast[0].type, 'a-node');
  });
});

describe('block and inline rules', function () {
  const callout = definePlugin({
    name: 'callout',
    node: 'callout',
    blocks: [{
      chars: ':',
      start: (line) => {
        const m = /^:::\s*(\w+)\s*$/.exec(line);
        return m ? { type: 'callout', kind: m[1], lines: [] } : null;
      },
      continue: (node, line) => {
        if (/^\s*:::\s*$/.test(line)) return 'end';
        node.lines.push(line);
        return true;
      },
      close: (node) => {
        node.value = node.lines.join('\n');
        delete node.lines;
      },
    }],
    render: (node, h) => h('aside', { class: `md-callout md-callout-${node.kind}` }, node.value),
  });

  const mention = definePlugin({
    name: 'mention',
    node: 'mention',
    inlines: [{
      char: '@',
      scan: (src, pos) => {
        const m = /^@([a-z][a-z0-9-]*)/.exec(src.slice(pos));
        return m ? { node: { type: 'mention', user: m[1] }, end: pos + m[0].length } : null;
      },
    }],
    render: (node, h) => h('a', { class: 'md-mention', href: '/u/' + node.user }, '@' + node.user),
  });

  it('block rules claim, continue and close', function () {
    const doc = parseMarkdown('before\n\n::: warning\ndanger zone\n:::\n\nafter\n', { plugins: [callout] });
    assert.deepEqual(doc.ast.map((n) => n.type), ['paragraph', 'callout', 'paragraph']);
    assert.equal(doc.ast[1].kind, 'warning');
    assert.equal(doc.ast[1].value, 'danger zone');
    const html = renderToString(mdToVnode(doc, { plugins: [callout] }));
    assert.match(html, /<aside class="md-callout md-callout-warning">danger zone<\/aside>/);
  });

  it('inline rules claim their trigger character', function () {
    const doc = parseMarkdown('ping @some-user!', { plugins: [mention] });
    const children = doc.ast[0].children;
    assert.deepEqual(children[1], { type: 'mention', user: 'some-user' });
    const html = renderToString(mdToVnode(doc, { plugins: [mention] }));
    assert.equal(html.includes('<a class="md-mention" href="/u/some-user">@some-user</a>'), true);
  });

  it('a declining inline rule leaves the character as text', function () {
    const doc = parseMarkdown('mail@ nothing', { plugins: [mention] });
    assert.equal(doc.ast[0].children.length, 1);
    assert.equal(doc.ast[0].children[0].value, 'mail@ nothing');
  });
});

describe('highlightPlugin', function () {
  it('tokenizes with the built-in grammars', function () {
    const tokens = tokenizeCode('const x = "s"; // c\n', 'js');
    assert.notEqual(tokens, null);
    const kinds = /** @type {any[]} */ (tokens).map((t) => t.kind + ':' + t.value);
    assert.deepEqual(kinds, [
      'kw:const', 'id: x ', 'op:=', 'id: ', 'str:"s"', 'pun:;', 'id: ', 'com:// c', 'id:\n',
    ]);
    // The token stream always reconstructs the source exactly.
    assert.equal(/** @type {any[]} */ (tokens).map((t) => t.value).join(''), 'const x = "s"; // c\n');
  });

  it('covers the shipped grammar set', function () {
    for (const [lang, code] of [
      ['ts', 'interface X { a: number }'],
      ['json', '{ "a": [1, true, null] }'],
      ['toml', 'a = 1 # c'],
      ['josl', 'a = null'],
      ['html', '<!-- c --><div class="x">'],
      ['css', '.a { color: #fff; } /* c */'],
      ['md', '# h `code`'],
      ['bash', 'if true; then echo "hi"; fi # c'],
    ]) {
      const tokens = tokenizeCode(/** @type {string} */ (code), /** @type {string} */ (lang));
      assert.notEqual(tokens, null, lang);
      assert.equal(/** @type {any[]} */ (tokens).map((t) => t.value).join(''), code, lang);
    }
    assert.equal(tokenizeCode('x', 'no-such-lang'), null);
  });

  it('renders token spans inside the code vnode', function () {
    const doc = parseMarkdown('```js\nreturn 42;\n```\n');
    const html = renderToString(mdToVnode(doc, { plugins: [highlightPlugin()] }));
    assert.equal(html.includes('<span class="tok-kw">return</span>'), true);
    assert.equal(html.includes('<span class="tok-num">42</span>'), true);
    assert.equal(html.includes('class="language-js"'), true);
  });

  it('adapter mode wins, null falls back to built-in', function () {
    const adapter = (code, lang) =>
      (lang === 'special' ? [{ kind: 'kw', value: code }] : null);
    const plugin = highlightPlugin({ adapter });
    const special = renderToString(mdToVnode(parseMarkdown('```special\nall kw\n```\n'), { plugins: [plugin] }));
    assert.equal(special.includes('<span class="tok-kw">all kw\n</span>'), true);
    const js = renderToString(mdToVnode(parseMarkdown('```js\nlet y;\n```\n'), { plugins: [plugin] }));
    assert.equal(js.includes('<span class="tok-kw">let</span>'), true);
  });

  it('custom grammars compile once and take precedence', function () {
    const plugin = highlightPlugin({
      grammars: { mylang: { keywords: ['zork'], strings: '"' } },
    });
    const html = renderToString(mdToVnode(parseMarkdown('```mylang\nzork "s"\n```\n'), { plugins: [plugin] }));
    assert.equal(html.includes('<span class="tok-kw">zork</span>'), true);
  });

  it('plain languages render as plain code', function () {
    const html = renderToString(mdToVnode(parseMarkdown('```weird\na < b\n```\n'), { plugins: [highlightPlugin()] }));
    assert.equal(html, '<article class="md"><pre><code class="language-weird">a &lt; b\n</code></pre></article>');
  });
});

describe('mermaidPlugin (native, TODO_18)', function () {
  it('renders inline pure-vnode SVG with no injected instance or innerHTML', function () {
    const plugin = mermaidPlugin();
    const doc = parseMarkdown('```mermaid\ngraph TD; A-->B\n```\n', { plugins: [plugin] });
    const html = renderToString(mdToVnode(doc, { plugins: [plugin] }));
    assert.match(html, /<div class="md-mermaid mermaid-block"[^>]*><svg/);
    assert.equal(html.includes('<script'), false);
    // Deterministic: same content, same markup.
    assert.equal(html, renderToString(mdToVnode(
      parseMarkdown('```mermaid\ngraph TD; A-->B\n```\n', { plugins: [plugin] }), { plugins: [plugin] })));
  });

  it('is a self-frozen MdPlugin-shaped object with no hydrate (render is complete)', function () {
    const plugin = mermaidPlugin();
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.name, 'mermaid');
    assert.deepEqual([...plugin.fences], ['mermaid', 'mmd']);
    assert.equal(plugin.node, 'mermaid');
    assert.equal(typeof plugin.render, 'function');
    assert.equal(/** @type {any} */ (plugin).hydrate, undefined);
  });

  it('renders an error vnode instead of throwing on a broken diagram', function () {
    const plugin = mermaidPlugin();
    const doc = parseMarkdown('```mermaid\nflowchart TD\n  A[oops\n```\n', { plugins: [plugin] });
    const html = renderToString(mdToVnode(doc, { plugins: [plugin] }));
    assert.match(html, /mm-error/);
  });

  it('claimed mermaid nodes round-trip through toMarkdown', function () {
    const plugin = mermaidPlugin();
    const src = '```mermaid\ngraph TD; A-->B\n```\n';
    const doc = parseMarkdown(src, { plugins: [plugin] });
    assert.equal(toMarkdown(doc), src);
  });
});
