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
fs.rmSync = name => {
  if (options.inspectArgs) console.log('FS_MUTATION_MARKER');
  if (isReport(name)) report = null;
};
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
cp.spawnSync = (_command, args) => {
  if (options.inspectArgs) console.log('CHILD_ARGS_MARKER ' + JSON.stringify(args));
  if (options.writesReport) report = 'CURRENT_REPORT_MARKER';
  return {
    status: options.status,
    signal: null,
    error: options.launchError ? new Error('LAUNCH_ERROR_MARKER') : undefined,
    stdout: 'x'.repeat(options.padding ?? 0) + '\u2716 failing case\n  AssertionError [ERR_ASSERTION]: DIAGNOSTIC_MARKER\n'
      + '  actual: 12\n  expected: 21\n  at test/example.test.js:9:12\n'
      + '\u2139 tests 1\n\u2139 pass 0\n\u2139 fail 1\n',
  };
};
syncBuiltinESMExports();
process.argv = [process.execPath, 'benchmark/coverage.js',
  ...(options.args ?? (options.deadCode ? ['--dead-code'] : ['/required.json', '--functions']))];
await import('./benchmark/coverage.js');
`;

/**
 * The audit refuses to run without a PostgreSQL server, so every case names
 * one (the mocked child never connects); `pg` replaces it, `null` unsets it.
 * @param {{ deadCode?: boolean, writesReport: boolean, status: number | null, launchError?: boolean, padding?: number, args?: string[], inspectArgs?: boolean, pg?: string | null }} options
 */
function invoke(options) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, FORCE_COLOR: '0', JAREN_PG_URL: options.pg ?? 'postgres://audit.invalid/never-connected' };
  if (options.pg === null) delete env.JAREN_PG_URL;
  const result = spawnSync(process.execPath,
    ['--input-type=module', '--eval', HARNESS, JSON.stringify(options)],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env });
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

  it('drains a long failed suite before exiting, preserving its final diagnosis', () => {
    const result = invoke({ deadCode: true, writesReport: true, status: 1, padding: 1024 * 1024 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DIAGNOSTIC_MARKER/);
    assert.match(result.stderr, /expected: 21/);
    assert.match(result.stderr, /fix the suite first/);
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

describe('the audit\'s requirements', () => {
  const REFUSAL = 'The dead-code audit needs PostgreSQL, or every PostgreSQL path reads as dead code: '
    + 'run `npm run postgres:up`, then set JAREN_PG_URL to the endpoint it publishes '
    + '(postgres://jaren:jaren@127.0.0.1:55432/jaren by default).\n';

  it('refuses without JAREN_PG_URL, in one line and exit 2, before touching a report or launching the suite', () => {
    for (const pg of [null, '']) {
      const result = invoke({ deadCode: true, writesReport: true, status: 0, inspectArgs: true, pg });
      assert.equal(result.status, 2, JSON.stringify(pg));
      assert.equal(result.stderr, REFUSAL);
      assert.equal(result.stdout, '');
    }
  });

  it('runs the profiler without one: only the audit reads the PostgreSQL paths', () => {
    const result = invoke({ writesReport: true, status: 0, inspectArgs: true, pg: null });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CHILD_ARGS_MARKER/);
  });
});

describe('coverage CLI option boundaries', () => {
  it('honors the supplied temporary directory in both modes', () => {
    for (const prefix of [['--dead-code'], ['/required.json']]) {
      const result = invoke({ writesReport: true, status: 0, inspectArgs: true,
        args: [...prefix, '--temp-dir', 'coverage/custom temp'] });
      assert.equal(result.status, 0, result.stderr);
      const args = JSON.parse(result.stdout.match(/CHILD_ARGS_MARKER (.+)/)[1]);
      const directory = args[args.indexOf('--temp-directory') + 1];
      assert.equal(directory.replaceAll('\\', '/'), ROOT.replaceAll('\\', '/').replace(/\/$/, '') + '/coverage/custom temp');
    }
  });

  it('refuses unknown, missing, extra and wrong-mode arguments before any work', () => {
    for (const args of [
      [], [''], ['--functions'],
      ['--dead-code', '--typo'], ['--dead-code', '--temp-dir'],
      ['--dead-code', '--temp-dir', '--json'], ['--dead-code', '--iterations', '1'],
      ['--dead-code', '/required.json'], ['/required.json', '--json'],
      ['/required.json', '--no-fail'], ['/required.json', '/extra.json'],
      ['/required.json', '--threshold', 'abc'], ['/required.json', '--threshold', 'Infinity'],
      ['/required.json', '--iterations', 'abc'], ['/required.json', '--iterations', '0'],
      ['/required.json', '--iterations', '1.5'], ['/required.json', '--iterations'],
    ]) {
      const result = invoke({ writesReport: true, status: 0, inspectArgs: true, args });
      assert.notEqual(result.status, 0, args.join(' '));
      assert.doesNotMatch(result.stdout, /FS_MUTATION_MARKER|CHILD_ARGS_MARKER/, args.join(' '));
    }
  });

  it('keeps valid profiler controls and explains audit controls in help', () => {
    const result = invoke({ writesReport: true, status: 0, inspectArgs: true,
      args: ['/required.json', '--functions', '--touched-only', '--iterations', '2', '--threshold', '-1'] });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.stdout.match(/CHILD_ARGS_MARKER (.+)/)[1]);
    assert.equal(args[args.indexOf('--iterations') + 1], '2');
    const help = invoke({ writesReport: true, status: 0, args: ['--help'] });
    assert.equal(help.status, 0);
    for (const option of ['--dead-code', '--json', '--no-fail', '--temp-dir'])
      assert.ok(help.stdout.includes(option), option);
  });
});
