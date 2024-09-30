import {
  loadRemoteJson,
  loadTestSuiteJson
} from "./loader.js";

import * as jarenjs from './adaptors/jaren.js';

const jsonRemotes = await loadRemoteJson('draft7');
const jsonTests = await loadTestSuiteJson('draft7');

const jaren = jarenjs.loader('draft7', jsonRemotes);
  
for (const [key, tests] of Object.entries(jsonTests)) {
  console.log(`## suite ${key}`);

  for (let i = 0; i < tests.length; ++i) {
    const test = tests[i];
    console.log(`### test ${test.description}`);

    const validator = jarenjs.setup(jaren, test.schema);

    const asserts = test.tests;
    for (let j = 0; j < asserts.length; ++j) {
      const item = asserts[j];
      const valid = jarenjs.run(validator, item.data) === item.valid;
      console.log(`- ${item.description} = ${valid}`);
    }
  }
}
