#!/usr/bin/env node
/**
 * Coverage Analysis Tool for JarenJS
 *
 * Runs any combination of the official JSON-Schema-Test-Suite (single file
 * or ALL suites across all drafts) and the repository unit tests under V8
 * coverage, merges everything into a single report, and analyzes which
 * functions were touched (executed) and which were not - so you can decide
 * where tests are missing and what might be dead code.
 *
 * Usage:
 *   node benchmark/coverage.js [testfile.json] [options]
 *
 * What to run (combine freely; at least one is required):
 *   <testfile.json>    Cover a single official-suite file (e.g. '/ref.json')
 *   --all              Cover the COMPLETE official suite (all drafts)
 *   --unit-tests       Cover the repository unit tests (all test globs)
 *
 * Options:
 *   --draft <list>     Draft(s) to run, comma separated
 *                      (default for --all: draft7,draft2019-09,draft2020-12)
 *   --iterations <n>   Profiling iterations (default: 1 with --all,
 *                      1000 for a single file)
 *   --threshold <n>    Only show files with function coverage > n% (default: 0)
 *   --functions        Show TOUCHED and NOT touched functions with hit counts
 *   --touched-only     Show only TOUCHED functions (hides NOT touched)
 *   --json <path>      Write the full analysis as JSON
 *   --temp-dir <dir>   Temporary directory for V8 coverage data
 *
 * Examples:
 *   # The full picture: every draft of the official suite plus the unit
 *   # tests, merged - untouched functions are dead-code candidates
 *   node benchmark/coverage.js --all --unit-tests
 *
 *   # Complete suite only, with per-function detail
 *   node benchmark/coverage.js --all --functions
 *
 *   # What does a single suite file touch?
 *   node benchmark/coverage.js '/required.json' --threshold 25
 *
 *   # Machine readable output for diffing between runs
 *   node benchmark/coverage.js --all --unit-tests --json coverage/analysis.json
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const USAGE = `Usage: node benchmark/coverage.js [testfile.json] [options]

What to run (combine freely; at least one is required):
  <testfile.json>    Cover a single official-suite file (e.g. '/ref.json')
  --all              Cover the COMPLETE official suite (all drafts)
  --unit-tests       Cover the repository unit tests (test/**/*.test.js)

Options:
  --draft <list>     Draft(s) to run, comma separated
                     (default for --all: draft7,draft2019-09,draft2020-12)
  --iterations <n>   Profiling iterations (default: 1 with --all, 1000 single file)
  --threshold <n>    Only show files with function coverage > n% (default: 0)
  --functions        Show TOUCHED and NOT touched functions with hit counts
  --touched-only     Show only TOUCHED functions (hides NOT touched)
  --json <path>      Write the full analysis as JSON
  --temp-dir <dir>   Temporary directory for V8 coverage data
  --help, -h         Show this help message

