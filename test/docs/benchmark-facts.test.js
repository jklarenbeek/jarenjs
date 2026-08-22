//@ts-check
/**
 * @file The benchmark-figure drift gate. Every measured number quoted in
 * committed markdown sits between `<!--bm:key-->` markers and is derived
 * from the committed `public/benchmarks/*.json` by
 * `scripts/generate-benchmark-facts.js`. This runs that script's
 * `--check` mode, so the suite fails when a document and the
 * measurements disagree — in either direction, whether the docs were
 * edited by hand or the suites were re-measured.
 *
 * Re-measuring is deliberately NOT part of this: the script only reads
 * the committed numbers, so the gate is instant and machine-independent.
 * `npm run docs:benchmarks` refreshes the prose after a real
 * `benchmark:generate` run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFactsGate } from '../../scripts/generate-benchmark-facts.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A throwaway document carrying one marker. */
function fixture(body) {
  const file = join(mkdtempSync(join(tmpdir(), 'jaren-facts-')), 'fixture.md');
  writeFileSync(file, body);
  return file;
}

describe('a marker the data cannot answer fails the gate, in both modes', () => {
  // The write branch used to collect its problems and then print a
  // success line over them, so a checkout whose data could not answer a
  // marker was "refreshed" with last month's number still in place.
  const source = 'The figure is <!--bm:not.a.real.fact-->0.0<!--/bm-->x today.\n';

  it('refuses to rewrite, and names the marker', () => {
    const file = fixture(source);
    const report = runFactsGate({ docs: [file], check: false });
    assert.strictEqual(report.code, 1, 'the write branch fails on an unanswerable marker');
    assert.strictEqual(report.unanswered.length, 1);
    assert.match(report.unanswered[0], /not\.a\.real\.fact/);
    assert.strictEqual(readFileSync(file, 'utf8'), source,
      'nothing is written when a marker in the set could not be derived');
  });

  it('fails --check the same way', () => {
    assert.strictEqual(runFactsGate({ docs: [fixture(source)], check: true }).code, 1);
  });

  it('reports a derivation that throws rather than baking around it', () => {
    const file = fixture('The figure is <!--bm:boom-->1<!--/bm-->x today.\n');
    const report = runFactsGate({
      docs: [file],
      facts: { boom: () => { throw new Error('suite.json was never regenerated'); } },
      check: false,
    });
    assert.strictEqual(report.code, 1);
    assert.match(report.unanswered.join('\n'), /boom: resolver threw — suite\.json was never regenerated/);
    assert.strictEqual(report.seen.length, 0, 'a fact that threw is not counted as resolved');
  });

  it('bakes a document whose markers all resolve', () => {
    const file = fixture('The figure is <!--bm:ok-->0.0<!--/bm-->x today.\n');
    const report = runFactsGate({ docs: [file], facts: { ok: () => '7.5' }, check: false });
    assert.strictEqual(report.code, 0);
    assert.strictEqual(report.rewritten, 1);
    assert.match(readFileSync(file, 'utf8'), /<!--bm:ok-->7\.5<!--\/bm-->/);
    // and again, on its own output, changes nothing
    const second = runFactsGate({ docs: [file], facts: { ok: () => '7.5' }, check: false });
    assert.strictEqual(second.rewritten, 0, 'the bake is idempotent');
  });
});

describe('quoted benchmark figures match the committed measurements', () => {
  it('no document drifts from the benchmark data', () => {
    try {
      execFileSync(process.execPath, ['scripts/generate-benchmark-facts.js', '--check'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (err) {
      assert.fail(`${err.stderr ?? ''}${err.stdout ?? ''}`);
    }
  });
});
