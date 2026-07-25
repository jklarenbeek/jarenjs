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
 *   node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12
 *   node benchmark/profiler.js --profile-all --output json --filepath results.json
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
const TEST_SUITE_DIR = './benchmark/suite/tests';

// Map draft aliases to schema draft names (for Jaren)
const DRAFT_SCHEMA_MAP = {
  'draft6': 'draft6',
  'draft7': 'draft7',
  'draft2019-09': 'draft2019-09',
  '2019': 'draft2019-09',
  'draft2020-12': 'draft2020-12',
  '2020': 'draft2020-12',
  'latest': 'latest',
  'draft-next': 'draft-next',
};

// Cache for discovered drafts
let discoveredDraftsCache = null;

/**
 * Discover available test suites from the benchmark/suite/tests folder
 * @returns {Object} Object with draft folder names as keys and info as values
 */
async function discoverAvailableDrafts() {
  if (discoveredDraftsCache) {
    return discoveredDraftsCache;
  }

  const drafts = {};

  try {
    const entries = await fs.promises.readdir(TEST_SUITE_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const folderName = entry.name;
        drafts[folderName] = {
          folder: folderName,
          isSymlink: false,
        };
      } else if (entry.isSymbolicLink()) {
        // Handle symlinks like 'latest'
        const linkPath = path.join(TEST_SUITE_DIR, entry.name);
        try {
          const target = await fs.promises.readlink(linkPath);
          const targetName = path.basename(target);
          drafts[entry.name] = {
            folder: entry.name,
            isSymlink: true,
            target: targetName,
          };
        } catch {
          // Ignore broken symlinks
        }
      }
    }
  } catch (e) {
    console.error(`Error discovering drafts from ${TEST_SUITE_DIR}:`, e.message);
  }

  discoveredDraftsCache = drafts;
  return drafts;
}

/**
 * Get the test suite folder name for a draft alias
 * @param {string} draft - Draft alias
 * @param {Object} availableDrafts - Available drafts from discoverAvailableDrafts
 * @returns {string|null} Test suite folder name or null if not found
 */
function getDraftFolder(draft, availableDrafts) {
  // First check if it's a direct folder name
  if (availableDrafts[draft]) {
    return availableDrafts[draft].folder;
  }

  // Check if it's a known alias
  const mapped = DRAFT_SCHEMA_MAP[draft];
  if (mapped && availableDrafts[mapped]) {
    return availableDrafts[mapped].folder;
  }

  // Try the draft name as-is
  return draft;
}

/**
 * Get the schema draft name for a draft alias
 * @param {string} draft - Draft alias
 * @returns {string} Schema draft name
 */
function getSchemaDraft(draft) {
  return DRAFT_SCHEMA_MAP[draft] || draft;
}

/**
 * Check if a draft is valid/supported
 * @param {string} draft - Draft name to check
 * @param {Object} availableDrafts - Available drafts from discoverAvailableDrafts
 * @returns {boolean} True if valid
 */
function isValidDraft(draft, availableDrafts) {
  if (availableDrafts[draft]) return true;
  if (DRAFT_SCHEMA_MAP[draft] && availableDrafts[DRAFT_SCHEMA_MAP[draft]]) return true;
  return false;
}

/**
 * Parse comma-separated draft list
 * @param {string} draftArg - Draft argument (e.g., "draft7" or "draft7,draft2019-09")
 * @returns {string[]} Array of draft names
 */
function parseDrafts(draftArg) {
  if (!draftArg) return [DEFAULT_TEST_DRAFT];
  return draftArg.split(',').map(d => d.trim()).filter(d => d);
}

