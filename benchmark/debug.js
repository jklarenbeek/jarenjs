#!/usr/bin/env node

/**
 * JarenJS Debug Tool
 * 
 * A powerful debugging utility for investigating test failures and understanding
 * schema validation behavior. This tool focuses on detailed test inspection,
 * assertion-level debugging, and test case discovery.
 * 
 * IMPORTANT: This tool does NOT measure performance (use profiler.js for that),
 * does NOT analyze code coverage (use coverage.js for that), and does NOT
 * generate call graphs (use callgraph.js for that).
 * 
 * Usage:
 *   # List all available test files for a draft
 *   node benchmark/debug.js --list-files --draft 2019
 * 
 *   # List all test cases in a file
 *   node benchmark/debug.js '/anchor.json' --list --draft 2019
 * 
 *   # Run all tests in a file with a specific draft
 *   node benchmark/debug.js '/anchor.json' --draft 2019
 * 
 *   # Run a specific test by description
 *   node benchmark/debug.js '/anchor.json' 'same $anchor with different base uri' --draft 2019
 * 
 *   # Run a specific test by index
 *   node benchmark/debug.js '/anchor.json' --index 3 --draft 2019
 * 
 *   # Export test suite JSON to file
 *   node benchmark/debug.js '/anchor.json' --export anchor-tests.json --draft 2019
 * 
 *   # Show detailed validation errors
 *   node benchmark/debug.js '/ref.json' 'nested refs' --show-errors --draft 7
 * 
 *   # Interactive mode - step through assertions one by one
 *   node benchmark/debug.js '/ref.json' 'nested refs' --interactive --draft 7
 * 
 *   # Show schema and data without running tests (dry run)
 *   node benchmark/debug.js '/anchor.json' --dry-run --draft 2019
 * 
 *   # Compare Jaren vs AJV in detail
 *   node benchmark/debug.js '/ref.json' 'nested refs' --compare --draft 7
 * 
 * Options:
 *   --draft, -d <version>    JSON Schema draft version (default: draft7)
 *                            Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020
 *   --list, -l               List all test cases in the file
 *   --list-files             List all available test files for the draft
 *   --index, -i <n>          Select test case by index (0-based)
 *   --export <filepath>      Export test suite JSON to file
 *   --export-test <filepath> Export specific test case JSON to file
 *   --show-errors, -e        Show detailed validation error messages
 *   --interactive, -I        Interactive mode - step through assertions
 *   --dry-run                Show schema and data without running validation
 *   --compare, -c            Show detailed Jaren vs AJV comparison per assertion
 *   --jaren-only             Only run Jaren (skip AJV)
 *   --ajv-only               Only run AJV (skip Jaren)
 *   --verbose, -v            Show full schema, data, and results
 *   --silent, -s             Minimal output (errors only)
 *   --color, --no-color      Enable/disable colored output
 *   --help, -h               Show this help message
 */

