import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { exportProject, createProjectZip } from '@jarenjs/studio/export';
import { fileSkeleton, writeProjectArtifact, resolveProjectFile } from '@jarenjs/studio';
import { createProjectFlowWidget } from '@jarenjs/studio/flow';
import { commitProject } from '../../packages/website/src/boundaries/project.js';
import { createStubHost } from '../view/dom.stub.js';



it('writes imported artifacts atomically while retaining untouched source identities', () => {
  const project = { files: [
    { name: 'app', kind: 'app', text: '{}', imports: { view: 'view', state: 'state' } },
    { name: 'view', kind: 'jslt', text: '[{"match":"$","body":["p",{},"$.n"]}]' },
    { name: 'state', kind: 'state', text: '{"n":1}' },
  ] };
  const doc = resolveProjectFile(project, 'app').doc;
  doc.state.n = 2;
  const files = writeProjectArtifact(project, 'app', doc);
  assert.equal(files[0], project.files[0]);
  assert.equal(files[1], project.files[1]);
  assert.deepEqual(JSON.parse(files[2].text), { n: 2 });
  assert.equal(project.files[2].text, '{"n":1}');
});

it('writes a member-order edit, and refuses import sites that differ only in member order', () => {
  // a query's `$for` bindings nest in key order: the reorder IS the edit
  const MB = { $for: { m: '$.a[*]', b: '$.b[*]' }, $return: '$b' };
  const BM = { $for: { b: '$.b[*]', m: '$.a[*]' }, $return: '$b' };
  const project = { files: [{ name: 'q', kind: 'query', text: JSON.stringify(MB) }] };
  const [written] = writeProjectArtifact(project, 'q', BM);
  assert.deepEqual(Object.keys(JSON.parse(written.text).$for), ['b', 'm']);
  // the same order is no edit: the file keeps its identity and text
  assert.equal(writeProjectArtifact(project, 'q', structuredClone(MB))[0], project.files[0]);
  // two import sites of one source disagree when only their member order does
  const shared = { files: [
    { name: 'model', kind: 'model', text: '{}', imports: { collections: 'shared', entities: 'shared' } },
    { name: 'shared', kind: 'data', text: '{"a":1,"b":2}' },
  ] };
  assert.throws(() => writeProjectArtifact(shared, 'model', { collections: { a: 1, b: 2 }, entities: { b: 2, a: 1 } }),
    { code: 'JS0003', message: /conflicting values for shared source 'shared'/ });
});

it('a flow edit rewrites only the files whose content changed, whatever top-level order the editor rebuilds', () => {
  // the editor's delete rebuilds the document in its own top-level order;
  // an fsm's top-level members are slots the project assembles itself, so
  // the untouched local file keeps its identity and text
  const project = { project: '0.1', active: 'm', files: [
    { name: 'm', kind: 'fsm', text: JSON.stringify({ initial: 'idle', $fsm: '0.1' }), imports: { states: 's', transitions: 't' }, input: 'seed' },
    { name: 's', kind: 'data', text: JSON.stringify(['idle', 'done', 'gone']) },
    { name: 't', kind: 'data', text: JSON.stringify([{ from: 'idle', event: 'go', to: 'done' }]) },
    { name: 'seed', kind: 'data', text: '{}' },
  ] };
  const first = commitProject(project);
  const { container } = createStubHost();
  const widget = createProjectFlowWidget({ schedule: (/** @type {() => void} */ flush) => flush() });
  /** @type {any[]} */
  const edits = [];
  const handle = widget.mount(container, first.mount, (/** @type {any} */ binding) => edits.push(binding));
  const editor = handle.app;
  editor.dispatch('flow/pick', { type: 'state', id: 'gone' });
  editor.dispatch('flow/delete');
  const edit = edits.filter((e) => e.action === 'project/artifact-edit').at(-1);
  assert.deepEqual(Object.keys(edit.with.doc), ['$fsm', 'initial', 'states', 'transitions'], 'the editor rebuilt the top level');
  const files = writeProjectArtifact(project, 'm', edit.with.doc);
  assert.equal(files[0], project.files[0], 'the local file is unchanged');
  assert.deepEqual(JSON.parse(files[1].text), ['idle', 'done']);
  assert.equal(files[2], project.files[2]);
  // and the project's echo of the edit keeps the editor
  widget.update(handle, commitProject({ ...project, files, ...first }).mount, first.mount);
  assert.equal(handle.app, editor);
  widget.unmount(handle);
  // plain round trips stay kept, with and without imports
  const plain = { files: [{ name: 'app', kind: 'app', text: JSON.stringify({ state: { n: 1 }, actions: {}, view: [] }) }] };
  assert.equal(writeProjectArtifact(plain, 'app', resolveProjectFile(plain, 'app').doc)[0], plain.files[0]);
  const imported = { files: [{ name: 'app', kind: 'app', text: JSON.stringify({ actions: {}, state: { n: 1 } }), imports: { view: 'v' } },
    { name: 'v', kind: 'jslt', text: JSON.stringify([{ match: '$', body: ['p', { b: 1, a: 2 }] }]) }] };
  const back = writeProjectArtifact(imported, 'app', resolveProjectFile(imported, 'app').doc);
  assert.deepEqual(back.map((file, i) => file === imported.files[i]), [true, true]);
});

it('exports a valid deterministic ZIP with local dependencies and verbatim arbitrary-named files', () => {
  const project = { project: '0.1', files: [
    { name: '../🪶.json', kind: 'app', text: fileSkeleton('app') },
  ], active: '../🪶.json', layout: { mode: 'top', ratio: .3, autorun: false } };
  const assets = { 'runtime.js': 'export const version = 1;', 'runtime.css': 'body{color:black}' };
  const first = exportProject(project, assets);
  assert.deepEqual(first, exportProject(project, assets));
  const directory = mkdtempSync(join(tmpdir(), 'jaren-eject-'));
  try {
    const path = join(directory, 'project.zip'); writeFileSync(path, first);
    const inspected = JSON.parse(execFileSync('python3', ['-c',
      'import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"names":z.namelist(),"project":json.loads(z.read("project.json")),"source":z.read("files/0001.json").decode()}))', path], { encoding: 'utf8' }));
    assert.equal(inspected.source, project.files[0].text);
    assert.deepEqual(inspected.project.files, project.files);
    assert.deepEqual(inspected.project.layout, project.layout);
    assert.ok(inspected.names.includes('runtime/runtime.js'));
    assert.ok(inspected.names.every((name) => !name.includes('..')));
  }
  finally { rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => createProjectZip({ '../escape': '' }), /unsafe archive path/);
  assert.throws(() => exportProject(project, {}), /runtime.js/);
});
