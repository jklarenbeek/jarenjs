import {
  loadRemoteJson,
  loadTestSuiteJson
} from "./loader.js";

import * as jarenAdaptor from './adaptors/jaren.js';
import * as ajvAdaptor from './adaptors/ajv.js';
import { TestRunner } from './runner.js';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TEST_DRAFT = 'draft7';

// TODO: We should be able to set an shell argument for this!
const CONF_SHOW_LOG_RESULT = 'Jaren';

TestRunner.initialize(DEFAULT_TEST_DRAFT, jarenAdaptor, ajvAdaptor);
const remotes = await loadRemoteJson(DEFAULT_TEST_DRAFT);
TestRunner.load(remotes);

const jsonTests = await loadTestSuiteJson(DEFAULT_TEST_DRAFT);

const allResults = {};
const validators = new Set();

console.log('Running benchmarks...');

for (const [key, tests] of Object.entries(jsonTests)) {
  console.log(`## suite ${key}`);
  allResults[key] = [];

  for (let i = 0; i < tests.length; ++i) {
    const test = tests[i];
    // TODO: select adapter
    const results = TestRunner.runTest(test);

    // Structure: { description: string, results: [{ validator, failures, total, time, error? }] }
    allResults[key].push({
      description: test.description,
      results: results
    });

    let sums = null;
    if (CONF_SHOW_LOG_RESULT == null || CONF_SHOW_LOG_RESULT === '') {
      sums = results.reduce(
        (acc, { total, failures, time }) => {
          acc.total += total;
          acc.failures += failures;
          acc.time += time;
          return acc;
        },
        { total: 0, failures: 0, time: 0 }
      );
    }
    else {
      sums = results.find(item =>
        item.validator.toLowerCase() === CONF_SHOW_LOG_RESULT.toLowerCase()
      );
    }

    // trim output
    if (sums.failures > 0)
      console.log(`Test run complete: asserts ${sums.total}, failures ${sums.failures}, time ${sums.time.toFixed(3)}`);

    results.forEach(r => validators.add(r.validator));
  }
}
console.log('\nBenchmarks complete.');

// Generate HTML
const validatorList = Array.from(validators);
let html = `<!DOCTYPE html>
<html>
<head>
  <title>JarenJS vs Ajv Benchmark Results</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    .fail { background-color: #ffebee; color: #c62828; }
    .pass { background-color: #e8f5e9; color: #2e7d32; }
    .header { font-size: 1.2em; font-weight: bold; margin-top: 20px; }
    .summary-box { display: flex; gap: 20px; margin-bottom: 20px; }
    .card { border: 1px solid #ccc; padding: 15px; border-radius: 5px; min-width: 200px; }
  </style>
</head>
<body>
  <h1>Benchmark Results (${DEFAULT_TEST_DRAFT})</h1>
`;

// Summary Calculation
const summary = {};
validatorList.forEach(v => {
  summary[v] = { totalTests: 0, failedTests: 0, totalTime: 0, errors: 0, wins: 0 };
});

for (const suiteName in allResults) {
  for (const test of allResults[suiteName]) {
    // Determine winner for this test
    let fastestTime = Infinity;
    let fastestValidator = null;

    // First pass: find fastest
    for (const res of test.results) {
      if (!res.error && res.time < fastestTime) {
        fastestTime = res.time;
        fastestValidator = res.validator;
      }
    }

    // Increment win count
    if (fastestValidator && summary[fastestValidator]) {
      summary[fastestValidator].wins++;
    }

    for (const res of test.results) {
      if (!summary[res.validator]) continue;
      summary[res.validator].totalTests += res.total;
      summary[res.validator].failedTests += res.failures;
      summary[res.validator].totalTime += res.time;
      if (res.error) summary[res.validator].errors++;
    }
  }
}

html += `<div class="summary-box">`;
validatorList.forEach(v => {
  const s = summary[v];
  const passRate = s.totalTests > 0 ? ((s.totalTests - s.failedTests) / s.totalTests * 100).toFixed(2) : '0';
  html += `
    <div class="card">
      <h3>${v}</h3>
      <p>Total Assertions: ${s.totalTests}</p>
      <p>Failures: ${s.failedTests}</p>
      <p>Errors: ${s.errors}</p>
      <p>Pass Rate: ${passRate}%</p>
      <p>Total Time: ${s.totalTime.toFixed(2)} ms</p>
      <p><b>Fastest In: ${s.wins} tests</b></p>
    </div>
  `;
});
html += `</div>`;

// Detailed Results
html += `<table>
  <thead>
    <tr>
      <th>Suite</th>
      <th>Test Case</th>`;
validatorList.forEach(v => {
  html += `<th>${v} (Fail/Total)</th><th>${v} Time (ms)</th>`;
});
html += `</tr></thead><tbody>`;

for (const suiteName in allResults) {
  for (const test of allResults[suiteName]) {
    html += `<tr>
      <td>${suiteName}</td>
      <td>${test.description}</td>`;

    // Find fastest for this row again for display logic
    let fastestTime = Infinity;
    let fastestValidator = null;
    test.results.forEach(r => {
      if (!r.error && r.time < fastestTime) {
        fastestTime = r.time;
        fastestValidator = r.validator;
      }
    });

    validatorList.forEach(v => {
      const res = test.results.find(r => r.validator === v);
      if (res) {
        if (res.error) {
          html += `<td class="fail">ERROR: ${res.error}</td><td>-</td>`;
        } else {
          const classParams = res.failures > 0 ? 'class="fail"' : 'class="pass"';

          let timeDisplay = res.time.toFixed(4);
          if (v === fastestValidator) {
            timeDisplay = `<b>${timeDisplay}</b>`;
          } else if (fastestValidator) {
            // Calculate diff
            const diff = ((res.time - fastestTime) / fastestTime * 100).toFixed(0);
            timeDisplay = `${timeDisplay} <span style="font-size:0.8em; color:#666">(+${diff}%)</span>`;
          }

          html += `<td ${classParams}>${res.failures} / ${res.total}</td>
                    <td>${timeDisplay}</td>`;
        }
      } else {
        html += `<td>-</td><td>-</td>`;
      }
    });
    html += `</tr>`;
  }
}

html += `</tbody></table></body></html>`;

const outputPath = path.join('benchmark', 'results', 'results.html');
fs.writeFileSync(outputPath, html);
console.log(`Results written to ${outputPath}`);
