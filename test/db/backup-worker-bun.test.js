//@ts-check
/**
 * @file The Bun binding's backup inside a `bun build --compile` executable:
 * the page copy runs in a worker, so the calling thread stays free while it
 * copies. The executable is built from a fixture entry into a temporary
 * directory and run from an empty one, so nothing beside the binary can
 * supply the worker. It completes one backup while a timer ticks (ticks
 * between two progress events ran during the copy) and reopens it holding
 * every row; a timer the first progress event arms aborts a second
 * (`JD2079`) and passes a third's deadline on the store's clock
 * (`JD2075`), each before the copy's last page, with no later event
 * delivered and nothing published or left behind; the aborted copy settles
 * in a small part of the ticks a whole copy takes, so the worker stopped
 * too. In a file of its own: a
 * host without Bun skips it by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const entry = fileURLToPath(new URL('./fixtures/backup-worker-compiled.mjs', import.meta.url));

describe('a Bun backup inside a compiled executable', () => {
  it('copies in a worker: timers run during the copy, an abort or a deadline stops it between pages', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) return t.skip('no bun binary on PATH');
    const directory = mkdtempSync(join(tmpdir(), 'jaren-backup-compiled-'));
    try {
      const binary = join(directory, 'backup-app');
      const build = spawnSync('bun', ['build', '--compile', entry, '--outfile', binary],
        { encoding: 'utf8', cwd: repositoryRoot });
      assert.equal(build.status, 0, build.stderr);
      const run = join(directory, 'run');
      mkdirSync(run);
      const result = spawnSync(binary, [], { encoding: 'utf8', cwd: run, timeout: 60000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
      assert.deepEqual([report?.runtime, report?.compiled], ['bun', true], result.stdout);

      // one event per step but the last, at one page per step
      const { complete, aborted, deadline } = report;
      assert.equal(complete.events, complete.pages - 1, JSON.stringify(complete));
      assert.ok(complete.ticksDuringCopy > 0, `no timer ran during the copy: ${JSON.stringify(complete)}`);
      assert.deepEqual([complete.rows, complete.everyRow], [3000, true]);

      for (const [stopped, code] of [[aborted, 'JD2079'], [deadline, 'JD2075']]) {
        assert.equal(stopped.code, code, JSON.stringify(stopped));
        // the timer ran before the copy's last page, and no event came after it
        assert.ok(stopped.eventsWhenFired !== null && stopped.eventsWhenFired < complete.events, JSON.stringify(stopped));
        assert.equal(stopped.events, stopped.eventsWhenFired, JSON.stringify(stopped));
        assert.equal(stopped.published, false);
      }
      // the abort stopped the worker, not only the events: the copy settled
      // in a small part of the ticks a whole copy takes (copying on, it
      // takes more than the whole copy's)
      assert.ok(aborted.ticksAfterAbort * 2 < complete.ticksDuringCopy, JSON.stringify([aborted, complete]));
      assert.deepEqual(report.leftovers, []);
      assert.deepEqual(readdirSync(run).filter((name) => !/^(source|complete)\.db(-wal|-shm)?$/.test(name)), []);
    }
    finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
