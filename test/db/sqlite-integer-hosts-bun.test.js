import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The integer-read corpus under bun:sqlite, in a file of its own: the
// PostgreSQL qualification runs every file that names its endpoint and
// refuses a skipped case, and a host without Bun skips this one. bun:sqlite
// hands an integer past ±(2^53 - 1) back as the nearest double unless asked
// for bigints, so this is the host the shared decoder changes most.
describe('a stored integer past ±(2^53 - 1) on bun:sqlite', () => {
  it('reads back exactly where a double holds it and is refused where it would round', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/integer-reads-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, FORCE_COLOR: '0' } });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0);
  });
});