Examples:
  node benchmark/coverage.js --all --unit-tests
  node benchmark/coverage.js --all --functions
  node benchmark/coverage.js '/required.json' --threshold 25
  node benchmark/coverage.js --all --unit-tests --json coverage/analysis.json`;

// Parse arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

let targetFile = null;
let allSuites = false;
let unitTests = false;
let drafts = null;
let threshold = 0;
let showFunctions = false;
let touchedOnly = false;
let iterations = null;
let jsonPath = null;
let tempDir = path.join(rootDir, 'coverage', 'tmp');

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    switch (arg) {
      case '--all':
        allSuites = true;
        break;
      case '--unit-tests':
        unitTests = true;
        break;
      case '--draft':
        drafts = args[++i];
        break;
      case '--threshold':
        threshold = parseFloat(args[++i]) || 0;
        break;
      case '--functions':
        showFunctions = true;
        break;
      case '--touched-only':
        touchedOnly = true;
        showFunctions = true; // implied
        break;
      case '--iterations':
        iterations = parseInt(args[++i], 10) || null;
        break;
      case '--json':
        jsonPath = path.resolve(args[++i]);
        break;
      case '--temp-dir':
        tempDir = path.resolve(args[++i]);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  } else if (!targetFile) {
    targetFile = arg;
  }
}

if (!targetFile && !allSuites && !unitTests) {
  console.log(USAGE);
  process.exit(1);
}
if (targetFile && allSuites) {
  console.error('Choose either a single test file or --all, not both.');
  process.exit(1);
}

// Ensure target file is properly formatted
if (targetFile && !targetFile.startsWith('/')) {
  targetFile = '/' + targetFile;
}

// Build the list of runs. Every run is a plain node command executed with
// NODE_V8_COVERAGE pointing at the shared temp directory; c8 then merges
// the raw V8 coverage of all runs (including node --test child processes)
// into one report.
const runs = [];

if (allSuites) {
  const draftList = drafts || 'draft7,draft2019-09,draft2020-12';
  const iters = iterations ?? 1;
  runs.push({
    name: `official test suite (${draftList}, ${iters} iteration${iters === 1 ? '' : 's'})`,
    cmd: [
      'node', path.join(__dirname, 'profiler.js'),
      '--profile-all',
      '--draft', draftList,
      '--iterations', String(iters),
      '--output', 'json',
      '--filepath', path.join(tempDir, 'profile-results.json'),
    ].join(' '),
  });
}
else if (targetFile) {
  const iters = iterations ?? 1000;
  runs.push({
    name: `suite file ${targetFile}${drafts ? ` (${drafts})` : ''}`,
    cmd: [
      'node', path.join(__dirname, 'debug.js'),
      `'${targetFile}'`,
      '--profile',
      '--iterations', String(iters),
      ...(drafts ? ['--draft', drafts] : []),
    ].join(' '),
  });
}

if (unitTests) {
  runs.push({
    name: 'unit tests (node --test test/**/*.test.js)',
    // Quoted so node's own glob expands it (sh treats ** as a single *)
    cmd: "node --no-warnings=ExperimentalWarning --test 'test/**/*.test.js'",
  });
}

// Clean temp directory
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true });
}
fs.mkdirSync(tempDir, { recursive: true });

console.log('='.repeat(80));
console.log('COVERAGE ANALYSIS');
console.log('='.repeat(80));
for (const run of runs) {
  console.log(`  • ${run.name}`);
}
console.log(`Threshold: ${threshold}%`);
console.log('');

// Execute all runs with V8 coverage enabled
for (const run of runs) {
  console.log(`Running: ${run.name} ...`);
  try {
    execSync(run.cmd, {
      cwd: rootDir,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: tempDir },
    });
  } catch (e) {
    // Failing assertions/tests still produce coverage; only bail when
    // nothing was written at all (e.g. the command itself is broken).
    const wrote = fs.readdirSync(tempDir).some((f) => f.startsWith('coverage-'));
    if (!wrote) {
      console.error(`Command failed without producing coverage: ${run.cmd}`);
      console.error(e.stdout || e.message);
      process.exit(1);
    }
    console.log('  (command exited non-zero; coverage was still collected)');
  }
}

// Merge all raw V8 coverage into a single istanbul JSON report.
// --all + --include makes files that were NEVER loaded appear with 0%.
const coverageFile = path.join(rootDir, 'coverage', 'coverage-final.json');
if (fs.existsSync(coverageFile)) fs.rmSync(coverageFile);

const reportCmd = [
  'npx c8 report',
  '--reporter=json',
  '--all',
  "--include 'packages/*/src/**/*.js'",
  "--exclude 'packages/website/**'",
  "--exclude 'packages/_/**'",
  `--temp-directory ${tempDir}`,
].join(' ');

console.log('\nMerging coverage ...');
try {
  execSync(reportCmd, {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
} catch (e) {
  // c8 may exit non-zero but still produce the report
}

if (!fs.existsSync(coverageFile)) {
  console.error('Error: Coverage file not generated');
  process.exit(1);
}

// Parse coverage data
const coverageData = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));

// Analyze coverage
const results = [];
const neverLoadedFiles = [];
const zeroCoverageFiles = [];
let grandTotalFunctions = 0;
let grandHitFunctions = 0;

for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
  // Skip node_modules and non-project files
  if (filePath.includes('node_modules')) continue;

  const relativePath = path.relative(rootDir, filePath);

  // Calculate function coverage
  const fnMap = fileCoverage.fnMap || {};
  const fnHits = fileCoverage.f || {};
  const totalFunctions = Object.keys(fnMap).length;

  // Calculate statement coverage
  const statementMap = fileCoverage.statementMap || {};
  const s = fileCoverage.s || {};
  const totalStatements = Object.keys(statementMap).length;
  let hitStatements = 0;
  for (const stmtId of Object.keys(statementMap)) {
    if ((s[stmtId] || 0) > 0) hitStatements++;
  }
  const statementCoveragePct = totalStatements > 0 ? (hitStatements / totalStatements) * 100 : 0;

  // Files c8 --all added without ever being loaded either have no function
  // map or a single synthetic '(empty-report)' entry; they are the
  // strongest dead-file candidates.
  const fnEntries = Object.values(fnMap);
  const neverLoaded = totalFunctions === 0
    || (fnEntries.length === 1 && fnEntries[0].name === '(empty-report)' && hitStatements === 0);
  if (neverLoaded) {
    if (hitStatements === 0) {
      neverLoadedFiles.push({ file: relativePath, statements: totalStatements });
    }
    continue;
  }

  let hitFunctions = 0;
  const fileUncoveredFunctions = [];
  const fileCoveredFunctions = [];

  for (const [fnId, fnInfo] of Object.entries(fnMap)) {
    const hitCount = fnHits[fnId] || 0;
    const fnData = {
      name: fnInfo.name || '(anonymous)',
      line: fnInfo.decl?.start?.line || fnInfo.line || '?',
      hits: hitCount,
    };
    if (hitCount > 0) {
      hitFunctions++;
      fileCoveredFunctions.push(fnData);
    } else {
      fileUncoveredFunctions.push(fnData);
    }
  }

  grandTotalFunctions += totalFunctions;
  grandHitFunctions += hitFunctions;

  const functionCoveragePct = (hitFunctions / totalFunctions) * 100;

  const entry = {
    file: relativePath,
    functionCoverage: functionCoveragePct,
    statementCoverage: statementCoveragePct,
    hitFunctions,
    totalFunctions,
    uncovered: fileUncoveredFunctions,
    coveredFunctions: fileCoveredFunctions,
  };

  if (hitFunctions === 0) {
    zeroCoverageFiles.push(entry);
    continue;
  }

  // Apply threshold filter for the main table
  if (functionCoveragePct <= threshold) continue;

  results.push(entry);
}

// Sort by function coverage (ascending: the gaps come first)
results.sort((a, b) => a.functionCoverage - b.functionCoverage);
zeroCoverageFiles.sort((a, b) => a.file.localeCompare(b.file));
neverLoadedFiles.sort((a, b) => a.file.localeCompare(b.file));

// Display results
if (results.length === 0) {
  console.log('\nNo files match the criteria.');
  console.log(`All files have <= ${threshold}% function coverage.`);
} else {
  console.log(`\nFiles with >${threshold}% function coverage (lowest first):\n`);

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
      if (r.coveredFunctions.length > 0) {
        console.log('  Functions TOUCHED during this run:');
        for (const fn of r.coveredFunctions) {
          console.log(`    ✓ ${fn.name} (line ${fn.line}) ${fn.hits}x`);
        }
      }
      if (!touchedOnly && r.uncovered.length > 0) {
        console.log('  Functions NOT touched during this run:');
        for (const fn of r.uncovered) {
          console.log(`    ✗ ${fn.name} (line ${fn.line})`);
        }
      }
      console.log('');
    }
  }
}

// Untouched function overview: the "add tests or delete?" list
const untouchedByFile = [...results, ...zeroCoverageFiles]
  .filter((r) => r.uncovered.length > 0)
  .map((r) => ({ file: r.file, functions: r.uncovered }));
const untouchedCount = untouchedByFile.reduce((sum, f) => sum + f.functions.length, 0);

if (!showFunctions && untouchedCount > 0) {
  console.log('');
  console.log('='.repeat(80));
  console.log(`UNTOUCHED FUNCTIONS (${untouchedCount}) - add tests for these, or consider removal`);
  console.log('='.repeat(80));
  for (const f of untouchedByFile) {
    console.log(`\n${f.file}:`);
    for (const fn of f.functions) {
      console.log(`    ✗ ${fn.name} (line ${fn.line})`);
    }
  }
}

if (zeroCoverageFiles.length > 0) {
  console.log('');
  console.log('='.repeat(80));
  console.log(`FILES WITH 0% FUNCTION COVERAGE (${zeroCoverageFiles.length})`);
  console.log('='.repeat(80));
  for (const f of zeroCoverageFiles) {
    console.log(`  ✗ ${f.file} (${f.totalFunctions} functions)`);
  }
}

if (neverLoadedFiles.length > 0) {
  console.log('');
  console.log('='.repeat(80));
  console.log(`FILES NEVER LOADED (${neverLoadedFiles.length}) - strongest dead-code candidates`);
  console.log('='.repeat(80));
  for (const f of neverLoadedFiles) {
    console.log(`  ✗ ${f.file}`);
  }
}

// Summary
console.log('');
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
for (const run of runs) {
  console.log(`  • ${run.name}`);
}
console.log(`Files analyzed: ${results.length + zeroCoverageFiles.length}` +
  (neverLoadedFiles.length > 0 ? ` (+${neverLoadedFiles.length} never loaded)` : ''));
if (grandTotalFunctions > 0) {
  console.log(`Functions hit: ${grandHitFunctions}/${grandTotalFunctions} ` +
    `(${((grandHitFunctions / grandTotalFunctions) * 100).toFixed(1)}%)`);
}
if (untouchedCount > 0 && !showFunctions) {
  console.log(`Untouched functions: ${untouchedCount} (listed above)`);
}

// Machine readable output
if (jsonPath) {
  const analysis = {
    generatedAt: new Date().toISOString(),
    runs: runs.map((r) => r.name),
    threshold,
    summary: {
      filesAnalyzed: results.length + zeroCoverageFiles.length,
      filesNeverLoaded: neverLoadedFiles.length,
      functionsTotal: grandTotalFunctions,
      functionsHit: grandHitFunctions,
      functionsUntouched: untouchedCount,
    },
    files: [...results, ...zeroCoverageFiles].map((r) => ({
      file: r.file,
      functionCoverage: r.functionCoverage,
      statementCoverage: r.statementCoverage,
      hitFunctions: r.hitFunctions,
      totalFunctions: r.totalFunctions,
      touched: r.coveredFunctions,
      untouched: r.uncovered,
    })),
    neverLoadedFiles,
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));
  console.log(`\nAnalysis written to ${path.relative(rootDir, jsonPath)}`);
}

console.log('');
