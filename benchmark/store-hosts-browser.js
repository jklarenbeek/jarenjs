//@ts-check
/** Reduce the actual Playwright attachments to the committed capability matrix. */
import { readFile, writeFile } from 'node:fs/promises';
const input = process.argv[2];
if (!input) throw new Error('Pass the JSON reporter output from storage.spec.js');
const report = JSON.parse(await readFile(input, 'utf8'));
const rows = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) for (const test of spec.tests) {
    const result = test.results.at(-1);
    if (result.status !== 'passed') throw new Error(`Storage probe failed: ${spec.title}`);
    const attachment = result.attachments.find((entry) => entry.name === 'storage-capabilities');
    if (!attachment) throw new Error(`Storage probe has no capability report: ${spec.title}`);
    rows.push({ scenario: spec.title, ...JSON.parse(Buffer.from(attachment.body, 'base64').toString()) });
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites) if (suite.file?.endsWith('storage.spec.js')) walk(suite);
if (rows.length !== 15) throw new Error('The storage matrix requires five scenarios in each of three engines');
await writeFile(new URL('./store-hosts-browser-results.json', import.meta.url), JSON.stringify({
  measuredAt: report.stats.startTime,
  recipe: 'npm run website:build; npx playwright test -c packages/website/playwright.config.js storage.spec.js --workers=3 --reporter=json > /tmp/storehosts-browser.json; node benchmark/store-hosts-browser.js /tmp/storehosts-browser.json',
  environment: 'Ubuntu 24.04 ubuntu-playwright container, run as user joham; ordinary and COOP/COEP Vite preview servers',
  passed: rows.length, rows,
}, null, 2) + '\n');
console.log(`Recorded ${rows.length} passing storage observations.`);
