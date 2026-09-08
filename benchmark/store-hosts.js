//@ts-check
/** Reproducible host tradeoffs; baseline data is deliberately kept separately. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { decodeCountedJson, jsonBytes } from '../packages/db/src/json-bytes.js';

const samples = 7;
const sql = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500000) SELECT sum(x) AS total FROM n';
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
};
const folder = await mkdtemp(join(tmpdir(), 'jaren-host-benchmark-'));
const hosts = [];
try {
  for (const [name, factory] of [
    ['node', () => nodeDriver()], ['worker', () => nodeWorkerDriver()],
    ['pool-1-reader', () => nodeWorkerPoolDriver({ readers: 1 })],
    ['pool-3-readers', () => nodeWorkerPoolDriver({ readers: 3 })],
  ]) {
    const driver = factory();
    const path = join(folder, `${name}.sqlite`);
    const startup = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      const c = await driver.open(path);
      startup.push(performance.now() - start);
      await c.close();
    }
    const c = await driver.open(path);
    const statement = await c.prepare(sql, { readOnly: true });
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    const timings = [];
    histogram.enable();
    for (let i = 0; i < samples; i++) {
      await delay(10);
      const start = performance.now();
      await statement.get();
      timings.push(performance.now() - start);
    }
    await delay(10);
    histogram.disable();
    const tiny = await c.prepare('SELECT 7 AS n', { readOnly: true });
    const tinyStart = performance.now();
    for (let i = 0; i < 1000; i++) await tiny.get();
    const tinyMs = performance.now() - tinyStart;
    globalThis.gc?.();
    const initial = process.memoryUsage();
    const rows = await c.prepare(sql.replace('500000', '100000').replace('sum(x) AS total', 'x'), { readOnly: true });
    const iterator = await rows.iterate();
    let count = 0;
    let peakHeap = initial.heapUsed;
    let peakRss = initial.rss;
    const cursorStart = performance.now();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (++count % 1024 === 0) {
        const usage = process.memoryUsage();
        peakHeap = Math.max(peakHeap, usage.heapUsed);
        peakRss = Math.max(peakRss, usage.rss);
      }
    }
    await iterator.return?.();
    const cursor = { rows: count, durationMs: performance.now() - cursorStart,
      sampledHeapGrowthBytes: peakHeap - initial.heapUsed, sampledRssGrowthBytes: peakRss - initial.rss, sampledRssBytes: peakRss };
    const metrics = c.metrics?.() ?? null;
    await c.close();
    const mix = await driver.open(path);
    await mix.exec('CREATE TABLE IF NOT EXISTS writes(n); DELETE FROM writes');
    const mixedRead = await mix.prepare(sql.replace('500000', '50000'), { readOnly: true });
    const write = await mix.prepare('INSERT INTO writes VALUES(?)');
    const mixedStart = performance.now();
    const jobs = [];
    for (let i = 0; i < 24; i++) {
      jobs.push(mixedRead.get());
      if (i % 4 === 0) jobs.push(write.run([i]));
    }
    await Promise.all(jobs);
    const mixed = { reads: 24, writes: 6, durationMs: performance.now() - mixedStart, metrics: mix.metrics?.() ?? null };
    hosts.push({ name, startupMs: stats(startup), statementMs: stats(timings),
      eventLoopDelayMs: { p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 },
      tiny: { operations: 1000, durationMs: tinyMs, operationsPerSecond: 1000000 / tinyMs },
      cursor, mixed, metrics });
    await mix.close();
  }
}
finally { await rm(folder, { recursive: true }); }
const encoded = JSON.stringify(Array.from({ length: 10000 }, (_, id) => ({ id, body: 'é😀\\\n'.repeat(30) })));
const includes = [];
for (const method of ['serialize-again', 'count-during-decode']) {
  const times = [];
  const allocations = [];
  let bytes;
  for (let i = 0; i < samples; i++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    if (method === 'serialize-again') bytes = Buffer.byteLength(JSON.stringify(JSON.parse(encoded)));
    else { const sizes = new WeakMap(); const parsed = decodeCountedJson(encoded, sizes); bytes = jsonBytes(parsed, sizes); }
    times.push(performance.now() - start);
    allocations.push(process.memoryUsage().heapUsed - before);
  }
  includes.push({ method, bytes, durationMs: stats(times), heapGrowthBytes: stats(allocations) });
}
const result = { recipe: 'node --expose-gc benchmark/store-hosts.js', measuredAt: new Date().toISOString(),
  runtime: process.version, host: { platform: platform(), release: release(), cpu: cpus()[0]?.model },
  samples, slowStatementSql: sql, workerEventLoopMaxBoundMs: 50, hosts, includes,
  notes: ['Uncollected heap growth is allocation evidence, not retained memory or a precise allocation count.',
    'RSS includes SQLite worker heaps; sampling occurs every 1024 cursor rows.',
    'Mixed workload uses classified Connection reads; Store root admission remains serial to preserve transaction ownership.',
    'Tiny queries and startup include transport overhead; pool configuration adds a writer to its reader count.'] };
await writeFile(new URL('./store-hosts-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (hosts.find((h) => h.name === 'worker').eventLoopDelayMs.max >= result.workerEventLoopMaxBoundMs)
  throw new Error('Worker event-loop acceptance bound exceeded');
