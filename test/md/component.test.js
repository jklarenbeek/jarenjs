//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, hashContent } from '@jarenjs/md';
import { createMdComponent, DEFAULT_PLUGINS } from '@jarenjs/md/component';
import { highlightPlugin, definePlugin } from '@jarenjs/md/plugins';
import { renderToString, h } from '@jarenjs/view';

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

// A synthetic hydratable plugin exercises the generic hydrate machinery
// (the native mermaid plugin no longer hydrates — its render is
// complete).
const widgetPlugin = definePlugin({
  name: 'widget',
  fences: ['widget'],
  node: 'widget',
  render: (node) => h('div', { class: 'widget', 'data-md-hydrate': 'widget', 'data-md-hash': hashContent(node.value) }),
  hydrate: async (el) => { el.innerHTML = '<svg>ok</svg>'; },
});

describe('createMdComponent: hydrate', function () {
  it('hydrates marked elements once per content hash', async function () {
    const plugins = [highlightPlugin(), widgetPlugin];
    const md = createMdComponent({ plugins });
    const source = '```widget\ngraph TD; A-->B\n```\n';
    md.view(source); // indexes the hydratable node
    const hash = hashContent('graph TD; A-->B\n');
    let calls = 0;
    const el = {
      set innerHTML(v) { this._html = v; calls++; },
      get innerHTML() { return this._html ?? ''; },
      getAttribute: (name) => (name === 'data-md-hydrate' ? 'widget' : hash),
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

// The per-call rendering policy: one component, many provenances. A host
// that renders repo-authored documents beside text from anywhere else
// cannot pick one id policy for both, and two components are not the
// answer — hydration runs off one instance's index (asserted below).
describe('createMdComponent: per-call rendering policy', function () {
  const SOURCE = '## Setup\n\ntext\n';
  const UNTRUSTED = { slugPrefix: 'user-content-' };

  it('leaves a call that names no policy on the construction defaults', function () {
    const md = createMdComponent({ headingIds: true });
    const plain = md.view(SOURCE);
    assert.equal(md.view(SOURCE, undefined), plain);
    assert.equal(md.view(SOURCE, {}), plain);
    assert.match(renderToString(plain), /id="setup"/);
  });

  it('mints ids under the policy the call names', function () {
    const md = createMdComponent({ headingIds: true, headingAnchors: true });
    const html = renderToString(md.view(SOURCE, UNTRUSTED));
    assert.match(html, /id="user-content-setup"/);
    // the anchor beside the heading follows the id, or the copy-a-link
    // affordance points at a heading that no longer exists
    assert.match(html, /href="#user-content-setup"/);
  });

  it('memoizes per source AND policy: two policies, two stable vnodes', function () {
    const md = createMdComponent({ headingIds: true });
    const trusted = md.view(SOURCE);
    const untrusted = md.view(SOURCE, UNTRUSTED);
    assert.notEqual(trusted, untrusted);
    // each is a memo HIT on repeat — the O(change) contract holds per
    // policy, so alternating provenances cannot thrash the cache
    assert.equal(md.view(SOURCE), trusted);
    assert.equal(md.view(SOURCE, UNTRUSTED), untrusted);
    assert.equal(md.view(SOURCE, { slugPrefix: 'user-content-' }), untrusted);
  });

  it('keys a policy by what it says, not by how it is spelled', function () {
    const md = createMdComponent({ headingIds: true });
    const a = md.view(SOURCE, { slugPrefix: 'x-', headingAnchors: false });
    assert.equal(md.view(SOURCE, { headingAnchors: false, slugPrefix: 'x-' }), a);
    assert.notEqual(md.view(SOURCE, { slugPrefix: 'y-', headingAnchors: false }), a);
  });

  it('applies a policy to an already-parsed document too', function () {
    const md = createMdComponent({ headingIds: true });
    const doc = parseMarkdown(SOURCE);
    const untrusted = md.view(doc, UNTRUSTED);
    assert.match(renderToString(untrusted), /id="user-content-setup"/);
    assert.equal(md.view(doc, UNTRUSTED), untrusted);
    assert.notEqual(md.view(doc), untrusted);
    assert.equal(md.view(null, UNTRUSTED), null);
  });

  it('refuses an option a policy may not set', function () {
    const md = createMdComponent();
    // plugins change the PARSE, so honoring one per call would render a
    // document against a table it was not parsed with
    assert.throws(() => md.view(SOURCE, /** @type {any} */ ({ plugins: [] })),
      /not a rendering option/);
    assert.throws(() => md.view(SOURCE, /** @type {any} */ ({ sanitizeUrl: () => null })),
      /not a rendering option/);
  });

  it('shares one compile across policies', function () {
    const md = createMdComponent({ headingIds: true });
    const compiled = md.compile(SOURCE);
    md.view(SOURCE, UNTRUSTED);
    assert.equal(md.compile(SOURCE), compiled);
  });

  it('keeps one hydratable index across mixed-policy renders', async function () {
    const md = createMdComponent({ plugins: [highlightPlugin(), widgetPlugin] });
    const source = '```widget\ngraph TD; A-->B\n```\n';
    // indexed through the POLICY path; the default-policy hydrate must
    // still find it — one instance, one index
    md.view(source, UNTRUSTED);
    const hash = hashContent('graph TD; A-->B\n');
    const el = {
      _html: '',
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      getAttribute: (name) => (name === 'data-md-hydrate' ? 'widget' : hash),
    };
    md.hydrate({ querySelectorAll: () => [el] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(el.innerHTML, '<svg>ok</svg>');
  });

  it('bounds the number of retained policies', function () {
    const md = createMdComponent({ headingIds: true, policyLimit: 2 });
    const first = md.view(SOURCE, { slugPrefix: 'a-' });
    md.view(SOURCE, { slugPrefix: 'b-' });
    md.view(SOURCE, { slugPrefix: 'c-' }); // evicts 'a-'
    assert.notEqual(md.view(SOURCE, { slugPrefix: 'a-' }), first);
  });
});
