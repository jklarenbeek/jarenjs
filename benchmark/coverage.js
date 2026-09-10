#!/usr/bin/env node
/**
 * Coverage Analysis Tool for JarenJS
 * 
 * This tool runs c8 coverage while profiling a test suite and analyzes
 * which functions were touched (executed) during the run. It filters out
 * functions with 0% coverage and can apply a threshold for minimum coverage.
 * 
 * Usage:
 *   node benchmark/coverage.js <testfile.json> [options]
 *   node benchmark/coverage.js --dead-code [audit options]
 *   
 * Options:
 *   --threshold <n>    Filter out files with coverage <= n% (default: 0)
 *   --functions        Show TOUCHED and NOT touched functions with hit counts
 *   --touched-only     Show only TOUCHED functions (hides NOT touched)
 *   --iterations <n>   Number of profiling iterations (default: 1000)
 *   --temp-dir <dir>   c8 temporary directory in either mode (default: coverage/tmp;
 *                     coverage/tmp-dead for the audit)
 *   --dead-code        Audit untouched shipped functions across the full test suite
 *   --json             Print audit data as JSON
 *   --no-fail          Report dead code without failing; failed tests still fail
 * 
 * Examples:
 *   # Show files with >0% coverage after profiling required.json
 *   node benchmark/coverage.js '/required.json'
 *   
 *   # Only show files with >25% coverage
 *   node benchmark/coverage.js '/required.json' --threshold 25
 *   
 *   # Show TOUCHED and NOT touched functions with hit counts
 *   node benchmark/coverage.js '/required.json' --functions
 *   
 *   # Show only TOUCHED functions (cleaner output)
 *   node benchmark/coverage.js '/required.json' --touched-only
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// A failed child can still produce useful partial coverage, but its status
// and full diagnosis must survive even when it produced no report at all.
function reportRunFailure(run, label) {
  if (run.status === 0) return false;
  console.warn(`${label} exited ${run.status} (signal ${run.signal ?? 'none'}).`);
  if (run.error != null) console.warn(run.error);
  const output = String(run.stdout ?? '').trimEnd();
  if (output !== '') console.warn(output);
  return true;
}

/** Print the two modes and the options each can honor. */
function printHelp() {
  console.log(`Usage: node benchmark/coverage.js <testfile.json> [options]
       node benchmark/coverage.js --dead-code [audit options]

Shared options:
  --temp-dir <dir>   Temporary directory for c8 (default: coverage/tmp;
                    coverage/tmp-dead in audit mode)
  --help, -h         Show this help message

Single-fixture options:
  --threshold <n>    Filter out files with coverage <= n% (default: 0;
                    use -1 to include files with zero coverage)
  --functions        Show individual function-level coverage
  --touched-only     Show only TOUCHED functions (hides NOT touched)
  --iterations <n>   Positive integer profiling iterations (default: 1000)

Audit options:
  --dead-code        Audit the whole test suite for untouched source functions
  --json             Print audit data as JSON after the run banner
  --no-fail          Report dead code without failing; a failed suite still fails

Examples:
  node benchmark/coverage.js '/required.json' --threshold 25
  node benchmark/coverage.js '/required.json' --functions
  node benchmark/coverage.js --dead-code --json`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const deadCode = args.includes('--dead-code');
let targetFile = null;
let threshold = 0;
let showFunctions = false;
let touchedOnly = false;
let iterations = 1000;
let tempDir = path.join(rootDir, 'coverage', deadCode ? 'tmp-dead' : 'tmp');
let failOnDeadCode = true;
let json = false;

// Validate before touching coverage files or launching a child. A switch
// belonging to another mode is a mistake, never an ignored instruction.
try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--threshold', '--functions', '--touched-only', '--iterations'].includes(arg) && deadCode)
      throw new Error(`${arg} is only available in single-fixture mode`);
    if (['--json', '--no-fail'].includes(arg) && !deadCode)
      throw new Error(`${arg} requires --dead-code`);
    let value;
    if (['--threshold', '--iterations', '--temp-dir'].includes(arg)) {
      value = args[++i];
      if (value === undefined || value.trim() === '' || value.startsWith('--'))
        throw new Error(`${arg} requires a value`);
    }
    switch (arg) {
      case '--dead-code': break;
      case '--no-fail': failOnDeadCode = false; break;
      case '--json': json = true; break;
      case '--threshold':
        threshold = Number(value);
        if (!Number.isFinite(threshold)) throw new Error('--threshold must be a finite number');
        break;
      case '--functions': showFunctions = true; break;
      case '--touched-only': touchedOnly = true; showFunctions = true; break;
      case '--iterations':
        iterations = Number(value);
        if (!Number.isSafeInteger(iterations) || iterations < 1)
          throw new Error('--iterations must be a positive safe integer');
        break;
      case '--temp-dir': tempDir = path.resolve(value); break;
      default:
        if (arg === '') throw new Error('the target file must not be empty');
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (deadCode) throw new Error('--dead-code does not take a target file');
        if (targetFile !== null) throw new Error(`Unexpected extra target file: ${arg}`);
        targetFile = arg;
    }
  }
}
catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Pipes are asynchronous: drain a failed suite's full diagnosis before exit.
if (deadCode) {
  const exitCode = runDeadCodeAudit({ tempDir, fail: failOnDeadCode, json });
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise((resolve) => stream.write('', resolve))));
  process.exit(exitCode);
}

