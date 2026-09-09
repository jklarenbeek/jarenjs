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
import { ADDABLE_KINDS, fileSkeleton } from '../../packages/website/src/content/projectTemplates.js';
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
  return { app, container, document, go: (h) => routeCb(parseHash(h)) };
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
  it('stores results under the exact file name, including JSON Pointer characters', () => {
    const { app } = mountSite();
    for (const name of ['folder/a.query', 'a~1b.query', '__proto__']) {
      app.dispatch('project/result', { name, result: { ok: true, value: 42 } });
      assert.deepStrictEqual(app.getState().project.results[name], { ok: true, value: 42 });
      assert.strictEqual(Object.hasOwn(app.getState().project.results, name), true);
    }
    app.destroy();
  });
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
    assert.match(serialize(container), /js-stage-error/);
    assert.ok(serialize(container).includes(app.getState().project.stageError));
    app.dispatch('project/run');
    assert.strictEqual(app.getState().project.stageError, null, 'a successful restart clears the old failure');
  });

  it('autorun false preserves the last app frame until an explicit run', () => {
    const { app, container } = mountSite();
    app.dispatch('project/autorun');
    assert.strictEqual(app.getState().project.layout.autorun, false);
    editActiveApp(app, container, (doc) => { doc.state.title = 'MANUAL TITLE'; });
    assert.doesNotMatch(serialize(container), /<h1[^>]*>MANUAL TITLE/);
    assert.match(serialize(container), /Hello from the studio/);
    app.dispatch('project/run');
    assert.match(serialize(container), /<h1[^>]*>MANUAL TITLE/);
    app.dispatch('project/autorun');
    editActiveApp(app, container, (doc) => { doc.state.title = 'LIVE AGAIN'; });
    assert.match(serialize(container), /<h1[^>]*>LIVE AGAIN/);
  });
});

describe('transform file kinds run live on the stage (the playground fold)', () => {
  it('a query file runs against its data file — registered $npv included — and renders result nodes', () => {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'finance');
    const result = app.getState().project.results['npv.query'];
    assert.ok(result && Array.isArray(result.nodes), 'the query ran and stored render nodes');
    assert.match(serialize(container), /Result/, 'the result renders on the stage');
  });

  it('a jslt file transforms its data file live', () => {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'transform');
    assert.ok(app.getState().project.results['shape.jslt'], 'the jslt ran');
    assert.match(serialize(container), /greeting|Output/, 'the transform output renders on the stage');
  });

  it('a schema file validates the data file live (valid → invalid)', () => {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'validate');
    assert.strictEqual(app.getState().project.active, 'user.schema');
    assert.ok(app.getState().project.results['user.schema']?.nodes, 'the schema validated its data');
    assert.match(serialize(container), /✓/, 'good data reports valid');

    // break the data file, then re-validate from the schema
    app.dispatch('project/active', 'user.data');
    fire(find(container, (n) => n.tagName === 'textarea'), 'change', { target: { value: '{"age":-1}' } });
    app.dispatch('project/active', 'user.schema');
    assert.match(serialize(container), /Invalid/, 'bad data reports invalid with errors');
  });

  it('a contract file renders its describe() and OpenAPI projections; a broken one docks its JC code + docPath', () => {
    const { app, container } = mountSite();
    const contractText = JSON.stringify({
      $contract: '0.1', id: 'shop',
      operations: { 'catalog.load': { kind: 'read', output: true, http: { method: 'GET', path: '/api/catalog' } } },
    });
    const files = [{ name: 'shop.contract', kind: 'contract', text: contractText }];
    app.dispatch('project/files-set', { files, active: 'shop.contract' });
    app.dispatch('project/active', 'shop.contract');
    const result = app.getState().project.results['shop.contract'];
    assert.ok(result && Array.isArray(result.nodes), 'the contract projections ran and stored render nodes');
    const html = serialize(container);
    assert.match(html, /describe\(\)/, 'the describe() pane renders on the stage');
    assert.match(html, /OpenAPI 3\.1/, 'the OpenAPI pane renders on the stage');

    // break the document (no output): the rail docks the coded refusal
    const editor = find(container, (n) => n.tagName === 'textarea');
    fire(editor, 'change', { target: { value: JSON.stringify({
      $contract: '0.1',
      operations: { 'catalog.load': { kind: 'read', http: { method: 'GET', path: '/api/catalog' } } },
    }) } });
    assert.match(serialize(container), /JC00\d\d/, 'the JC code shows in the error strip');
    assert.match(serialize(container), /\/operations\/catalog\.load\/output/, 'with its docPath');
  });

  it('editing a transform re-runs it, and Run re-runs on demand', () => {
    const { app, container } = mountSite();
    app.dispatch('project/template', 'finance');
    const editor = find(container, (n) => n.tagName === 'textarea');
    fire(editor, 'change', { target: { value: '{"echo":"$.rate"}' } });
    assert.ok(app.getState().project.results['npv.query'], 'the edited query re-ran');
    app.dispatch('project/run');
    assert.ok(app.getState().project.results['npv.query'], 'Run re-ran the active transform');
  });
});

