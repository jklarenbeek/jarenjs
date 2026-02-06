#!/usr/bin/env node

/**
 * JarenJS Performance Profiler
 * 
 * Profiles Jaren vs AJV performance on JSON Schema Test Suite tests.
 * 
 * Usage:
 *   node benchmark/profiler.js '/string.json' --profile
 *   node benchmark/profiler.js '/string.json' --profile --iterations 5000
 *   node benchmark/profiler.js --profile-all
 *   node benchmark/profiler.js --profile-all --output csv
 *   node benchmark/profiler.js --profile-all --output json
 */

import { loadTestSuiteJson, loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TEST_DRAFT = 'draft7';
const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

// Supported draft versions
const SUPPORTED_DRAFTS = ['draft6', 'draft7', 'draft2019-09', '2019', 'draft2020-12', '2020'];

// Map draft aliases to test suite folder names
const DRAFT_FOLDER_MAP = {
  'draft6': 'draft6',
  'draft7': 'draft7',
  'draft2019-09': 'draft2019-09',
  '2019': 'draft2019-09',
  'draft2020-12': 'draft2020-12',
  '2020': 'draft2020-12',
};

// Map draft aliases to schema draft names (for Jaren)
const DRAFT_SCHEMA_MAP = {
  'draft6': 'draft6',
  'draft7': 'draft7',
  'draft2019-09': 'draft2019-09',
  '2019': '2019',
  'draft2020-12': 'draft2020-12',
  '2020': '2020',
};

/**
 * Get the test suite folder name for a draft alias
 * @param {string} draft - Draft alias
 * @returns {string} Test suite folder name
 */
function getDraftFolder(draft) {
  return DRAFT_FOLDER_MAP[draft] || draft;
}

/**
 * Get the schema draft name for a draft alias
 * @param {string} draft - Draft alias
 * @returns {string} Schema draft name
 */
function getSchemaDraft(draft) {
  return DRAFT_SCHEMA_MAP[draft] || draft;
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    targetFile: null,
    profile: false,
    profileAll: false,
    iterations: DEFAULT_ITERATIONS,
    output: 'console', // 'console', 'csv', 'json'
    verbose: false,
    topN: null, // Only show top N slowest tests
    draft: DEFAULT_TEST_DRAFT, // Draft version to use
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--profile') {
      options.profile = true;
    } else if (arg === '--profile-all') {
      options.profileAll = true;
    } else if (arg === '--iterations' || arg === '-i') {
      options.iterations = parseInt(args[++i], 10) || DEFAULT_ITERATIONS;
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i] || 'console';
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--top') {
      options.topN = parseInt(args[++i], 10) || null;
    } else if (arg === '--draft' || arg === '-d') {
      options.draft = args[++i] || DEFAULT_TEST_DRAFT;
    } else if (!arg.startsWith('--')) {
      options.targetFile = arg;
    }
  }

  return options;
}

/**
 * Profile a single test with multiple iterations
 * @param {Object} test - The test object from test suite
 * @param {number} iterations - Number of iterations to run
 * @param {string} draft - The draft version to use
 * @returns {Object} Profiling results
 */
