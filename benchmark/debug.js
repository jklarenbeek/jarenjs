import { loadTestSuiteJson, loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';

const [,, targetFile, targetDesc] = process.argv;

if (!targetFile) {
  console.log('Usage: node debug.js <testfile.json> [description]');
  process.exit(1);
}

export async function findAndRunSuiteTest(draft, targetFile, targetDesc) {
  const tests = await loadTestSuiteJson(draft);
  const remotes = await loadRemoteJson(draft);

  TestRunner.initialize(draft, ajv, jaren);
  TestRunner.load(remotes);

  // Normalize targetFile to include leading slash if needed
  const fileKey = targetFile.startsWith('/') ? targetFile : '/' + targetFile;

  if (tests[fileKey]) {
    console.log(`## suite ${fileKey}`);
    for (const test of tests[fileKey]) {
      if (!targetDesc || test.description.includes(targetDesc)) {
          console.log(`Running test: ${test.description}`);
          try {
             const results = TestRunner.runTest(test);
             // Print detailed results
             results.forEach(res => {
                if (res.error) {
                    console.log(`- ${res.validator} failed: ${res.error}`);
                } else {
                    console.log(`- ${res.validator}: ${res.failures}/${res.total} failures (${res.time.toFixed(2)}ms)`);
                }
             });
          }
          catch (e) {
             console.log("Caught top level error:");
             console.log(e);
          }
      }
    }
  } else {
    console.log(`Test file '${fileKey}' not found. Available keys:`, Object.keys(tests).slice(0, 5));
  }

}

findAndRunSuiteTest('draft7', targetFile, targetDesc);