describe('the drag splitter (headless — the pointer drag itself is browser-verified)', () => {
  const splitterOf = (container) => find(container, (n) => n.__jarenWidget?.name === 'studio-splitter');

  it('renders as an ARIA separator with a live aria-valuenow', () => {
    const { container } = mountSite();
    const s = splitterOf(container);
    assert.ok(s, 'the splitter widget mounted');
    assert.strictEqual(s.getAttribute('role'), 'separator');
    assert.strictEqual(s.getAttribute('aria-valuenow'), '50', 'the committed ratio drives aria-valuenow');
  });

  it('keyboard resizes and commits: ArrowRight +5%, Shift +1%, End clamps to the max', () => {
    const { app, container } = mountSite();
    const s = splitterOf(container);
    fire(s, 'keydown', { key: 'ArrowRight' });
    assert.strictEqual(app.getState().project.layout.ratio, 0.55, 'ArrowRight is a 5% nudge');
    fire(s, 'keydown', { key: 'ArrowLeft', shiftKey: true });
    assert.ok(Math.abs(app.getState().project.layout.ratio - 0.54) < 1e-9, 'Shift is a 1% nudge');
    fire(s, 'keydown', { key: 'End' });
    assert.strictEqual(app.getState().project.layout.ratio, 0.9, 'End clamps to the max');
  });

  it('a pointer drag (down on the handle, move/up on the document) commits on pointer-up', () => {
    const { app, container, document } = mountSite();
    const s = splitterOf(container);
    fire(s, 'pointerdown', { button: 0, pointerId: 1 });   // arms the drag + arms the doc listeners
    fire(document, 'pointermove', { clientX: 20 });          // moves ride the document
    fire(document, 'pointerup', {});                         // commit
    assert.strictEqual(typeof app.getState().project.layout.ratio, 'number', 'pointer-up committed a ratio');
  });

  it('reflects an external ratio change, then unmounts cleanly on route leave', () => {
    const { app, container, go } = mountSite();
    app.dispatch('project/layout-ratio', 0.7);
    assert.strictEqual(app.getState().project.layout.ratio, 0.7);
    assert.strictEqual(splitterOf(container).getAttribute('aria-valuenow'), '70',
      'the widget reflected an external write (share / undo / AI)');
    go('#/');
    assert.strictEqual(splitterOf(container), undefined, 'leaving #/project unmounts the splitter');
  });
});

describe('file management (open a template, add / delete / rename)', () => {
  it('the template gallery renders; opening a card replaces the project', () => {
    const { app, container } = mountSite();
    assert.match(serialize(container), /js-template/, 'the gallery renders template cards');
    assert.match(serialize(container), /Query \+ data/, 'a template title shows');
    app.dispatch('project/template', 'finance');
    assert.strictEqual(app.getState().project.active, 'npv.query', 'opening the card loaded the project');
  });

  it('add-file appends a fresh file of a kind and activates it', () => {
    const { app, container } = mountSite();
    const before = app.getState().project.files.length;
    const select = find(container, (n) => n.tagName === 'select');
    fire(select, 'change', { target: { value: 'schema' } });
    const p = app.getState().project;
    assert.strictEqual(p.files.length, before + 1, 'a file was added');
    assert.strictEqual(p.active, 'schema-1.schema', 'the new file is active');
    assert.strictEqual(p.files.find((f) => f.name === 'schema-1.schema').kind, 'schema');
  });

  it('delete removes a file (never the last) and re-picks the active', () => {
    const { app } = mountSite();
    app.dispatch('project/active', 'stats.query');
    app.dispatch('project/delete', 'stats.query');
    const p = app.getState().project;
    assert.ok(!p.files.some((f) => f.name === 'stats.query'), 'the file is gone');
    assert.notStrictEqual(p.active, 'stats.query', 'the active moved off the deleted file');

    const solo = mountSite();
    solo.app.dispatch('project/open', {
      project: '0.1', name: 'solo', active: 'a.json', layout: { mode: 'classic', ratio: 0.5, autorun: true },
      files: [{ name: 'a.json', kind: 'app', text: '{"view":[{"match":"$","body":["p",{},"x"]}]}' }],
    });
    solo.app.dispatch('project/delete', 'a.json');
    assert.strictEqual(solo.app.getState().project.files.length, 1, 'the last file is never deleted');
  });

  it('rename changes the active file name and rejects a duplicate', () => {
    const { app, container } = mountSite();
    const nameField = () => find(container, (n) => n.tagName === 'input' && n.getAttribute?.('class') === 'js-editor-name');
    fire(nameField(), 'change', { target: { value: 'main.json' } });
    let p = app.getState().project;
    assert.ok(p.files.some((f) => f.name === 'main.json'), 'app.json was renamed');
    assert.strictEqual(p.active, 'main.json', 'the active follows the rename');

    // a rename onto an existing name is rejected (no silent clobber)
    app.dispatch('project/active', 'stats.query');
    fire(nameField(), 'change', { target: { value: 'main.json' } });
    p = app.getState().project;
    assert.strictEqual(p.active, 'stats.query', 'the duplicate rename was rejected');
    assert.strictEqual(p.files.filter((f) => f.name === 'main.json').length, 1, 'no duplicate name');
  });
});

