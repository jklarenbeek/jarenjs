//@ts-check
/** Offline protocol and complete-ingestion costs against the retained reader. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { adoptionRows } from '../scripts/lib/adoption.js';
import { readProviderTranscript } from '../test/adoption/provider-oracle.js';
import { qualifyDialects, runIngestionConsumer } from '../test/consumer/providers.js';

const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../test/adoption/fixtures/providers.json', import.meta.url), 'utf8'));
const descriptors = JSON.parse(readFileSync(new URL('../test/contract/fixtures/provider-descriptors.json', import.meta.url), 'utf8'));
const consumers = [];
await qualifyDialects(fixture, descriptors);
for (const definition of manifest.consumers) {
  const rows = adoptionRows(definition).slice(0, definition.budgets.providers.rows);
  const pageSize = Math.ceil(rows.length / definition.budgets.providers.pages);
  const pages = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) pages.push({ items: rows.slice(offset, offset + pageSize),
    next: offset + pageSize < rows.length ? String(offset + pageSize) : null, version: 'snapshot-1' });
  const start = performance.now();
  const reference = readProviderTranscript({ envelope: '$.items[*]', pages });
  const referenceMs = performance.now() - start;
  assert.deepEqual(reference.ids, rows.map((row) => row.id));
  const native = await runIngestionConsumer(definition, rows);
  assert.equal(native.requests, pages.length);
  assert.ok(native.requests <= definition.budgets.providers.pages);
  assert.ok(native.bytes <= definition.budgets.providers.bytes);
  assert.equal(native.secondWrites, 0);
  assert.equal(native.secondRevisions, 0);
  assert.equal(native.remainingHandles, 0);
  consumers.push({ consumer: definition.id, reference: { elapsedMs: referenceMs, rows: rows.length, pages: pages.length }, native });
}
const result = {
  format: 'jaren-provider-measurements/1', freezeHash: manifest.freezeHash,
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
  scope: 'Offline synthetic Node SQLite ingestion. The retained reader only extracts recorded transcripts; native timings include opening storage, descriptor execution, private authority checks, page/checkpoint commits, publication and zero-write replay. Their timings describe different work. No real provider latency, credentials, external write reconciliation or production cutover is qualified.',
  dialects: fixture.dialects.length, consumers,
};
writeFileSync(new URL('./providers-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
