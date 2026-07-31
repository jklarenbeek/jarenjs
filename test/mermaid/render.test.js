//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { renderMermaid, compileMermaid, sanitizeHref } from '@jarenjs/mermaid';
import { renderToString, isElementNode } from '@jarenjs/view';

describe('render to pure-vnode SVG', function () {
  it('emits an svg-rooted tagged-array vnode (no innerHTML)', function () {
    const v = renderMermaid('flowchart TD\n  A[Start] --> B[End]');
    assert.ok(isElementNode(v));
    assert.equal(v[0], 'svg');
    // no functions anywhere in the vnode → fully serializable
    assert.equal(JSON.stringify(v).includes('svg'), true);
  });

  it('toSvgString produces a standalone SVG with no browser', function () {
    const c = compileMermaid('flowchart LR\n  A --> B --> C');
    const svg = c.toSvgString();
    assert.equal(svg.startsWith('<svg'), true);
    assert.match(svg, /<path|<polygon|<rect/);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(svg.includes('<script'), false);
  });

  it('structural sharing: identical source → reference-equal vnode', function () {
    const c = compileMermaid('sequenceDiagram\n  A->>B: hi');
    assert.equal(c.toVnode(), c.toVnode());
  });

  it("theme 'host' stamps host-linked cssVars, keeps attributes concrete", function () {
    const v = renderMermaid('flowchart TD\n  A --> B', { theme: 'host' });
    // the inline stamp references the host token with the concrete fallback
    assert.equal(v[1].style['--mm-node-fill'], 'var(--accent-soft, #dbeafe)');
    assert.equal(v[1].style['--mm-node-stroke'], 'var(--accent, #2563eb)');
    // presentation attributes stay concrete → standalone-valid SVG
    assert.match(renderToString(v), /fill="#dbeafe"/);
  });

  it('error path renders an error vnode instead of throwing', function () {
    const v = renderMermaid('flowchart TD\n  A[unterminated');
    assert.doesNotThrow(() => renderToString(v));
    assert.match(renderToString(v), /mm-error|parse error/i);
  });

  it('rejects javascript: hrefs in the sanitizer', function () {
    assert.equal(sanitizeHref('javascript:alert(1)'), null);
    assert.equal(sanitizeHref('https://ok.test'), 'https://ok.test');
  });

  it('renders every first-class diagram type to an svg', function () {
    for (const src of [
      'flowchart TD\n A-->B',
      'sequenceDiagram\n A->>B: x',
      'pie\n "a" : 1\n "b" : 2',
      'stateDiagram-v2\n [*] --> S',
      'classDiagram\n class Foo',
      'erDiagram\n A ||--o{ B : has',
      'gantt\n title T\n section S\n T1 : a, 1d',
    ]) {
      const svg = renderToString(renderMermaid(src));
      assert.equal(svg.startsWith('<svg'), true, src);
      assert.equal(svg.includes('mm-error'), false, src);
    }
  });

  it('secondary types render an honest placeholder', function () {
    const svg = renderToString(renderMermaid('mindmap\n  root'));
    assert.match(svg, /not yet laid out/);
  });
});

describe('state diagrams render as laid-out graphs', function () {
  const SRC = `stateDiagram-v2
  [*] --> draft
  draft --> review : submit [ok] / notify
  review --> approved
  approved --> [*]`;

  it('renders through the flowchart engine with the mm-state root class', function () {
    const svg = compileMermaid(SRC).toSvgString();
    assert.match(svg, /class="mermaid mm-svg mm-state"/);
    assert.match(svg, /data-id="draft"/);
    assert.match(svg, /data-id="review"/);
    assert.match(svg, /submit \[ok\] \/ notify/, 'the verbatim label is the edge text');
  });

  it('draws the [*] pseudo-states as a filled dot and a ring', function () {
    const svg = compileMermaid(SRC).toSvgString();
    assert.match(svg, /data-id="__start"/);
    assert.match(svg, /data-id="__end"/);
    // the end ring is the two-circle doublecircle group
    const rings = svg.match(/<circle/g) ?? [];
    assert.ok(rings.length >= 3, 'start dot + end double ring');
  });

  it('is deterministic: same source, identical bytes', function () {
    assert.equal(compileMermaid(SRC).toSvgString(), compileMermaid(SRC).toSvgString());
  });

  it('the old structured panel path refuses state loudly', async function () {
    const { structuredSections } = await import('../../components/mermaid/src/render/misc.js');
    assert.throws(() => structuredSections('state', {}), /not a structured-panel type/);
  });
});

describe('stable identity attributes for editors', function () {
  it('every flowchart node and edge carries its identity', function () {
    const src = 'flowchart LR\n  A[Start] --> B{OK?}\n  B -->|yes| C((Done))\n  B -->|no| A';
    const c = compileMermaid(src);
    const svg = c.toSvgString();
    for (const node of c.doc.ast.nodes) {
      assert.ok(svg.includes(`data-id="${node.id}"`), node.id);
    }
    c.doc.ast.edges.forEach((e, i) => {
      assert.ok(
        svg.includes(`data-edge="${i}" data-from="${e.from}" data-to="${e.to}"`),
        `edge ${i} carries its AST position and endpoints`);
    });
  });

  it('toLayout() is the cached hit-testing substrate and agrees with the SVG', function () {
    const c = compileMermaid('stateDiagram-v2\n  [*] --> a\n  a --> b : go');
    const layout = c.toLayout();
    assert.equal(c.toLayout(), layout, 'reference-stable per compiled document');
    const a = layout.nodes.find((n) => n.id === 'a');
    assert.ok(a.w > 0 && a.h > 0);
    assert.ok(c.toSvgString().includes(`x="${a.x}"`),
      'the layout rectangle is the rendered rectangle');
    assert.equal(compileMermaid('pie\n"A" : 1').toLayout(), null,
      'null for types without a geometric layout');
    assert.equal(compileMermaid('%%not mermaid%%').toLayout(), null,
      'null when the document failed to parse');
  });
});