if (targetFile === null) {
  printHelp();
  process.exit(1);
}

// Ensure target file is properly formatted
if (!targetFile.startsWith('/')) {
  targetFile = '/' + targetFile;
}

// Clean temp directory
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true });
}
fs.mkdirSync(tempDir, { recursive: true });

const coverageFile = path.join(rootDir, 'coverage', 'coverage-final.json');
fs.rmSync(coverageFile, { force: true });

// Run c8 with profiler
console.log('='.repeat(80));
console.log(`COVERAGE ANALYSIS: ${targetFile}`);
console.log('='.repeat(80));
console.log(`Iterations: ${iterations}`);
console.log(`Threshold: ${threshold}%`);
console.log('');

// argv-based on purpose: shell-quoted arguments are not portable
// (Windows cmd.exe passes single quotes through literally)
const c8Args = [
  path.join(rootDir, 'node_modules', 'c8', 'bin', 'c8.js'),
  '--reporter=json',
  '--all',
  '--exclude', 'packages/_',
  '--exclude', 'test/',
  '--exclude', 'coverage/',
  '--temp-directory', tempDir,
  '--clean',
  process.execPath, path.join(__dirname, 'debug.js'),
  targetFile,
  '--profile',
  '--iterations', String(iterations),
];

// Keep current-run partial coverage when c8 fails, with a failing exit code.
const run = spawnSync(process.execPath, c8Args, {
  cwd: rootDir,
  stdio: ['inherit', 'pipe', 'inherit'],
  encoding: 'utf8'
});
if (reportRunFailure(run, 'The profiler')) process.exitCode = 1;

// Check if coverage file was generated
if (!fs.existsSync(coverageFile)) {
  console.error('Error: Coverage file not generated');
  process.exit(1);
}

// Parse coverage data
const coverageData = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));

// Analyze coverage
const results = [];
const uncoveredFunctions = [];

for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
  // Skip node_modules and non-project files
  if (filePath.includes('node_modules')) continue;
  
  const relativePath = path.relative(rootDir, filePath);
  
  // Calculate function coverage
  const fnMap = fileCoverage.fnMap || {};
  const fnHits = fileCoverage.f || {};
  
  const totalFunctions = Object.keys(fnMap).length;
  if (totalFunctions === 0) continue;
  
  let hitFunctions = 0;
  const fileUncoveredFunctions = [];
  const fileCoveredFunctions = [];
  
  for (const [fnId, fnInfo] of Object.entries(fnMap)) {
    const hitCount = fnHits[fnId] || 0;
    const fnData = {
      name: fnInfo.name || '(anonymous)',
      line: fnInfo.decl?.start?.line || fnInfo.line || '?',
      column: fnInfo.decl?.start?.column || fnInfo.loc?.start?.column || 0,
      hits: hitCount
    };
    if (hitCount > 0) {
      hitFunctions++;
      fileCoveredFunctions.push(fnData);
    } else {
      fileUncoveredFunctions.push(fnData);
    }
  }
  
  const functionCoveragePct = (hitFunctions / totalFunctions) * 100;
  
  // Calculate statement coverage for comparison
  const statementMap = fileCoverage.statementMap || {};
  const s = fileCoverage.s || {};
  const totalStatements = Object.keys(statementMap).length;
  let hitStatements = 0;
  for (const stmtId of Object.keys(statementMap)) {
    if ((s[stmtId] || 0) > 0) hitStatements++;
  }
  const statementCoveragePct = totalStatements > 0 ? (hitStatements / totalStatements) * 100 : 0;
  
  // Apply threshold filter
  if (functionCoveragePct <= threshold) continue;
  
  results.push({
    file: relativePath,
    functionCoverage: functionCoveragePct,
    statementCoverage: statementCoveragePct,
    hitFunctions,
    totalFunctions,
    uncovered: fileUncoveredFunctions,
    coveredFunctions: fileCoveredFunctions
  });
  
  if (fileUncoveredFunctions.length > 0) {
    uncoveredFunctions.push(...fileUncoveredFunctions.map(fn => ({
      file: relativePath,
      ...fn
    })));
  }
}

