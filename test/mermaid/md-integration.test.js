//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, toMarkdown, compileMarkdown } from '@jarenjs/md';
import { mermaidPlugin, refreshMermaidFence } from '@jarenjs/mermaid/plugin';
import { parseMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const PLUGINS = [mermaidPlugin()];

describe('markdown integration', function () {
  it('a mixed document renders the mermaid fence as inline svg', function () {
    const src = '# Title\n\ntext\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\nmore\n';
    const doc = parseMarkdown(src, { plugins: PLUGINS });
    const html = renderToString(mdToVnode(doc, { plugins: PLUGINS }));
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /class="md-mermaid mermaid-block"[^>]*><svg/);
  });

  it('round-trips through toMarkdown (source kept in node.value)', function () {
    const src = '```mermaid\nflowchart TD\n  A-->B\n```\n';
    const doc = parseMarkdown(src, { plugins: PLUGINS });
    assert.equal(toMarkdown(doc), src);
  });

  it('re-renders unchanged blocks reference-equal', function () {
    const src = '```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n';
    const c = compileMarkdown(src, { plugins: PLUGINS });
    assert.equal(c.toVnode(), c.toVnode());
  });

  it('a transformed diagram re-emits updated Mermaid text via refreshed value', function () {
    const src = '```mermaid\nflowchart TD\n  A[Old] --> B\n```\n';
    const doc = parseMarkdown(src, { plugins: PLUGINS });
    const fenceNode = doc.ast.find((n) => n.type === 'mermaid');
    // Transform the diagram AST.
    const diagram = parseMermaid(fenceNode.value);
    diagram.ast.nodes[0].label = 'New';
    const fresh = refreshMermaidFence(fenceNode, diagram);
    // Splice the refreshed fence back in and print.
    const newDoc = { ...doc, ast: doc.ast.map((n) => (n === fenceNode ? fresh : n)) };
    const printed = toMarkdown(newDoc);
    assert.match(printed, /A\[New\]/);
    // And the refreshed source itself re-parses to the transformed AST.
    assert.deepEqual(parseMermaid(fresh.value).ast, diagram.ast);
  });
});
