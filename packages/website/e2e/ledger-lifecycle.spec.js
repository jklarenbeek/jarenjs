//@ts-check
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
test.use({ serviceWorkers: 'block' });
const root = fileURLToPath(new URL('../../../', import.meta.url));
let bundle;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    export { createLedger, createRefiner, createClaimRefiner, validateClaimEvidence } from '@jarenjs/ai';
    export { applyJSONPatch } from '@jarenjs/json';
    export { createSlotLedgerStorage } from './packages/website/src/lib/ledgerStore.js';
  `, resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  bundle = result.outputFiles[0].text;
});
const boot = async (page, noLocks = false) => {
  await page.route('**/ledger-fixture.js*', (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'cache-control': 'no-store' }, body: bundle }));
  await page.goto('/');
  return page.evaluate(async (noLocks) => {
    const api = await import(`/ledger-fixture.js?instance=${Date.now()}-${Math.random()}`);
    const slot = { key: 'ledger-lifecycle-test', reliable: true,
      read: () => JSON.parse(localStorage.getItem('ledger-lifecycle-test') ?? 'null'),
      write: (next) => {
        if (window.failLedgerWrite) throw new DOMException('test quota', 'QuotaExceededError');
        localStorage.setItem('ledger-lifecycle-test', JSON.stringify(next));
      } };
    window.ledgerApi = api;
    window.ledgerStorage = api.createSlotLedgerStorage(slot, noLocks ? { locks: null } : {});
    window.testLedger = api.createLedger({ storage: window.ledgerStorage,
      archiveLimits: { maxItems: 3, maxBytes: 20000 },
      goalLimits: { maxEntries: 3, maxChars: 12000, maxBytes: 16000 },
      now: () => '2026-09-09T00:00:00Z' });
    return window.testLedger.concurrency;
  }, noLocks);
};

test('two tabs retain ids, evidence and reported archives across eviction, quota failure and restart', async ({ page, context, browserName }, testInfo) => {
  const second = await context.newPage();
  expect(await boot(page)).toBe('atomic');
  expect(await boot(second)).toBe('atomic');
  await page.evaluate(() => window.testLedger.setGoal({ objective: 'Resume verified receipts' }));
  const elected = await page.evaluate(() => window.ledgerStorage.status().concurrency === 'single-writer');
  if (elected) {
    const refused = await second.evaluate(async () => {
      try { await window.testLedger.addMemory({ text: 'must refuse', evidence: 'another writer' }); return null; }
      catch (error) { return error.message; }
    });
    expect(refused).toContain('another tab owns');
  }
  await Promise.all([page, elected ? page : second].map((tab, writer) => tab.evaluate(async (writer) => {
    for (let i = 0; i < 12; i++) {
      const ledger = window.testLedger;
      await ledger.addMemory({ text: `writer ${writer} item ${i}`, evidence: 'verified receipt' });
      await ledger.recordProgress({ note: 'Completed verified batch', evidence: 'receipt 42' });
    }
  }, writer)));
  const state = await page.evaluate(async () => {
    const ledger = window.testLedger;
    await ledger.putSlot('old', 'old bytes', { kind: 'agent-round' });
    await ledger.putSlot('protected', 'protected bytes', { kind: 'agent-round', pinned: true });
    await ledger.putSlot('recent', 'recent bytes', { kind: 'agent-round' });
    await ledger.putSlot('new', 'new bytes', { kind: 'agent-round' });
    const memories = await ledger.listMemories(), goal = await ledger.getGoal();
    return { ids: memories.map((m) => m.id), entries: (goal.checkpoint?.sources.length ?? 0) + goal.progress.length,
      evicted: await ledger.readSlot('old'), prompt: await ledger.composeGoal() };
  });
  expect(new Set(state.ids).size).toBe(24);
  expect(state.entries).toBe(24);
  expect(state.evicted.status).toBe('evicted');
  expect(state.prompt.text.length).toBeLessThanOrEqual(12000);
  const references = await page.evaluate(async () => {
    const ledger = window.testLedger, api = window.ledgerApi;
    const envelope = { version: 1, artifacts: [{ id: 'protected', kind: 'slot', locator: 'protected' }],
      evidence: [{ id: 'e', artifact: 'protected', quote: 'protected bytes' }], visibleEvidence: ['e'],
      claims: [{ id: 'c', text: 'protected content exists', critical: true, status: 'supported', evidence: ['e'] }] };
    const good = await ledger.addMemory({ text: 'referential memory', evidence: envelope });
    const bad = structuredClone(envelope); bad.evidence[0].artifact = 'missing';
    const refused = await ledger.addMemory({ text: 'bad reference', evidence: bad });
    const wrong = await api.createRefiner({ ledger, applyPatch: api.applyJSONPatch }).commit([
      { op: 'add', path: '/goal/progress/-', value: { text: 'wrong path shape', evidence: 'source' } },
    ]);
    await ledger.deleteMemory(good.id);
    return { stored: good.evidence, refused: Boolean(refused.error), wrong: Boolean(wrong.error),
      quota: await navigator.storage?.estimate?.(), bytes: new TextEncoder().encode(localStorage.getItem('ledger-lifecycle-test')).length };
  });
  expect(references.stored.version).toBe(1);
  expect(references.refused).toBe(true);
  expect(references.wrong).toBe(true);
  await testInfo.attach('ledger-storage-probe', { contentType: 'application/json',
    body: JSON.stringify({ browser: browserName, observed: references.quota, serializedBytes: references.bytes,
      quotaFailure: 'injected at write boundary; no universal quota is assumed' }) });
  const refusal = await (elected ? page : second).evaluate(async () => {
    const before = localStorage.getItem('ledger-lifecycle-test');
    window.failLedgerWrite = true;
    const refiner = window.ledgerApi.createRefiner({ ledger: window.testLedger, applyPatch: window.ledgerApi.applyJSONPatch });
    const result = await refiner.commit([{ op: 'add', path: '/memories/-', value: { text: 'must not land', evidence: 'test' } }]);
    window.failLedgerWrite = false;
    return { error: result.error, unchanged: before === localStorage.getItem('ledger-lifecycle-test'), status: window.ledgerStorage.status() };
  });
  expect(refusal.error).toContain('storage failure');
  expect(refusal.unchanged).toBe(true);
  expect(refusal.status.durability).toBe('failed');
  if (elected) await page.close();
  await boot(second);
  const restarted = await second.evaluate(async () => {
    const ledger = window.testLedger;
    const old = await ledger.readSlot('old'), kept = await ledger.readSlot('protected');
    const count = (await ledger.listMemories()).length;
    await ledger.clearArchives();
    return { old, kept, count, slots: await ledger.listSlots(), cleared: await ledger.readSlot('old'), report: await ledger.retentionReport() };
  });
  expect(restarted.old.status).toBe('evicted');
  expect(restarted.kept).toBe('protected bytes');
  expect(restarted.count).toBe(24);
  expect(restarted.slots).toEqual([]);
  expect(restarted.cleared).toBeUndefined();
  expect(restarted.report).toBeNull();
});

test('a host without locks explicitly refuses atomic retention', async ({ page }) => {
  expect(await boot(page, true)).toBe('single-writer');
  const result = await page.evaluate(() => window.testLedger.setGoal({ objective: 'goal' }));
  expect(result.code).toBe('ATOMIC_REQUIRED');
});