function profileTest(test, iterations, draft, remotes) {
  const results = TestRunner.runTest(test);
  const jarenResult = results.find(r => r.validator === 'Jaren');
  const ajvResult = results.find(r => r.validator === 'Ajv');

  if (!jarenResult || !ajvResult) {
    return null;
  }

  if (jarenResult.error || ajvResult.error) {
    return {
      description: test.description,
      jarenError: jarenResult.error || null,
      ajvError: ajvResult.error || null,
    };
  }

  // Warmup phase - run a few iterations to stabilize JIT
  const jarenInstance = jaren.loader(draft, remotes);
  const ajvInstance = ajv.loader(draft, remotes);
  const jarenValidator = jaren.setup(jarenInstance, test.schema);
  const ajvValidator = ajv.setup(ajvInstance, test.schema);

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    for (const item of test.tests) {
      jaren.run(jarenValidator, item.data);
      ajv.run(ajvValidator, item.data);
    }
  }

  // Profile Jaren
  const jarenStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const item of test.tests) {
      jaren.run(jarenValidator, item.data);
    }
  }
  const jarenEnd = performance.now();
  const jarenTotalTime = jarenEnd - jarenStart;
  const jarenPerIteration = jarenTotalTime / iterations;

  // Profile AJV
  const ajvStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const item of test.tests) {
      ajv.run(ajvValidator, item.data);
    }
  }
  const ajvEnd = performance.now();
  const ajvTotalTime = ajvEnd - ajvStart;
  const ajvPerIteration = ajvTotalTime / iterations;

  // Calculate statistics
  const ratio = ajvPerIteration > 0 ? jarenPerIteration / ajvPerIteration : 0;
  const diff = jarenPerIteration - ajvPerIteration;
  const diffPercent = ajvPerIteration > 0 ? (diff / ajvPerIteration) * 100 : 0;

  return {
    description: test.description,
    assertions: test.tests.length,
    jarenTime: jarenPerIteration,
    jarenTotal: jarenTotalTime,
    ajvTime: ajvPerIteration,
    ajvTotal: ajvTotalTime,
    ratio,
    diff,
    diffPercent,
    testCount: test.tests.length,
  };
}

/**
 * Profile all tests in a suite file
 * @param {string} fileKey - The test file key (e.g., '/string.json')
 * @param {Object} tests - The tests object from loader
 * @param {number} iterations - Number of iterations
 * @param {string} draft - The draft version to use
 * @returns {Array} Array of profiling results
 */
function profileSuite(fileKey, tests, iterations, draft, remotes) {
  const results = [];
  
  for (const test of tests) {
    try {
      const profile = profileTest(test, iterations, draft, remotes);
      if (profile) {
        results.push({
          suite: fileKey,
          ...profile,
        });
      }
    } catch (e) {
      results.push({
        suite: fileKey,
        description: test.description,
        error: e.message,
      });
    }
  }

  return results;
}

/**
 * Format time in appropriate units
 * @param {number} timeMs - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatTime(timeMs) {
  if (timeMs < 0.001) {
    return `${(timeMs * 1000000).toFixed(2)} ns`;
  } else if (timeMs < 1) {
    return `${(timeMs * 1000).toFixed(2)} μs`;
  } else {
    return `${timeMs.toFixed(2)} ms`;
  }
}

/**
 * Print results to console in table format
 * @param {Array} results - Profiling results
 * @param {Object} options - Output options
 * @param {string} schemaDraft - The schema draft version
 * @param {string} folderDraft - The test suite folder name
 */
