//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSuiteArgs } from '../../benchmark/lib/args.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Run only the CLI preflight: --help avoids loading or measuring a corpus. */
function invoke(runner, args) {
  try {
    const stdout = execFileSync(process.execPath, [`benchmark/${runner}.js`, '--help', ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { status: 0, stdout, stderr: '' };
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return { status: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

describe('benchmark iteration counts cannot silently produce invalid timings', () => {
  it('preserves defaults and parses both count flags without swallowing later arguments', () => {
    const config = { defaultIterations: 2000, engines: ['jaren'] };
    assert.strictEqual(parseSuiteArgs(['node', 'runner'], config).iterations, 2000);
    for (const flag of ['--iterations', '-i']) {
      const options = parseSuiteArgs(['node', 'runner', flag, '25', '--profile', 'basic'], config);
      assert.strictEqual(options.iterations, 25);
      assert.strictEqual(options.profile, true);
      assert.strictEqual(options.filter, 'basic');
    }
  });

  for (const [label, args] of [
    ['a non-numeric count', ['--iterations', 'abc']],
    ['a missing count', ['--iterations']],
    ['a count that swallowed the next flag', ['--iterations', '--profile']],
    ['zero', ['--iterations', '0']],
    ['a negative count', ['--iterations', '-1']],
    ['a fractional count', ['--iterations', '1.5']],
    ['trailing characters', ['--iterations', '12abc']],
    ['an unsafe integer', ['--iterations', '9007199254740992']],
    ['a malformed short count', ['-i', 'abc']],
  ]) {
    it(`refuses ${label} before profiling or printing help`, () => {
      const result = invoke('jsonpath', args);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.stderr.trim(), '--iterations must be a positive integer');
    });
  }

  for (const runner of ['jsonquery', 'jslt']) {
    it(`${runner} uses the same count refusal`, () => {
      const result = invoke(runner, ['--iterations', 'abc']);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.stderr.trim(), '--iterations must be a positive integer');
    });
  }

  it('allows a valid CLI count to reach help', () => {
    const result = invoke('jsonpath', ['--iterations', '25']);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, '');
    assert.match(result.stdout, /JSONPath .*Compliance & Performance Benchmark/);
  });
});
