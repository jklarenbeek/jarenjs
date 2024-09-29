import {
  loadRemoteJson,
  loadTestSuiteJson
} from "./loader.js";

const jsonRemotes = await loadRemoteJson('draft7');
console.log(jsonRemotes);

const jsonTests = await loadTestSuiteJson('draft7');
console.log(jsonTests);
