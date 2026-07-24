//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import {
  validateAppDocument, loadStudioDocument, auditDocumentRender,
} from '../../packages/website/src/boundaries/studio.js';
import { STUDIO_TEMPLATES, studioTemplate } from '../../packages/website/src/content/appTemplates.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** A headless site over the stub DOM, focused on the Studio surface. */
function mountSite({ hash = '#/studio', stored = null, modelContext, share, download } = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  let storeData = stored;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    share,
    download,
    storage: {
      read: () => storeData,
      write: (data) => { storeData = JSON.parse(JSON.stringify(data)); },
    },
    modelContext,
    onError: (err) => { throw err; },
  });
  return { app, container, go: (h) => routeCb(parseHash(h)), storage: () => storeData };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const findButton = (container, label) => find(container, (n) =>
  n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === label);

describe('website — the Studio boundary (loadStudioDocument)', function () {
  it('every seed template validates against the meta-schema, boots and renders', function () {
    for (const template of STUDIO_TEMPLATES) {
      assert.strictEqual(validateAppDocument(template.doc).valid, true,
        `${template.name} validates`);
      const { document, container } = createStubHost();
      const result = loadStudioDocument(template.doc, {
        node: container, document, schedule: (f) => f(),
      });
      assert.strictEqual(result.ok, true, `${template.name} boots`);
      const html = serialize(container);
      assert.ok(html.length > 200, `${template.name} rendered output`);
      /** @type {any} */ (result).app.destroy();
      assert.strictEqual(container.childNodes.length, 0, `${template.name} destroy empties the mount`);
    }
  });

  it('form template: the standard forms stylesheet renders and validates live', function () {
    const { document, container } = createStubHost();
    const result = /** @type {any} */ (loadStudioDocument(studioTemplate('form')?.doc, {
      node: container, document, schedule: (f) => f(),
    }));
    let html = serialize(container);
    assert.match(html, /Create your account/);
    assert.match(html, /jaren-form-field/, 'the standard forms stylesheet rendered the schema');
    const nameInput = find(container, (n) => n.tagName === 'input'
      && n.parentNode?.parentNode?.attributes?.get('data-pointer') === '/name');
    fire(nameInput, 'input', { target: { value: 'A' } });
    assert.strictEqual(result.app.getState().data.name, 'A',
      'the widget binding dispatched the standard form action into the document');
    html = serialize(container);
    assert.match(html, /jaren-form-error/, 'live JSON Schema error (minLength) shows');
    fire(nameInput, 'input', { target: { value: 'Ada' } });
    result.app.destroy();
  });

  it('dashboard template: the select filters both chart panels', function () {
    const { document, container } = createStubHost();
    const result = /** @type {any} */ (loadStudioDocument(studioTemplate('dashboard')?.doc, {
      node: container, document, schedule: (f) => f(),
    }));
    let html = serialize(container);
    assert.match(html, /Revenue — Europe/);
    assert.ok((html.match(/<svg/g) ?? []).length >= 2, 'two chart panels render as SVG');
    fire(find(container, (n) => n.tagName === 'select'), 'change', { target: { value: 'us' } });
    html = serialize(container);
    assert.match(html, /Revenue — Americas/);
    assert.match(html, /Channel share — Americas/, 'both panels switched from one action');
    result.app.destroy();
  });

  it('mini-site template: routed pages of markdown with a mermaid diagram', function () {
    const { document, container } = createStubHost();
    const result = /** @type {any} */ (loadStudioDocument(studioTemplate('minisite')?.doc, {
      node: container, document, schedule: (f) => f(),
    }));
    assert.match(serialize(container), /Wavelength Coffee/, 'the home page markdown renders');
    fire(findButton(container, 'About'), 'click');
    const html = serialize(container);
    assert.match(html, /How an order flows/);
    assert.match(html, /<svg/, 'the mermaid fence renders inline SVG');
    assert.doesNotMatch(html, /<script/);
    result.app.destroy();
  });

  it('the mermaid widget capability renders a diagram directly (not only via md fences)', function () {
    const { document, container } = createStubHost();
    const result = /** @type {any} */ (loadStudioDocument({
      view: {
        $jslt: '0.1',
        rules: [{
          match: '$',
          body: ['div', {},
            ['jaren-widget', { name: 'mermaid', props: { source: 'flowchart LR\n  A[Ask] --> B[Render]' } }],
          ],
        }],
      },
    }, { node: container, document, schedule: (f) => f() }));
    assert.strictEqual(result.ok, true);
    const html = serialize(container);
    assert.match(html, /<svg/, 'the diagram rendered as inline SVG');
    assert.match(html, /Ask/);
    result.app.destroy();
  });

  it('an invalid document reports meta-schema errors with instancePaths and mounts nothing', function () {
    const { document, container } = createStubHost();
    const result = loadStudioDocument(
      { $app: '0.2', view: [], actions: { bad: { $bogus: [1] } } },
      { node: container, document, schedule: (f) => f() });
    assert.strictEqual(result.ok, false);
    const failed = /** @type {any} */ (result);
    assert.ok(failed.total > 0);
    assert.ok(failed.errors.length > 0);
    assert.ok(failed.errors.some((e) => e.instancePath === '/$app'), 'errors carry instancePaths');
    assert.strictEqual(container.childNodes.length, 0, 'nothing mounted');
  });

  it('a grammar-valid document that fails to compile rolls back atomically (JA0007)', function () {
    const { document, container } = createStubHost();
    const result = loadStudioDocument(
      { view: { $jslt: '0.1', rules: [{ match: '$[unclosed', body: 'x' }] } },
      { node: container, document, schedule: (f) => f() });
    assert.strictEqual(result.ok, false);
    assert.match(/** @type {any} */ (result).message, /failed to compile|failed to boot/);
    assert.strictEqual(container.childNodes.length, 0, 'the container ends empty — no half-mounted DOM');
  });
});

