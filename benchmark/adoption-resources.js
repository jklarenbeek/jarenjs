//@ts-check
/**
 * Combined live heap and remaining host resources, measured apart from the
 * timed journey: each host runs each full workload in a fresh process whose
 * only instrument is benchmark/adoption-resources-entry.js. A forced
 * collection inside a timed region would move the published timings, so
 * timings, sampled heap and RSS stay with benchmark/adoption-journey.js.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeAdoptionConsumer } from '../scripts/lib/adoption-journey.js';
import { adoptionHash, readAdoption, verifyFreeze, assessBudget } from '../test/adoption/evidence.js';

if (process.argv.slice(2).some((arg) => arg !== '--write')) throw new Error('Usage: node benchmark/adoption-resources.js [--write]');
const root = fileURLToPath(new URL('../', import.meta.url)), manifest = readAdoption('manifest.json');
verifyFreeze(manifest);
const sources = ['packages/website/src/examples/adoption.js', 'packages/website/src/examples/adoption-model.js',
  'packages/website/src/examples/adoption-fixture.js', 'test/consumer/journey.js', 'scripts/lib/adoption-journey.js',
  'benchmark/adoption-resources.js', 'benchmark/adoption-resources-entry.js', 'packages/db/src/jobs.js', 'packages/db/src/store.js'];
const timed = JSON.parse(readFileSync(join(root, 'benchmark/adoption-journey-result.json'), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'jaren-combined-resources-'));
try {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeAdoptionConsumer(directory, root);
  const entry = join(directory, 'resources-entry.js');
  copyFileSync(join(root, 'benchmark/adoption-resources-entry.js'), entry);
  writeFileSync(join(directory, 'resources-input.json'), JSON.stringify({ consumers: manifest.consumers,
    originals: readAdoption('fixtures/formulas.json').formulas }));
  const hosts = [['node', process.execPath, ['--expose-gc', '--no-warnings=ExperimentalWarning', entry]], ['bun', 'bun', [entry]]]
    .map(([label, command, prefix]) => ({ label, results: manifest.consumers.map((definition) => {
      const path = join(directory, `${label}-${definition.id}.sqlite`);
      try {
        const run = spawnSync(/** @type {string} */ (command), [.../** @type {string[]} */ (prefix), 'all', definition.id, path],
          { cwd: directory, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(run.status, 0, `${label}/${definition.id}: ${run.error ?? run.stderr}`);
        const row = JSON.parse(run.stdout.trim());
        assert.equal(row.rows, definition.rows);
        const plain = timed.hosts.find((host) => host.label === label)?.results.find((value) => value.consumer === definition.id && value.phase === 'all');
        assert.equal(row.searchHash, plain?.searchHash, `${label}/${definition.id}: the instrumented journey answered another search`);
        return row;
      }
      finally { for (const suffix of ['', '-wal', '-shm', '.remote']) rmSync(path + suffix, { force: true }); }
    }) }));
  const checks = hosts.flatMap((host) => host.results.map((row) => {
    const limits = manifest.consumers.find((value) => value.id === row.consumer).budgets.resources;
    return { host: host.label, consumer: row.consumer, checks: assessBudget(
      { peakHeapBytes: limits.peakHeapBytes, remainingHandles: limits.remainingHandles },
      { peakHeapBytes: row.peakLiveHeapBytes, remainingHandles: row.remainingHandles }) };
  }));
  const report = { format: 'jaren-adoption-resources/1', freezeHash: manifest.freezeHash,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
    sourceHashes: Object.fromEntries(sources.map((file) => [file, adoptionHash(readFileSync(join(root, file)))])),
    method: {
      liveHeap: 'process.memoryUsage().heapUsed after two forced full collections (Node --expose-gc gc(), Bun.gc(true)) at each phase boundary',
      boundaries: ['start: modules loaded', 'rows: frozen workload generated', 'seed: pre-existing file written', 'open: each application open',
        'after each awaited application call the journey makes: migrateSaved, query, saveRule, rows, preview, command.execute, ingest, prepare, runner.run, close',
        'teardown: the journey returned after its final close'],
      remaining: 'process.getActiveResourcesInfo() after teardown and one setImmediate turn, minus the list taken before the workload once the standard streams are open (multiset)',
      drain: 'the loop drained (beforeExit) before an unreferenced 1 ms timer fired; a live loop counts at least one remaining handle',
    },
    hosts, checks,
    limitations: ['The peak is the largest live set at the named boundaries; a live set inside one application call can be larger and is not observed.',
      'The live set includes the journey assertions that run in the same process, as the timed run does.',
      'process.getActiveResourcesInfo() omits unreferenced timers and handles, so one of those is neither listed nor counted; it does list the standard stream pipes, which is why the baseline is taken once they are open.',
      'Bun returns an empty resource list even with a listening server and a pending timer, so its remaining count rests on the drain check alone: it can show zero or at least one, never which resource remains.',
      'Linux source hosts only; standalone executables and other operating systems are not measured here.'] };
  if (process.argv.includes('--write')) writeFileSync(new URL('adoption-resources-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
finally { rmSync(directory, { recursive: true, force: true }); }