// Parse command line arguments
async function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    targetFile: null,
    profile: false,
    profileAll: false,
    iterations: DEFAULT_ITERATIONS,
    output: 'console', // 'console', 'csv', 'json'
    verbose: false,
    topN: null, // Only show top N slowest tests
    drafts: [DEFAULT_TEST_DRAFT], // Array of draft versions to use
    successOnly: false, // Only include tests where all agents succeed
    filepath: null, // Custom output file path
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
      options.drafts = parseDrafts(args[++i]);
    } else if (arg === '--success-only') {
      options.successOnly = true;
    } else if (arg === '--filepath' || arg === '-f') {
      options.filepath = args[++i];
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
 * @param {Object} remotes - Remote schemas
 * @param {boolean} successOnly - If true, skip tests where any agent fails
 * @returns {Object} Profiling results
 */
function profileTest(test, iterations, draft, remotes, successOnly = false, suiteName = undefined) {
  // First, validate the test to check for errors/failures
  TestRunner.initialize(draft, jaren, ajv);
  TestRunner.load(remotes);
  const results = TestRunner.runTest(test, suiteName);
  const jarenResult = results.find(r => r.validator === 'Jaren');
  const ajvResult = results.find(r => r.validator === 'Ajv');

  if (!jarenResult || !ajvResult) {
    return null;
  }

  // Check for errors first
  if (jarenResult.error || ajvResult.error) {
    return {
      description: test.description,
      jarenError: jarenResult.error || null,
      ajvError: ajvResult.error || null,
      jarenFailures: 0,
      ajvFailures: 0,
    };
  }

  // If successOnly mode, skip tests where any agent has failures
  if (successOnly && (jarenResult.failures > 0 || ajvResult.failures > 0)) {
    return {
      description: test.description,
      jarenError: jarenResult.failures > 0 ? `Failed ${jarenResult.failures} assertions` : null,
      ajvError: ajvResult.failures > 0 ? `Failed ${ajvResult.failures} assertions` : null,
      jarenFailures: jarenResult.failures,
      ajvFailures: ajvResult.failures,
    };
  }

  // Determine if this is a "success" test (no failures and no errors)
  const isSuccessTest = jarenResult.failures === 0 && ajvResult.failures === 0 &&
                        !jarenResult.error && !ajvResult.error;

  // Track failures for display
  const jarenFailures = jarenResult.failures;
  const ajvFailures = ajvResult.failures;

  // Warmup phase - run a few iterations to stabilize JIT
  const jarenInstance = jaren.loader(draft, remotes);
  const ajvInstance = ajv.loader(draft, remotes);
  const jarenValidator = jaren.setup(jarenInstance, test.schema, suiteName);
  const ajvValidator = ajv.setup(ajvInstance, test.schema, suiteName);

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
    isSuccessTest,
    jarenFailures,
    ajvFailures,
  };
}

/**
 * Profile all tests in a suite file
 * @param {string} fileKey - The test file key (e.g., '/string.json')
 * @param {Object} tests - The tests object from loader
 * @param {number} iterations - Number of iterations
 * @param {string} draft - The draft version to use
 * @param {Object} remotes - Remote schemas
 * @param {boolean} successOnly - If true, skip tests where any agent fails
 * @returns {Array} Array of profiling results
 */
