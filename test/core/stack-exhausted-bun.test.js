import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { childReport } from '../lib/child-report.js';

// The stack refusal on a host whose engine words it differently from V8, in
// a file of its own: a host without Bun skips it.
describe('isStackExhausted under Bun', () => {
  it('takes the refusal of the host it runs on, and no other value', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/stack-exhausted.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, FORCE_COLOR: '0' } });
    const report = childReport(run);
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0);
  });
});
