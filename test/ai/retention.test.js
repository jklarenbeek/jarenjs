//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, createMemoryStorage, checkpointProgress, validateCheckpoint, ledgerFootprint } from '@jarenjs/ai';
import { archiveFootprint } from '../../packages/ai/src/archive.js';
import { retentionFixture, measureRetention } from '../../benchmark/lib/retention.js';
const now = () => '2026-09-09T00:00:00Z';
const dump = (map) => JSON.stringify([...map].sort());

it('reconciles serialized bytes and measures referenced/unreferenced losses after restart', async () => {
  const fixture = await retentionFixture();
  const measured = ledgerFootprint(fixture.records);
  assert.equal(measured.bytes, Buffer.byteLength(JSON.stringify(fixture.records)));
  assert.equal(measured.bytes, measured.overhead + Object.values(measured.classes).reduce((n, c) => n + c.bytes, 0));
  const oldest = await measureRetention(fixture, 8, 'oldest');
  const protectedResult = await measureRetention(fixture, 8, 'unreferenced');
  assert.ok(oldest.referencedResolution < 1);
  assert.equal(protectedResult.referencedResolution, 1);
  assert.equal(protectedResult.resumedCorrectness, 1);
  assert.equal(protectedResult.retrievalRecall10, 1);
  assert.ok(protectedResult.unreferencedResolution < 1);
  const checkpoint = await measureRetention(fixture, 48, 'checkpoint');
  assert.ok(checkpoint.goalChars < oldest.goalChars);
});

it('evicts deterministically with durable tombstones, protects evidence, and clears intentionally', async () => {
  const backing = new Map(), storage = createMemoryStorage(backing);
  const ledger = createLedger({ storage, now, archiveLimits: { maxItems: 2, maxBytes: 10000 } });
  await ledger.putSlot('old', 'old content', { kind: 'agent-round' });
  await ledger.putSlot('protected', 'keep content', { kind: 'agent-round', pinned: true });
  assert.ok(!(await ledger.putSlot('new', 'new content', { kind: 'agent-round' })).error);
  assert.equal((await ledger.readSlot('old')).status, 'evicted');
  assert.equal(await ledger.readSlot('protected'), 'keep content');
  assert.equal(await ledger.readSlot('absent'), undefined);
  assert.equal((await ledger.retentionReport()).evicted[0].name, 'old');
  const reopened = createLedger({ storage, now, archiveLimits: { maxItems: 2 } });
  assert.equal((await reopened.readSlot('old')).reason, 'archive-budget');
  await ledger.addMemory({ text: 'requires new', evidence: 'new' });
  const before = dump(backing);
  assert.equal((await reopened.putSlot('refused', 'x', { kind: 'agent-round' })).code, 'ARCHIVE_BUDGET');
  assert.equal(dump(backing), before);
  await reopened.clearArchives();
  assert.equal((await reopened.listSlots()).length, 0);
  assert.equal(await reopened.readSlot('old'), undefined);
  assert.equal(await reopened.retentionReport(), null);
  assert.equal((await reopened.listMemories()).length, 1);
});

it('archive byte limits include report/tombstones and refusal publishes no partial batch', async () => {
  const backing = new Map(), storage = createMemoryStorage(backing);
  const unbounded = createLedger({ storage, now, archiveLimits: { maxItems: 1 } });
  await unbounded.putSlot('first', 'é'.repeat(500), { kind: 'agent-round' });
  const bytes = archiveFootprint(Object.fromEntries([...backing].map(([k, v]) => [k, JSON.parse(v)]))).bytes;
  const bounded = createLedger({ storage, now, archiveLimits: { maxBytes: bytes, maxItems: 1 } });
  assert.ok(!(await bounded.putSlot('first', 'é'.repeat(500), { kind: 'agent-round' })).error);
  const before = dump(backing);
  const tooSmall = createLedger({ storage, now, archiveLimits: { maxBytes: bytes - 1 } });
  assert.equal((await tooSmall.putSlot('first', 'é'.repeat(500), { kind: 'agent-round' })).code, 'ARCHIVE_BUDGET');
  assert.equal(dump(backing), before);
  assert.ok((await bounded.putArchive([{ name: 'a', text: 'a', kind: 'agent-round' }, { name: 'b', text: 'b', kind: 'agent-round' }])).error);
  assert.equal(dump(backing), before);
});