function profileSuite(fileKey, tests, iterations, draft, remotes, successOnly = false) {
  const results = [];

  for (const test of tests) {
    try {
      const profile = profileTest(test, iterations, draft, remotes, successOnly, fileKey);
      if (profile) {
        results.push({
          suite: fileKey,
          draft: draft,
          ...profile,
        });
      }
    } catch (e) {
      results.push({
        suite: fileKey,
        draft: draft,
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

function padStart(text, targetWidth) {
  const visualWidth = [...text].reduce((width, char) => {
    const code = char.codePointAt(0);
    // Emoji and wide characters typically take 2 cells
    return width + (code > 0x1F000 ? 2 : 1);
  }, 0);

  const padding = Math.max(0, targetWidth - visualWidth);
  return ' '.repeat(padding) + text;
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

  // Calculate success-only stats
  const successResults = validResults.filter(r => r.isSuccessTest);

  // Calculate failure/error counts per engine
  const errorResults = results.filter(r => r.error || r.jarenError || r.ajvError);
  const jarenErrors = errorResults.filter(r => r.jarenError).length;
  const ajvErrors = errorResults.filter(r => r.ajvError).length;
  const jarenFailures = validResults.filter(r => r.jarenFailures > 0).length;
  const ajvFailures = validResults.filter(r => r.ajvFailures > 0).length;

  // Combine all results for display (valid + errors), sorted by ratio
  const allDisplayResults = [...results].sort((a, b) => {
    // Put error results at the end
    const aValid = !a.error && !a.jarenError && !a.ajvError;
    const bValid = !b.error && !b.ajvError && !b.ajvError;
    if (!aValid && bValid) return 1;
    if (aValid && !bValid) return -1;
    // Both valid, sort by ratio
    if (aValid && bValid) return (b.ratio || 0) - (a.ratio || 0);
    return 0;
  });

  // Limit to top N if specified (but include errors)
  let displayResults;
  if (options.topN) {
    const topValid = sortedResults.slice(0, options.topN);
    displayResults = [...topValid, ...errorResults];
  } else {
    displayResults = allDisplayResults;
  }

  // Print summary
  console.log('\n' + '='.repeat(100));
  console.log('PERFORMANCE PROFILE SUMMARY');
  console.log('='.repeat(100));
  console.log(`Draft version: ${schemaDraft} (folder: ${folderDraft})`);
  console.log(`Total tests profiled: ${results.length}`);
  console.log(`  Valid tests: ${validResults.length}`);
  console.log(`  Tests with errors: ${errorResults.length}`);
  console.log(`Success tests (no failures/errors): ${successResults.length}`);
  console.log(`Iterations per test: ${options.iterations}`);

  // Engine-specific failure/error counts
  console.log(`\nEngine Results:`);
  console.log(`  Jaren: ${results.length - jarenErrors - jarenFailures} passed, ${jarenFailures} failed, ${jarenErrors} errors`);
  console.log(`  AJV:   ${results.length - ajvErrors - ajvFailures} passed, ${ajvFailures} failed, ${ajvErrors} errors`);

  if (validResults.length === 0) {
    console.log('\nNo valid results to display.');
    return;
  }

  // Calculate aggregate statistics (for valid results only)
  const avgRatio = validResults.reduce((sum, r) => sum + r.ratio, 0) / validResults.length;
  const minRatio = Math.min(...validResults.map(r => r.ratio));
  const maxRatio = Math.max(...validResults.map(r => r.ratio));
  const jarenWins = validResults.filter(r => r.ratio < 1.0).length;
  const tied = validResults.filter(r => r.ratio === 1.0).length;
  const ajvWins = validResults.filter(r => r.ratio > 1.0).length;

  console.log(`\nAggregate Statistics (Valid Tests):`);
  console.log(`  Average Ratio: ${avgRatio.toFixed(2)}x`);
  console.log(`  Min Ratio: ${minRatio.toFixed(2)}x`);
  console.log(`  Max Ratio: ${maxRatio.toFixed(2)}x`);
  console.log(`  Jaren faster: ${jarenWins} tests`);
  console.log(`  Tied: ${tied} tests`);
  console.log(`  AJV faster: ${ajvWins} tests`);

  // Calculate success-only statistics
  if (successResults.length > 0) {
    const successAvgRatio = successResults.reduce((sum, r) => sum + r.ratio, 0) / successResults.length;
    const successMinRatio = Math.min(...successResults.map(r => r.ratio));
    const successMaxRatio = Math.max(...successResults.map(r => r.ratio));
    const successJarenWins = successResults.filter(r => r.ratio < 1.0).length;
    const successTied = successResults.filter(r => r.ratio === 1.0).length;
    const successAjvWins = successResults.filter(r => r.ratio > 1.0).length;

    console.log(`\nSuccess Tests Only (no failures/errors):`);
    console.log(`  Count: ${successResults.length} tests`);
    console.log(`  Average Ratio: ${successAvgRatio.toFixed(2)}x`);
    console.log(`  Min Ratio: ${successMinRatio.toFixed(2)}x`);
    console.log(`  Max Ratio: ${successMaxRatio.toFixed(2)}x`);
    console.log(`  Jaren faster: ${successJarenWins} tests`);
    console.log(`  Tied: ${successTied} tests`);
    console.log(`  AJV faster: ${successAjvWins} tests`);
  }

  console.log('');

  // Print detailed results
  console.log('='.repeat(100));
  console.log('DETAILED RESULTS (sorted by ratio, slowest first; ❌ indicates failure/error)');
  console.log('='.repeat(100));

  // Print header
  const suiteWidth = 25;
  const descWidth = 40;
  const timeWidth = 12;  // Increased to accommodate ❌ prefix (3 chars: ❌ + space)
  const ratioWidth = 10; // Increased to accommodate indicator + ratio
  console.log(
    `${'Suite'.padEnd(suiteWidth)} | ` +
    `${'Test Description'.padEnd(descWidth)} | ` +
    `${'Jaren'.padStart(timeWidth)} | ` +
    `${'AJV'.padStart(timeWidth)} | ` +
    `${'Ratio'.padStart(ratioWidth)} | ` +
    `${'Diff'.padStart(10)}`
  );
  console.log('-'.repeat(123));

  // Print rows
  for (const r of displayResults) {
    const suite = r.suite.length > suiteWidth - 3
      ? r.suite.substring(0, suiteWidth - 3) + '...'
      : r.suite;
    const desc = r.description.length > descWidth - 3
      ? r.description.substring(0, descWidth - 3) + '...'
      : r.description;

    // Check for errors or failures
    const hasJarenError = r.jarenError || r.error;
    const hasAjvError = r.ajvError;
    const hasJarenFailure = r.jarenFailures > 0;
    const hasAjvFailure = r.ajvFailures > 0;

    // Format time with ❌ indicator if error or failure
    let jarenTimeStr;
    if (hasJarenError) {
      jarenTimeStr = padStart('❌ Error', timeWidth);
    } else if (hasJarenFailure) {
      jarenTimeStr = padStart(`❌ ${formatTime(r.jarenTime || 0)}`, timeWidth);
    } else {
      jarenTimeStr = padStart(formatTime(r.jarenTime || 0), timeWidth);
    }

    let ajvTimeStr;
    if (hasAjvError) {
      ajvTimeStr = padStart('❌ Error', timeWidth);
    } else if (hasAjvFailure) {
      ajvTimeStr = padStart(`❌ ${formatTime(r.ajvTime || 0)}`, timeWidth);
    } else {
      ajvTimeStr = padStart(formatTime(r.ajvTime || 0), timeWidth);
    }

    // For error rows, don't show ratio/diff
    if (hasJarenError || hasAjvError) {
      console.log(
        `${suite.padEnd(suiteWidth)} | ` +
        `${desc.padEnd(descWidth)} | ` +
        `${jarenTimeStr.padStart(timeWidth)} | ` +
        `${ajvTimeStr.padStart(timeWidth)} | ` +
        `${'-'.padStart(ratioWidth)} | ` +
        `${'-'.padStart(10)}`
      );
    } else {
      const ratioStr = r.ratio.toFixed(2) + 'x';
      const ratioIndicator = r.ratio < 1.0 ? '✓' : r.ratio > 2.0 ? '⚠' : ' ';
      const ratioCol = `${ratioIndicator} ${ratioStr.padStart(6)}`.padStart(ratioWidth);

      console.log(
        `${suite.padEnd(suiteWidth)} | ` +
        `${desc.padEnd(descWidth)} | ` +
        `${jarenTimeStr.padStart(timeWidth)} | ` +
        `${ajvTimeStr.padStart(timeWidth)} | ` +
        `${ratioCol} | ` +
        `${(r.diff > 0 ? '+' : '') + formatTime(r.diff).padStart(8)}`
      );
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

  let csv = 'Suite,Description,Assertions,Jaren Time (ms),Jaren Total (ms),AJV Time (ms),AJV Total (ms),Ratio,Diff (ms),Diff (%),Assertions/Iter,IsSuccessTest\n';

  for (const r of sortedResults) {
    csv += `"${r.suite}","${r.description.replace(/"/g, '""')}",${r.assertions},${r.jarenTime},${r.jarenTotal},${r.ajvTime},${r.ajvTotal},${r.ratio},${r.diff},${r.diffPercent},${r.testCount},${r.isSuccessTest ? 'true' : 'false'}\n`;
  }

  fs.writeFileSync(outputPath, csv);
  console.log(`CSV results written to: ${outputPath}`);
}

/**
 * Calculate summary statistics for a set of results
 * @param {Array} results - Results to calculate stats for
 * @returns {Object} Summary statistics
 */
function calculateSummaryStats(results) {
  const validResults = results.filter(r => !r.error && !r.jarenError && !r.ajvError);
  const successResults = validResults.filter(r => r.isSuccessTest);
  
  if (validResults.length === 0) {
    return {
      all: { avgRatio: 0, minRatio: 0, maxRatio: 0, jarenWins: 0, tied: 0, ajvWins: 0 },
      successOnly: null,
    };
  }
  
  return {
    all: {
      avgRatio: validResults.reduce((sum, r) => sum + r.ratio, 0) / validResults.length,
      minRatio: Math.min(...validResults.map(r => r.ratio)),
      maxRatio: Math.max(...validResults.map(r => r.ratio)),
      jarenWins: validResults.filter(r => r.ratio < 1.0).length,
      tied: validResults.filter(r => r.ratio === 1.0).length,
      ajvWins: validResults.filter(r => r.ratio > 1.0).length,
    },
    successOnly: successResults.length > 0 ? {
      avgRatio: successResults.reduce((sum, r) => sum + r.ratio, 0) / successResults.length,
      minRatio: Math.min(...successResults.map(r => r.ratio)),
      maxRatio: Math.max(...successResults.map(r => r.ratio)),
      jarenWins: successResults.filter(r => r.ratio < 1.0).length,
      tied: successResults.filter(r => r.ratio === 1.0).length,
      ajvWins: successResults.filter(r => r.ratio > 1.0).length,
    } : null,
  };
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
  const successResults = validResults.filter(r => r.isSuccessTest);
  
  // Calculate per-draft summaries
  const byDraft = {};
  const engineStats = { jaren: {}, ajv: {} };
  
  for (const draft of options.drafts) {
    const draftResults = results.filter(r => r.draft === draft);
    const draftErrors = draftResults.filter(r => r.error || r.jarenError || r.ajvError);
    const draftValidResults = draftResults.filter(r => !r.error && !r.jarenError && !r.ajvError);
    const draftSuccessResults = draftValidResults.filter(r => r.isSuccessTest);
    
    // Calculate timing totals for this draft
    // Total time = all tests (including errors and failures)
    const jarenTotalTime = draftResults.reduce((sum, r) => sum + (r.jarenTotal || 0), 0);
    const ajvTotalTime = draftResults.reduce((sum, r) => sum + (r.ajvTotal || 0), 0);
    // Success time = only tests with no errors AND no failures
    const jarenSuccessTime = draftSuccessResults.reduce((sum, r) => sum + (r.jarenTotal || 0), 0);
    const ajvSuccessTime = draftSuccessResults.reduce((sum, r) => sum + (r.ajvTotal || 0), 0);
    
    byDraft[draft] = {
      totalTests: draftResults.length,
      validTests: draftValidResults.length,
      successTests: draftSuccessResults.length,
      jarenTotalTime,
      ajvTotalTime,
      jarenSuccessTime,
      ajvSuccessTime,
      jarenErrors: draftErrors.filter(r => r.jarenError).length,
      ajvErrors: draftErrors.filter(r => r.ajvError).length,
      jarenFailures: draftValidResults.filter(r => r.jarenFailures > 0).length,
      ajvFailures: draftValidResults.filter(r => r.ajvFailures > 0).length,
      ...calculateSummaryStats(draftResults),
    };
    
    engineStats.jaren[draft] = {
      passed: draftResults.length - draftErrors.filter(r => r.jarenError).length - draftValidResults.filter(r => r.jarenFailures > 0).length,
      failed: draftValidResults.filter(r => r.jarenFailures > 0).length,
      errors: draftErrors.filter(r => r.jarenError).length,
    };
    engineStats.ajv[draft] = {
      passed: draftResults.length - draftErrors.filter(r => r.ajvError).length - draftValidResults.filter(r => r.ajvFailures > 0).length,
      failed: draftValidResults.filter(r => r.ajvFailures > 0).length,
      errors: draftErrors.filter(r => r.ajvError).length,
    };
  }

  // Calculate overall timing totals
  // Total time = all tests (including errors and failures)
  const jarenTotalTime = results.reduce((sum, r) => sum + (r.jarenTotal || 0), 0);
  const ajvTotalTime = results.reduce((sum, r) => sum + (r.ajvTotal || 0), 0);
  // Success time = only tests with no errors AND no failures
  const jarenSuccessTime = successResults.reduce((sum, r) => sum + (r.jarenTotal || 0), 0);
  const ajvSuccessTime = successResults.reduce((sum, r) => sum + (r.ajvTotal || 0), 0);

  const output = {
    metadata: {
      timestamp: new Date().toISOString(),
      iterations: options.iterations,
      warmupIterations: WARMUP_ITERATIONS,
      totalTests: results.length,
      validTests: validResults.length,
      successTests: successResults.length,
      drafts: options.drafts,
    },
    summary: {
      overall: {
        jarenTotalTime,
        ajvTotalTime,
        jarenSuccessTime,
        ajvSuccessTime,
        jarenErrors: results.filter(r => r.jarenError).length,
        ajvErrors: results.filter(r => r.ajvError).length,
        jarenFailures: validResults.filter(r => r.jarenFailures > 0).length,
        ajvFailures: validResults.filter(r => r.ajvFailures > 0).length,
        ...calculateSummaryStats(results),
      },
      byDraft,
      engineStats,
    },
    results: sortedResults,
    errors: results.filter(r => r.error || r.jarenError || r.ajvError),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`JSON results written to: ${outputPath}`);
}

/**
 * Profile a single draft version
 * @param {string} draft - Draft version to profile
 * @param {Object} options - Profiling options
 * @param {Object} availableDrafts - Available drafts from discoverAvailableDrafts
 * @returns {Array} Results for this draft
 */
async function profileDraft(draft, options, availableDrafts) {
  const schemaDraft = getSchemaDraft(draft);
  const folderDraft = getDraftFolder(draft, availableDrafts);

  if (!folderDraft) {
    console.error(`Draft '${draft}' not found in available test suites.`);
    return [];
  }

  // Load tests
  const allTests = await loadTestSuiteJson(folderDraft);
  const remotes = await loadRemoteJson();

  let results = [];

  if (options.profileAll) {
    console.log(`\nProfiling ${draft} with ${options.iterations} iterations each...`);

    const suiteKeys = Object.keys(allTests).sort();
    let completedSuites = 0;

    for (const fileKey of suiteKeys) {
      if (options.verbose) {
        console.log(`Profiling ${fileKey}...`);
      }
      const suiteResults = profileSuite(fileKey, allTests[fileKey], options.iterations, schemaDraft, remotes, options.successOnly);
      results.push(...suiteResults);
      completedSuites++;

      if (!options.verbose) {
        process.stdout.write(`\r  Progress: ${completedSuites}/${suiteKeys.length} suites completed`);
      }
    }
    console.log('');
  } else if (options.profile && options.targetFile) {
    const fileKey = options.targetFile.startsWith('/') ? options.targetFile : '/' + options.targetFile;

    if (!allTests[fileKey]) {
      console.error(`Test file '${fileKey}' not found.`);
      console.log('Available test files:');
      Object.keys(allTests).forEach(key => console.log(`  ${key}`));
      process.exit(1);
    }

    console.log(`Profiling ${fileKey} with ${options.iterations} iterations (${draft})...\n`);
    results = profileSuite(fileKey, allTests[fileKey], options.iterations, schemaDraft, remotes, options.successOnly);
  }

  return results;
}

/**
 * Main profiling function
 */
async function main() {
  const options = await parseArgs();
  const availableDrafts = await discoverAvailableDrafts();

  // Validate draft options
  const invalidDrafts = options.drafts.filter(d => !isValidDraft(d, availableDrafts));
  if (invalidDrafts.length > 0) {
    console.error(`Error: Unsupported draft(s): ${invalidDrafts.join(', ')}`);
    console.error(`Available test suites: ${Object.keys(availableDrafts).join(', ')}`);
    console.error(`Supported aliases: ${Object.keys(DRAFT_SCHEMA_MAP).join(', ')}`);
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
    console.log('  node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12');
    console.log('  node benchmark/profiler.js --profile-all --output json --filepath results.json');
    console.log('');
    console.log('Options:');
    console.log('  --profile              Profile a specific test file');
    console.log('  --profile-all          Profile all test files');
    console.log('  --iterations, -i N     Number of iterations (default: 1000)');
    console.log('  --output, -o FORMAT    Output format: console, csv, json (default: console)');
    console.log('  --draft, -d VERSION    JSON Schema draft version(s), comma-separated');
    console.log(`                         (default: ${DEFAULT_TEST_DRAFT})`);
    console.log(`                         Available: ${Object.keys(availableDrafts).join(', ')}`);
    console.log(`                         Aliases: ${Object.keys(DRAFT_SCHEMA_MAP).join(', ')}`);
    console.log('  --filepath, -f PATH    Output file path (for csv/json output)');
    console.log('                         Default: benchmark/results/profile-{timestamp}.{ext}');
    console.log('  --top N                Show only top N slowest tests');
    console.log('  --success-only         Exclude tests where any agent fails or errors');
    console.log('  --verbose, -v          Verbose output');
    process.exit(1);
  }

  // Profile all specified drafts
  const allResults = [];

  for (const draft of options.drafts) {
    const draftResults = await profileDraft(draft, options, availableDrafts);

    // For console output, print immediately per draft
    if (options.output === 'console') {
      const schemaDraft = getSchemaDraft(draft);
      const folderDraft = getDraftFolder(draft, availableDrafts);
      printConsoleTable(draftResults, options, schemaDraft, folderDraft);
    }

    allResults.push(...draftResults);
  }

  // Output results (for non-console formats)
  if (options.output === 'csv') {
    let outputPath;
    if (options.filepath) {
      outputPath = options.filepath;
      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      const outputDir = path.join('benchmark', 'results');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      outputPath = path.join(outputDir, `profile-${timestamp}.csv`);
    }
    exportCsv(allResults, outputPath);
  } else if (options.output === 'json') {
    let outputPath;
    if (options.filepath) {
      outputPath = options.filepath;
      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      const outputDir = path.join('benchmark', 'results');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      outputPath = path.join(outputDir, `profile-${timestamp}.json`);
    }
    exportJson(allResults, outputPath, options);
  } else {
    // Console output already printed per draft above
    if (options.drafts.length > 1) {
      console.log(`\nTotal tests across ${options.drafts.length} drafts: ${allResults.filter(r => !r.error && !r.jarenError && !r.ajvError).length}`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
