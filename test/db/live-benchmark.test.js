//@ts-check
/** The operator-facing benchmark must accept equal records with different key order. */
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('the live benchmark checks both maintained and rerun event-time values successfully', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jaren-live-benchmark-'));
  const output = join(directory, 'live.json');
  try {
    await promisify(execFile)(process.execPath,
      ['benchmark/live.js', '--quick', '--output', 'json', '--filepath', output],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 55_000 });
    const report = JSON.parse(await readFile(output, 'utf8'));
    const table = report.tables.find((entry) => entry.title.startsWith('Event-time views:'));
    assert.deepEqual(table.rows.map((row) => row.name), [
      'maintained — bucket (60 s ladder, mean), 1000 rows',
      're-run — bucket (60 s ladder, mean), 1000 rows',
      'maintained — rolling (5 min window, mean), 1000 rows',
      're-run — rolling (5 min window, mean), 1000 rows',
    ]);
    assert.equal(report.meta.eventTimeRatios.length, 2);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});
