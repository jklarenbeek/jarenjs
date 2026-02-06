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
 *   
 * Options:
 *   --threshold <n>    Filter out files with coverage <= n% (default: 0)
 *   --functions        Show TOUCHED and NOT touched functions with hit counts
 *   --touched-only     Show only TOUCHED functions (hides NOT touched)
 *   --iterations <n>   Number of profiling iterations (default: 1000)
 *   --temp-dir <dir>   Temporary directory for c8 coverage data (default: coverage/tmp)
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

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Check for help first
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node benchmark/coverage.js <testfile.json> [options]`);
  console.log('');
  console.log('Options:');
  console.log('  --threshold <n>    Filter out files with coverage <= n% (default: 0)');
  console.log('  --functions        Show individual function-level coverage');
  console.log('  --touched-only     Show only TOUCHED functions (hides NOT touched)');
  console.log('  --iterations <n>   Number of profiling iterations (default: 1000)');
  console.log('  --temp-dir <dir>   Temporary directory for c8 (default: coverage/tmp)');
  console.log('  --help, -h         Show this help message');
  console.log('');
  console.log('Examples:');
  console.log(`  node benchmark/coverage.js '/required.json'`);
  console.log(`  node benchmark/coverage.js '/required.json' --threshold 25`);
  console.log(`  node benchmark/coverage.js '/required.json' --functions`);
  console.log(`  node benchmark/coverage.js '/required.json' --touched-only`);
  process.exit(0);
}

// Parse arguments
let targetFile = null;
let threshold = 0;
let showFunctions = false;
let touchedOnly = false;
let iterations = 1000;
let tempDir = path.join(rootDir, 'coverage', 'tmp');

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    switch (arg) {
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
        iterations = parseInt(args[++i], 10) || 1000;
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

if (!targetFile) {
  console.log(`Usage: node benchmark/coverage.js <testfile.json> [options]`);
  console.log('');
  console.log('Options:');
  console.log('  --threshold <n>    Filter out files with coverage <= n% (default: 0)');
  console.log('  --functions        Show individual function-level coverage');
  console.log('  --touched-only     Show only TOUCHED functions (hides NOT touched)');
  console.log('  --iterations <n>   Number of profiling iterations (default: 1000)');
  console.log('  --temp-dir <dir>   Temporary directory for c8 (default: coverage/tmp)');
  console.log('  --help, -h         Show this help message');
  console.log('');
  console.log('Examples:');
  console.log(`  node benchmark/coverage.js '/required.json'`);
  console.log(`  node benchmark/coverage.js '/required.json' --threshold 25`);
  console.log(`  node benchmark/coverage.js '/required.json' --functions`);
  console.log(`  node benchmark/coverage.js '/required.json' --touched-only`);
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

// Run c8 with profiler
console.log('='.repeat(80));
console.log(`COVERAGE ANALYSIS: ${targetFile}`);
console.log('='.repeat(80));
console.log(`Iterations: ${iterations}`);
console.log(`Threshold: ${threshold}%`);
console.log('');

const c8Cmd = [
  'npx c8',
  '--reporter=json',
  '--all',
  '--exclude packages/_',
  '--exclude test/',
  '--exclude coverage/',
  `--temp-directory ${tempDir}`,
  '--clean',
  `node ${path.join(__dirname, 'debug.js')}`,
  `'${targetFile}'`,
  '--profile',
  `--iterations ${iterations}`
].join(' ');

try {
  execSync(c8Cmd, {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8'
  });
} catch (e) {
  // c8 may exit with error code but still produce coverage
}

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
  console.log('(Use --threshold 0 to include these)');
}

console.log('');
