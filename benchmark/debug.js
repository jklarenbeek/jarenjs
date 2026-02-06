import { loadTestSuiteJson, loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';

const [,, targetFile, targetDesc, verboseFlag] = process.argv;

if (!targetFile) {
  console.log('Usage: node benchmark/debug.js <testfile.json> [description] [--verbose]');
  console.log('');
  console.log('Examples:');
  console.log('  node benchmark/debug.js \'/ref.json\'');
  console.log('  node benchmark/debug.js \'/ref.json\' \'ref overrides\'');
  console.log('  node benchmark/debug.js \'/ref.json\' \'ref overrides\' --verbose');
  console.log('');
  console.log('Options:');
  console.log('  --verbose    Show full schema, data, and expected vs actual results');
  process.exit(1);
}

const verbose = verboseFlag === '--verbose' || verboseFlag === '-v';

function printDivider() {
  console.log('='.repeat(80));
}

function printSection(title) {
  console.log('');
  console.log(`## ${title}`);
  console.log('-'.repeat(40));
}

function formatResult(result, index, expected) {
  const status = result === expected ? '✓ PASS' : '✗ FAIL';
  const expectedStr = expected ? 'valid' : 'invalid';
  const actualStr = result ? 'valid' : 'invalid';
  return `  Test ${index}: ${status} (expected: ${expectedStr}, got: ${actualStr})`;
}

export async function findAndRunSuiteTest(draft, targetFile, targetDesc) {
  const tests = await loadTestSuiteJson(draft);
  const remotes = await loadRemoteJson(draft);

  TestRunner.initialize(draft, ajv, jaren);
  TestRunner.load(remotes);

  // Normalize targetFile to include leading slash if needed
  const fileKey = targetFile.startsWith('/') ? targetFile : '/' + targetFile;

  if (tests[fileKey]) {
    printDivider();
    console.log(`SUITE: ${fileKey}`);
    printDivider();
    
    for (const test of tests[fileKey]) {
      if (!targetDesc || test.description.toLowerCase().includes(targetDesc.toLowerCase())) {
        printSection(`TEST: ${test.description}`);
        
        if (verbose) {
          console.log('\nSCHEMA:');
          console.log(JSON.stringify(test.schema, null, 2));
          console.log('');
        }
        
        try {
          const results = TestRunner.runTest(test);
          
          // Print detailed results for each validator
          for (const res of results) {
            console.log(`\n--- ${res.validator} ---`);
            
            if (res.error) {
              console.log(`ERROR: ${res.error}`);
            } else {
              console.log(`Result: ${res.failures}/${res.total} failures (${res.time.toFixed(2)}ms)`);
              
              // Run individual test assertions with detailed output
              if (verbose && res.validator === 'Jaren') {
                console.log('\nDetailed assertions:');
                const adaptor = res.validator === 'Ajv' ? ajv : jaren;
                const jarenInstance = jaren.loader(draft, remotes);
                const validator = jaren.setup(jarenInstance, test.schema);
                
                for (let i = 0; i < test.tests.length; i++) {
                  const item = test.tests[i];
                  const result = jaren.run(validator, item.data);
                  const passed = result === item.valid;
                  console.log(formatResult(result, i, item.valid) + ` - ${item.description}`);
                  if (!passed && verbose) {
                    console.log('    Data:', JSON.stringify(item.data));
                  }
                }
              }
            }
          }
          
          // Summary
          console.log('\n--- SUMMARY ---');
          const jarenResult = results.find(r => r.validator === 'Jaren');
          if (jarenResult) {
            if (jarenResult.error) {
              console.log('Jaren: ERROR - ' + jarenResult.error);
            } else if (jarenResult.failures > 0) {
              console.log(`Jaren: ${jarenResult.failures} FAILED assertions`);
            } else {
              console.log('Jaren: ALL PASSED');
            }
          }
          
        } catch (e) {
          console.log('CAUGHT EXCEPTION:');
          console.log(e.message);
          if (verbose) {
            console.log(e.stack);
          }
        }
      }
    }
    
    printDivider();
    console.log('Debug run complete');
    printDivider();
  } else {
    console.log(`Test file '${fileKey}' not found.`);
    console.log('Available test files:');
    Object.keys(tests).forEach(key => console.log(`  ${key}`));
  }
}

findAndRunSuiteTest('draft7', targetFile, targetDesc);