function printConsoleTable(results, options, schemaDraft, folderDraft) {
  // Filter out errors and sort by ratio (slowest first)
  const validResults = results.filter(r => !r.error && !r.jarenError && !r.ajvError);
  const sortedResults = validResults.sort((a, b) => b.ratio - a.ratio);

  // Limit to top N if specified
  const displayResults = options.topN ? sortedResults.slice(0, options.topN) : sortedResults;

  // Print summary
  console.log('\n' + '='.repeat(100));
  console.log('PERFORMANCE PROFILE SUMMARY');
  console.log('='.repeat(100));
  console.log(`Draft version: ${schemaDraft} (folder: ${folderDraft})`);
  console.log(`Total tests profiled: ${validResults.length}`);
  console.log(`Iterations per test: ${options.iterations}`);
  console.log(`Tests with errors: ${results.length - validResults.length}`);
  
  if (validResults.length === 0) {
    console.log('\nNo valid results to display.');
    return;
  }

  // Calculate aggregate statistics
  const avgRatio = validResults.reduce((sum, r) => sum + r.ratio, 0) / validResults.length;
  const minRatio = Math.min(...validResults.map(r => r.ratio));
  const maxRatio = Math.max(...validResults.map(r => r.ratio));
  const jarenWins = validResults.filter(r => r.ratio < 1.0).length;
  const tied = validResults.filter(r => r.ratio === 1.0).length;
  const ajvWins = validResults.filter(r => r.ratio > 1.0).length;

  console.log(`\nAggregate Statistics:`);
  console.log(`  Average Ratio: ${avgRatio.toFixed(2)}x`);
  console.log(`  Min Ratio: ${minRatio.toFixed(2)}x`);
  console.log(`  Max Ratio: ${maxRatio.toFixed(2)}x`);
  console.log(`  Jaren faster: ${jarenWins} tests`);
  console.log(`  Tied: ${tied} tests`);
  console.log(`  AJV faster: ${ajvWins} tests`);
  console.log('');

  // Print detailed results
  console.log('='.repeat(100));
  console.log('DETAILED RESULTS (sorted by ratio, slowest first)');
  console.log('='.repeat(100));

  // Print header
  const suiteWidth = 25;
  const descWidth = 40;
  console.log(
    `${'Suite'.padEnd(suiteWidth)} | ` +
    `${'Test Description'.padEnd(descWidth)} | ` +
    `${'Jaren'.padStart(10)} | ` +
    `${'AJV'.padStart(10)} | ` +
    `${'Ratio'.padStart(8)} | ` +
    `${'Diff'.padStart(10)}`
  );
  console.log('-'.repeat(115));

  // Print rows
  for (const r of displayResults) {
    const suite = r.suite.length > suiteWidth - 3 
      ? r.suite.substring(0, suiteWidth - 3) + '...'
      : r.suite;
    const desc = r.description.length > descWidth - 3 
      ? r.description.substring(0, descWidth - 3) + '...'
      : r.description;
    
    const ratioStr = r.ratio.toFixed(2) + 'x';
    const ratioIndicator = r.ratio < 1.0 ? '✓' : r.ratio > 2.0 ? '⚠' : ' ';
    
    console.log(
      `${suite.padEnd(suiteWidth)} | ` +
      `${desc.padEnd(descWidth)} | ` +
      `${formatTime(r.jarenTime).padStart(10)} | ` +
      `${formatTime(r.ajvTime).padStart(10)} | ` +
      `${ratioIndicator} ${ratioStr.padStart(6)} | ` +
      `${(r.diff > 0 ? '+' : '') + formatTime(r.diff).padStart(8)}`
    );
  }

  // Print errors if any
  const errorResults = results.filter(r => r.error || r.jarenError || r.ajvError);
  if (errorResults.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('ERRORS');
    console.log('='.repeat(100));
    for (const r of errorResults) {
      console.log(`\n${r.suite} - ${r.description}:`);
      if (r.error) console.log(`  Profile error: ${r.error}`);
      if (r.jarenError) console.log(`  Jaren error: ${r.jarenError}`);
      if (r.ajvError) console.log(`  AJV error: ${r.ajvError}`);
    }
  }

  console.log('\n');
}

/**
 * Export results to CSV format
 * @param {Array} results - Profiling results
 * @param {string} outputPath - Output file path
 */
function exportCsv(results, outputPath) {
  const validResults = results.filter(r => !r.error && !r.jarenError && !r.ajvError);
  const sortedResults = validResults.sort((a, b) => b.ratio - a.ratio);

  let csv = 'Suite,Description,Assertions,Jaren Time (ms),Jaren Total (ms),AJV Time (ms),AJV Total (ms),Ratio,Diff (ms),Diff (%),Assertions/Iter\n';
  
  for (const r of sortedResults) {
    csv += `"${r.suite}","${r.description.replace(/"/g, '""')}",${r.assertions},${r.jarenTime},${r.jarenTotal},${r.ajvTime},${r.ajvTotal},${r.ratio},${r.diff},${r.diffPercent},${r.testCount}\n`;
  }

  fs.writeFileSync(outputPath, csv);
  console.log(`CSV results written to: ${outputPath}`);
}

/**
 * Export results to JSON format
 * @param {Array} results - Profiling results
 * @param {string} outputPath - Output file path
 * @param {Object} options - Options for metadata
 */
function exportJson(results, outputPath, options) {
  const validResults = results.filter(r => !r.error && !r.jarenError && !r.ajvError);
  const sortedResults = validResults.sort((a, b) => b.ratio - a.ratio);

  const output = {
    metadata: {
      timestamp: new Date().toISOString(),
      iterations: options.iterations,
      warmupIterations: WARMUP_ITERATIONS,
      totalTests: results.length,
      validTests: validResults.length,
    },
    summary: {
      avgRatio: validResults.reduce((sum, r) => sum + r.ratio, 0) / validResults.length,
      minRatio: Math.min(...validResults.map(r => r.ratio)),
      maxRatio: Math.max(...validResults.map(r => r.ratio)),
      jarenWins: validResults.filter(r => r.ratio < 1.0).length,
      tied: validResults.filter(r => r.ratio === 1.0).length,
      ajvWins: validResults.filter(r => r.ratio > 1.0).length,
    },
    results: sortedResults,
    errors: results.filter(r => r.error || r.jarenError || r.ajvError),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`JSON results written to: ${outputPath}`);
}

