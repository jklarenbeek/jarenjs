//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createFormulaResource } from '@jarenjs/app/formula';

function host() {
  const worker = new Worker(new URL('./formula-worker.js', import.meta.url));
  return { request: (message) => new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject); worker.once('exit', () => reject(Error('terminated'))); worker.postMessage(message);
  }), terminate: () => worker.terminate() };
}
it('a real runaway worker is terminated and drained at the hard deadline', async () => {
  const resource = createFormulaResource({ workerFactory: host, timeoutMs: 100 });
  const result = await resource.run({ runaway: true });
  assert.equal(result.reason, 'deadline'); assert.equal(resource.stats().pending, 0);
  await resource.dispose(); await resource.dispose();
  assert.equal((await resource.run({})).reason, 'disposed');
  const successful = createFormulaResource({ workerFactory: host, timeoutMs: 5000 });
  assert.equal((await successful.run({})).state, 'complete'); await successful.dispose();
});

function controlled() {
  let resolve;
  return { message: null, request(message) { this.message = message; return new Promise((done) => { resolve = done; }); },
    finish(changes = {}) { resolve({ ...this.message, result: 1, ...changes }); },
    async terminate() { resolve?.(null); } };
}
it('stale work, cancellation, corrupt identity and resource credits cannot publish', async () => {
  const workers = [];
  const resource = createFormulaResource({ workerFactory: () => { const worker = controlled(); workers.push(worker); return worker; } });
  const first = resource.run({}, { revision: 'a' }); await Promise.resolve();
  const second = resource.run({}, { revision: 'b' }); await Promise.resolve();
  assert.equal((await resource.run({})).reason, 'in-flight');
  workers[1].finish(); assert.equal((await second).state, 'complete');
  assert.equal((await first).reason, 'superseded');
  const corrupt = resource.run({}); await Promise.resolve(); workers[2].finish({ revision: 'bad' });
  assert.equal((await corrupt).reason, 'worker-identity');
  const controller = new AbortController(); const cancelled = resource.run({}, { signal: controller.signal });
  await Promise.resolve(); controller.abort(); assert.equal((await cancelled).reason, 'cancelled');
  assert.equal((await resource.run({}, { signal: controller.signal })).reason, 'cancelled');
  const pending = resource.run({}); await resource.dispose(); assert.equal((await pending).reason, 'disposed');
  assert.equal(resource.stats().pending, 0);
  assert.throws(() => createFormulaResource({ workerFactory: null }), TypeError);
  const broken = createFormulaResource({ workerFactory: () => { throw Error('bad'); } });
  assert.equal((await broken.run({})).reason, 'worker-failed'); await broken.dispose();
});
