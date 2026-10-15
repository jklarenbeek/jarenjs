//@ts-check
/**
 * @file The Bun binding's backup while another connection holds the file's
 * exclusive lock (a rollback journal), which a timer on the calling thread
 * releases: neither the copy's own reads of the store's handle nor the
 * worker's start hold that thread while the lock is held, so the timer runs,
 * the lock is released, and the copy waits it out and completes with every
 * row. In a file of its own: a host without Bun skips it by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('a Bun backup under another connection\'s lock', () => {
  it('waits the lock out while the calling thread runs, and copies every row', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/backup-busy-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', timeout: 60000,
      cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.equal(run.status, 0, run.stderr);
    // the timer ran while the copy waited, and the copy then completed
    assert.deepEqual([report.code, report.releasedBeforeSettled, report.released, report.rows], [undefined, true, true, 200],
      JSON.stringify(report));
    assert.ok(report.pages > 1, JSON.stringify(report));
  });
});
