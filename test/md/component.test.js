//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, hashContent } from '@jarenjs/md';
import { createMdComponent, DEFAULT_PLUGINS } from '@jarenjs/md/component';
import { mermaidPlugin, highlightPlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';

describe('createMdComponent: view projection', function () {
  it('is reference-stable per source string (the O(change) contract)', function () {
    const md = createMdComponent();
    const a1 = md.view('# A\n\ntext\n');
    const a2 = md.view('# A\n\ntext\n');
    assert.equal(a1, a2);
    assert.notEqual(md.view('# B\n'), a1);
  });

  it('is reference-stable per parsed document', function () {
    const md = createMdComponent();
    const doc = parseMarkdown('# D\n');
    assert.equal(md.view(doc), md.view(doc));
    assert.equal(md.view(null), null);
    assert.equal(md.view(undefined), null);
  });

  it('renders with the default highlight plugin compiled in', function () {
    const md = createMdComponent();
    assert.deepEqual(md.plugins, DEFAULT_PLUGINS);
    const html = renderToString(md.view('```js\nreturn 1;\n```\n'));
    assert.equal(html.includes('<span class="tok-kw">return</span>'), true);
  });

  it('evicts the source memo beyond memoLimit', function () {
    const md = createMdComponent({ memoLimit: 2 });
    const first = md.view('# 1\n');
    md.view('# 2\n');
    md.view('# 3\n'); // evicts '# 1\n'
    assert.notEqual(md.view('# 1\n'), first);
  });

  it('compile() shares the memo with view()', function () {
    const md = createMdComponent();
    const compiled = md.compile('# C\n');
    assert.equal(md.view('# C\n'), compiled.toVnode());
  });
});

describe('createMdComponent: app effects', function () {
  it('md-parse dispatches the plain MdDocument', function () {
    const md = createMdComponent();
    const dispatched = [];
    md.effects['md-parse']({ source: '# P\n', done: 'doc/loaded' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0][0], 'doc/loaded');
    assert.equal(dispatched[0][1].$md, '0.1');
    assert.equal(dispatched[0][1].ast[0].type, 'heading');
  });

  it('md-load fetches, compiles and dispatches done', async function () {
    const fetchFn = async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null }, body: null,
      text: async () => '---\ntitle: T\n---\n# L\n',
    });
    const md = createMdComponent({ fetch: /** @type {any} */ (fetchFn), cache: false });
    const dispatched = [];
    await md.effects['md-load']({ url: 'https://x.test/a.md', done: 'doc/loaded' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched[0][0], 'doc/loaded');
    assert.deepEqual(dispatched[0][1].frontmatter, { title: 'T' });
    assert.equal(dispatched[0][1].meta.sourceUrl, 'https://x.test/a.md');
  });

  it('md-load routes failures to the error action when given', async function () {
    const fetchFn = async () => ({
      ok: false, status: 404, statusText: 'Not Found',
      headers: { get: () => null }, body: null, text: async () => '',
    });
    const md = createMdComponent({ fetch: /** @type {any} */ (fetchFn), cache: false });
    const dispatched = [];
    await md.effects['md-load']({ url: 'https://x.test/nope.md', done: 'ok', error: 'doc/failed' },
      (name, payload) => dispatched.push([name, payload]));
    assert.equal(dispatched[0][0], 'doc/failed');
    assert.match(dispatched[0][1].message, /404/);
  });
});

describe('createMdComponent: hydrate', function () {
  it('hydrates marked elements once per content hash', async function () {
    let calls = 0;
    const fake = {
      initialize() {},
      render: async () => { calls++; return { svg: '<svg>ok</svg>' }; },
    };
    const plugins = [highlightPlugin(), mermaidPlugin({ mermaid: fake })];
    const md = createMdComponent({ plugins });
    const source = '```mermaid\ngraph TD; A-->B\n```\n';
    md.view(source); // indexes the hydratable node
    const hash = hashContent('graph TD; A-->B\n');
    const el = {
      innerHTML: '',
      getAttribute: (name) => (name === 'data-md-hydrate' ? 'mermaid' : hash),
    };
    const container = { querySelectorAll: () => [el] };
    md.hydrate(container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(el.innerHTML, '<svg>ok</svg>');
    md.hydrate(container); // second pass: cached, no re-render
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
  });

  it('is a no-op without hydratable plugins', function () {
    const md = createMdComponent();
    md.hydrate({ querySelectorAll: () => { throw new Error('should not be called'); } });
  });
});
