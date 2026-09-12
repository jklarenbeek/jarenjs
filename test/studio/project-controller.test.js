import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { createProjectHost, createProjectController, createProjectState, PROJECT_ACTIONS } from '@jarenjs/studio/component';
const document = { project: '0.1', name: 'Example', files: [{ name: 'data', kind: 'data', text: '{"value":1}' }], active: 'data', layout: { mode: 'classic', ratio: 0.5, autorun: false } };
function fixture(t, projectData) {
  let app;
  const host = createProjectHost({ loadDocument: () => ({ ok: false }), runQuery: () => [], runJslt: () => [], runValidation: () => ({ valid: true }) });
  const controller = createProjectController({ getApp: () => app, host, projectData, debounceMs: 0 });
  app = createApp({ state: { project: createProjectState(structuredClone(document)) }, view: [{ match: '$', body: ['div'] }], actions: PROJECT_ACTIONS }, { effects: controller.effects, schedule: f => f() });
  controller.attach(); t.after(() => { controller.dispose(); app.destroy(); });
  return { app, controller };
}
it('uses the same file validation and actions for accepted replacements, with isolated snapshots and subscriptions', async t => {
  const { app, controller } = fixture(t), changes = [];
  const stop = controller.subscribe(value => changes.push(value));
  const initial = controller.read(); initial.document.files[0].text = '{"outside":true}';
  assert.equal(app.getState().project.files[0].text, '{"value":1}');
  const candidate = structuredClone(document); candidate.files[0].text = '{"value":2}';
  const result = await controller.replace(candidate, { expectedRevision: initial.revision });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(app.getState().project.files[0].text, candidate.files[0].text);
  assert.notEqual(result.revision, initial.revision); assert.equal(changes.length, 1);
  candidate.files[0].text = 'changed afterward'; assert.equal(controller.read().document.files[0].text, '{"value":2}');
  stop();
  const patched = await controller.apply([{ op: 'replace', path: '/files/0/text', value: '{"value":3}' }], { expectedRevision: result.revision });
  assert.equal(patched.ok, true); assert.equal(changes.length, 1);
});
it('refuses invalid candidates and stale revisions without changing the document or dirty typing buffer', async t => {
  const { app, controller } = fixture(t), initial = controller.read();
  const invalid = structuredClone(document); invalid.files[0].text = '{bad';
  assert.equal((await controller.replace(invalid, { expectedRevision: initial.revision })).ok, false);
  assert.deepEqual(controller.read(), initial);
  app.dispatch('project/files-set', { files: [{ ...document.files[0], text: '{"manual":true}' }] });
  const stale = await controller.replace(document, { expectedRevision: initial.revision });
  assert.equal(stale.conflict, true); assert.equal(controller.read().document.files[0].text, '{"manual":true}');
  app.dispatch('project/buffer-text', null, { value: '{"draft":true}' });
  const before = app.getState().project.buffer;
  const accepted = await controller.replace(document, { expectedRevision: controller.read().revision });
  assert.equal(accepted.ok, true); assert.deepEqual(app.getState().project.buffer, before);
});
it('checks revision inside the queued transition when a manual edit is already waiting', async t => {
  const { app, controller } = fixture(t); let pending;
  const initial = controller.read();
  const detach = app.subscribe((_state, changes) => {
    if (!changes?.includes('/project/mobilePane')) return;
    app.dispatch('project/files-set', { files: [{ ...document.files[0], text: '{"queued":true}' }] });
    pending = controller.replace(document, { expectedRevision: initial.revision });
  });
  app.dispatch('project/pane', 'stage');
  assert.equal((await pending).conflict, true); assert.equal(controller.read().document.files[0].text, '{"queued":true}');
  detach();
});
it('disposal is idempotent, refuses writes and releases subscriptions', async t => {
  const { app, controller } = fixture(t); let notices = 0;
  controller.subscribe(() => notices++); controller.dispose(); controller.dispose();
  assert.equal((await controller.replace(document, { expectedRevision: controller.read().revision })).ok, false);
  app.dispatch('project/files-set', { files: [{ ...document.files[0], text: '{"after":true}' }] });
  assert.equal(notices, 0); assert.match(controller.run().error, /disposed/);
});

