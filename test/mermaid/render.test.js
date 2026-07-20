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