/**
 * Main profiling function
 */
async function main() {
  const options = parseArgs();

  // Validate draft option
  if (!SUPPORTED_DRAFTS.includes(options.draft)) {
    console.error(`Error: Unsupported draft '${options.draft}'`);
    console.error(`Supported drafts: ${SUPPORTED_DRAFTS.join(', ')}`);
    process.exit(1);
  }

  // Validate options
  if (!options.profile && !options.profileAll) {
    console.log('Usage:');
    console.log('  node benchmark/profiler.js \'/string.json\' --profile');
    console.log('  node benchmark/profiler.js \'/string.json\' --profile --iterations 5000');
    console.log('  node benchmark/profiler.js --profile-all');
    console.log('  node benchmark/profiler.js --profile-all --output csv');
    console.log('  node benchmark/profiler.js --profile-all --output json');
    console.log('');
    console.log('Options:');
    console.log('  --profile              Profile a specific test file');
    console.log('  --profile-all          Profile all test files');
    console.log('  --iterations, -i N     Number of iterations (default: 1000)');
    console.log('  --output, -o FORMAT    Output format: console, csv, json (default: console)');
    console.log('  --draft, -d VERSION    JSON Schema draft version (default: draft7)');
    console.log('                         Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020');
    console.log('  --top N                Show only top N slowest tests');
    console.log('  --verbose, -v          Verbose output');
    process.exit(1);
  }

  // Get the proper draft names for different purposes
  const schemaDraft = getSchemaDraft(options.draft);
  const folderDraft = getDraftFolder(options.draft);

  // Initialize test runner
  TestRunner.initialize(schemaDraft, jaren, ajv);
  const remotes = await loadRemoteJson(folderDraft);
  TestRunner.load(remotes);

  // Load tests
  const allTests = await loadTestSuiteJson(folderDraft);

  let results = [];

  if (options.profileAll) {
    console.log(`Profiling all test suites with ${options.iterations} iterations each...`);
    console.log('This may take a while...\n');

    const suiteKeys = Object.keys(allTests).sort();
    let completedSuites = 0;

    for (const fileKey of suiteKeys) {
      if (options.verbose) {
        console.log(`Profiling ${fileKey}...`);
      }
      const suiteResults = profileSuite(fileKey, allTests[fileKey], options.iterations, schemaDraft, remotes);
      results.push(...suiteResults);
      completedSuites++;
      
      if (!options.verbose) {
        process.stdout.write(`\rProgress: ${completedSuites}/${suiteKeys.length} suites completed`);
      }
    }
    console.log('\n');
  } else if (options.profile && options.targetFile) {
    const fileKey = options.targetFile.startsWith('/') ? options.targetFile : '/' + options.targetFile;
    
    if (!allTests[fileKey]) {
      console.error(`Test file '${fileKey}' not found.`);
      console.log('Available test files:');
      Object.keys(allTests).forEach(key => console.log(`  ${key}`));
      process.exit(1);
    }

    console.log(`Profiling ${fileKey} with ${options.iterations} iterations (draft: ${schemaDraft})...\n`);
    results = profileSuite(fileKey, allTests[fileKey], options.iterations, schemaDraft);
  } else {
    console.error('Error: Must specify a test file with --profile, or use --profile-all');
    process.exit(1);
  }

  // Output results
  if (options.output === 'csv') {
    const outputDir = path.join('benchmark', 'results');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    exportCsv(results, path.join(outputDir, `profile-${timestamp}.csv`));
  } else if (options.output === 'json') {
    const outputDir = path.join('benchmark', 'results');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    exportJson(results, path.join(outputDir, `profile-${timestamp}.json`), options);
  } else {
    printConsoleTable(results, options, schemaDraft, folderDraft);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
