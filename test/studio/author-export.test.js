import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { exportProject, createProjectZip } from '@jarenjs/studio/export';
import { fileSkeleton, writeProjectArtifact, resolveProjectFile } from '@jarenjs/studio';



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
