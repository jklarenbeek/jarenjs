//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createMermaidComponent } from '@jarenjs/mermaid/component';
import { parseMermaid } from '@jarenjs/mermaid';
import { renderToString, isElementNode } from '@jarenjs/view';

describe('createMermaidComponent: view projection', function () {
  it('is reference-stable per source string (the O(change) contract)', function () {
    const c = createMermaidComponent();
    const a1 = c.view('flowchart TD\n A-->B');
    const a2 = c.view('flowchart TD\n A-->B');
    assert.equal(a1, a2);
    assert.notEqual(c.view('flowchart TD\n A-->C'), a1);
  });

  it('is reference-stable per parsed document', function () {
    const c = createMermaidComponent();
    const doc = parseMermaid('sequenceDiagram\n A->>B: hi');
    assert.equal(c.view(doc), c.view(doc));
    assert.equal(c.view(null), null);
  });

  it('renders a valid svg from a source string', function () {
    const c = createMermaidComponent();
    assert.equal(renderToString(c.view('flowchart TD\n A-->B')).startsWith('<svg'), true);
  });

  it('evicts the source memo beyond memoLimit', function () {
    const c = createMermaidComponent({ memoLimit: 2 });
    const first = c.view('flowchart TD\n A-->B');
    c.view('flowchart TD\n C-->D');
    c.view('flowchart TD\n E-->F'); // evicts the first
    assert.notEqual(c.view('flowchart TD\n A-->B'), first);
  });
});

describe('createMermaidComponent: app effects', function () {
  it('mermaid-render dispatches an svg vnode', function () {
    const c = createMermaidComponent();
    const dispatched = [];
    c.effects['mermaid-render']({ source: 'flowchart TD\n A-->B', done: 'diagram/ready' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched[0][0], 'diagram/ready');
    assert.ok(isElementNode(dispatched[0][1]));
    assert.equal(dispatched[0][1][0], 'svg');
  });

  it('mermaid-load fetches, compiles and dispatches the doc', async function () {
    const fetchFn = async () => ({ ok: true, status: 200, text: async () => 'flowchart TD\n A-->B' });
    const c = createMermaidComponent({ fetch: /** @type {any} */ (fetchFn) });
    const dispatched = [];
    await c.effects['mermaid-load']({ url: 'https://x.test/d.mmd', done: 'diagram/loaded' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched[0][0], 'diagram/loaded');
    assert.equal(dispatched[0][1].diagram, 'flowchart');
  });

  it('mermaid-load routes failures to the error action', async function () {
    const fetchFn = async () => ({ ok: false, status: 500, text: async () => '' });
    const c = createMermaidComponent({ fetch: /** @type {any} */ (fetchFn) });
    const dispatched = [];
    await c.effects['mermaid-load']({ url: 'https://x.test/nope', done: 'ok', error: 'diagram/failed' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched[0][0], 'diagram/failed');
    assert.match(dispatched[0][1].message, /500/);
  });

  it('hydrate is a no-op (render is complete)', function () {
    const c = createMermaidComponent();
    assert.doesNotThrow(() => c.hydrate({ querySelectorAll: () => { throw new Error('should not run'); } }));
  });
});
