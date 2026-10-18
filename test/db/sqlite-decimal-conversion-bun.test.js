//@ts-check
/**
 * @file bun:sqlite's SQLite converts a decimal past the significant digits
 * it keeps as node:sqlite's and the wasm build's do (sqlite-decimal-conversion.test.js):
 * the double nearer zero where the dropped digits decide a tie, by `CAST`
 * and by `jsonb_extract` alike. In a file of its own: a host without Bun
 * skips it by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { conversionReport, convertedByJson, nearTies } from './sqlite-decimal-cases.js';

describe('bun:sqlite reads a decimal past the digits it keeps as the double nearer zero', () => {
  it('by CAST and by jsonb_extract alike', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) return t.skip('no bun binary on PATH');
    const texts = nearTies(300);
    const fixture = fileURLToPath(new URL('./fixtures/sqlite-decimal-bun.mjs', import.meta.url));
    const converted = texts.flatMap((text, i) => (convertedByJson(text) ? [i] : []));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', timeout: 60000, input: JSON.stringify({ texts, converted }),
      cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    for (const reading of [conversionReport(texts, report.cast),
      conversionReport(converted.map((i) => texts[i]), report.extract)]) {
      assert.ok(reading.differ > 0, `SQLite ${report.version} under Bun rounds every digit of a decimal: narrow the README's "Two backends, frankly" row`);
      assert.deepEqual({ notDescribed: reading.notDescribed, notNeighbour: reading.notNeighbour, keptAllYetDiffer: reading.keptAllYetDiffer },
        { notDescribed: [], notNeighbour: [], keptAllYetDiffer: [] });
    }
  });
});