describe('website — the Studio page', function () {
  it('shows the template picker with no document, and the nav entry', function () {
    const { container } = mountSite();
    const html = serialize(container);
    assert.match(html, /<h1>Studio<\/h1>/);
    assert.match(html, /Form \+ validation/);
    assert.match(html, /Dashboard/);
    assert.match(html, /Mini-site/);
    assert.match(html, /nav-link active/, 'the Studio nav entry is active');
  });

  it('loading a template boots the document inside the split view', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    assert.strictEqual(app.getState().studio.revision, 1);
    const html = serialize(container);
    assert.match(html, /studio-grid/, 'the split view rendered');
    assert.match(html, /Document \(JSON\)/, 'the collapsible editor is there');
    assert.match(html, /Create your account/, 'the hosted app rendered inside the mount');
    assert.match(html, /jaren-form-field/);
  });

  it('an invalid editor commit reports errors and keeps the old document live', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    const editor = find(container, (n) =>
      n.tagName === 'textarea' && n.attributes?.get('class') === 'editor');

    fire(editor, 'change', { target: { value: '{ not json' } });
    let html = serialize(container);
    assert.match(html, /Invalid JSON/, 'the parse error surfaces as an error node');
    assert.match(html, /Create your account/, 'the old document is still mounted');
    assert.strictEqual(app.getState().studio.revision, 1, 'no swap happened');

    fire(editor, 'change', { target: { value: JSON.stringify({ $app: '0.2', view: [] }) } });
    html = serialize(container);
    assert.match(html, /error-card/, 'meta-schema errors render as standard error nodes');
    assert.match(html, /dataPath: \/\$app/, 'with instancePaths');
    assert.match(html, /Create your account/, 'rejected atomically — old document still live');

    fire(editor, 'change', {
      target: {
        value: JSON.stringify({
          view: { $jslt: '0.1', rules: [{ match: '$', body: ['h2', {}, 'Hand-edited'] }] },
        }),
      },
    });
    html = serialize(container);
    assert.match(html, /Hand-edited/, 'a valid commit swaps the document in');
    assert.doesNotMatch(html, /error-card/, 'the error report cleared');
    assert.strictEqual(app.getState().studio.revision, 2);
  });

  it('an error report appearing must NOT remount the host widget (keyed reconciliation)', function () {
    const { app, container } = mountSite();
    app.dispatch('studio/template', 'minisite');
    fire(findButton(container, 'About'), 'click');
    assert.match(serialize(container), /How an order flows/, 'the document navigated internally');

    // an invalid commit inserts the error block before the split view;
    // without keys, positional div-vs-div patching would rebuild the
    // grid, remount the widget and silently reboot the nested app —
    // observable as its internal state resetting to the home page
    const editor = find(container, (n) =>
      n.tagName === 'textarea' && n.attributes?.get('class') === 'editor');
    fire(editor, 'change', { target: { value: '{ not json' } });
    const html = serialize(container);
    assert.match(html, /Invalid JSON/, 'the error report rendered');
    assert.match(html, /How an order flows/,
      'the nested app kept its internal state — no phantom remount');
  });

  it('leaving the route destroys the nested app; returning reboots it', function () {
    const { app, container, go } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    assert.match(serialize(container), /Create your account/);
    go('#/');
    const html = serialize(container);
    assert.doesNotMatch(html, /studio-mount/, 'the mount left the tree');
    assert.doesNotMatch(html, /Create your account/, 'the nested app was destroyed with it');
    go('#/studio');
    assert.match(serialize(container), /Create your account/,
      'the document persists in state and reboots on return');
    assert.strictEqual(app.getState().studio.revision, 1, 'no phantom revision bump');
  });

  it('clear returns to the picker; a boot failure surfaces via the document error line', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    fire(findButton(container, 'New'), 'click');
    assert.strictEqual(app.getState().studio.doc, null);
    assert.match(serialize(container), /Form \+ validation/, 'back to the picker');

    // a document the grammar accepts but the compiler rejects: the host
    // widget reports through studio/error instead of throwing
    app.dispatch('studio/doc', {
      doc: { view: { $jslt: '0.1', rules: [{ match: '$[oops', body: 'x' }] } },
    });
    const html = serialize(container);
    assert.match(html, /error-line/, 'the failure renders in the editor card');
    assert.match(app.getState().studio.error, /failed to compile|failed to boot/);
  });

  it('a runtime failure inside the hosted document reports through its own error sink', function () {
    const { app, container } = mountSite();
    // an action whose patch cannot apply at runtime: clicking it makes
    // the NESTED app fail (JA2004) — its own onError sink routes the
    // failure to studio/error instead of breaking the site
    app.dispatch('studio/doc', {
      doc: {
        view: {
          $jslt: '0.1',
          rules: [{ match: '$', body: ['button', { on: { click: 'boom' } }, 'Boom'] }],
        },
        actions: {
          boom: { patch: [{ op: 'replace', path: '/no/such/place', value: 1 }] },
        },
      },
    });
    assert.strictEqual(app.getState().studio.error, null, 'the document boots clean');
    fire(findButton(container, 'Boom'), 'click');
    assert.match(app.getState().studio.error, /boom|JA2004|patch/i,
      'the nested runtime failure surfaced in the studio error line');
    assert.match(serialize(container), /error-line/, 'and renders in the editor card');
  });

  it('saves, reloads and deletes a studio document through the IDE store', function () {
    const share = [];
    const { app, container, go, storage } = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    fire(findButton(container, 'Load'), 'click');
    app.dispatch('ide/name', null, { target: { value: 'my-app' } });
    app.dispatch('ide/save');
    assert.strictEqual(storage().experiments['my-app'].engine, 'studio',
      'saved as the studio experiment kind');
    assert.deepStrictEqual(storage().experiments['my-app'].inputs.doc, app.getState().studio.doc);

    go('#/');
    app.dispatch('ide/load', 'my-app');
    assert.strictEqual(app.getState().route.page, 'studio', 'loading navigates to the studio');
    assert.match(serialize(container), /Create your account/, 'the experiment booted');

    app.dispatch('ide/share');
    assert.match(share[0], /^#\/studio\?s=/, 'the share link targets the studio route');
    assert.strictEqual(app.getState().ide.shared, 'link copied');

    app.dispatch('ide/delete', 'my-app');
    assert.strictEqual(storage().experiments['my-app'], undefined);
  });

  it('an inbound share link boots the shared document through the same meta-schema gate', function () {
    const share = [];
    const first = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    fire(findButton(first.container, 'Load'), 'click');
    first.app.dispatch('ide/share');
    const token = share[0].split('s=')[1];

    const second = mountSite({ hash: `#/studio?s=${token}` });
    assert.strictEqual(second.app.getState().studio.revision, 1);
    assert.match(serialize(second.container), /Create your account/, 'the shared document booted');

    // a corrupt token is ignored; a token with an invalid document reports
    const third = mountSite({ hash: '#/studio?s=not-a-token' });
    assert.strictEqual(third.app.getState().studio.doc, null);
    assert.match(serialize(third.container), /Form \+ validation/, 'falls back to the picker');
  });

  it('share-link honesty: an oversized document refuses with the recorded limit', function () {
    const share = [];
    const { app, container } = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    fire(findButton(container, 'Load'), 'click');
    // inflate the document far past the token limit
    app.dispatch('studio/doc', {
      doc: {
        ...app.getState().studio.doc,
        state: { blob: 'x'.repeat(20000) },
      },
    });
    app.dispatch('ide/share');
    assert.strictEqual(share.length, 0, 'no mangled URL was produced');
    assert.match(app.getState().ide.shared, /too large for a share link \(\d+ > 8000 chars\)/);
  });

  it('downloads the document through the host capability (no-op headless)', function () {
    const saved = [];
    const withHost = mountSite({ download: (name, text) => { saved.push({ name, text }); return true; } });
    fire(findButton(withHost.container, 'Load'), 'click');
    withHost.app.dispatch('studio/download');
    assert.strictEqual(saved[0].name, 'jaren-studio-app.json');
    assert.deepStrictEqual(JSON.parse(saved[0].text), withHost.app.getState().studio.doc);
    assert.strictEqual(withHost.app.getState().ide.shared, 'document downloaded');

    const headless = mountSite();
    fire(findButton(headless.container, 'Load'), 'click');
    headless.app.dispatch('studio/download');
    assert.strictEqual(headless.app.getState().ide.shared, 'download unavailable here');
  });
});

