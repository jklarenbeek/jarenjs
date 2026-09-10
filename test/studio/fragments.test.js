import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProject, resolveProjectFile, assembleArtifacts, classifyChange,
  describe, projectFileContext, renameProjectFile, fileSkeleton, KINDS } from '@jarenjs/studio';
import { commitProject } from '../../packages/website/src/boundaries/project.js';

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
