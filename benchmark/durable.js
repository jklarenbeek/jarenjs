//@ts-check
/** Reproducible local atomicity/replay costs against the same domain/outbox work. */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { runDurableConsumer } from '../test/consumer/durable.js';
const manifestBytes = readFileSync(new URL('../test/durable/manifest.json', import.meta.url));
const manifest = JSON.parse(manifestBytes.toString());
const consumers = [];
for (const count of manifest.cases) consumers.push(await runDurableConsumer(count, manifest.limits));
const result = { format: 'jaren-durable-measurements/1', freezeHash: createHash('sha256').update(manifestBytes).digest('hex'),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model }, scope: manifest.scope, consumers };
writeFileSync(new URL('./durable-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
