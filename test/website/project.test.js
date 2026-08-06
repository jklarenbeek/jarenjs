//@ts-check
/**
 * @file The Project IDE surface (`#/project`) end to end, headless over
 * the stub DOM: the IDE chrome renders, the active `app` file boots LIVE
 * on the stage, and the two hard problems behave — a structural edit
 * reboots (revision bumps), a state-only edit hot-updates (revision
 * holds, the new state shows without a remount), and an invalid edit
 * keeps the last good frame. Plus `commitProject`, the edit-loop step, as
 * a unit. The live drag splitter and the pointer interactions are the
 * browser e2e (`e2e/project.spec.js`).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { commitProject, projectComponent } from '../../packages/website/src/boundaries/project.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** A headless site over the stub DOM, entered at the Project IDE. */
function mountSite({ hash = '#/project' } = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    onError: (err) => { throw err; },
  });
  return { app, container, go: (h) => routeCb(parseHash(h)) };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
const editor = (container) => find(container, (n) => n.tagName === 'textarea');
const editActiveApp = (app, container, mutate) => {
  const doc = JSON.parse(app.getState().project.files[0].text);
  mutate(doc);
  fire(editor(container), 'change', { target: { value: JSON.stringify(doc) } });
};

describe('website — the Project IDE (#/project)', () => {
  it('boots the starter project: the IDE chrome, the file rail, and a LIVE app stage', () => {
    const { app, container } = mountSite();
    const html = serialize(container);
    assert.match(html, /jstudio/, 'the IDE shell rendered');
    assert.match(html, /app\.json/, 'the file rail lists the starter file');
    assert.match(html, /js-editor-input/, 'the editor is present');
    assert.match(html, /Hello from the studio/, 'the starter app booted LIVE on the stage');
    const p = app.getState().project;
    assert.strictEqual(p.mount.name, 'app.json');
    assert.strictEqual(p.revision, 1, 'the first commit set the reboot revision');
  });

  it('a view (structural) edit reboots the stage: the revision bumps and the new render appears', () => {
    const { app, container } = mountSite();
    editActiveApp(app, container, (doc) => { doc.view[0].body.push(['p', { class: 'brandnew' }, 'BRAND NEW VIEW']); });
    assert.strictEqual(app.getState().project.revision, 2, 'a structural change bumped the reboot revision');
    assert.match(serialize(container), /BRAND NEW VIEW/, 'the rebooted stage shows the new view');
  });

  it('a state-only edit HOT-updates: the revision holds and the new state shows live', () => {
    const { app, container } = mountSite();
    editActiveApp(app, container, (doc) => { doc.state.title = 'HOT TITLE'; });
    assert.strictEqual(app.getState().project.revision, 1, 'a state-only change did NOT reboot');
    assert.match(serialize(container), /HOT TITLE/, 'the hot-updated state shows live on the running app');
  });

  it('an invalid edit keeps the last good frame: the stage never blanks, the coded error docks', () => {
    const { app, container } = mountSite();
    const before = app.getState().project;
    fire(editor(container), 'change', { target: { value: '{ this is not json' } });
    const after = app.getState().project;
    assert.strictEqual(after.revision, before.revision, 'an invalid edit does not bump the revision');
    assert.strictEqual(after.mount, before.mount, 'the last-good mount is untouched (same reference)');
    assert.match(serialize(container), /Hello from the studio/, 'the last good render stays on the stage');
    assert.match(serialize(container), /js-errorstrip/, 'the parse error is docked in the error strip');
  });

  it('opens a multi-file template; every file shows; $npv validates green via the mounted packs', () => {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'finance');
    const p = app.getState().project;
    assert.strictEqual(p.active, 'npv.query');
    const html = serialize(container);
    assert.match(html, /npv\.query/);
    assert.match(html, /cashflows\.data/);
    const vm = projectComponent.viewModel({ project: p });
    assert.strictEqual(vm.problemCount, 0, '$npv is not an error — the finance pack is mounted');
    assert.strictEqual(vm.stage.kind, 'result', 'a query file drives the result stage');
  });

  it('explicit Run force-restarts the app stage (the reboot revision bumps)', () => {
    const { app } = mountSite();
    assert.strictEqual(app.getState().project.revision, 1);
    app.dispatch('project/run');
    assert.strictEqual(app.getState().project.revision, 2, 'Run bumps the reboot revision');
  });

  it('a nested-app RUNTIME error surfaces as a stage error, never a site crash', () => {
    const { app, container } = mountSite();
    const boom = JSON.stringify({
      state: { n: 0 },
      view: [{ match: '$', body: ['button', { type: 'button', on: { click: 'boom' } }, 'boom'] }],
      actions: { boom: { patch: [{ op: 'replace', path: '/does/not/exist', value: 1 }] } },
    });
    app.dispatch('project/open', {
      project: '0.1', name: 'boom', active: 'app.json',
      files: [{ name: 'app.json', kind: 'app', text: boom }],
      layout: { mode: 'classic', ratio: 0.5, autorun: true },
    });
    const btn = find(container, (n) => n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === 'boom');
    assert.ok(btn, 'the nested app booted with its button');
    fire(btn, 'click', {});
    assert.notStrictEqual(app.getState().project.stageError, null,
      'the nested runtime error was captured as a stage error, isolated from the site');
  });
});

