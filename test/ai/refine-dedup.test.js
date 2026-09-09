//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, createRefiner, createMemoryStorage } from '@jarenjs/ai';
import { applyJSONPatch } from '@jarenjs/json';

const memory = { text: 'Amber retries twice.', evidence: 'Audit R1.', tags: ['amber', 'retry'] };
const add = (value = memory) => ({ op: 'add', path: '/memories/-', value });
const make = (ledger, options = {}) => createRefiner({ ledger, client: {}, applyPatch: applyJSONPatch, ...options });

describe('opt-in exact-evidence refinement', () => {
  it('leaves defaults intact and rejects an unknown policy', async () => {
    const ledger = createLedger(), refiner = make(ledger);
    await refiner.commit([add(), add()]);
    assert.equal((await ledger.listMemories()).length, 2);
    assert.throws(() => make(ledger, { deduplicate: 'cosine' }), /deduplicate/);
  });
  it('skips exact repeats within/across batches and audits the retained source', async () => {
    const ledger = createLedger(), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    const first = await refiner.commit([add(), add({ ...memory, tags: ['retry', 'amber'] })]);
    assert.equal(first.ok, true);
    assert.equal(first.memories.length, 1);
    assert.deepEqual(first.deduplicated, [{ path: '/memories/1', retainedPath: '/memories/0' }]);
    const stored = await ledger.listMemories();
    const repeat = await refiner.commit([add()]);
    assert.equal(repeat.snapshot, null);
    assert.equal(repeat.deduplicated[0].retainedId, stored[0].id);
    assert.deepEqual(await ledger.listMemories(), stored);
  });
  it('preserves conflicting case, whitespace, details, citations and tags', async () => {
    const ledger = createLedger(), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    await refiner.commit([add()]);
    const different = [
      { text: 'AMBER retries twice.' }, { text: 'Amber retries  twice.' }, { text: 'Amber retries thrice.' },
      { evidence: 'Independent audit R2.' }, { tags: ['amber'] },
    ];
    await refiner.commit(different.map((change) => add({ ...memory, ...change })));
    assert.equal((await ledger.listMemories()).length, 6);
  });
  it('never matches a record removed by the same patch', async () => {
    const ledger = createLedger(), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    await refiner.commit([add()]);
    const before = await ledger.listMemories();
    const result = await refiner.commit([{ op: 'remove', path: '/memories/0' }, add()]);
    assert.equal(result.ok, true);
    assert.equal((await ledger.listMemories()).length, 1);
    assert.notEqual((await ledger.listMemories())[0].id, before[0].id);
  });
  it('serializes concurrent commits on one refiner and recovers its queue after failure', async () => {
    const ledger = createLedger(), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    const results = await Promise.all(Array.from({ length: 8 }, () => refiner.commit([add()])));
    assert.ok(results.every((r) => r.ok));
    assert.equal((await ledger.listMemories()).length, 1);
    assert.ok((await refiner.commit([add({ text: 'bad', evidence: '' })])).error);
    assert.equal((await refiner.commit([add()])).ok, true);
  });
  it('validates every proposal before skipping duplicates', async () => {
    const ledger = createLedger(), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    await refiner.commit([add()]);
    const before = await ledger.listMemories();
    const result = await refiner.commit([add({ ...memory, extra: 'invalid' })]);
    assert.ok(result.error);
    assert.deepEqual(await ledger.listMemories(), before);
  });
  it('resumes the serialized generation queue after a rejected provider call', async () => {
    const ledger = createLedger();
    let calls = 0;
    const client = { endpoint: { provider: 'scripted' }, complete: async () => {
      if (++calls === 1) throw new Error('provider failed');
      return { message: { content: JSON.stringify([add()]) } };
    } };
    const refiner = make(ledger, { client, deduplicate: 'exact-evidence' });
    await assert.rejects(refiner.refine([]), /provider failed/);
    assert.equal((await refiner.refine([])).ok, true);
    assert.equal((await ledger.listMemories()).length, 1);
  });
  it('restores byte-identical state when a later write throws', async () => {
    const backing = new Map(), base = createMemoryStorage(backing);
    let writes = 0, armed = false;
    const storage = { ...base, set: async (key, value) => {
      if (armed && key.startsWith('ai/state/memory/') && ++writes === 2) { armed = false; throw new Error('disk failure'); }
      await base.set(key, value);
    } };
    const ledger = createLedger({ storage }), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    await refiner.commit([add()]);
    const before = await ledger.listMemories();
    armed = true;
    const failed = await refiner.commit([add({ ...memory, evidence: 'R2' }), add({ ...memory, evidence: 'R3' })]);
    assert.match(failed.error, /rolled back.*disk failure/);
    assert.deepEqual(await ledger.listMemories(), before);
    assert.equal((await refiner.commit([add({ ...memory, evidence: 'R2' })])).ok, true);
  });
  it('restores a replacement after a deletion throws and exposes failed rollback honestly', async () => {
    const base = createMemoryStorage();
    let failDelete = false, failRestore = false;
    const storage = { ...base, delete: async (key) => {
      if (failDelete) { failDelete = false; throw new Error('delete failed'); }
      await base.delete(key);
    }, set: async (key, value) => {
      if (failRestore && key.startsWith('ai/state/memory/')) throw new Error('cannot store');
      await base.set(key, value);
    } };
    const ledger = createLedger({ storage }), refiner = make(ledger, { deduplicate: 'exact-evidence' });
    await refiner.commit([add()]);
    const before = await ledger.listMemories();
    failDelete = true;
    const replace = [{ op: 'replace', path: '/memories/0', value: { ...memory, text: 'Updated claim.' } }];
    assert.match((await refiner.commit(replace)).error, /rolled back/);
    assert.deepEqual(await ledger.listMemories(), before);
    failRestore = true;
    assert.match((await refiner.commit(replace)).error, /rollback failed/);
  });
});
