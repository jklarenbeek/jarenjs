//@ts-check
/**
 * @file The Studio COMPONENT (the IDE), headless: the view-model
 * derivation (rail / editor / error strip / stage), the JSLT shell
 * rendering a real vnode over that model, and the two hard-problem
 * policies (reboot-vs-hot-update, buffer reconciliation). The live DOM
 * stage/splitter widgets and the site mount are the next patch, browser-
 * verified; everything renderable without a DOM is proven here.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createStudioComponent, projectViewModel, projectRules, projectModes,
  hostPolicy, reconcileBuffer, editorTextarea, errorLine, KIND_BADGE,
} from '@jarenjs/studio/component';
import { compileJsltStylesheet, createJsltRegistry } from '@jarenjs/json/jslt';

const APP = JSON.stringify({ state: { n: 1 }, view: [{ match: '$', body: ['p', {}, 'n=', '$.n'] }] });
const state = (over = {}) => ({
  project: {
    project: '0.1',
    files: [
      { name: 'app.json', kind: 'app', text: APP },
      { name: 'stats.query', kind: 'query', text: '{"m":{"$mean":"$.r[*]"}}' },
      { name: 'bad.query', kind: 'query', text: '{"x":{"$flter":"$"}}' },
      { name: 'seed.data', kind: 'data', text: '{"r":[1,2,3]}' },
    ],
    active: 'app.json', layout: { mode: 'classic', ratio: 0.5, autorun: true },
    results: {}, revision: 1, ...over,
  },
});

/** Render the studio shell over a view model (headless — no DOM). The
 * host mounts it at `$.ui.project`; the shell rule matches that path. */
function renderIDE(vm) {
  const sheet = {
    $jslt: '0.1',
    modes: projectModes,
    rules: [{ match: '$', body: { $apply: ['$.ui.project', 'project'] } }, ...projectRules],
  };
  return compileJsltStylesheet(sheet)({ ui: { project: vm } });
}

describe('projectViewModel', () => {
  it('derives the rail with kind badges, the active editor, the error strip and an app stage', () => {
    const vm = projectViewModel(state());
    assert.strictEqual(vm.rail.length, 4);
    assert.deepStrictEqual(vm.rail.map((r) => r.badge), ['view', 'query', 'query', 'json']);
    assert.strictEqual(vm.rail.find((r) => r.name === 'bad.query').valid, false);
    assert.strictEqual(vm.active, 'app.json');
    assert.match(vm.editorValue, /"view"/);
    assert.strictEqual(vm.stage.kind, 'app');
    assert.ok(vm.stage.mount.doc.view, 'the assembled app document is on the mount');
    assert.strictEqual(vm.stage.mount.revision, 1);
    assert.ok(vm.problemCount >= 1);
    assert.strictEqual(vm.problems.find((p) => p.file === 'bad.query').code, 'JQ0002');
  });

  it('the stage follows the active kind: query→result, data→inert, app→mount', () => {
    assert.strictEqual(projectViewModel(state({ active: 'stats.query' })).stage.kind, 'result');
    assert.strictEqual(projectViewModel(state({ active: 'seed.data' })).stage.kind, 'inert');
    // an invalid active app cannot boot — the stage says so, never a blank mount
    const brokenApp = state({ files: [{ name: 'app.json', kind: 'app', text: '{"nope":1}' }], active: 'app.json' });
    assert.strictEqual(projectViewModel(brokenApp).stage.kind, 'boot-failed');
  });

  it('an empty project shows an add-a-file stage, never a void', () => {
    assert.strictEqual(projectViewModel({ project: { files: [] } }).stage.kind, 'empty');
  });
});

