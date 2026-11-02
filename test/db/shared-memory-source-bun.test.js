//@ts-check
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { childReport } from '../lib/child-report.js';

// The stores over one shared-cache in-memory URI under Bun, in a file of its
// own: the PostgreSQL qualification runs every file that names its endpoint
// and refuses a skipped case, and a host without Bun skips this one.
describe('a shared-cache in-memory database under Bun', () => {
  it('is one source for the Node and worker drivers that share it, and bun:sqlite\'s file of that name is another', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/shared-memory-source-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    const report = childReport(run);
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0, run.stderr);
  });
});

describe('a fixture child\'s report', () => {
  const none = (/** @type {string} */ cause) =>
    `the child wrote no JSON report as its last stdout line (${cause})\nstderr:\n(empty)\nstdout:\n(empty)`;
  /** @param {any} run @param {string} message */
  const refused = (run, message) => assert.throws(() => childReport(run), { name: 'AssertionError', message });

  it('is the last stdout line, parsed', () => {
    assert.deepEqual(childReport({ status: 0, signal: null, stdout: 'noise\n{"runtime":"bun","failures":[]}\n', stderr: '' }),
      { runtime: 'bun', failures: [] });
  });

  it('is missing from a child that died before writing it: the failure names its exit status and stderr', () => {
    const run = spawnSync(process.execPath, ['-e', "process.stderr.write('opened nothing\\n'); process.exit(3)"],
      { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    refused(run, 'the child wrote no JSON report as its last stdout line (exit status 3, signal null)'
      + '\nstderr:\nopened nothing\nstdout:\n(empty)');
  });

  it('is missing from a child a signal killed or that never launched: the failure names the signal or the launch error', () => {
    refused({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, none('exit status null, signal SIGKILL'));
    const run = spawnSync('jaren-no-such-binary', [], { encoding: 'utf8' });
    refused(run, none(`exit status null, signal null, launch error: ${run.error?.message}`));
  });
});
