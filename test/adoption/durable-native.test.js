//@ts-check
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runDurableConsumer } from '../consumer/durable.js';
const manifest = JSON.parse(readFileSync(new URL('../durable/manifest.json', import.meta.url), 'utf8'));
for (const count of manifest.cases) it(`public durable composition: ${count} commands and interrupted multi-leg execution`, async () => {
  await runDurableConsumer(count, manifest.limits);
});