describe('website — the Studio render audit (auditDocumentRender)', function () {
  it('reports the widgets of every seed template with no problems', function () {
    for (const template of STUDIO_TEMPLATES) {
      const audit = auditDocumentRender(template.doc);
      assert.deepStrictEqual(audit.problems, [], `${template.name} renders clean`);
      assert.ok(audit.widgets.length > 0, `${template.name} hosts at least one widget`);
    }
  });

  it('catches the valid-but-broken shapes the meta-schema accepts', function () {
    const base = /** @type {any} */ (studioTemplate('form')).doc;

    // a bare object where a vnode belongs (a model patch clobbered a child)
    const clobbered = JSON.parse(JSON.stringify(base));
    clobbered.view.rules[0].body[2] = { class: 'studio-app' };
    const bare = auditDocumentRender(clobbered);
    assert.ok(bare.problems.some((p) => /bare object is not a vnode/.test(p)), bare.problems.join('; '));

    // a form widget whose schema resolves to nothing
    const misfed = JSON.parse(JSON.stringify(base));
    misfed.view.rules[0].body[4] = ['jaren-widget', { name: 'form', props: { schema: '$.nope' } }];
    const feed = auditDocumentRender(misfed);
    assert.ok(feed.problems.some((p) => /props\.schema did not resolve/.test(p)), feed.problems.join('; '));

    // an unknown widget name
    const unknown = JSON.parse(JSON.stringify(base));
    unknown.view.rules[0].body[4] = ['jaren-widget', { name: 'fom', props: {} }];
    const named = auditDocumentRender(unknown);
    assert.ok(named.problems.some((p) => /unknown widget 'fom'/.test(p)), named.problems.join('; '));

    // an invalid tag name (a text fragment wrapped in an array) is a
    // boot-stopper: createElement(' | ') throws in a real DOM
    const invalidTag = JSON.parse(JSON.stringify(base));
    invalidTag.view.rules[0].body.push([' | ']);
    const tagged = auditDocumentRender(invalidTag);
    assert.ok(tagged.problems.some((p) => /' \| ' is not a valid element tag name/.test(p)),
      tagged.problems.join('; '));

    // one-element arrays with a REAL tag are valid void elements —
    // ['hr'] must never be flagged
    const voidEl = JSON.parse(JSON.stringify(base));
    voidEl.view.rules[0].body.push(['hr']);
    assert.deepStrictEqual(auditDocumentRender(voidEl).problems, [],
      "['hr'] is a legitimate void element");
  });

  it('rides along on the studio write/patch tool results', function () {
    /** @type {any[]} */
    let registered = [];
    mountSite({
      hash: '#/',
      modelContext: { provideContext: ({ tools }) => { registered = tools; } },
    });
    const tool = (name) => registered.find((t) => t.name === name);
    const seed = tool('jaren_get_templates').execute({ name: 'form' });

    const written = tool('jaren_studio_write').execute({ doc: seed.doc });
    assert.strictEqual(written.ok, true);
    assert.deepStrictEqual(written.widgets, ['form'], 'a clean write reports its widgets');
    assert.strictEqual(written.renderProblems, undefined);

    // break the form widget's feed through a valid patch: the tool
    // answers ok (the document IS valid and live) plus the problems
    const patched = tool('jaren_studio_patch').execute({
      patch: [{ op: 'replace', path: '/view/rules/0/body/4/1/props/schema', value: '$.nope' }],
    });
    assert.strictEqual(patched.ok, true);
    assert.ok(patched.renderProblems.some((p) => /props\.schema did not resolve/.test(p)),
      'the render audit surfaced the broken widget feed');
    assert.match(patched.hint, /renders broken/);
  });
});

