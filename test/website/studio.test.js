//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { encodeShare } from '@jarenjs/app';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import {
  validateAppDocument, loadStudioDocument, auditDocumentRender,
} from '../../packages/website/src/boundaries/studio.js';
import { STUDIO_TEMPLATES, studioTemplate } from '../../packages/website/src/content/appTemplates.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** A headless site over the stub DOM, focused on the folded Studio —
 * app authoring on the project surface. */
function mountSite({ hash = '#/project', stored = null, modelContext, share, download } = {}) {
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

describe('website — app authoring on the project surface (the folded Studio)', function () {
  const editorOf = (container) => find(container, (n) => n.tagName === 'textarea');

  it('the three seed apps are project templates; each boots on the stage', function () {
    const { app, container } = mountSite();
    const html = serialize(container);
    for (const title of ['Form + validation', 'Dashboard', 'Mini-site']) {
      assert.match(html, new RegExp(title.replace('+', '\\+')), `the '${title}' template card shows`);
    }
    assert.match(html, /nav-link active/, 'the Studio nav entry is active');

    for (const [id, marker] of [
      ['form', /Create your account/],
      ['dashboard', /Revenue — Europe/],
      ['minisite', /Wavelength Coffee/],
    ]) {
      app.dispatch('project/template', id);
      assert.strictEqual(app.getState().project.revision, 1, `${id} committed`);
      assert.match(serialize(container), marker, `the ${id} app booted on the stage`);
    }
  });

  it('the dashboard select drives the DOCUMENT\'s own action — both panels switch', function () {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'dashboard');
    let html = serialize(container);
    assert.match(html, /Revenue — Europe/);
    assert.ok((html.match(/<svg/g) ?? []).length >= 2, 'two chart panels render as SVG');
    fire(find(container, (n) => n.tagName === 'select' && n.parentNode?.attributes?.get('class') === 'studio-app-control'),
      'change', { target: { value: 'us' } });
    html = serialize(container);
    assert.match(html, /Revenue — Americas/);
    assert.match(html, /Channel share — Americas/, 'both panels switched from one action');
  });

  it('an invalid editor commit docks errors and keeps the old document live', function () {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'form');
    const editor = editorOf(container);

    fire(editor, 'change', { target: { value: '{ not json' } });
    let html = serialize(container);
    assert.match(html, /js-errorline/, 'the parse error docks in the error strip');
    assert.match(html, /not valid JSON/);
    assert.match(html, /Create your account/, 'the old document is still mounted');
    assert.strictEqual(app.getState().project.revision, 1, 'no swap happened');

    fire(editor, 'change', { target: { value: JSON.stringify({ $app: '0.2', view: [] }) } });
    html = serialize(container);
    assert.match(html, /js-errorline/, 'meta-schema errors dock in the error strip');
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
    assert.doesNotMatch(html, /js-errorline/, 'the error strip cleared');
  });

  it('a docked error report must NOT remount the stage host (the nested app keeps its state)', function () {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'minisite');
    fire(findButton(container, 'About'), 'click');
    assert.match(serialize(container), /How an order flows/, 'the document navigated internally');

    // an invalid commit docks the error strip; the stage widget must not
    // remount over it — observable as the nested app's internal state
    // resetting to the home page
    fire(editorOf(container), 'change', { target: { value: '{ not json' } });
    const html = serialize(container);
    assert.match(html, /js-errorline/, 'the error report rendered');
    assert.match(html, /How an order flows/,
      'the nested app kept its internal state — no phantom remount');
  });

  it('leaving the route destroys the nested app; returning reboots it fresh', function () {
    const { app, container, go } = mountSite();
    app.dispatch('project/template', 'form');
    assert.match(serialize(container), /Create your account/);
    go('#/');
    const html = serialize(container);
    assert.doesNotMatch(html, /js-stage-mount/, 'the mount left the tree');
    assert.doesNotMatch(html, /Create your account/, 'the nested app was destroyed with it');
    go('#/project');
    assert.match(serialize(container), /Create your account/,
      'the document persists in state and reboots on return');
    assert.strictEqual(app.getState().project.revision, 1, 'no phantom revision bump');
  });

  it('#/studio redirects to the project IDE', function () {
    const { app } = mountSite({ hash: '#/studio' });
    assert.strictEqual(app.getState().route.page, 'project', 'the retired route lands on #/project');
  });

  it('saves, reloads and deletes a project through the IDE store', function () {
    const share = [];
    const { app, container, go, storage } = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    app.dispatch('project/template', 'form');
    app.dispatch('ide/name', null, { target: { value: 'my-app' } });
    app.dispatch('ide/save');
    assert.strictEqual(storage().experiments['my-app'].engine, 'project',
      'saved as the project experiment kind');
    assert.deepStrictEqual(storage().experiments['my-app'].inputs.project.files,
      app.getState().project.files);

    go('#/');
    app.dispatch('ide/load', 'my-app');
    assert.strictEqual(app.getState().route.page, 'project', 'loading navigates to the project IDE');
    assert.match(serialize(container), /Create your account/, 'the experiment booted');

    app.dispatch('ide/share');
    assert.match(share[0], /^#\/project\?s=/, 'the share link targets the project route');
    assert.strictEqual(app.getState().ide.shared, 'link copied');

    app.dispatch('ide/delete', 'my-app');
    assert.strictEqual(storage().experiments['my-app'], undefined);
  });

  it('a legacy studio experiment (engine \'studio\') opens as a single-app project', function () {
    const stored = {
      experiments: {
        'old-app': { engine: 'studio', inputs: { doc: studioTemplate('form')?.doc }, savedAt: 'x' },
      },
    };
    const { app, container } = mountSite({ hash: '#/', stored });
    assert.deepStrictEqual(app.getState().ide.names, ['old-app'], 'the legacy save is listed');
    app.dispatch('ide/load', 'old-app');
    assert.strictEqual(app.getState().route.page, 'project');
    const p = app.getState().project;
    assert.deepStrictEqual(p.files.map((f) => ({ name: f.name, kind: f.kind })),
      [{ name: 'app.json', kind: 'app' }], 'the doc landed as the one app file');
    assert.match(serialize(container), /Create your account/, 'and booted on the stage');
  });

  it('an inbound share link restores the project; a legacy studio token opens as one too', function () {
    const share = [];
    const first = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    first.app.dispatch('project/template', 'form');
    first.app.dispatch('ide/share');
    const token = share[0].split('s=')[1];

    const second = mountSite({ hash: `#/project?s=${token}` });
    assert.match(serialize(second.container), /Create your account/, 'the shared project booted');

    // a legacy studio-document token still opens — on #/studio, which
    // redirects to #/project with the token riding along
    const legacy = encodeShare({ e: 'studio', i: { doc: studioTemplate('minisite')?.doc } });
    const third = mountSite({ hash: `#/studio?s=${legacy}` });
    assert.strictEqual(third.app.getState().route.page, 'project');
    assert.match(serialize(third.container), /Wavelength Coffee/, 'the legacy token booted as a one-app project');

    // a corrupt token is ignored — the starter stays
    const fourth = mountSite({ hash: '#/project?s=not-a-token' });
    assert.match(serialize(fourth.container), /Hello from the studio/, 'falls back to the starter');
  });

  it('share-link honesty: an oversized project refuses with the recorded limit', function () {
    const share = [];
    const { app, container } = mountSite({ share: (h) => { share.push(h); return `https://x/${h}`; } });
    app.dispatch('project/template', 'form');
    // inflate the app file far past the token limit
    fire(editorOf(container), 'change', {
      target: {
        value: JSON.stringify({
          state: { blob: 'x'.repeat(20000) },
          view: [{ match: '$', body: ['p', {}, 'big'] }],
        }),
      },
    });
    app.dispatch('ide/share');
    assert.strictEqual(share.length, 0, 'no mangled URL was produced');
    assert.match(app.getState().ide.shared, /too large for a share link \(\d+ > 8000 chars\)/);
  });

  it('downloads the app document through the host capability (no-op headless)', function () {
    const saved = [];
    const withHost = mountSite({ download: (name, text) => { saved.push({ name, text }); return true; } });
    withHost.app.dispatch('project/template', 'form');
    withHost.app.dispatch('project/download');
    assert.strictEqual(saved[0].name, 'jaren-studio-app.json');
    assert.deepStrictEqual(JSON.parse(saved[0].text), studioTemplate('form')?.doc);
    assert.strictEqual(withHost.app.getState().ide.shared, 'document downloaded');

    const headless = mountSite();
    headless.app.dispatch('project/template', 'form');
    headless.app.dispatch('project/download');
    assert.strictEqual(headless.app.getState().ide.shared, 'download unavailable here');
  });

  it('exports every project file even when there is no app file', function () {
    const saved = [];
    const { app } = mountSite({ download: (name, text) => { saved.push({ name, text }); return true; } });
    app.dispatch('project/template', 'finance');
    app.dispatch('project/export');
    assert.strictEqual(saved[0].name, 'jaren-project.json');
    const restored = JSON.parse(saved[0].text);
    assert.deepStrictEqual(restored.files, app.getState().project.files);
    assert.deepStrictEqual(restored.layout, app.getState().project.layout);
    assert.strictEqual(restored.active, app.getState().project.active);
    assert.strictEqual(restored.project, '0.1');
    assert.strictEqual(restored.mount, undefined);
    assert.strictEqual(app.getState().ide.shared, 'project downloaded');
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

  it('notes a seed heading left stale over a repurposed form — and only that', function () {
    const base = /** @type {any} */ (studioTemplate('form')).doc;

    // pristine seed: heading and title are the seed's own pair — silent
    assert.deepStrictEqual(auditDocumentRender(base).notes, []);

    // schema retitled, seed heading kept: the run-3 leftover — noted
    const repurposed = JSON.parse(JSON.stringify(base));
    repurposed.state.schema.title = 'Mental Health Check-in';
    const noted = auditDocumentRender(repurposed);
    assert.strictEqual(noted.notes.length, 1);
    assert.match(noted.notes[0], /"Create your account"/);
    assert.match(noted.notes[0], /"Mental Health Check-in"/);
    assert.deepStrictEqual(noted.problems, [], 'a note is not a problem');

    // heading patched along with the title — silent again
    const kept = JSON.parse(JSON.stringify(repurposed));
    kept.view.rules[0].body[2] = ['h2', {}, 'Mental Health Check-in'];
    assert.deepStrictEqual(auditDocumentRender(kept).notes, []);

    // an authored heading of the user's own never trips the rule
    const authored = JSON.parse(JSON.stringify(repurposed));
    authored.view.rules[0].body[2] = ['h2', {}, 'Weekly wellbeing form'];
    assert.deepStrictEqual(auditDocumentRender(authored).notes, []);
  });


});