describe('the JSLT shell renders headlessly', () => {
  it('produces a vnode with the rail rows, the editor and the coded error strip', () => {
    const out = JSON.stringify(renderIDE(projectViewModel(state())));
    assert.match(out, /jstudio/);
    assert.match(out, /js-editor-input/);
    assert.match(out, /"data-badge":"view"/); // the app file's blue badge
    assert.match(out, /stats\.query/);        // a rail row
    assert.match(out, /JQ0002/);              // the bad file's coded error in the strip
    assert.match(out, /studio-stage/);        // the app stage widget mount point
    assert.match(out, /project\/layout-mode/); // the layout switcher dispatches the mode
    assert.match(out, /Stack/);               // the third layout segment
    assert.match(out, /studio-splitter/);     // the drag splitter widget mount point
    assert.match(out, /separator/);           // rendered as an ARIA separator
    assert.match(out, /js-addfile/);          // the add-file control
    assert.match(out, /js-editor-name/);      // the editable file name
    assert.match(out, /js-file-del/);         // the per-row delete affordance
  });
});

describe('the two hard-problem policies', () => {
  it('hostPolicy: a state-only edit → hot, a view edit → reboot', () => {
    const p = createStudioComponent();
    const base = p.parseProject({ project: '0.1', files: [{ name: 'a.json', kind: 'app', text: APP }] });
    const stateEdit = p.parseProject({ project: '0.1', files: [{ name: 'a.json', kind: 'app', text: JSON.stringify({ state: { n: 9 }, view: [{ match: '$', body: ['p', {}, 'n=', '$.n'] }] }) }] });
    const viewEdit = p.parseProject({ project: '0.1', files: [{ name: 'a.json', kind: 'app', text: JSON.stringify({ state: { n: 1 }, view: [{ match: '$', body: ['h1', {}, '$.n'] }] }) }] });
    assert.strictEqual(hostPolicy(base, stateEdit)['a.json'], 'hot');
    assert.strictEqual(hostPolicy(base, viewEdit)['a.json'], 'reboot');
    assert.strictEqual(hostPolicy(base, base)['a.json'], 'skip');
  });

  it('reconcileBuffer: clean adopts; dirty+different conflicts; dirty+same clears', () => {
    assert.deepStrictEqual(reconcileBuffer({ text: 'old', dirty: false }, 'new'),
      { text: 'new', dirty: false, conflict: null });
    assert.deepStrictEqual(reconcileBuffer({ text: 'mine', dirty: true }, 'theirs'),
      { text: 'mine', dirty: true, conflict: { incoming: 'theirs' } });
    assert.deepStrictEqual(reconcileBuffer({ text: 'same', dirty: true }, 'same'),
      { text: 'same', dirty: false, conflict: null });
  });
});

describe('the component surface + primitives', () => {
  it('createStudioComponent composes the view, derivation and engine surface', () => {
    const c = createStudioComponent();
    assert.strictEqual(c.mode, 'project');
    assert.ok(Array.isArray(c.rules));
    assert.strictEqual(c.viewModel(state()).active, 'app.json');
    assert.strictEqual(c.validateFile({ kind: 'query', text: '{"a":"$.x"}' }).valid, true);
    assert.strictEqual(c.describe(c.parseProject({ project: '0.1', files: [{ name: 'a.query', kind: 'query', text: '{"a":"$.x"}' }] })).files.length, 1);
  });
  it('threads a host operator registry (no packs → $npv unknown)', () => {
    const c = createStudioComponent({ operators: createJsltRegistry() });
    const vm = c.viewModel(state({ files: [{ name: 'n.query', kind: 'query', text: '{"v":{"$npv":["$.r","$.c[*]"]}}' }], active: 'n.query' }));
    assert.ok(vm.problemCount >= 1, 'without the finance pack $npv is an error');
  });
  it('the editor primitives build the expected vnodes', () => {
    const ta = editorTextarea({ value: '$.x', action: 'a' });
    assert.strictEqual(ta[0], 'textarea');
    assert.strictEqual(ta[1].on.change, 'a');
    assert.strictEqual(errorLine('hi')[0], 'p');
    assert.strictEqual(KIND_BADGE.app, 'view');
    assert.strictEqual(KIND_BADGE.model, 'model');
  });
});