// Sort by function coverage (ascending)
results.sort((a, b) => a.functionCoverage - b.functionCoverage);

// Display results
if (results.length === 0) {
  console.log('\nNo files match the criteria.');
  console.log(`All files have <= ${threshold}% function coverage.`);
} else {
  console.log(`\nFiles with >${threshold}% function coverage:\n`);
  
  // Print table header
  const header = `${'File'.padEnd(50)} | ${'Func %'.padStart(6)} | ${'Stmt %'.padStart(6)} | ${'Hit/Total'.padStart(9)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  
  // Print file summary
  for (const r of results) {
    const fileName = r.file.length > 49 ? '...' + r.file.slice(-46) : r.file;
    const funcStr = r.functionCoverage.toFixed(1).padStart(6);
    const stmtStr = r.statementCoverage.toFixed(1).padStart(6);
    const hitStr = `${r.hitFunctions}/${r.totalFunctions}`.padStart(9);
    console.log(`${fileName.padEnd(50)} | ${funcStr} | ${stmtStr} | ${hitStr}`);
    
    // Show individual functions if requested
    if (showFunctions) {
      console.log('');
      if (r.coveredFunctions && r.coveredFunctions.length > 0) {
        console.log(`  Functions TOUCHED during this run:`);
        for (const fn of r.coveredFunctions) {
          const hitStr = fn.hits > 0 ? `${fn.hits}x` : '';
          console.log(`    ✓ ${fn.name} (line ${fn.line}) ${hitStr}`);
        }
      }
      if (!touchedOnly && r.uncovered.length > 0) {
        console.log(`  Functions NOT touched during this run:`);
        for (const fn of r.uncovered) {
          console.log(`    ✗ ${fn.name} (line ${fn.line})`);
        }
      }
      if ((r.coveredFunctions?.length || 0) + r.uncovered.length === 0) {
        console.log('  (no functions found)');
      }
      console.log('');
    }
  }
  
  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Files shown: ${results.length}`);
  
  const totalHitFuncs = results.reduce((sum, r) => sum + r.hitFunctions, 0);
  const totalFuncs = results.reduce((sum, r) => sum + r.totalFunctions, 0);
  console.log(`Functions hit: ${totalHitFuncs}/${totalFuncs} (${((totalHitFuncs/totalFuncs)*100).toFixed(1)}%)`);
  
  if (!showFunctions && uncoveredFunctions.length > 0) {
    console.log('');
    console.log(`Uncovered functions in shown files: ${uncoveredFunctions.length}`);
    console.log('(Use --functions to see which functions were TOUCHED vs NOT touched)');
  }
}

// Always show fully uncovered files separately
const uncoveredFiles = [];
for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
  if (filePath.includes('node_modules')) continue;
  
  const fnMap = fileCoverage.fnMap || {};
  const fnHits = fileCoverage.f || {};
  const totalFunctions = Object.keys(fnMap).length;
  
  if (totalFunctions === 0) continue;
  
  let hitFunctions = 0;
  for (const fnId of Object.keys(fnMap)) {
    if ((fnHits[fnId] || 0) > 0) hitFunctions++;
  }
  
  if (hitFunctions === 0) {
    const relativePath = path.relative(rootDir, filePath);
    uncoveredFiles.push({
      file: relativePath,
      totalFunctions
    });
  }
}

