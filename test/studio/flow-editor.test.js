import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { mountFlowEditor, FLOW_ACTIONS, createFlowState, createFlowRuntime, createFlowController } from '@jarenjs/studio/flow';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';
const fsm = { $fsm: '0.1', initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b' }] };
const dag = { $dag: '0.1', nodes: { input: { kind: 'input' }, task: { kind: 'task', run: 'double' }, out: { kind: 'output' } }, edges: [{ from: 'input', to: 'task' }, { from: 'task', to: 'out' }] };
function find(node, predicate) { return predicate(node) ? node : [...(node.childNodes ?? [])].map(n => find(n, predicate)).find(Boolean); }
function click(container, label) { const button = find(container, n => n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === label); assert.ok(button, label); fire(button, 'click'); }
function fixture(t, options = {}) {
  const { container } = createStubHost();
  const editor = mountFlowEditor(container, { kind: 'fsm', document: fsm, schedule: f => f(), onError: e => { throw e; }, ...options });
  t.after(editor.dispose); return { container, editor };
}
it('mounts independent Flow editors and sends manual and external edits through the same history', async t => {
  const a = fixture(t), b = fixture(t), notices = []; a.editor.subscribe(value => notices.push(value));
  const original = a.editor.read(); original.document.states.push('outside');
  assert.equal(a.editor.read().document.states.length, 2); assert.equal('app' in a.editor, false);
  click(a.container, 'Add state'); assert.equal(a.editor.read().document.states.length, 3);
  assert.equal(b.editor.read().document.states.length, 2);
  assert.equal((await a.editor.replace(fsm, { expectedRevision: original.revision })).conflict, true);
  const candidate = { ...fsm, states: ['a', 'b', 'external'] };
  const accepted = await a.editor.replace(candidate, { expectedRevision: a.editor.read().revision });
  assert.equal(accepted.ok, true); assert.match(serialize(a.container), /external/);
  candidate.states.push('outside'); assert.equal(a.editor.read().document.states.length, 3);
  click(a.container, 'Undo'); assert.equal(a.editor.read().document.states.at(-1), 's3');
  click(a.container, 'Redo'); assert.equal(a.editor.read().document.states.at(-1), 'external');
  assert.equal(notices.length, 4);
});
it('invalid replacements preserve the selection, history, projections and running result', async t => {
  const { container, editor } = fixture(t);
  fire(find(container, n => n.getAttribute?.('data-id') === 'a'), 'click');
  await editor.run(); const before = editor.read(), html = serialize(container);
  const result = await editor.replace({ ...fsm, initial: 'missing' }, { expectedRevision: before.revision });
  assert.equal(result.ok, false); assert.deepEqual(editor.read(), before); assert.equal(serialize(container), html);
  const sent = await editor.run({ event: 'go' }); assert.equal(sent.ok, true);
  assert.equal(editor.read().result.current, 'b');
});
it('validates and applies JSON patches against an expected revision', async t => {
  const { editor } = fixture(t); const before = editor.read();
  const result = await editor.apply([{ op: 'add', path: '/states/-', value: 'c' }], { expectedRevision: before.revision });
  assert.equal(result.ok, true); assert.equal(editor.read().document.states.at(-1), 'c');
  assert.equal((await editor.apply([{ op: 'remove', path: '/absent' }], { expectedRevision: result.revision })).ok, false);
});
it('rejects a candidate when an earlier queued manual edit changes its revision', async t => {
  let app, pending;
  const runtime = createFlowRuntime({ getFlow: () => app.getState().flow });
  const controller = createFlowController({ getApp: () => app, runtime });
  app = createApp({ state: { flow: createFlowState({ kind: 'fsm', document: fsm }) }, actions: FLOW_ACTIONS, view: [] }, { schedule: f => f(), effects: { ...runtime.effects, ...controller.effects } });
  controller.attach(); t.after(() => { controller.dispose(); app.destroy(); });
  const before = controller.read();
  app.subscribe((_state, changes) => {
    if (!changes?.includes('/flow/mobilePane')) return;
    app.dispatch('flow/state-minted', 'manual'); pending = controller.replace(fsm, { expectedRevision: before.revision });
  });
  app.dispatch('flow/pane', 'inspector');
  assert.equal((await pending).conflict, true); assert.equal(controller.read().document.states.at(-1), 'manual');
});
it('runs the actual DAG with injected tasks and explicit input, reporting success and failure', async t => {
  const { editor } = fixture(t, { kind: 'dag', document: dag, tasks: { double: async ({ input }) => input * 2 } });
  const result = await editor.run({ input: 7 }); assert.equal(result.ok, true); assert.equal(result.output, 14);
  assert.equal(editor.read().result.output, 14);
  const missing = fixture(t, { kind: 'dag', document: dag });
  const failed = await missing.editor.run({ input: 7 }); assert.equal(failed.ok, false); assert.match(failed.error, /double/);
});
it('checks complete DAG publications with the shared compiler before changing the live editor', async t => {
  const { editor } = fixture(t, { kind: 'dag', document: dag, tasks: { double: async ({ input }) => input * 2 } });
  await editor.run({ input: 4 });
  const before = editor.read(), cyclic = structuredClone(dag);
  cyclic.edges.push({ from: 'task', to: 'task' });
  const checked = editor.validate(cyclic);
  assert.equal(checked.valid, false); assert.match(checked.errors[0].code, /^JF/);
  assert.equal((await editor.replace(cyclic, { expectedRevision: before.revision })).ok, false);
  assert.deepEqual(editor.read(), before);
});
it('disposes repeatedly, aborts pending tasks, refuses publication and releases subscriptions', async t => {
  let started, aborted = false; const ready = new Promise(resolve => { started = resolve; });
  const { editor, container } = fixture(t, { kind: 'dag', document: dag, tasks: {
    double: async (_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); started(); }),
  } });
  const pending = editor.run({ input: 1 }); await ready; editor.dispose(); editor.dispose();
  assert.equal((await pending).ok, false); assert.equal(aborted, true); assert.equal(container.childNodes.length, 0);
  assert.equal((await editor.replace(dag, { expectedRevision: editor.read().revision })).ok, false);
  assert.equal((await editor.run()).ok, false);
});
