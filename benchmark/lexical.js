//@ts-check
/** Isolated, repeatable lexical measurements and full-corpus differential qualification. */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import MiniSearch from 'minisearch';
import { compareLexicalAnswers } from './lexical-compare.js';
import { compileLexical } from '@jarenjs/core/search';
import { adoptionRows } from '../scripts/lib/adoption.js';
import { readAdoption, verifyFreeze, assessBudget } from '../test/adoption/evidence.js';
import { searchOptions } from '../test/adoption/oracles.js';

const manifest = readAdoption('manifest.json'), fixture = readAdoption('fixtures/search.json');
verifyFreeze(manifest);
const sourceFiles = ['benchmark/lexical.js', 'packages/core/src/search/index.js', 'packages/core/src/search/config.js',
  'packages/core/src/search/vocabulary.js', 'packages/core/src/string.js', 'scripts/lib/adoption.js', 'test/adoption/oracles.js', 'benchmark/lexical-compare.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const worker = process.argv.find((arg) => arg.startsWith('--measure='));
if (worker) {
  const [consumerId, engine] = worker.slice(10).split(':');
  const consumer = manifest.consumers.find((item) => item.id === consumerId), began = performance.now();
  const rows = adoptionRows(consumer), sourceBytes = Buffer.byteLength(JSON.stringify(rows));
  const sample = () => process.memoryUsage().heapUsed;
  let sampledHeapBytes = sample(); const allocationSamples = [];
  const measure = (fn) => { const start = performance.now(); const value = fn(); sampledHeapBytes = Math.max(sampledHeapBytes, sample()); allocationSamples.push(process.memoryUsage()); return { ms: performance.now() - start, value }; };
  const compiled = compileLexical({ version: 1, fields: fixture.fields, ...fixture.options,
    limits: { maxResults: consumer.rows, maxSourceBytes: consumer.budgets.search.sourceBytes,
      maxIndexBytes: consumer.budgets.search.indexBytes, maxTemporaryBytes: consumer.budgets.resources.peakHeapBytes } });
  const cold = measure(() => {
    if (engine === 'reference') { const index = new MiniSearch(searchOptions(fixture)); index.addAll(rows); return index; }
    const index = compiled.create(), result = index.rebuild(rows, { sourceRevision: consumer.workloadHash });
    if (result.state !== 'complete') throw new Error(JSON.stringify(result)); return index;
  });
  const index = cold.value;
  const snapshot = measure(() => engine === 'reference' ? JSON.stringify(index) : index.snapshot());
  const warm = measure(() => {
    if (engine === 'reference') return MiniSearch.loadJSON(snapshot.value, searchOptions(fixture));
    const restored = compiled.create(), result = restored.restore(snapshot.value, { sourceRevision: consumer.workloadHash });
    if (result.state !== 'complete') throw new Error(JSON.stringify(result)); return restored;
  });
  const startupMs = performance.now() - began;
  const answers = [], timings = [], reloadAnswers = [], querySamples = [];
  for (const query of fixture.queries) {
    let hits; const samples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const run = measure(() => index.search(query.text)); timings.push(run.ms); samples.push(run.ms);
      if (engine === 'reference') hits = run.value;
      else { if (run.value.state !== 'complete' || run.value.hasMore) throw new Error(JSON.stringify(run.value)); hits = run.value.hits; }
    }
    querySamples.push({ text: query.text, ms: samples, matches: hits.length });
    answers.push(hits.map(({ id, score }) => ({ id, score })));
    const reloaded = warm.value.search(query.text);
    if (engine === 'native' && (reloaded.state !== 'complete' || reloaded.hasMore)) throw new Error(JSON.stringify(reloaded));
    reloadAnswers.push((engine === 'reference' ? reloaded : reloaded.hits).map(({ id, score }) => ({ id, score })));
  }
  const changed = { ...rows[0], title: 'White tea' };
  const incremental = measure(() => {
    if (engine === 'reference') { index.replace(changed); return null; }
    const result = index.update({ put: [changed] }, { sourceRevision: `${consumer.workloadHash}:2` });
    if (result.state !== 'complete') throw new Error(JSON.stringify(result)); return result;
  });
  const indexBytes = engine === 'reference' ? Buffer.byteLength(snapshot.value) : index.stats().indexBytes;
  const start = performance.now();
  if (engine === 'native') { index.dispose(); warm.value.dispose(); }
  else { index.removeAll(); warm.value.removeAll(); }
  const teardownMs = performance.now() - start;
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ consumer: consumer.id, engine, answers, reloadAnswers, allocationSamples, querySamples,
    metrics: { search: { startupMs, coldIndexMs: cold.ms, warmIndexMs: warm.ms,
      queryMs: timings[Math.floor(timings.length * 0.95)], sourceBytes, indexBytes },
    resources: { sampledHeapBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024, peakHeapBytes: getHeapStatistics().heap_size_limit, teardownMs,
      remainingHandles: engine === 'native' ? index.stats().documents + warm.value.stats().documents : null } },
    snapshotMs: snapshot.ms, snapshotBytes: Buffer.byteLength(snapshot.value), snapshotGzipBytes: gzipSync(snapshot.value).length,
    incrementalMs: incremental.ms, peakAccountedBytes: incremental.value?.peakBytes ?? null,
    queryMaxMs: timings.at(-1) }));
}
else {
  const bundle = async (contents) => {
    const result = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, minify: true, platform: 'browser', format: 'esm' });
    return gzipSync(result.outputFiles[0].contents).length;
  };
  const browserBytes = { native: await bundle("export {compileLexical} from '@jarenjs/core/search';"),
    reference: await bundle("export {default} from 'minisearch';") };
  const consumers = [];
  for (const consumer of manifest.consumers) {
    const run = (engine) => {
      const result = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=16', `--max-old-space-size=${Math.floor(consumer.budgets.resources.peakHeapBytes / 1048576) - 64}`, fileURLToPath(import.meta.url), `--measure=${consumer.id}:${engine}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout);
    };
    const reference = run('reference'), native = run('native');
    const differences = native.answers.map((hits, q) => compareLexicalAnswers(fixture.queries[q].text,
      reference.answers[q], hits, reference.reloadAnswers[q], native.reloadAnswers[q]));
    delete reference.answers; delete reference.reloadAnswers; delete native.answers; delete native.reloadAnswers;
    native.metrics.search.browserGzipBytes = browserBytes.native; reference.metrics.search.browserGzipBytes = browserBytes.reference;
    const budgets = { search: assessBudget(consumer.budgets.search, native.metrics.search), resources: assessBudget(consumer.budgets.resources, native.metrics.resources) };
    consumers.push({ consumer: consumer.id, rows: consumer.rows, reference, native, differences, budgets });
  }
  const report = { format: 'lexical-measurements/1', freezeHash: manifest.freezeHash, sourceHashes, measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model, os: release() },
    scope: 'Separate Node processes, identical source rows and queries, five query samples each; startup includes source generation, cold build, snapshot and warm restore. An earlier unconstrained native run exceeded the larger corpus heap and RSS ceilings; the explicit host heap settings are required for this qualification. RSS is the OS process high-water mark; heap is sampled after operations. peakHeapBytes is the V8 hard heap ceiling (a conservative bound, not an observed peak); both engines run with the same max-old-space-size derived from the frozen heap budget, reserving 64 MiB for young space and explicitly limiting each semi-space to 16 MiB. Unconstrained GC is not a bounded host. Reference indexBytes is serialized JSON; native indexBytes is conservative logical retained allocation, so those columns are not the same metric. Both retain a cold and a restored index during query qualification.',
    consumers };
  writeFileSync(new URL('./lexical-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (consumers.some((c) => c.differences.some((d) => d.missingOrExtra || d.order || d.score || d.nativeReload)
    || Object.values(c.budgets).flat().some((b) => b.status === 'fail'))) process.exitCode = 1;
}