it('goal checkpoint preserves every source through restart and rejects invented evidence', async () => {
  const backing = new Map(), storage = createMemoryStorage(backing);
  const options = { storage, now, goalLimits: { maxEntries: 2, maxChars: 6000, maxBytes: 10000 } };
  const ledger = createLedger(options);
  await ledger.setGoal({ objective: 'Resume verified work' });
  for (let i = 0; i < 12; i++) {
    const answer = await ledger.recordProgress({ note: 'verified '.repeat(20), evidence: 'receipt '.repeat(20) });
    assert.ok(!answer.error, answer.error);
  }
  const goal = await createLedger(options).getGoal();
  assert.equal(goal.checkpoint.sources.length + goal.progress.length, 12);
  assert.equal(new Set(goal.checkpoint.sources.map((s) => s.id)).size, goal.checkpoint.sources.length);
  assert.ok((await ledger.composeGoal()).text.length <= 6000);
  const checkpoint = checkpointProgress(goal);
  assert.equal(validateCheckpoint(checkpoint, goal).valid, true);
  checkpoint.records[0].evidence = 'invented';
  assert.equal(validateCheckpoint(checkpoint, goal).valid, false);
  const liar = createLedger({ ...options, goalLimits: { maxEntries: 0 }, checkpointReducer: () => checkpoint });
  const before = dump(backing);
  assert.equal((await liar.recordProgress({ note: 'new', evidence: 'receipt' })).code, 'GOAL_CHECKPOINT');
  assert.equal(dump(backing), before);
  const tiny = createLedger({ ...options, goalLimits: { maxChars: 10 } });
  assert.equal((await tiny.composeGoal()).code, 'GOAL_BUDGET');
  assert.equal((await tiny.recordProgress({ note: 'new', evidence: 'receipt' })).code, 'GOAL_BUDGET');
  assert.equal(dump(backing), before);
  await ledger.setGoal({ objective: 'Next objective' });
  assert.equal((await ledger.listArchivedGoals())[0].checkpoint.sources.length, 12);
});

it('retention requires atomic storage and quota failures leave all durable bytes unchanged', async () => {
  const base = createMemoryStorage();
  const plain = { ...base, mutate: undefined };
  const legacy = createLedger({ storage: plain, archiveLimits: { maxItems: 1 }, goalLimits: { maxEntries: 1 } });
  assert.equal((await legacy.putSlot('x', 'x', { kind: 'agent-round' })).code, 'ATOMIC_REQUIRED');
  assert.equal((await legacy.setGoal({ objective: 'x' })).code, 'ATOMIC_REQUIRED');
  const backing = new Map(), durable = createMemoryStorage(backing);
  let fail = false;
  const storage = { ...durable, mutate: (prefix, fn) => durable.mutate(prefix, (current) => {
    const result = fn(current);
    if (fail && result.next) throw new Error('quota');
    return result;
  }) };
  const ledger = createLedger({ storage, now, archiveLimits: { maxItems: 1 }, goalLimits: { maxEntries: 0 } });
  await ledger.setGoal({ objective: 'goal' });
  await ledger.putSlot('old', 'old', { kind: 'agent-round' });
  const before = dump(backing); fail = true;
  await assert.rejects(ledger.putSlot('new', 'new', { kind: 'agent-round' }), /quota/);
  await assert.rejects(ledger.recordProgress({ note: 'done', evidence: 'source' }), /quota/);
  assert.equal(dump(backing), before);
});