describe('the editor typing buffer (a render must never eat an edit)', () => {
  it('a render mid-edit does NOT overwrite the box, and the edit still commits', () => {
    const { app, container } = mountSite();
    const box = editor(container);
    const typed = '{"state":{"title":"TYPED"},"view":[{"match":"$","body":["h1",{},"$.title"]}]}';

    // the user types (input), but has not blurred yet — the commit is
    // blur-deferred, so the FILE still holds the old text
    box.value = typed;
    fire(box, 'input', { target: { value: typed } });
    assert.notStrictEqual(app.getState().project.files[0].text, typed,
      'the file is deliberately not committed yet');

    // something else re-renders the site while the edit is in flight. The
    // renderer reasserts every controlled value on a settled pass, so this
    // is exactly the moment the typing used to be silently overwritten.
    app.dispatch('theme/toggle');
    assert.strictEqual(box.value, typed,
      'the reassert kept the user text — it did not restore the committed text');

    // and because the box was never rewritten, the blur commit lands
    fire(box, 'change', { target: { value: box.value } });
    assert.strictEqual(app.getState().project.files[0].text, typed, 'the edit committed');
    assert.strictEqual(app.getState().project.buffer, null, 'the buffer cleared on commit');
    assert.match(serialize(container), /TYPED/, 'and the stage rebooted on it');
  });

  it('an external write while the buffer is dirty raises a conflict, clobbering neither side', () => {
    const { app, container } = mountSite();
    const box = editor(container);
    const mine = '{"state":{"title":"MINE"},"view":[{"match":"$","body":["h1",{},"$.title"]}]}';
    fire(box, 'input', { target: { value: mine } });

    // an AI write lands on the SAME file (the assistant's path) while the
    // human's buffer is dirty and differs
    const theirs = '{"state":{"title":"THEIRS"},"view":[{"match":"$","body":["h2",{},"$.title"]}]}';
    const p = app.getState().project;
    app.dispatch('project/files-set', {
      files: p.files.map((f) => (f.name === p.active ? { ...f, text: theirs } : f)),
    });

    const vm = projectComponent.viewModel({ project: app.getState().project });
    assert.strictEqual(vm.editorValue, mine, 'the human keeps the box');
    assert.strictEqual(vm.conflict, theirs, 'the incoming version is offered, not discarded');
    assert.match(serialize(container), /js-conflict/, 'and the notice renders');

    // taking theirs drops the buffer, so the incoming text is what shows
    app.dispatch('project/buffer-accept');
    assert.strictEqual(
      projectComponent.viewModel({ project: app.getState().project }).editorValue, theirs);
  });

  it('a buffer for another file is ignored, and switching files drops it', () => {
    const { app } = mountSite();
    app.dispatch('project/buffer-text', null, { target: { value: 'scratch' } });
    assert.strictEqual(app.getState().project.buffer.file, 'app.json');
    app.dispatch('project/active', 'stats.query');
    assert.strictEqual(app.getState().project.buffer, null, 'the buffer left with the file');
    const vm = projectComponent.viewModel({ project: app.getState().project });
    assert.strictEqual(vm.editorValue, app.getState().project.files[1].text,
      'the newly active file shows its own committed text');
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

describe('the add-file menu and its skeletons cannot drift apart', () => {
  // Three copies of "which kinds can a user add" exist by necessity: the
  // skeleton table (the real gate — no skeleton makes `project-add` bail
  // silently), the ADDABLE_KINDS export derived from it, and the studio
  // component's own `<select>`, which lives in a published package and so
  // cannot import either. This pins the third against the first two; a
  // kind added to the menu with no skeleton would otherwise ship as a
  // menu entry that does nothing at all.
  it('every option the studio offers has a skeleton, and every skeleton is offered', function () {
    const { container } = mountSite();
    const select = find(container, (n) => n.getAttribute?.('class') === 'js-addfile');
    assert.ok(select !== undefined, 'the add-file select renders');

    const offered = (select.childNodes ?? [])
      .map((option) => option.getAttribute?.('value'))
      .filter((value) => value !== undefined && value !== '');
    assert.deepStrictEqual(offered, [...ADDABLE_KINDS],
      'the studio <select> and ADDABLE_KINDS list the same kinds, in the same order');

    for (const kind of offered) {
      assert.strictEqual(typeof fileSkeleton(kind), 'string',
        `the offered kind '${kind}' has a starter skeleton`);
    }
  });

  it('a kind with no skeleton is not offered — adding one would do nothing', function () {
    for (const kind of ['fsm', 'dag', 'model']) {
      assert.strictEqual(fileSkeleton(kind), null, `${kind} has no skeleton`);
      assert.ok(!ADDABLE_KINDS.includes(kind), `${kind} is not offered in the menu`);
    }
  });
});
