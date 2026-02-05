import { loadTestSuiteJson, loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';

export async function findAndRunSuiteTest(draft, targetFile, targetDesc) {
  const tests = await loadTestSuiteJson(draft);
  const remotes = await loadRemoteJson(draft);

  TestRunner.initialize(draft, ajv, jaren);
  TestRunner.load(remotes);

  if (tests[targetFile]) {
    console.log(`## suite /${targetFile}`);
    for (const test of tests[targetFile]) {
      if (test.description === targetDesc) {
          try {
             TestRunner.runTest(test);
          }
          catch (e) {
             console.log("Caught top level error:");
             console.log(e);
          }
      }
    }
  } else {
    console.log('Test file not found');
  }

}

findAndRunSuiteTest('draft7','/ref.json', 'Location-independent identifier');
