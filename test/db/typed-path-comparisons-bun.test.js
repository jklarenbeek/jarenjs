import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The typed path comparison group under bun:sqlite, in a file of its own: the
// PostgreSQL qualification runs every file that names its endpoint and
// refuses a skipped case, and a host without Bun skips this one.
describe('the corpus group on bun:sqlite', () => {
  it('plans native with no user function and answers as the engine does', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/typed-paths-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0);
  });
});
