import {
  loadRemoteJson,
  loadTestSuiteJson
} from "./loader.js";

const jsonRemotes = await loadRemoteJson('draft7');
console.log(Object.entries(jsonRemotes).length);

const jsonTests = await loadTestSuiteJson('draft7');
console.log(Object.entries(jsonTests).length);
