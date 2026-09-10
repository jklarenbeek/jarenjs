//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLexical } from '@jarenjs/core/search';
import { createSearchResource } from '@jarenjs/app/search';

const definition = { version: 1, fields: ['title'] };
const identity = (generation) => ({ generation, sourceRevision: `r${generation}`, requestId: `q${generation}` });
function workerHost() {
  const requests = [];
  return { requests, request: (message, options) => new Promise((resolve) => requests.push({ message, options, resolve })),
    dispose() { for (const request of requests) request.resolve(null); requests.length = 0; } };
}
function finish(request, changes = {}) {
  const { message } = request, index = compileLexical(message.definition).create();
  index.rebuild(message.documents, message);
  request.resolve({ version: 1, ...identity(message.generation), state: 'complete', snapshot: index.snapshot(), ...changes });
  index.dispose();
}
describe('injected lexical worker lifecycle', () => {
  it('publishes only matching complete snapshots, progress stays JSON and teardown drains', async () => {
    for (let cycle = 0; cycle < 12; cycle++) {
      const worker = workerHost(), progress = [];
      const resource = createSearchResource(definition, { workerFactory: () => worker, onProgress: (p) => progress.push(p) });
      const first = resource.build([{ id: 'old', title: 'tea' }], identity(1));
      const second = resource.build([{ id: 'new', title: 'tea' }], identity(2));
      worker.requests[0].options.onProgress({ version: 1, ...identity(1), work: 20 });
      worker.requests[1].options.onProgress({ version: 1, ...identity(2), work: 10 });
      assert.equal(progress.length, 1); assert.deepEqual(progress[0], { ...identity(2), work: 10 });
      finish(worker.requests[1]); assert.equal((await second).state, 'complete');
      finish(worker.requests[0]); assert.equal((await first).state, 'invalidated');
      assert.deepEqual(resource.search('tea').hits.map((h) => h.id), ['new']);
      const pending = resource.build([], identity(3)); await resource.dispose(); await resource.dispose();
      assert.equal((await pending).reason, 'disposed');
      assert.equal(resource.stats().pending, 0); assert.equal(resource.stats().workers, 0);
      assert.equal(resource.stats().documents, 0); assert.equal(resource.stats().sourceBytes, 0);
      assert.equal((await resource.build([], identity(4))).reason, 'disposed');
    }
  });
  it('refuses worker corruption, stale identities and incomplete snapshots', async () => {
    const worker = workerHost(), resource = createSearchResource(definition, { workerFactory: () => worker });
    for (const [i, change] of [{ requestId: 'wrong' }, { snapshot: '{}' }, { state: 'loading' }, { state: 'budget-exhausted', reason: 'work' }].entries()) {
      const build = resource.build([{ id: 'a', title: 'tea' }], identity(i + 1)); finish(worker.requests.at(-1), change);
      assert.notEqual((await build).state, 'complete'); assert.equal(resource.stats().documents, 0);
    }
    assert.equal((await resource.build([], identity(1))).reason, 'stale-generation');
    assert.equal((await resource.build([], { ...identity(5), generation: -1 })).reason, 'invalid-identity');
    await resource.dispose();
  });
  it('honors cancellation and admission credits without publishing abandoned results', async () => {
    const worker = workerHost(), resource = createSearchResource(definition, { workerFactory: () => worker, maxInFlight: 1 });
    const controller = new AbortController(), pending = resource.build([], identity(1), controller.signal);
    assert.equal((await resource.build([], identity(2))).reason, 'in-flight');
    controller.abort(); finish(worker.requests[0]); assert.equal((await pending).reason, 'cancelled');
    assert.equal((await resource.build([], identity(2), controller.signal)).reason, 'cancelled');
    await resource.dispose();
    assert.throws(() => createSearchResource(definition, { workerFactory: null }));
    const broken = createSearchResource(definition, { workerFactory: () => { throw new Error('launch'); } });
    assert.equal((await broken.build([], identity(1))).reason, 'launch'); await broken.dispose();
  });
});

it('projects declared text before transport and refuses oversized or malformed source without a worker', async () => {
  const worker = workerHost();
  const resource = createSearchResource({ ...definition, limits: { maxDocuments: 1, maxFieldBytes: 8, maxSourceBytes: 8 } }, { workerFactory: () => worker });
  for (const [rows, reason] of [[null, 'invalid-documents'], [[{}, {}], 'documents'], [[{ id: 'a', title: 1 }], 'invalid-documents'],
    [[{ id: 'a', title: '123456789' }], 'field-bytes'], [[{ id: 'a', title: '抹茶緑' }], 'field-bytes'], [[{ id: 'a', title: '12345678' }], 'source-bytes']]) {
    assert.equal((await resource.build(rows, identity(1))).reason, reason); assert.equal(worker.requests.length, 0);
  }
  const pending = resource.build([{ id: 'a', title: 'tea', unrelated: new Uint8Array(5000) }], identity(1));
  assert.deepEqual(worker.requests[0].message.documents, [{ id: 'a', title: 'tea' }]); finish(worker.requests[0]);
  assert.equal((await pending).state, 'complete'); await resource.dispose();
});
