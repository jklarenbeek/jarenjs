//@ts-check
/**
 * @file A native statement hands back what the engine reads. A number past
 * 2^53 is read as the double the engine holds, where a driver's integer
 * read refuses it. Every case runs on SQLite and, when `JAREN_PG_URL` names
 * an endpoint, on PostgreSQL; the same cases run under Bun.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onBothEngines } from './query-core-engines.js';
import { cases } from './fixtures/exact-reads-cases.mjs';

describe('a native read answers what the engine answers', () => {
  for (const kase of cases) {
    it(kase.name, async () => {
      await onBothEngines(kase.model, async (store, host) => {
        if (kase.hosts !== undefined && !kase.hosts.includes(host)) return;
        const rows = store.collection('rows');
        for (const document of kase.docs) await rows.insert(document);
        await kase.run(rows, kase.docs, host);
      });
    });
  }

  it('the same cases on bun:sqlite', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/exact-reads-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0);
  });
});