import { loadTestSuiteJson, loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';
import fs from 'fs';
import path from 'path';

// Draft version mapping
const DRAFT_MAP = {
  'draft6': 'draft6',
  '6': 'draft6',
  'draft7': 'draft7',
  '7': 'draft7',
  'draft2019-09': 'draft2019-09',
  '2019': 'draft2019-09',
  'draft2020-12': 'draft2020-12',
  '2020': 'draft2020-12',
};

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

let useColors = true;

function color(name, text) {
  if (!useColors) return text;
  return `${COLORS[name] || ''}${text}${COLORS.reset}`;
}

function printDivider() {
  console.log('='.repeat(80));
}

function printSection(title) {
  console.log('');
  console.log(color('bright', `## ${title}`));
  console.log(color('dim', '-'.repeat(40)));
}

function formatResult(result, expected) {
  if (result === expected) {
    return color('green', '✓ PASS');
  } else {
    return color('red', '✗ FAIL');
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    targetFile: null,
    targetDesc: null,
    draft: 'draft7',
    list: false,
    listFiles: false,
    index: null,
    exportPath: null,
    exportTestPath: null,
    showErrors: false,
    interactive: false,
    dryRun: false,
    compare: false,
    jarenOnly: false,
    ajvOnly: false,
    verbose: false,
    silent: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--draft' || arg === '-d') {
      const draftArg = args[++i];
      options.draft = DRAFT_MAP[draftArg] || draftArg || 'draft7';
    } else if (arg === '--list' || arg === '-l') {
      options.list = true;
    } else if (arg === '--list-files') {
      options.listFiles = true;
    } else if (arg === '--index' || arg === '-i') {
      options.index = parseInt(args[++i], 10);
    } else if (arg === '--export') {
      options.exportPath = args[++i];
    } else if (arg === '--export-test') {
      options.exportTestPath = args[++i];
    } else if (arg === '--show-errors' || arg === '-e') {
      options.showErrors = true;
    } else if (arg === '--interactive' || arg === '-I') {
      options.interactive = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--compare' || arg === '-c') {
      options.compare = true;
    } else if (arg === '--jaren-only') {
      options.jarenOnly = true;
    } else if (arg === '--ajv-only') {
      options.ajvOnly = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--silent' || arg === '-s') {
      options.silent = true;
    } else if (arg === '--color') {
      useColors = true;
    } else if (arg === '--no-color') {
      useColors = false;
    }
    // Backward compatibility flags (used by coverage.js)
    else if (arg === '--profile') {
      // Ignored - for backward compatibility with coverage.js
    } else if (arg === '--iterations') {
      // Ignored - for backward compatibility with coverage.js
      i++; // Skip the iterations count
    } else if (!arg.startsWith('--') && !options.targetFile) {
      options.targetFile = arg;
    } else if (!arg.startsWith('--') && !options.targetDesc) {
      options.targetDesc = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`JarenJS Debug Tool

A powerful debugging utility for investigating test failures and understanding
schema validation behavior.

${color('bright', 'USAGE:')}
  node benchmark/debug.js [options] [<testfile.json>] [test-description]

${color('bright', 'COMMANDS:')}
  # List all available test files for a draft
  node benchmark/debug.js --list-files --draft 2019

  # List all test cases in a file
  node benchmark/debug.js '/anchor.json' --list --draft 2019

  # Run all tests in a file with a specific draft
  node benchmark/debug.js '/anchor.json' --draft 2019

  # Run a specific test by description
  node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019

  # Run a specific test by index
  node benchmark/debug.js '/anchor.json' --index 3 --draft 2019

  # Export test suite JSON to file
  node benchmark/debug.js '/anchor.json' --export anchor-tests.json --draft 2019

  # Show detailed validation errors
  node benchmark/debug.js '/ref.json' 'nested refs' --show-errors --draft 7

  # Interactive mode - step through assertions
  node benchmark/debug.js '/ref.json' 'nested refs' --interactive --draft 7

  # Show schema and data without running (dry run)
  node benchmark/debug.js '/anchor.json' --dry-run --draft 2019

  # Compare Jaren vs AJV per assertion
  node benchmark/debug.js '/ref.json' 'nested refs' --compare --draft 7

${color('bright', 'OPTIONS:')}
  --draft, -d <version>    JSON Schema draft (default: draft7)
                           Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020
  --list, -l               List all test cases in the file
  --list-files             List all available test files for the draft
  --index, -i <n>          Select test case by index (0-based)
  --export <filepath>      Export test suite JSON to file
  --export-test <filepath> Export specific test case JSON to file
  --show-errors, -e        Show detailed validation error messages
  --interactive, -I        Interactive mode - step through assertions
  --dry-run                Show schema and data without running validation
  --compare, -c            Show detailed Jaren vs AJV comparison per assertion
  --jaren-only             Only run Jaren (skip AJV)
  --ajv-only               Only run AJV (skip Jaren)
  --verbose, -v            Show full schema, data, and results
  --silent, -s             Minimal output (errors only)
  --color, --no-color      Enable/disable colored output
  --help, -h               Show this help message

${color('bright', 'NOTES:')}
  - This tool is for debugging, not performance profiling (use profiler.js)
  - For code coverage analysis, use coverage.js
  - For call graph analysis, use callgraph.js
`);
  process.exit(0);
}

// List all available test files for a draft
async function listTestFiles(draft) {
  const tests = await loadTestSuiteJson(draft);
  printDivider();
  console.log(`Available test files for ${color('cyan', draft)}:`);
  printDivider();
  
  const files = Object.keys(tests).sort();
  files.forEach((file, index) => {
    const testCount = tests[file].length;
    console.log(`  ${index.toString().padStart(3)}. ${color('bright', file)} (${testCount} test case${testCount !== 1 ? 's' : ''})`);
  });
  
  console.log(`\nTotal: ${files.length} test files`);
  printDivider();
}

// List all test cases in a file
async function listTestCases(tests, fileKey, draft) {
  if (!tests[fileKey]) {
    console.error(color('red', `Test file '${fileKey}' not found for ${draft}.`));
    console.log('\nAvailable test files:');
    Object.keys(tests).sort().forEach(key => console.log(`  ${key}`));
    return false;
  }

  printDivider();
  console.log(`Test cases in ${color('cyan', fileKey)} (${draft}):`);
  printDivider();

  tests[fileKey].forEach((test, index) => {
    const assertionCount = test.tests.length;
    console.log(`\n${color('bright', `[${index}] ${test.description}`)}`);
    console.log(`  Assertions: ${assertionCount}`);
    if (test.schema && typeof test.schema === 'object') {
      const keywords = Object.keys(test.schema).slice(0, 5).join(', ');
      console.log(`  Keywords: { ${keywords}${Object.keys(test.schema).length > 5 ? ', ...' : ''} }`);
    }
  });

  console.log(`\n\nTotal: ${tests[fileKey].length} test cases`);
  printDivider();
  return true;
}

// Export test suite to JSON file
async function exportTestSuite(tests, fileKey, exportPath) {
  const testSuite = tests[fileKey];
  if (!testSuite) {
    console.error(color('red', `Test file '${fileKey}' not found.`));
    return false;
  }

  const exportData = {
    file: fileKey,
    testCaseCount: testSuite.length,
    testCases: testSuite,
  };

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  console.log(color('green', `✓ Exported ${testSuite.length} test cases to ${exportPath}`));
  return true;
}

// Export specific test case to JSON file
async function exportTestCase(test, testIndex, exportPath) {
  const exportData = {
    index: testIndex,
    description: test.description,
    schema: test.schema,
    tests: test.tests,
  };

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  console.log(color('green', `✓ Exported test case "${test.description}" to ${exportPath}`));
  return true;
}

// Run a single test case with detailed output
async function runTestCase(test, options, draft, remotes, suiteName = undefined) {
  const adaptors = [];
  if (!options.ajvOnly) adaptors.push(jaren);
  if (!options.jarenOnly) adaptors.push(ajv);

  TestRunner.initialize(draft, ...adaptors);
  TestRunner.load(remotes);

  printDivider();
  console.log(`TEST: ${color('bright', test.description)}`);
  printDivider();

  if (options.verbose || options.dryRun) {
    printSection('SCHEMA');
    console.log(JSON.stringify(test.schema, null, 2));
  }

  if (options.dryRun) {
    printSection('ASSERTIONS (Dry Run)');
    test.tests.forEach((item, index) => {
      console.log(`\n[${index}] ${item.description}`);
      console.log(`  Data: ${JSON.stringify(item.data)}`);
      console.log(`  Expected: ${item.valid ? color('green', 'valid') : color('red', 'invalid')}`);
    });
    return true;
  }

  // Run the test
  const results = TestRunner.runTest(test, suiteName);

  // Print results per validator
  for (const res of results) {
    printSection(`${res.validator} Results`);
    
    if (res.error) {
      console.log(color('red', `ERROR: ${res.error}`));
      continue;
    }

    console.log(`Failures: ${res.failures}/${res.total}`);

    // Detailed assertion breakdown
    if (options.verbose || options.compare || options.showErrors || options.interactive) {
      const adaptor = res.validator === 'Ajv' ? ajv : jaren;
      const instance = adaptor.loader(draft, remotes);
      const validator = adaptor.setup(instance, test.schema, suiteName);

      console.log('\nAssertions:');
      
      for (let i = 0; i < test.tests.length; i++) {
        const item = test.tests[i];
        
        if (options.interactive && i > 0) {
          // Wait for user input in interactive mode
          process.stdout.write('\nPress Enter to continue (or q to quit)... ');
          const buffer = Buffer.alloc(1);
          try {
            fs.readSync(process.stdin.fd, buffer, 0, 1, null);
            if (buffer[0] === 113) { // 'q'
              console.log('\n');
              return true;
            }
          } catch (e) {
            // stdin might not be available
          }
        }

        const result = adaptor.run(validator, item.data);
        const passed = result === item.valid;

        console.log(`\n[${i}] ${item.description}`);
        console.log(`  Data: ${JSON.stringify(item.data)}`);
        console.log(`  Expected: ${item.valid ? 'valid' : 'invalid'}`);
        console.log(`  Actual: ${result ? 'valid' : 'invalid'}`);
        console.log(`  Result: ${formatResult(result, item.valid)}`);

        if (options.showErrors && !passed && res.validator === 'Jaren') {
          // Re-run to capture errors
          const errorsBefore = validator.errors ? validator.errors.length : 0;
          adaptor.run(validator, item.data);
          if (validator.errors && validator.errors.length > errorsBefore) {
            console.log(`  Errors: ${JSON.stringify(validator.errors.slice(errorsBefore), null, 2)}`);
          }
        }
      }
    }
  }

  // Comparison summary
  if (options.compare && results.length === 2) {
    printSection('Comparison Summary');
    const jarenResult = results.find(r => r.validator === 'Jaren');
    const ajvResult = results.find(r => r.validator === 'Ajv');
    
    if (jarenResult && ajvResult) {
      const jarenError = !!jarenResult.error;
      const ajvError = !!ajvResult.error;
      const jarenPassed = !jarenError && jarenResult.failures === 0;
      const ajvPassed = !ajvError && ajvResult.failures === 0;
      
      if (jarenError) {
        console.log(color('red', '✗ Jaren has an error'));
      } else if (ajvError) {
        console.log(color('green', '✓ Jaren works where AJV has an error'));
      } else if (jarenPassed && ajvPassed) {
        console.log(color('green', '✓ Both validators pass all assertions'));
      } else if (!jarenPassed && !ajvPassed) {
        console.log(color('yellow', '⚠ Both validators have failures'));
      } else if (jarenPassed && !ajvPassed) {
        console.log(color('green', '✓ Jaren passes where AJV fails'));
      } else {
        console.log(color('red', '✗ Jaren fails where AJV passes'));
      }
    }
  }

  // Final summary
  if (!options.silent) {
    printSection('Summary');
    results.forEach(res => {
      if (res.error) {
        console.log(`${res.validator}: ${color('red', 'ERROR')} - ${res.error}`);
      } else if (res.failures > 0) {
        console.log(`${res.validator}: ${color('red', `${res.failures} FAILED`)} assertions`);
      } else {
        console.log(`${res.validator}: ${color('green', 'ALL PASSED')}`);
      }
    });
  }

  return true;
}

// Main function
async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
  }

  const draft = options.draft;

  // Load test suite
  const tests = await loadTestSuiteJson(draft);
  const remotes = await loadRemoteJson(draft);

  // List files mode
  if (options.listFiles) {
    await listTestFiles(draft);
    return;
  }

  // Ensure target file is specified for other modes
  if (!options.targetFile) {
    console.error(color('red', 'Error: Test file not specified.'));
    console.log('\nUsage: node benchmark/debug.js <testfile.json> [options]');
    console.log('       node benchmark/debug.js --list-files --draft 2019');
    console.log('\nRun with --help for more information.');
    process.exit(1);
  }

  // Normalize target file
  const fileKey = options.targetFile.startsWith('/') ? options.targetFile : '/' + options.targetFile;

  // List test cases mode
  if (options.list) {
    const success = await listTestCases(tests, fileKey, draft);
    process.exit(success ? 0 : 1);
  }

  // Export suite mode
  if (options.exportPath) {
    const success = await exportTestSuite(tests, fileKey, options.exportPath);
    process.exit(success ? 0 : 1);
  }

  // Find the test to run
  let testToRun = null;
  let testIndex = -1;

  if (options.index !== null) {
    // Select by index
    if (tests[fileKey] && tests[fileKey][options.index]) {
      testToRun = tests[fileKey][options.index];
      testIndex = options.index;
    } else {
      console.error(color('red', `Test index ${options.index} not found in ${fileKey}`));
      if (tests[fileKey]) {
        console.log(`\nValid indices: 0-${tests[fileKey].length - 1}`);
      }
      process.exit(1);
    }
  } else if (options.targetDesc) {
    // Select by description
    const targetDescLower = options.targetDesc.toLowerCase();
    testToRun = tests[fileKey]?.find((t, idx) => {
      if (t.description.toLowerCase().includes(targetDescLower)) {
        testIndex = idx;
        return true;
      }
      return false;
    });
    
    if (!testToRun) {
      console.error(color('red', `No test matching "${options.targetDesc}" found in ${fileKey}`));
      console.log('\nAvailable tests:');
      tests[fileKey]?.forEach((t, idx) => {
        console.log(`  [${idx}] ${t.description}`);
      });
      process.exit(1);
    }
  } else {
    // Run all tests in the file
    if (!tests[fileKey]) {
      console.error(color('red', `Test file '${fileKey}' not found for ${draft}.`));
      console.log('\nAvailable test files:');
      Object.keys(tests).sort().forEach(key => console.log(`  ${key}`));
      process.exit(1);
    }

    // Run each test case
    let totalFailures = 0;
    for (let i = 0; i < tests[fileKey].length; i++) {
      const test = tests[fileKey][i];
      if (!options.silent) {
        if (i > 0) console.log('\n');
        console.log(color('dim', `[${i + 1}/${tests[fileKey].length}]`));
      }
      
      try {
        await runTestCase(test, options, draft, remotes, fileKey);
        
        // Check for failures
        const adaptors = [];
        if (!options.ajvOnly) adaptors.push(jaren);
        if (!options.jarenOnly) adaptors.push(ajv);
        TestRunner.initialize(draft, ...adaptors);
        TestRunner.load(remotes);
        const results = TestRunner.runTest(test, fileKey);
        const failures = results.reduce((sum, r) => sum + (r.failures || 0), 0);
        totalFailures += failures;
      } catch (e) {
        console.error(color('red', `Error running test: ${e.message}`));
        if (options.verbose) {
          console.error(e.stack);
        }
        totalFailures++;
      }
    }

    printDivider();
    console.log(`Completed: ${tests[fileKey].length} test cases`);
    if (totalFailures > 0) {
      console.log(color('red', `Total failures: ${totalFailures}`));
      process.exit(1);
    } else {
      console.log(color('green', 'All tests passed!'));
      process.exit(0);
    }
  }

  // Export single test case
  if (options.exportTestPath && testToRun) {
    await exportTestCase(testToRun, testIndex, options.exportTestPath);
  }

  // Run single test case
  if (testToRun) {
    try {
      await runTestCase(testToRun, options, draft, remotes, fileKey);
    } catch (e) {
      console.error(color('red', `Error: ${e.message}`));
      if (options.verbose) {
        console.error(e.stack);
      }
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(color('red', `Error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
