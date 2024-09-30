import {
  loadRemoteJson,
  loadTestSuiteJson
} from "./loader.js";

import * as jarenAdaptor from './adaptors/jaren.js';
import * as ajvAdaptor from './adaptors/ajv.js';

import { TestRunner } from './runner.js';

const DEFAULT_TEST_DRAFT = 'draft7';

TestRunner.initialize(DEFAULT_TEST_DRAFT, jarenAdaptor, ajvAdaptor);
const remotes = await loadRemoteJson(DEFAULT_TEST_DRAFT);
TestRunner.load(remotes);

const jsonTests = await loadTestSuiteJson(DEFAULT_TEST_DRAFT);

for (const [key, tests] of Object.entries(jsonTests)) {
  console.log(`## suite ${key}`);

  for (let i = 0; i < tests.length; ++i) {
    const test = tests[i];
    TestRunner.runTest(test);
  }
}