if (uncoveredFiles.length > 0) {
  console.log('');
  console.log('='.repeat(80));
  console.log(`FILES WITH 0% COVERAGE (${uncoveredFiles.length} files) - Hidden by default`);
  console.log('='.repeat(80));
  console.log('(Use --threshold -1 to include these)');
}

console.log('');

/**
 * Whole-suite dead-code audit (the `--dead-code` mode). Runs the full test
 * suite under c8 with `--all` so that even a module no test imports shows
 * up at 0%, then reports:
 *   - FULLY DEAD FILES — every function in the file is unhit (no test loads it);
 *   - DEAD FUNCTIONS   — individual unhit functions inside otherwise-used files.
 * The refactor decides per finding: delete the dead code, or add a test that
 * exercises it. Returns 1 when findings exist (unless `--no-fail`), so it can
 * gate a health check.
 *
 * @param {{ tempDir: string, fail: boolean, json: boolean }} opts
 * @returns {number} the process exit code
 */
function runDeadCodeAudit(opts) {
  const coverageFile = path.join(rootDir, 'coverage', 'coverage-final.json');
  fs.rmSync(coverageFile, { force: true });
  if (fs.existsSync(opts.tempDir)) fs.rmSync(opts.tempDir, { recursive: true });
  fs.mkdirSync(opts.tempDir, { recursive: true });

  // Instrument only shipped source (packages/*/src, components/*/src); tests,
  // dist and node_modules are never "dead code" to be removed. The website
  // browser bootstrap (main.js) is excluded too: it wires the live DOM,
  // localStorage, fetch and the service worker, so no headless test can load
  // it — its logic is covered instead by driving createSiteApp over the stub
  // host (test/website/site.test.js). The jaren-emit CLI is excluded for the
  // same reason: it is an argv/filesystem entry point whose logic is the
  // library it calls, and that library is covered directly.
  // argv-based on purpose: shell-quoted globs are not portable (Windows
  // cmd.exe passes single quotes through literally, silently
  // instrumenting nothing) — the include/exclude patterns must reach c8
  // verbatim on every platform
  const c8Args = [
    path.join(rootDir, 'node_modules', 'c8', 'bin', 'c8.js'),
    '--reporter=json',
    '--all',
    '--include', 'packages/**/src/**/*.js',
    '--include', 'components/**/src/**/*.js',
    '--exclude', '**/*.test.js',
    '--exclude', '**/dist/**',
    '--exclude', 'packages/website/src/main.js',
    '--exclude', 'packages/emit/src/cli.js',
    // the jaren-db CLI follows the same rule (its interactive confirm()
    // needs a TTY no headless test has); the five commands are
    // subprocess-tested in test/db/cli.test.js
    '--exclude', 'packages/db/src/cli.js',
    // the data studio's browser transport and its owner worker: they
    // are Worker/BroadcastChannel/OPFS code no headless Node test can
    // load — their logic is proven by the real-browser e2e
    // (packages/website/e2e/data.spec.js across three engines), the
    // same rule main.js follows
    '--exclude', 'packages/website/src/boundaries/data.js',
    '--exclude', 'packages/website/src/db-worker.js',
    // Browser bootstrap/WASM entry points follow the same boundary. The
    // exported ZIP is executed with network blocked in project-offline.spec
    // (Chromium, Firefox, WebKit); their reusable hosts remain audited here.
    '--exclude', 'packages/website/src/project-db-worker.js',
    '--exclude', 'packages/website/src/offline-runtime.js',
    '--temp-directory', opts.tempDir,
    '--clean',
    process.execPath, '--no-warnings=ExperimentalWarning', '--test', 'test/**/*.test.js',
  ];

  console.log('='.repeat(80));
  console.log('DEAD-CODE AUDIT — running the full test suite under coverage…');
  console.log('='.repeat(80));

  // A non-zero exit means the suite has failing tests. Coverage is still
  // written, but a red suite makes the audit unreliable (untested paths
  // may simply not have run) — flag it.
  // A green suite's output is noise beside the plain test stage. On failure
  // keep it whole: assertions, actual/expected values and stacks are needed
  // to diagnose the failure, regardless of whether c8 wrote a report.
  const run = spawnSync(process.execPath, c8Args,
    { cwd: rootDir, stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  const suiteFailed = reportRunFailure(run, 'The instrumented suite');
  if (suiteFailed) {
    console.warn('Warning: the test suite did not pass cleanly — fix the suite first; '
      + 'dead-code findings below may be inaccurate.');
  }
  if (!fs.existsSync(coverageFile)) {
    console.error('Error: coverage data not generated.');
    return 1;
  }

  const data = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  // fail CLOSED on an empty report: "zero findings" from a run that
  // instrumented nothing is not evidence, it is a broken audit
  if (Object.keys(data).length === 0) {
    console.error('Error: the coverage report is empty — the audit instrumented nothing '
      + '(broken include/exclude patterns?). Failing closed.');
    return 1;
  }
  const deadFiles = [];   // { file, totalFunctions }
  const deadFns = [];     // { file, name, line }  (in files that ARE otherwise used)
  let totalFns = 0;
  let hitFns = 0;

  for (const [filePath, fc] of Object.entries(data)) {
    if (filePath.includes('node_modules')) continue;
    const rel = path.relative(rootDir, filePath);
    const fnMap = fc.fnMap || {};
    const f = fc.f || {};
    const ids = Object.keys(fnMap);
    if (ids.length === 0) continue; // pure re-export / constants module — nothing to call

    let fileHit = 0;
    const fileDead = [];
    for (const id of ids) {
      totalFns++;
      if ((f[id] || 0) > 0) { hitFns++; fileHit++; }
      else fileDead.push({
        file: rel,
        name: fnMap[id].name || '(anonymous)',
        line: fnMap[id].decl?.start?.line ?? fnMap[id].line ?? '?',
      });
    }
    if (fileHit === 0) deadFiles.push({ file: rel, totalFunctions: ids.length });
    else deadFns.push(...fileDead); // report only the unhit functions of a used file
  }

  deadFiles.sort((a, b) => a.file.localeCompare(b.file));
  deadFns.sort((a, b) => a.file.localeCompare(b.file) || (a.line - b.line));

  if (opts.json) {
    console.log(JSON.stringify({
      deadFiles, deadFunctions: deadFns,
      totalFunctions: totalFns, hitFunctions: hitFns,
    }, null, 2));
  } else {
    console.log('');
    console.log('='.repeat(80));
    console.log(`FULLY DEAD FILES — no test executes any function (${deadFiles.length})`);
    console.log('='.repeat(80));
    if (deadFiles.length === 0) console.log('  none');
    else for (const d of deadFiles) console.log(`  ✗ ${d.file}  (${d.totalFunctions} function(s))`);

    console.log('');
    console.log('='.repeat(80));
    console.log(`DEAD FUNCTIONS — unhit functions in otherwise-used files (${deadFns.length})`);
    console.log('='.repeat(80));
    if (deadFns.length === 0) {
      console.log('  none');
    } else {
      let current = null;
      for (const d of deadFns) {
        if (d.file !== current) { console.log(`  ${d.file}`); current = d.file; }
        console.log(`    ✗ ${d.name} (line ${d.line})`);
      }
    }

    console.log('');
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    const pct = totalFns > 0 ? ((hitFns / totalFns) * 100).toFixed(1) : '0.0';
    console.log(`Functions executed: ${hitFns}/${totalFns} (${pct}%)`);
    console.log(`Dead-code findings: ${deadFiles.length} file(s) + ${deadFns.length} function(s)`);
    console.log('');
    console.log('For each finding the refactor must DECIDE:');
    console.log('  • remove it (it is genuinely unreachable/obsolete), or');
    console.log('  • add a test that exercises it (it is a real, intended code path).');
    console.log('Do not leave it unresolved. (Some entries may be intentional public API');
    console.log('surface with no test yet — adding the test is then the correct choice.)');
    console.log('');
  }

  if (totalFns === 0) {
    console.error('Error: zero functions were instrumented — a 0/0 summary is a broken '
      + 'audit, never a pass. Failing closed.');
    return 1;
  }

  const findings = deadFiles.length + deadFns.length;
  return (opts.fail && findings > 0) || suiteFailed ? 1 : 0;
}
