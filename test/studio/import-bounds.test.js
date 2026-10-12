//@ts-check
/**
 * Resolving a file's imports reads each imported file once per import, so
 * a chain of files that each import the next one under two members read
 * the last file 2^n times: thirty tiny files, a project small enough for a
 * share link, kept the page busy for minutes. The reads of one resolution
 * are bounded, and past the bound the file is refused like a cycle is.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { assembleArtifacts, parseProject, resolveProjectFile } from '@jarenjs/studio';

/** @param {number} count files in a chain, each importing the next under two members */
function chain(count) {
  const files = [];
  for (let i = 0; i < count; i++) {
    files.push({
      name: `f${i}`, kind: 'app', text: '{}',
      ...(i < count - 1 ? { imports: { view: `f${i + 1}`, actions: `f${i + 1}` } } : {}),
    });
  }
  return parseProject({ project: '0.1', files });
}

describe('resolveProjectFile — the reads of one resolution are bounded', function () {
  it('refuses a chain of double imports at once instead of reading it 2^n times', () => {
    const project = chain(40);
    const started = performance.now();
    assert.throws(() => resolveProjectFile(project, 'f0'),
      { code: 'JS0003', message: /expand to too many file reads/ });
    assert.ok(performance.now() - started < 200, 'refused without walking the expansion');
  });

  it('reports the refusal per file when the project is assembled', () => {
    const { artifacts, errors } = assembleArtifacts(chain(40));
    assert.equal(errors.length > 0, true);
    assert.match(errors[0].message, /too many file reads/);
    assert.equal(artifacts.length < 40, true);
  });

  it('still resolves a shared file imported more than once', () => {
    const project = chain(5); // 2^4 reads of the last file
    const { doc, sourceFiles } = resolveProjectFile(project, 'f0');
    assert.deepEqual(sourceFiles, ['f0', 'f1', 'f2', 'f3', 'f4']);
    assert.deepEqual(Object.keys(doc).sort(), ['actions', 'view']);
  });
});

describe('resolveProjectFile — a layered shared-fragment project resolves', function () {
  it('resolves 15 files in 5 layers of 3, each importing three files of the next layer', () => {
    const files = [];
    for (let l = 0; l < 5; l++) {
      for (let i = 0; i < 3; i++) {
        files.push({
          name: `f${l}_${i}`, kind: 'app', text: '{}',
          ...(l < 4 ? { imports: Object.fromEntries(['view', 'actions', 'subs'].map((m, j) => [m, `f${l + 1}_${(i + j) % 3}`])) } : {}),
        });
      }
    }
    const { sourceFiles } = resolveProjectFile(parseProject({ project: '0.1', files }), 'f0_0');
    assert.equal(sourceFiles.length, 13);
  });
});
