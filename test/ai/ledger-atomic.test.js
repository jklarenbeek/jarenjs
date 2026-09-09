//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, createMemoryStorage } from '@jarenjs/ai';
const now = () => '2026-09-09T00:00:00Z';

it('reproduces lost ids on a four-method adapter and preserves them atomically', async () => {
  for (const atomic of [false, true]) {
    const backing = new Map();
    const adapter = () => {
      const { mutate, ...base } = createMemoryStorage(backing);
      return atomic ? { ...base, mutate } : base;
    };
    const a = createLedger({ storage: adapter(), now });
    const b = createLedger({ storage: adapter(), now });
    assert.equal(a.concurrency, atomic ? 'atomic' : 'single-writer');
    await Promise.all([a, b].map((ledger) => ledger.addMemory({ text: 'fact', evidence: 'source' })));
    assert.equal((await a.listMemories()).length, atomic ? 2 : 1);
    if (atomic) {
      await a.setGoal({ objective: 'finish' });
      await Promise.all(Array.from({ length: 30 }, (_, i) => [a, b][i % 2].recordProgress({ note: String(i), evidence: 'source' })));
      assert.equal((await b.getGoal()).progress.length, 30);
      const old = (await a.listMemories()).map((m) => m.id);
      for (const id of old) await a.deleteMemory(id);
      const next = await b.addMemory({ text: 'next', evidence: 'source' });
      assert.ok(!old.includes(next.id), 'deleted ids are never reused');
    }
  }
});

it('atomic adapter failures publish neither records nor counters', async () => {
  const backing = new Map();
  const base = createMemoryStorage(backing);
  const ledger = createLedger({ now, storage: { ...base,
    mutate: async (prefix, fn) => base.mutate(prefix, (current) => {
      const outcome = fn(current);
      if (outcome.next) throw new Error('quota');
      return outcome;
    }),
  } });
  await assert.rejects(ledger.addMemory({ text: 'fact', evidence: 'source' }), /quota/);
  assert.equal(backing.size, 0);
  await assert.rejects(base.mutate('ai/', async () => ({ next: {} })), /synchronous/);
  await assert.rejects(base.mutate('ai/', () => ({ next: { outside: true } })), /namespace/);
  assert.equal(backing.size, 0);
});

it('refinement refuses a stale generated document and never rolls another writer back', async () => {
  const { createRefiner } = await import('@jarenjs/ai');
  const { applyJSONPatch } = await import('@jarenjs/json');
  const backing = new Map(), first = createLedger({ storage: createMemoryStorage(backing), now });
  const second = createLedger({ storage: createMemoryStorage(backing), now });
  let release, started;
  const entered = new Promise((resolve) => { started = resolve; });
  const client = { endpoint: { provider: 'openrouter' }, complete: async () => {
    started(); await new Promise((resolve) => { release = resolve; });
    return { message: { content: JSON.stringify([{ op: 'add', path: '/memories/-', value: { text: 'stale', evidence: 'source' } }]) } };
  } };
  const refiner = createRefiner({ ledger: first, client, applyPatch: applyJSONPatch });
  const running = refiner.refine([]);
  await entered;
  await second.addMemory({ text: 'another writer', evidence: 'source' });
  release();
  assert.match((await running).error, /state changed/);
  assert.deepEqual((await first.listMemories()).map((m) => m.text), ['another writer']);
});

it('contention retries never repeat a successful embedding request', async () => {
  const backing = new Map();
  let calls = 0;
  const embedder = { model: 'fixture', dims: 2, embed: async () => { calls++; return [new Float32Array([1, 0])]; } };
  const options = { now, embedder, embedOnWrite: true };
  const a = createLedger({ ...options, storage: createMemoryStorage(backing) });
  const b = createLedger({ ...options, storage: createMemoryStorage(backing) });
  await Promise.all([a, b].map((ledger) => ledger.addMemory({ text: 'same', evidence: 'source' })));
  assert.equal(calls, 2);
  assert.equal((await a.listMemories()).length, 2);
});

it('a later goal-budget refusal publishes neither an earlier memory nor snapshot/counters', async () => {
  const { createRefiner } = await import('@jarenjs/ai');
  const { applyJSONPatch } = await import('@jarenjs/json');
  const backing = new Map(), storage = createMemoryStorage(backing);
  await createLedger({ storage, now }).setGoal({ objective: 'already active' });
  const ledger = createLedger({ storage, now, goalLimits: { maxChars: 1 } });
  const refiner = createRefiner({ ledger, applyPatch: applyJSONPatch });
  const before = JSON.stringify([...backing]);
  const result = await refiner.commit([
    { op: 'add', path: '/memories/-', value: { text: 'must not land', evidence: 'source' } },
    { op: 'add', path: '/goal/progress/-', value: { note: 'done', evidence: 'source' } },
  ]);
  assert.ok(result.error);
  assert.equal(result.snapshot, null);
  assert.equal(JSON.stringify([...backing]), before);
});