describe('commitProject — the edit-loop step', () => {
  const appFile = (state, body) => ({
    name: 'a.json', kind: 'app',
    text: JSON.stringify({ state, view: [{ match: '$', body: body ?? ['h1', {}, '$.x'] }], actions: {} }),
  });

  it('reboots on the first commit and on a structural change', () => {
    const c0 = commitProject({ files: [appFile({ x: 1 })], active: 'a.json' });
    assert.strictEqual(c0.revision, 1);
    assert.strictEqual(c0.mount.name, 'a.json');
    const c1 = commitProject({ files: [appFile({ x: 1 }, ['h2', {}, '$.x'])], active: 'a.json', mount: c0.mount, revision: c0.revision });
    assert.strictEqual(c1.revision, 2, 'a view change reboots');
  });

  it('hot-updates on a state-only change: the revision holds, the document swaps', () => {
    const c0 = commitProject({ files: [appFile({ x: 1 })], active: 'a.json' });
    const c1 = commitProject({ files: [appFile({ x: 2 })], active: 'a.json', mount: c0.mount, revision: c0.revision });
    assert.strictEqual(c1.revision, 1, 'a state-only change does not reboot');
    assert.notStrictEqual(c1.mount.doc, c0.mount.doc, 'the document is swapped for the hot-dispatch');
  });

  it('skips an unchanged commit (same mount reference)', () => {
    const c0 = commitProject({ files: [appFile({ x: 1 })], active: 'a.json' });
    const c1 = commitProject({ files: [appFile({ x: 1 })], active: 'a.json', mount: c0.mount, revision: c0.revision });
    assert.strictEqual(c1.mount, c0.mount, 'nothing changed — the mount reference is kept');
  });

  it('keeps the last good mount on an invalid edit', () => {
    const c0 = commitProject({ files: [appFile({ x: 1 })], active: 'a.json' });
    const c1 = commitProject({ files: [{ name: 'a.json', kind: 'app', text: '{bad json' }], active: 'a.json', mount: c0.mount, revision: c0.revision });
    assert.strictEqual(c1.mount, c0.mount, 'the last-good mount survives an invalid edit');
    assert.strictEqual(c1.revision, c0.revision);
  });

  it('a non-app active file leaves the mount untouched', () => {
    const c = commitProject({ files: [{ name: 'q.query', kind: 'query', text: '{"a":"$.x"}' }], active: 'q.query' });
    assert.strictEqual(c.mount, null);
    assert.strictEqual(c.revision, 0);
  });
});
