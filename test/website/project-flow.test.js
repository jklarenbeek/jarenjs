import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectFlowWidget } from '../../packages/website/src/boundaries/project-flow.js';
import { commitProject } from '../../packages/website/src/boundaries/project.js';
import { fileSkeleton, writeProjectArtifact } from '@jarenjs/studio';
import { createStubHost, serialize } from '../view/dom.stub.js';

it('the private editor writes its file, keeps undo on echo and disposes on replacement', () => {
  const { container } = createStubHost();
  const widget = createProjectFlowWidget({ schedule: (flush) => flush() });
  const edits = [];
  const props = { name: 'machine.fsm', kind: 'fsm', doc: JSON.parse(fileSkeleton('fsm')), revision: 1 };
  const handle = widget.mount(container, props, (binding) => edits.push(binding));
  const first = handle.app;
  first.dispatch('flow/add-state');
  const edit = edits.find((e) => e.action === 'project/artifact-edit');
  assert.equal(edit.with.name, props.name);
  assert.equal(edit.with.doc.states.length, 3);
  widget.update(handle, { ...props, doc: edit.with.doc, revision: 2 });
  assert.equal(handle.app, first);
  assert.ok(first.getState().flow.history.past.length > 0);
  first.dispatch('flow/clear');
  assert.deepEqual(first.getState().flow.doc, props.doc);
  assert.deepEqual(first.getState().flow.history.past, []);
  first.dispatch('unknown-editor-action');
  assert.equal(edits.at(-1).action, 'project/stage-error');
  assert.match(edits.at(-1).with, /unknown-editor-action/);
  widget.update(handle, { ...props, doc: edit.with.doc, input: { changed: true }, revision: 3 });
  assert.notEqual(handle.app, first);
  assert.match(serialize(container), /idle/);
  widget.unmount(handle);
  assert.equal(container.childNodes.length, 0);
});

it('an input re-sent with its members reordered reaches the editor', () => {
  // a flow reads its input through queries that can see member order, so
  // the editor must run on the new order, not keep the old one
  const files = (/** @type {any} */ input) => [{ name: 'flow', kind: 'dag', text: fileSkeleton('dag'), input: 'in' },
    { name: 'in', kind: 'data', text: JSON.stringify(input) }];
  const first = commitProject({ project: '0.1', active: 'flow', files: files({ a: 1, b: 2 }) });
  const second = commitProject({ project: '0.1', active: 'flow', files: files({ b: 2, a: 1 }), ...first });
  const { container } = createStubHost();
  const widget = createProjectFlowWidget({ schedule: (flush) => flush() });
  const handle = widget.mount(container, first.mount, () => {});
  const before = handle.app;
  widget.update(handle, second.mount, first.mount);
  const flow = handle.app.getState().flow;
  assert.notEqual(handle.app, before, 'a new input is a new editor');
  assert.equal(flow.dagInput, '{"b":2,"a":1}');
  assert.deepEqual(Object.keys(flow.runContext), ['b', 'a']);
  widget.unmount(handle);
});

it('a reorder-only edit inside a query node is written, and its echo keeps the editor', () => {
  // a query node embeds a query document: its `$for` bindings nest in key
  // order, so two orders run differently and the reorder is an edit
  const dag = (/** @type {any} */ bindings) => ({ $dag: '0.1', nodes: { input: { kind: 'input' },
    q: { kind: 'query', query: { $for: bindings, $return: { x: '$x', y: '$y' } } }, output: { kind: 'output' } },
  edges: [{ from: 'input', to: 'q' }, { from: 'q', to: 'output' }], output: 'output' });
  const project = { project: '0.1', active: 'flow', files: [{ name: 'flow', kind: 'dag', text: JSON.stringify(dag({ x: '$.xs[*]', y: '$.ys[*]' })) }] };
  const first = commitProject(project);
  const { container } = createStubHost();
  const widget = createProjectFlowWidget({ schedule: (flush) => flush() });
  /** @type {any[]} */
  const edits = [];
  const handle = widget.mount(container, first.mount, (/** @type {any} */ binding) => edits.push(binding));
  const editor = handle.app;
  editor.dispatch('flow/parsed', { doc: dag({ y: '$.ys[*]', x: '$.xs[*]' }) });
  const written = edits.filter((e) => e.action === 'project/artifact-edit');
  assert.equal(written.length, 1, 'the reorder is published');
  const files = writeProjectArtifact(project, 'flow', written[0].with.doc);
  assert.deepEqual(Object.keys(JSON.parse(files[0].text).nodes.q.query.$for), ['y', 'x'], 'and lands in the file');
  const second = commitProject({ ...project, files, ...first });
  widget.update(handle, second.mount, first.mount);
  assert.equal(handle.app, editor, 'the echo of its own edit keeps the editor, its selection and undo');
  widget.unmount(handle);
});

it('a reorder inside an fsm guard is published like one inside a query node', () => {
  // a guard is a query expression: its `$let` binds in key order
  const fsm = (/** @type {any} */ bindings) => ({ $fsm: '0.1', initial: 'a', states: ['a', 'b'],
    transitions: [{ from: 'a', event: 'go', guard: { $let: bindings, $return: { $gt: ['$x', '$y'] } }, to: 'b' }] });
  const { container } = createStubHost();
  const widget = createProjectFlowWidget({ schedule: (flush) => flush() });
  /** @type {any[]} */
  const edits = [];
  const handle = widget.mount(container, { name: 'm', kind: 'fsm', doc: fsm({ x: '$.x', y: '$.y' }), revision: 1 },
    (/** @type {any} */ binding) => edits.push(binding));
  handle.app.dispatch('flow/parsed', { doc: fsm({ y: '$.y', x: '$.x' }) });
  assert.equal(edits.filter((e) => e.action === 'project/artifact-edit').length, 1);
  widget.unmount(handle);
});
