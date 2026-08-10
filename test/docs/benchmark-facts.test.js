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
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

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