it('mounts the shared editor independently and keeps two instances and caller seed data isolated', async t => {
  const { mountStudioEditor } = await import('@jarenjs/studio/component');
  const { createStubHost, fire } = await import('../view/dom.stub.js');
  const host = createProjectHost({ loadDocument: () => ({ ok: false }), runQuery: () => [], runJslt: () => [], runValidation: () => ({ valid: true }) });
  const one = createStubHost(), two = createStubHost(), seed = structuredClone(document);
  const a = mountStudioEditor(one.container, { project: seed, host, schedule: f => f(), debounceMs: 0 });
  const b = mountStudioEditor(two.container, { project: seed, host, schedule: f => f(), debounceMs: 0 });
  t.after(() => { a.dispose(); b.dispose(); });
  assert.equal('app' in a, false); seed.files[0].text = 'outside';
  const find = node => node.tagName?.toLowerCase() === 'textarea' ? node : [...(node.childNodes ?? [])].map(find).find(Boolean);
  const textarea = find(one.container); assert.ok(textarea);
  fire(textarea, 'change', { target: { value: '{"manual":2}' } });
  assert.equal(a.read().document.files[0].text, '{"manual":2}');
  assert.equal(b.read().document.files[0].text, '{"value":1}');
  a.dispose(); a.dispose(); assert.equal(one.container.childNodes.length, 0);
});

it('the public Run uses the manual stage transition and publishes transform results', async t => {
  const { app, controller } = fixture(t);
  const query = { name: 'q', kind: 'query', text: '"answer"' };
  app.dispatch('project/files-set', { files: [...document.files, query] });
  const result = await controller.run('q');
  assert.equal(result.ok, true); assert.equal(app.getState().project.active, 'q');
  assert.equal(app.getState().project.mobilePane, 'stage');
  assert.deepEqual(result.result, { nodes: [] });
  assert.match(controller.run('absent').error, /Unknown project file/);
});

it('settles model host results once, refuses stale output, and releases pending runs on disposal', async t => {
  let resolveRun, calls = 0;
  const { app, controller } = fixture(t, { sync() {}, dispose() {}, execute: () => {
    calls++; return new Promise(resolve => { resolveRun = resolve; });
  } });
  const model = { name: 'm', kind: 'model', text: '{"$model":"0.1","collections":{"rows":{"schema":{"type":"object"},"key":"/id"}}}' };
  app.dispatch('project/files-set', { files: [model] });
  const first = controller.run('m'); resolveRun({ result: [1], plan: { sql: 'SELECT 1' } });
  const result = await first; assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.deepEqual(app.getState().project.results.m, result.result);
  assert.match(JSON.stringify(result.result), /SELECT 1/);
  const stale = controller.run('m');
  app.dispatch('project/files-set', { files: [{ ...model, text: model.text + ' ' }] });
  const before = structuredClone(app.getState().project.results);
  resolveRun({ result: [2], plan: {} }); assert.equal((await stale).stale, true);
  assert.deepEqual(app.getState().project.results, before);
  const pending = controller.run('m'); controller.dispose();
  assert.equal((await pending).ok, false); resolveRun({ result: [3], plan: {} });
  await Promise.resolve(); assert.deepEqual(app.getState().project.results, before);
});

it('explicit app commits preserve the stage revision for state edits and restart only when requested', async t => {
  const { controller } = fixture(t);
  const doc = { state: { value: 1 }, view: [{ match: '$', body: ['p', {}, '$.value'] }] };
  const project = { ...document, files: [{ name: 'app', kind: 'app', text: JSON.stringify(doc) }], active: 'app' };
  assert.equal((await controller.replace(project, { expectedRevision: controller.read().revision })).ok, true);
  assert.equal((await controller.run('app', { restart: false })).ok, true);
  const initial = controller.read(); assert.equal(typeof initial.stageRevision, 'number');
  doc.state.value = 2;
  project.files[0].text = JSON.stringify(doc);
  await controller.replace(project, { expectedRevision: initial.revision });
  await controller.run('app', { restart: false });
  assert.notEqual(controller.read().revision, initial.revision);
  assert.equal(controller.read().stageRevision, initial.stageRevision);
  doc.view[0].body.push('changed view'); project.files[0].text = JSON.stringify(doc);
  await controller.replace(project, { expectedRevision: controller.read().revision });
  await controller.run('app', { restart: false });
  assert.equal(controller.read().stageRevision, initial.stageRevision + 1);
  await controller.run('app');
  assert.equal(controller.read().stageRevision, initial.stageRevision + 2);
});
