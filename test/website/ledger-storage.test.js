//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createSlotLedgerStorage } from '../../packages/website/src/lib/ledgerStore.js';
import { createLedger } from '@jarenjs/ai';

const locks = () => {
  let tail = Promise.resolve();
  return { request: (_name, fn) => {
    const next = tail.then(fn); tail = next.catch(() => {}); return next;
  } };
};
it('reloads inside a shared lock even when both tabs previously cached the empty slot', async () => {
  let bytes = null, failing = false;
  const slot = { key: 'test', reliable: true, read: () => bytes && JSON.parse(bytes), write: (next) => {
    if (failing) throw new Error('quota');
    bytes = JSON.stringify(next);
  } };
  const shared = locks(), a = createSlotLedgerStorage(slot, { locks: shared }), b = createSlotLedgerStorage(slot, { locks: shared });
  await Promise.all([a.get('x'), b.get('x')]);
  const one = createLedger({ storage: a }), two = createLedger({ storage: b });
  await Promise.all([one.addMemory({ text: 'a', evidence: 'a' }), two.addMemory({ text: 'b', evidence: 'b' })]);
  assert.equal((await one.listMemories()).length, 2);
  const before = bytes; failing = true;
  await assert.rejects(one.putSlot('x', 'x'), /quota/);
  assert.equal(bytes, before);
  assert.equal(a.status().durability, 'failed');
  failing = false;
  await one.putSlot('x', 'x');
  assert.equal(a.status().durability, 'durable');
  assert.equal(await two.readSlot('x'), 'x');
});
it('reports no-lock mode, denies denied locks, and refuses malformed persistent maps', async () => {
  const slot = { read: () => null, write: () => false };
  const plain = createSlotLedgerStorage(slot, { locks: null });
  assert.equal(plain.mutate, undefined);
  assert.equal(plain.status().concurrency, 'single-writer');
  await assert.rejects(plain.set('x', 1), /write failed/);
  const denied = createSlotLedgerStorage(slot, { locks: { request: async () => { throw new Error('denied'); } } });
  await assert.rejects(denied.set('x', 1), /denied/);
  const corrupt = createSlotLedgerStorage({ read: () => [], write: () => {} }, { locks: locks() });
  await assert.rejects(corrupt.get('x'), /record map/);
});

it('an elected owner refuses a second writer and close permits explicit takeover', async () => {
  const held = new Set(), queues = new Map();
  const manager = { request: async (name, options, fn) => {
    if (typeof options === 'function') { fn = options; options = {}; }
    if (options.ifAvailable) {
      if (held.has(name)) return fn(null);
      held.add(name);
      try { return await fn({ name }); }
      finally { held.delete(name); }
    }
    const result = (queues.get(name) ?? Promise.resolve()).then(fn);
    queues.set(name, result.catch(() => {}));
    return result;
  } };
  let bytes = null;
  const slot = { key: 'owner', read: () => bytes, write: (next) => { bytes = structuredClone(next); } };
  const options = { locks: manager, singleWriter: true };
  const a = createSlotLedgerStorage(slot, options), b = createSlotLedgerStorage(slot, options);
  await a.set('one', 1);
  await assert.rejects(b.set('two', 2), /another tab owns/);
  assert.equal(bytes.two, undefined);
  assert.equal(a.status().concurrency, 'single-writer');
  await a.close();
  await b.set('two', 2);
  assert.equal(await b.get('one'), 1);
  await b.close();
});
