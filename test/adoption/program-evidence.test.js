//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAdoption } from './evidence.js';
import { summarizeAdoption } from '../../scripts/lib/adoption-program.js';
import { adoptionFacts } from '../../scripts/generate-adoption-facts.js';

const manifest = readAdoption('manifest.json');
const reports = Object.fromEntries(['adoption', 'adoption-journey', 'relational', 'collection', 'lexical', 'formula', 'providers']
  .map((name) => [name, JSON.parse(readFileSync(new URL(`../../benchmark/${name}-result.json`, import.meta.url), 'utf8'))]));

it('final comparison accounts for every frozen budget without turning missing measurements into passes', () => {
  const result = summarizeAdoption(manifest, reports);
  assert.equal(result.budgets.length, manifest.consumers.reduce((n, c) => n + Object.values(c.budgets).reduce((n, limits) => n + Object.keys(limits).length, 0), 0));
  assert.equal(result.budgets.filter((row) => row.reference.status === 'fail').length, 2);
  const peak = result.budgets.filter((row) => row.stage === 'resources' && row.metric === 'peakHeapBytes');
  assert.ok(peak.every((row) => row.combined.every((host) => host.status === 'pending' && host.value === null)));
  assert.ok(result.replacements.every((row) => row.library === 'pass' && row.portableConsumer === 'pass'
    && row.liveHost === 'pending' && row.manualOperator === 'pending' && row.retirement === 'pending'));
  assert.equal(result.program, 'library-ready; adoption-pending');
  assert.deepEqual(summarizeAdoption(manifest, reports), result);
});

it('comparison refuses another freeze or a missing consumer instead of publishing partial success', () => {
  const changed = structuredClone(reports); changed.lexical.freezeHash = 'another-freeze';
  assert.throws(() => summarizeAdoption(manifest, changed), /freeze/);
  const missing = structuredClone(reports); missing.collection.consumers.pop();
  assert.throws(() => summarizeAdoption(manifest, missing), /missing consumer.*archive-stock/);
});

it('measured losses and pending evidence survive aggregation even when source status labels claim pass', () => {
  const changed = structuredClone(reports);
  changed.lexical.consumers[0].native.metrics.search.queryMs = 101;
  changed['adoption-journey'].hosts[0].results[0].heapBytes = null;
  changed['adoption-journey'].evidence.portable = 'pending';
  const result = summarizeAdoption(manifest, changed);
  const row = result.budgets.find((row) => row.consumer === 'catalog' && row.stage === 'search' && row.metric === 'queryMs');
  assert.deepEqual(row.focused, { source: 'lexical', metric: 'queryMs', limit: 100, value: 101, status: 'fail' });
  assert.equal(result.budgets.find((row) => row.consumer === 'catalog' && row.metric === 'sampledHeapBytes').combined[0].status, 'pending');
  assert.ok(result.replacements.every((row) => row.portableConsumer === 'pending' && row.retirement === 'pending'));
});

it('the published final report matches the measured inputs and retains explicit retirement qualifications', () => {
  const report = JSON.parse(readFileSync(new URL('../../benchmark/adoption-program-result.json', import.meta.url), 'utf8'));
  const { sourceHashes, limitations, ...summary } = report;
  assert.ok(Object.keys(sourceHashes).length > 7); assert.ok(limitations.length > 0);
  assert.deepEqual(summary, summarizeAdoption(manifest, reports));
  assert.match(adoptionFacts.facts()['adoption.final'](), /library-ready; adoption-pending/);
  assert.match(adoptionFacts.facts()['adoption.budgets'](), /peakHeapBytes/);
});