describe('website — the Studio assistant tools (WebMCP)', function () {
  it('registers the four studio tools and they author, patch and read documents', function () {
    /** @type {any[]} */
    let registered = [];
    const { app, container } = mountSite({
      hash: '#/',
      modelContext: { provideContext: ({ tools }) => { registered = tools; } },
    });
    const tool = (name) => registered.find((t) => t.name === name);
    for (const expected of ['jaren_studio_write', 'jaren_studio_patch',
      'jaren_studio_read', 'jaren_get_templates']) {
      assert.notStrictEqual(tool(expected), undefined, `${expected} registered`);
    }

    // the seed library: list, then by name
    const list = tool('jaren_get_templates').execute({});
    assert.deepStrictEqual(list.map((t) => t.name), ['form', 'dashboard', 'minisite']);
    const seed = tool('jaren_get_templates').execute({ name: 'minisite' });
    assert.strictEqual(typeof seed.doc, 'object');
    assert.match(tool('jaren_get_templates').execute({ name: 'nope' }).error, /invalid input/,
      'Jaren guards the template enum');

    // write: validates, navigates, boots — the human watches
    const written = tool('jaren_studio_write').execute({ doc: seed.doc });
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.revision, 1);
    assert.strictEqual(app.getState().route.page, 'studio', 'writing navigated to #/studio');
    assert.match(serialize(container), /Wavelength Coffee/, 'the document booted on-page');

    // an invalid document returns the repair instructions, loads nothing
    const rejected = tool('jaren_studio_write').execute({ doc: { $app: '9.9' } });
    assert.strictEqual(rejected.ok, false);
    assert.ok(rejected.errors.length > 0 && rejected.total > 0);
    assert.strictEqual(typeof rejected.errors[0].instancePath, 'string');
    assert.match(rejected.hint, /meta-schema/);
    assert.strictEqual(app.getState().studio.revision, 1, 'the live document was untouched');

    // patch: applied by the suite's own engine, re-validated, revision bumps
    const patched = tool('jaren_studio_patch').execute({
      patch: [{ op: 'replace', path: '/state/pages/home', value: '# Patched!' }],
    });
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.revision, 2);
    assert.match(serialize(container), /Patched!/, 'the patched document rebooted live');

    // a patch producing an invalid document is rejected atomically
    const broken = tool('jaren_studio_patch').execute({
      patch: [{ op: 'remove', path: '/view' }],
    });
    assert.strictEqual(broken.ok, false);
    assert.notStrictEqual(app.getState().studio.doc.view, undefined, 'the document kept its view');
    assert.strictEqual(app.getState().studio.revision, 2, 'no revision bump on rejection');

    // a patch that cannot apply reports, never throws
    assert.match(tool('jaren_studio_patch').execute({
      patch: [{ op: 'replace', path: '/no/such/place', value: 1 }],
    }).error, /failed to apply/);

    // read: whole document, one subtree, and a miss
    assert.deepStrictEqual(tool('jaren_studio_read').execute({}).doc, app.getState().studio.doc);
    assert.deepStrictEqual(tool('jaren_studio_read').execute({ pointer: '/state/page' }),
      { value: 'home' });
    assert.match(tool('jaren_studio_read').execute({ pointer: '/nope' }).error, /nothing at/);
    assert.match(tool('jaren_studio_read').execute({ pointer: 'not-a-pointer' }).error,
      /invalid JSON Pointer/);

    // jaren_save_experiment covers studio documents (verified, not assumed)
    const saved = tool('jaren_save_experiment').execute({ name: 'from-chat' });
    assert.strictEqual(saved.ok, true);
    assert.ok(saved.names.includes('from-chat'));

    // patch/read with no document loaded report readable errors
    app.dispatch('studio/clear');
    assert.match(tool('jaren_studio_patch').execute({ patch: [] }).error, /no studio document/);
    assert.match(tool('jaren_studio_read').execute({}).error, /no studio document/);
  });
});
