//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adoptionHash, readAdoption, assessBudget } from './evidence.js';
import { adoptionFacts } from '../../scripts/generate-adoption-facts.js';
import { forcedCollection, createLiveSampler, remainingResources, remainingHandleCount, observeApplication }
  from '../../benchmark/adoption-resources-entry.js';

const entry = fileURLToPath(new URL('../../benchmark/adoption-resources-entry.js', import.meta.url));

it('a live set needs a forced collection: no collector is a refusal, never a raw heap reading', () => {
  assert.throws(() => forcedCollection({}), /forced collection: run Node with --expose-gc/);
  const calls = [];
  forcedCollection({ gc: () => calls.push('gc') })();
  forcedCollection({ Bun: { gc: (/** @type {boolean} */ sync) => calls.push(`Bun.gc(${sync})`) }, gc: () => calls.push('unused') })();
  assert.deepEqual(calls, ['gc', 'gc', 'Bun.gc(true)', 'Bun.gc(true)']);
});

it('the peak is the largest live set at the named boundaries, each taken after a collection', () => {
  const order = [], heap = [40, 90, 90, 60];
  const live = createLiveSampler(() => order.push('collect'), () => { order.push('read'); return /** @type {number} */ (heap.shift()); });
  assert.throws(() => live.peak(), /no live-set sample/);
  for (const phase of ['start', 'query', 'ingest', 'teardown']) live.sample(phase);
  assert.deepEqual(order, ['collect', 'read', 'collect', 'read', 'collect', 'read', 'collect', 'read']);
  assert.deepEqual(live.peak(), { phase: 'query', bytes: 90 });
  assert.deepEqual(live.samples.map((row) => row.phase), ['start', 'query', 'ingest', 'teardown']);
});

it('remaining resources are the after-teardown list less the baseline, counted as a multiset', () => {
  assert.deepEqual(remainingResources(['PipeWrap'], ['PipeWrap', 'Timeout', 'Timeout']), ['Timeout', 'Timeout']);
  assert.deepEqual(remainingResources(['PipeWrap', 'TTYWrap'], ['PipeWrap']), []);
  assert.deepEqual(remainingResources(['PipeWrap'], ['PipeWrap', 'PipeWrap']), ['PipeWrap']);
  assert.deepEqual(remainingResources([], ['TCPServerWrap']), ['TCPServerWrap']);
  assert.equal(remainingHandleCount([], true), 0);
  assert.equal(remainingHandleCount([], false), 1);
  assert.equal(remainingHandleCount(['Timeout'], false), 1);
  assert.equal(remainingHandleCount(['Timeout', 'TCPServerWrap'], true), 2);
});

it('every awaited application call the journey makes is a boundary, sampled after it resolves', async () => {
  const phases = [];
  const call = (/** @type {string} */ name) => async (/** @type {any} */ value) => { phases.push(`run ${name}`); return [name, value]; };
  const app = { client: 'client', capabilities: { live: false }, command: { execute: call('execute') }, runner: { run: call('run') },
    ...Object.fromEntries(['migrateSaved', 'query', 'saveRule', 'rows', 'preview', 'ingest', 'prepare', 'close'].map((name) => [name, call(name)])) };
  const observed = observeApplication(app, (phase) => phases.push(`sample ${phase}`));
  assert.equal(observed.client, 'client'); assert.equal(observed.capabilities, app.capabilities);
  assert.deepEqual(await observed.query('gren tea'), ['query', 'gren tea']);
  await observed.command.execute(1); await observed.runner.run(2); await observed.close();
  assert.deepEqual(phases, ['run query', 'sample query', 'run execute', 'sample command.execute', 'run run', 'sample runner.run', 'run close', 'sample close']);
});

const probe = fileURLToPath(new URL('loop-drain.js', import.meta.url));
const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
/** @param {string} command @param {string} held */
const drains = (command, held) => {
  const run = spawnSync(command, [probe, held], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

it('the drain check reports a loop kept alive by a referenced timer or server and only then', () => {
  for (const held of ['none', 'unreferenced-timer']) assert.equal(drains(process.execPath, held).drained, true, held);
  assert.deepEqual(drains(process.execPath, 'interval'), { listed: ['Timeout'], drained: false });
  assert.deepEqual(drains(process.execPath, 'server'), { listed: ['TCPServerWrap'], drained: false });
});

it('on Bun, whose resource list stays empty, the drain check alone still sees a live loop', { skip: !bun && 'bun is not installed' }, () => {
  for (const held of ['none', 'unreferenced-timer']) assert.deepEqual(drains('bun', held), { listed: [], drained: true }, held);
  for (const held of ['interval', 'server']) assert.deepEqual(drains('bun', held), { listed: [], drained: false }, held);
});

it('the entry refuses to run its journey without a forced collection', () => {
  const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', entry, 'all', 'catalog', '/nonexistent'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /A live-set measurement needs a forced collection: run Node with --expose-gc/);
});

it('the committed live-set and handle report names its sources and agrees with its own samples', () => {
  const manifest = readAdoption('manifest.json');
  const report = JSON.parse(readFileSync(new URL('../../benchmark/adoption-resources-result.json', import.meta.url), 'utf8'));
  assert.equal(report.format, 'jaren-adoption-resources/1'); assert.equal(report.freezeHash, manifest.freezeHash);
  for (const [file, hash] of Object.entries(report.sourceHashes))
    assert.equal(adoptionHash(readFileSync(new URL(`../../${file}`, import.meta.url))), hash, `stale resource measurement: ${file}`);
  assert.deepEqual(report.hosts.map((host) => host.label), ['node', 'bun']);
  for (const host of report.hosts) {
    assert.deepEqual(host.results.map((row) => row.consumer), manifest.consumers.map((definition) => definition.id));
    for (const row of host.results) {
      assert.equal(row.rows, manifest.consumers.find((definition) => definition.id === row.consumer).rows);
      assert.equal(row.phase, 'all');
      assert.deepEqual(row.samples.slice(0, 4).map((sample) => sample.phase), ['start', 'rows', 'seed', 'open']);
      assert.equal(row.samples.at(-1).phase, 'teardown');
      const peak = row.samples.reduce((best, sample) => sample.bytes > best.bytes ? sample : best);
      assert.deepEqual([row.peakLiveHeapBytes, row.peakPhase], [peak.bytes, peak.phase]);
      assert.deepEqual(row.resources.remaining, remainingResources(row.resources.baseline, row.resources.afterTeardown));
      assert.equal(row.remainingHandles, remainingHandleCount(row.resources.remaining, row.resources.drained));
    }
  }
  const published = adoptionFacts.facts()['adoption.resources']();
  for (const host of report.hosts) for (const row of host.results) {
    assert.ok(published.includes(`| ${host.label} ${row.runtime} | ${row.consumer} | ${row.rows} | ${row.samples.length} | ${(row.peakLiveHeapBytes / 1048576).toFixed(2)} | ${row.peakPhase} |`),
      `${host.label}/${row.consumer} is not derived from the committed report`);
  }
  assert.deepEqual(report.checks, report.hosts.flatMap((host) => host.results.map((row) => {
    const limits = manifest.consumers.find((definition) => definition.id === row.consumer).budgets.resources;
    return { host: host.label, consumer: row.consumer, checks: assessBudget(
      { peakHeapBytes: limits.peakHeapBytes, remainingHandles: limits.remainingHandles },
      { peakHeapBytes: row.peakLiveHeapBytes, remainingHandles: row.remainingHandles }) };
  })));
});
