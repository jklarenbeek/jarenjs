import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStudioFileAuthor } from '@jarenjs/studio/author';
import { exportProject, createProjectZip } from '@jarenjs/studio/export';
import { fileSkeleton, writeProjectArtifact, resolveProjectFile } from '@jarenjs/studio';

it('authors one model grammar and repairs a semantic compiler refusal before accepting', async () => {
  const requests = [];
  const good = JSON.parse(fileSkeleton('model'));
  const bad = structuredClone(good);
  bad.collections.notes.key = '/';
  bad.collections.notes.indexes = [{ name: 'broken', path: '$[*]' }];
  const replies = [bad, good];
  const client = { endpoint: { provider: 'openrouter' }, complete: async (request) => {
    requests.push(request); return { message: { content: JSON.stringify(replies.shift()) } };
  } };
  const result = await createStudioFileAuthor({ client }).author({ project: { files: [] },
    name: 'notes.model', kind: 'model', prompt: 'Create a notes model.' });
  assert.equal(result.attempts, 2);
  assert.deepEqual(JSON.parse(result.file.text), good);
  assert.match(requests[0].responseFormat.schema.$id, /jaren-model/);
  assert.doesNotMatch(JSON.stringify(requests[0].responseFormat.schema), /jaren-project/);
  assert.match(JSON.stringify(requests[1].messages), /JD0004/);
});

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
