//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Run the original CLI in a disposable process. Its child and every filesystem
// mutation are mocked, so these cases cannot touch a concurrent gate's report.
const HARNESS = String.raw`
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
const read = fs.readFileSync;
const exists = fs.existsSync;
let report = 'OLD_REPORT_MARKER';
const isReport = name => String(name).endsWith('coverage-final.json');
fs.existsSync = name => isReport(name) ? report !== null
  : String(name).includes('coverage') ? false : exists(name);
fs.rmSync = name => { if (isReport(name)) report = null; };
fs.unlinkSync = name => { if (isReport(name)) report = null; };
fs.mkdirSync = () => {};
fs.writeFileSync = () => {};
fs.readFileSync = (name, ...args) => {
  if (!isReport(name)) return read(name, ...args);
  return JSON.stringify({
    [process.cwd() + '/packages/core/src/' + report + '.js']: {
      fnMap: { 0: { name: report, decl: { start: { line: 1 } } } },
      f: { 0: 1 }, statementMap: {}, s: {},
    },
  });
};
cp.spawnSync = () => {
  if (options.writesReport) report = 'CURRENT_REPORT_MARKER';
  return {
    status: options.status,
    signal: null,
    error: options.launchError ? new Error('LAUNCH_ERROR_MARKER') : undefined,
    stdout: '\u2716 failing case\n  AssertionError [ERR_ASSERTION]: DIAGNOSTIC_MARKER\n'
      + '  actual: 12\n  expected: 21\n  at test/example.test.js:9:12\n'
      + '\u2139 tests 1\n\u2139 pass 0\n\u2139 fail 1\n',
  };
};
syncBuiltinESMExports();
process.argv = [process.execPath, 'benchmark/coverage.js',
  ...(options.deadCode ? ['--dead-code'] : ['/required.json', '--functions'])];
await import('./benchmark/coverage.js');
`;

/** @param {{ deadCode: boolean, writesReport: boolean, status: number | null, launchError?: boolean }} options */
function invoke(options) {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '--eval', HARNESS, JSON.stringify(options)],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}

describe('coverage CLI failure reporting', () => {
  it('preserves assertions, actual/expected values and stacks from a failed audit', () => {
    const result = invoke({ deadCode: true, writesReport: true, status: 1 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError \[ERR_ASSERTION\]: DIAGNOSTIC_MARKER/);
    assert.match(result.stderr, /actual: 12/);
    assert.match(result.stderr, /expected: 21/);
    assert.match(result.stderr, /test\/example\.test\.js:9:12/);
    assert.doesNotMatch(result.stdout, /OLD_REPORT_MARKER/);
  });

  it('fails a profiler run even when that failed child produces partial coverage', () => {
    const result = invoke({ deadCode: false, writesReport: true, status: 1 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CURRENT_REPORT_MARKER/);
    assert.doesNotMatch(result.stdout, /OLD_REPORT_MARKER/);
    assert.match(result.stderr, /The profiler exited 1/);
    assert.match(result.stderr, /DIAGNOSTIC_MARKER/);
  });

  it('reports launch errors and diagnostics before refusing a missing report in either mode', () => {
    for (const deadCode of [false, true]) {
      const result = invoke({ deadCode, writesReport: false, status: null, launchError: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /LAUNCH_ERROR_MARKER/);
      assert.match(result.stderr, /DIAGNOSTIC_MARKER/);
      assert.match(result.stderr, /not generated/i);
      assert.doesNotMatch(result.stdout, /OLD_REPORT_MARKER/);
    }
  });

  it('cannot reuse an old report when a successful child produces no new report', () => {
    for (const deadCode of [false, true]) {
      const result = invoke({ deadCode, writesReport: false, status: 0 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not generated/i);
      assert.doesNotMatch(result.stdout, /OLD_REPORT_MARKER/);
    }
  });

  it('keeps successful current-run coverage green and hides its routine child output', () => {
    for (const deadCode of [false, true]) {
      const result = invoke({ deadCode, writesReport: true, status: 0 });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /Functions (?:executed|hit): 1\/1/);
      assert.doesNotMatch(result.stdout, /DIAGNOSTIC_MARKER|OLD_REPORT_MARKER/);
    }
  });
});
