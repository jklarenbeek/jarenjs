import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProject, resolveProjectFile, assembleArtifacts, classifyChange,
  describe, projectFileContext, renameProjectFile, fileSkeleton, KINDS } from '@jarenjs/studio';
import { commitProject, createProjectStageWidget } from '../../packages/website/src/boundaries/project.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

const file = (name, kind, doc, extra = {}) => ({ name, kind, text: JSON.stringify(doc), ...extra });
const project = () => parseProject({ project: '0.1', active: 'app', files: [
  file('app', 'app', {}, { imports: { view: 'view', state: 'state', actions: 'actions' } }),
  file('view', 'jslt', [{ match: '$', body: ['h1', {}, '$.title'] }]),
  file('state', 'state', { title: 'first' }), file('actions', 'data', {}),
] });

it('assembles separate concerns, validates the result and hot-updates imported state', () => {
  const before = project();
  const resolved = resolveProjectFile(before, 'app');
  assert.deepEqual(resolved.sourceFiles, ['app', 'view', 'state', 'actions']);
  assert.equal(resolved.doc.state.title, 'first');
  assert.equal(describe(before).files[0].valid, true);
  const next = { ...before, active: 'state', files: before.files.map((f) => f.name === 'state'
    ? file('state', 'state', { title: 'second' }) : f) };
  assert.equal(classifyChange(before, next).perArtifact.app, 'state-only');
  const first = commitProject(before);
  const second = commitProject({ ...next, ...first });
  assert.equal(second.mount.doc.state.title, 'second');
  assert.equal(second.revision, first.revision);
  const broken = { ...next, files: next.files.filter((f) => f.name !== 'view') };
  assert.equal(assembleArtifacts(broken).errors.length, 1);
  assert.equal(describe(broken).files[0].errors[0].code, 'JS0003');
  assert.equal(commitProject({ ...broken, active: 'app', ...second }).mount, second.mount);
});

it('refuses collisions, cycles, invalid targets and missing inputs without modifying sources', () => {
  for (const files of [
    [file('a', 'app', { state: {} }, { imports: { state: 'b' } }), file('b', 'state', {})],
    [file('a', 'app', {}, { imports: { state: 'b' } }), file('b', 'app', {}, { imports: { state: 'a' } })],
    [file('a', 'data', {}, { imports: { state: 'b' } }), file('b', 'state', {})],
    [file('a', 'model', {}, { imports: { __invalid: 'b' } }), file('b', 'data', {})],
  ]) {
    const before = JSON.stringify(files);
    assert.throws(() => resolveProjectFile({ files }, 'a'), (e) => e.code === 'JS0003');
    assert.equal(JSON.stringify(files), before);
  }
  assert.throws(() => projectFileContext(project(), { name: 'q', input: 'missing' }), /must name/);
});

it('renames imported and routed references, including prototype-shaped file names', () => {
  const p = project();
  const files = renameProjectFile([...p.files, file('q', 'query', '$', { input: 'state', model: 'state' })], 'state', '__proto__');
  assert.equal(resolveProjectFile({ files }, 'app').doc.state.title, 'first');
  assert.equal(files.at(-1).input, '__proto__');
  assert.equal(files.at(-1).model, '__proto__');
  assert.equal(Object.getPrototypeOf(files[0].imports), Object.prototype);
});

it('every advertised kind has a valid starter document', () => {
  for (const kind of KINDS) {
    const p = { files: [{ name: kind, kind, text: fileSkeleton(kind) }] };
    assert.equal(describe(p).files[0].valid, true, kind);
  }
});

it('an unrelated invalid input does not block an app that imports its own state', () => {
  const p = project();
  const files = [{ name: 'unrelated.data', kind: 'data', text: '{' }, ...p.files];
  const commit = commitProject({ ...p, files });
  assert.equal(commit.mount.doc.state.title, 'first');
  const verdict = describe({ ...p, files });
  assert.equal(verdict.files[0].valid, false);
  assert.equal(verdict.files[1].valid, true);
});

it('an input re-sent with its members reordered is a new input, never the old mount', () => {
  // a flow reads its input through queries that can see member order (a
  // member passed through keeps its own), so the stage must not keep the
  // previous input when only the order changed
  const files = (/** @type {any} */ input) => [{ name: 'flow', kind: 'dag', text: fileSkeleton('dag'), input: 'in' },
    { name: 'in', kind: 'data', text: JSON.stringify(input) }];
  const first = commitProject({ project: '0.1', active: 'flow', files: files({ a: 1, b: 2 }) });
  assert.deepEqual(Object.keys(first.mount.input), ['a', 'b']);
  const reordered = commitProject({ project: '0.1', active: 'flow', files: files({ b: 2, a: 1 }), ...first });
  assert.notEqual(reordered.mount, first.mount);
  assert.deepEqual(Object.keys(reordered.mount.input), ['b', 'a']);
  const same = commitProject({ project: '0.1', active: 'flow', files: files({ b: 2, a: 1 }), ...reordered });
  assert.equal(same.mount, reordered.mount, 'the same order keeps the mount');
});

it('a reorder inside an app state is dispatched into the running stage', () => {
  // the view reads the state's member order (`$entries`), so a state-only
  // reorder must reach the running app rather than be skipped as unchanged
  const VIEW = [{ match: '$', body: ['p', {}, { $for: { k: { $entries: '$.items' } }, $return: '$k.key' }] }];
  const files = (/** @type {any} */ items) => [{ name: 'app', kind: 'app', text: JSON.stringify({ state: { items }, view: VIEW, actions: {} }) }];
  const first = commitProject({ project: '0.1', active: 'app', files: files({ a: 1, b: 2 }) });
  const second = commitProject({ project: '0.1', active: 'app', files: files({ b: 2, a: 1 }), ...first });
  assert.equal(second.mount.revision, first.mount.revision, 'a state-only edit keeps the revision');
  const { container } = createStubHost();
  const shown = () => serialize(container).replace(/<[^>]+>/g, '').trim();
  const widget = createProjectStageWidget({ schedule: (/** @type {() => void} */ flush) => flush() });
  const handle = widget.mount(container, first.mount, () => {});
  const running = handle.app;
  assert.equal(shown(), 'ab');
  widget.update(handle, second.mount, first.mount);
  assert.equal(handle.app, running, 'hot: the running app stays');
  assert.equal(shown(), 'ba');
  widget.unmount(handle);
});