it('committed retention curves validate and reproduce every seeded policy row', async () => {
  const { readFileSync } = await import('node:fs');
  const { JarenValidator } = await import('@jarenjs/validate');
  const read = (name) => JSON.parse(readFileSync(new URL(`../../benchmark/${name}`, import.meta.url), 'utf8'));
  const artifact = read('retention-result.json');
  const check = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(read('retention-result.schema.json'));
  assert.equal(check(artifact).valid, true);
  const fixture = await retentionFixture();
  for (const row of artifact.rows) assert.deepEqual(await measureRetention(fixture, row.maxItems, row.policy), row);
  const decoding = read('patch-decoding-live.json');
  assert.ok(decoding.rows.every((row) => row.schemaSent === true || row.outcome === 'failed'));
  const preparatory = read('patch-decoding-preparatory.json');
  assert.equal(preparatory.schemaSent, false);
});

it('scoped lifecycle reads and clears never expose or remove sibling archives', async () => {
  const { createEnvironment } = await import('@jarenjs/ai');
  const ledger = createLedger({ now, archiveLimits: { maxItems: 2 } });
  const a = createEnvironment({ ledger, scope: 'a/' }), b = createEnvironment({ ledger, scope: 'b/' });
  await a.ledger.putArchive([{ name: 'old', text: 'old', kind: 'agent-round' }]);
  await b.ledger.putArchive([{ name: 'keep', text: 'keep', kind: 'agent-round' }]);
  await a.ledger.putArchive([{ name: 'new', text: 'new', kind: 'agent-round' }]);
  assert.equal((await a.peek('old')).status, 'evicted');
  assert.equal((await a.peek('old')).name, 'old');
  assert.ok((await a.peek('b/keep')).error);
  assert.equal((await a.ledger.retentionReport()).evicted[0].name, 'old');
  assert.equal((await b.ledger.retentionReport()).evicted.length, 0);
  await a.ledger.clearArchives();
  assert.equal(await a.ledger.readSlot('old'), undefined);
  assert.equal(await b.ledger.readSlot('keep'), 'keep');
});

it('re-archiving identical content preserves timestamps and pinned protection', async () => {
  let tick = 0;
  const backing = new Map(), ledger = createLedger({ storage: createMemoryStorage(backing),
    now: () => new Date(Date.UTC(2026, 8, 9, 0, 0, tick++)).toISOString(), archiveLimits: { maxItems: 1 } });
  const first = await ledger.putSlot('pinned', 'held', { kind: 'agent-round', pinned: true });
  await ledger.putArchive([{ name: 'pinned', text: 'held', kind: 'agent-round' }]);
  assert.deepEqual(await ledger.getSlot('pinned'), first);
  const before = dump(backing);
  assert.equal((await ledger.putArchive([{ name: 'other', text: 'other', kind: 'agent-round' }])).code, 'ARCHIVE_BUDGET');
  assert.equal(dump(backing), before);
  assert.equal((await ledger.putArchive([{ name: 'outside', text: 'not a round', kind: 'text' }])).code, 'ARCHIVE_INPUT');
  assert.equal(dump(backing), before);
});

it('archive limits do not make ordinary slot writes copy an unrelated corpus', async () => {
  const base = createMemoryStorage();
  await base.set('ai/state/slot-content/corpus', 'x'.repeat(100000));
  let copied = 0;
  const storage = { ...base, mutate: (scope, fn) => base.mutate(scope, (current) => {
    copied = Math.max(copied, Buffer.byteLength(JSON.stringify(current)));
    return fn(current);
  }) };
  const ledger = createLedger({ storage, now, archiveLimits: { maxItems: 2 } });
  await ledger.putSlot('small', 'content');
  assert.ok(copied < 1000, `ordinary write copied ${copied} bytes`);
  assert.equal((await ledger.readSlot('corpus')).length, 100000);
});
