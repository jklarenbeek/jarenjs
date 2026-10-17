import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The foreign-commit corpus under bun:sqlite, in a file of its own: the
// PostgreSQL qualification runs every file that names its endpoint and
// refuses a skipped case, and a host without Bun skips this one. bun:sqlite
// has no statement reset, and an EXPLAIN it read to the end counts as an
// active statement until finalized, which held the connection's read
// transaction open across every later statement.
describe('a commit beside the store on bun:sqlite', () => {
  it('is seen by the reads after every read path, and is not refused busy in a rollback journal', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/foreign-commit-reads-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, FORCE_COLOR: '0' } });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.found, { wal: [], delete: [] });
    assert.equal(run.status, 0);
  });
});
