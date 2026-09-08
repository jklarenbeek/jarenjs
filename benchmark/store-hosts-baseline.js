//@ts-check
/** Host latency and allocation measurements; run with --expose-gc. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeDriver } from '@jarenjs/db/node';

const samples = 7;
const sql = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500000) SELECT sum(x) AS total FROM n';
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1) };
};
const connection = await nodeDriver().open(':memory:');
const statement = connection.prepare(sql);
const histogram = monitorEventLoopDelay({ resolution: 1 });
const timings = [];
histogram.enable();
for (let i = 0; i < samples; i++) {
  await delay(10);
  const start = performance.now();
  statement.get();
  timings.push(performance.now() - start);
}
await delay(10);
histogram.disable();
const startup = [];
for (let i = 0; i < samples; i++) {
  const start = performance.now();
  const worker = new Worker(new URL('./store-host-startup.js', import.meta.url));
  await once(worker, 'message');
  startup.push(performance.now() - start);
  await worker.terminate();
}
const nested = Array.from({ length: 10000 }, (_, id) => ({ id, body: 'é😀\\\n'.repeat(30) }));
const encoded = JSON.stringify(nested);
globalThis.gc?.();
const heap = process.memoryUsage().heapUsed;
const started = performance.now();
const parsed = JSON.parse(encoded);
const bytes = Buffer.byteLength(JSON.stringify(parsed));
const include = { bytes, durationMs: performance.now() - started,
  heapDeltaBytes: process.memoryUsage().heapUsed - heap, rows: parsed.length,
  method: 'JSON.parse then JSON.stringify and UTF-8 count' };
globalThis.gc?.();
const cursorHeap = process.memoryUsage().heapUsed;
const iterator = connection.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT x FROM n').iterate();
let cursorRows = 0;
for (const _row of iterator) cursorRows++;
const memory = { cursorRows, cursorHeapDeltaBytes: process.memoryUsage().heapUsed - cursorHeap,
  rssBytes: process.memoryUsage().rss };
connection.close();
const result = {
  recipe: 'node --expose-gc benchmark/store-hosts-baseline.js',
  measuredAt: new Date().toISOString(), runtime: process.version,
  host: { platform: platform(), release: release(), cpu: cpus()[0]?.model },
  samples, slowStatementSql: sql, statementMs: stats(timings),
  eventLoopDelayMs: { p50: histogram.percentile(50) / 1e6,
    p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 },
  workerStartupMs: stats(startup), memory, include,
  workerEventLoopMaxBoundMs: 50,
};
await writeFile(new URL('./store-hosts-baseline.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
