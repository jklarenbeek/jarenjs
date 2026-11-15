//@ts-check
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { childReport } from '../lib/child-report.js';

// The Bun driver's file identity under Bun, in a file of its own: the
// PostgreSQL qualification runs every file that names its endpoint and
// refuses a skipped case, and a host without Bun skips this one. Windows
// refuses to rename an open database file, so it cannot produce the case.
describe('a database path replaced after the open, under Bun', () => {
  it('is refused by the Bun driver\'s identity hook and by shadow isolation, as by the Node driver\'s', (t) => {
    if (process.platform === 'win32') return t.skip('Windows refuses to rename an open database file');
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/replaced-path-identity-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, FORCE_COLOR: '0' } });
    const report = childReport(run);
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0, run.stderr);
  });
});
