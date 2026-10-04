import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfilerArgs, buildProfileReport, printConsoleTable, exportCsv } from '../../benchmark/profiler.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILER = fileURLToPath(new URL('../../benchmark/profiler.js', import.meta.url));
const options = { drafts: ['draft7'], iterations: 1 };
const invoke = args => spawnSync(process.execPath, [PROFILER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
const temp = t => { const directory = mkdtempSync(join(tmpdir(), 'jaren-profiler-test-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
const capture = t => { const lines = []; t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); }); return lines; };
const rows = () => [
  { suite: '/fixture.json', draft: 'draft7', description: 'slow measured', assertions: 1, testCount: 1, isSuccessTest: true, jarenTime: 2, ajvTime: 1, jarenTotal: 4, ajvTotal: 2, ratio: 2, diff: 1, diffPercent: 100, jarenFailures: 0, ajvFailures: 0 },
  { suite: '/fixture.json', draft: 'draft7', description: 'fast measured', assertions: 1, testCount: 1, isSuccessTest: false, jarenTime: 0.5, ajvTime: 1, jarenTotal: 1, ajvTotal: 2, ratio: 0.5, diff: -0.5, diffPercent: -50, jarenFailures: 1, ajvFailures: 0 },
  { suite: '/fixture.json', draft: 'draft7', description: 'skipped assertion', timingSkipped: 'failed-assertions', jarenFailures: 0, ajvFailures: 2 },
  { suite: '/fixture.json', draft: 'draft7', description: 'jaren compile error', jarenError: 'cannot compile', jarenFailures: null, ajvFailures: 1 },
  { suite: '/fixture.json', draft: 'draft7', description: 'harness error', error: 'harness crashed' },
];

describe('profiler conformance stays independent of timing filters', () => {
  it('preserves the real content corpus verdicts in both timing modes', t => {
    const directory = temp(t);
    for (const filtered of [false, true]) {
      const output = join(directory, `${filtered ? 'filtered' : 'all'}.json`);
      const result = invoke(['/optional/content.json', '--profile', '-i', '1', '-d', 'draft7', '-o', 'json', '-f', output, ...(filtered ? ['--success-only'] : [])]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.deepEqual(report.summary.engineStats, { jaren: { draft7: { passed: 3, failed: 0, errors: 0 } }, ajv: { draft7: { passed: 0, failed: 3, errors: 0 } } });
      assert.equal(report.metadata.totalTests, 3);
      assert.equal(report.metadata.validTests, filtered ? 0 : 3);
      assert.equal(report.errors.length, 0);
      assert.equal(report.results.length, filtered ? 0 : 3);
      assert.equal(report.skipped.length, filtered ? 3 : 0);
      if (filtered) {
        assert.equal(report.summary.overall.jarenTotalTime, null);
        assert.equal(report.summary.overall.ajvTotalTime, null);
        assert.deepEqual(report.summary.overall.all, { avgRatio: null, minRatio: null, maxRatio: null, jarenWins: 0, tied: 0, ajvWins: 0 });
        for (const row of report.skipped) {
          assert.equal(row.timingSkipped, 'failed-assertions');
          assert.equal(row.jarenError, null); assert.equal(row.ajvError, null);
          for (const key of ['jarenTime', 'ajvTime', 'jarenTotal', 'ajvTotal', 'ratio', 'diff', 'diffPercent']) assert.equal(Object.hasOwn(row, key), false, key);
        }
      }
    }
  });

  it('attributes canonical rows to each requested draft group without merging aliases', t => {
    const directory = temp(t);
    for (const drafts of ['2019', '2019,draft2019-09']) {
      const output = join(directory, `${drafts}.json`);
      const result = invoke(['/type.json', '--profile', '-i', '1', '-d', drafts, '-o', 'json', '-f', output]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      const groups = drafts.split(',');
      assert.deepEqual(report.metadata.drafts, groups);
      assert.equal(report.metadata.totalTests, groups.length * 11);
      assert.equal(report.results.length, groups.length * 11);
      assert.ok(report.results.every(row => row.draft === 'draft2019-09' && !Object.hasOwn(row, 'requestedDraft')));
      for (const draft of groups) {
        assert.equal(report.summary.byDraft[draft].totalTests, 11);
        assert.deepEqual(report.summary.engineStats.jaren[draft], { passed: 11, failed: 0, errors: 0 });
        assert.deepEqual(report.summary.engineStats.ajv[draft], { passed: 11, failed: 0, errors: 0 });
      }
    }
  });

  it('counts evaluated tests across drafts separately from filtered timing rows', () => {
    // Repeat the same requested group to isolate timing omission from corpus differences.
    const result = invoke(['/optional/content.json', '--profile', '-i', '1', '-d', 'draft7,draft7', '--success-only']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Total tests evaluated across 2 drafts: 6/);
    assert.match(result.stdout, /Timed tests across 2 drafts: 0/);
  });

  it('reports measured rows, omissions and independent engine failures separately', () => {
    const report = buildProfileReport(rows(), options);
    assert.equal(report.metadata.totalTests, 5); assert.equal(report.metadata.validTests, 2); assert.equal(report.metadata.successTests, 1);
    assert.deepEqual(report.results.map(row => row.description), ['slow measured', 'fast measured']);
    assert.deepEqual(report.errors.map(row => row.description), ['jaren compile error', 'harness error']);
    assert.deepEqual(report.skipped.map(row => row.description), ['skipped assertion']);
    assert.deepEqual(report.summary.engineStats, { jaren: { draft7: { passed: 2, failed: 1, errors: 2 } }, ajv: { draft7: { passed: 2, failed: 2, errors: 1 } } });
    assert.deepEqual(report.summary.overall.all, { avgRatio: 1.25, minRatio: 0.5, maxRatio: 2, jarenWins: 1, tied: 0, ajvWins: 1 });
    for (const summary of [report.summary.overall, report.summary.byDraft.draft7]) {
      assert.equal(summary.jarenTotalTime, 5); assert.equal(summary.ajvTotalTime, 4);
      assert.equal(summary.jarenSuccessTime, 4); assert.equal(summary.ajvSuccessTime, 2);
    }
  });

  it('prints skipped rows with no invented timing when every comparison is omitted', t => {
    const lines = capture(t);
    printConsoleTable([rows()[2]], options, 'draft7', 'draft7');
    const output = lines.join('\n');
    assert.match(output, /AJV:\s+0 passed, 1 failed, 0 errors/);
    assert.match(output, /skipped assertion.*Skipped.*❌ Skipped.*-.*-/);
    assert.doesNotMatch(output, /0\.00 (?:ns|μs|ms)|NaN|undefined|Average Ratio/);
  });

  it('keeps timing order consistent across JSON, console and CSV, including top filtering', t => {
    const lines = capture(t), input = [rows()[3], rows()[1], rows()[0], rows()[2], rows()[4]];
    printConsoleTable(input, { ...options, topN: 1 }, 'draft7', 'draft7');
    const details = lines.join('\n');
    assert.match(details, /slow measured/); assert.doesNotMatch(details, /fast measured/);
    assert.ok(details.indexOf('slow measured') < details.indexOf('jaren compile error'));
    assert.match(details, /harness error.*❌ Error.*❌ Error/);
    assert.match(details, /skipped assertion/);
    const output = join(temp(t), 'report.csv'); exportCsv(input, output);
    const csv = readFileSync(output, 'utf8');
    assert.equal(csv.trim().split('\n').length, 3);
    assert.ok(csv.indexOf('slow measured') < csv.indexOf('fast measured'));
    assert.doesNotMatch(csv, /skipped assertion|compile error|harness error|undefined|NaN/);
    assert.match(lines.join('\n'), /2 timed rows; 1 skipped timings and 2 error rows omitted/);
  });
});

describe('profiler arguments refuse unmeasured artifacts', () => {
  it('retains short and long options and defaults', () => {
    const long = parseProfilerArgs(['/type.json', '--profile', '--iterations', '3', '--output', 'json', '--draft', 'draft7', '--filepath', 'report.json', '--top', '2', '--verbose', '--success-only']);
    const short = parseProfilerArgs(['/type.json', '--profile', '-i', '3', '-o', 'json', '-d', 'draft7', '-f', 'report.json', '--top', '2', '-v', '--success-only']);
    assert.deepEqual(short, long);
    assert.equal(long.iterations, 3); assert.equal(long.topN, 2);
    const defaults = parseProfilerArgs(['--profile-all']);
    assert.equal(defaults.iterations, 1000); assert.deepEqual(defaults.drafts, ['draft7']);
  });

  it('rejects invalid flags, missing values, counts and targets before writing a report', t => {
    const directory = temp(t);
    const target = ['/optional/content.json', '--profile'];
    const invalid = [
      [...target, '--iterations', '-1'], [...target, '-i', '0'], [...target, '-i', '1.5'], [...target, '-i', '12abc'], [...target, '-i', '9007199254740992'],
      [...target, '--iterations'], [...target, '--iterations', '--verbose'],
      [...target, '--top', '0'], [...target, '--top', '1.5'], [...target, '--top'],
      [...target, '--output', 'yaml'], [...target, '--output'],
      [...target, '--filepath'], [...target, '--filepath', ''],
      [...target, '--draft'], [...target, '--draft', ',,'],
      [...target, '--unknown'], [...target, '-z'],
      ['--profile', '--iterations', '1'],
    ];
    for (const [index, args] of invalid.entries()) {
      const output = join(directory, `invalid-${index}.json`);
      const full = ['-o', 'json', '-f', output, ...args];
      assert.throws(() => parseProfilerArgs(full), Error);
      const result = invoke(full);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.equal(existsSync(output), false, args.join(' '));
    }
    const output = join(directory, 'absent-target.json');
    const result = invoke(['/not-a-suite.json', '--profile', '-i', '1', '-o', 'json', '-f', output]);
    assert.equal(result.status, 1); assert.equal(existsSync(output), false); assert.doesNotMatch(result.stdout, /Profiling/);
  });
});
