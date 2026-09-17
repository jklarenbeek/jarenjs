import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderExecutor, providerReplayKey } from '@jarenjs/contract/provider';
const request = { url: 'https://example.test/items', safety: 'safe-read', account: 'tenant-1' };
const cacheScope = 'test-provider/schema-1/visibility-1';

test('provider capture replays bounded safe reads with zero second transport calls and fresh authority', async () => {
  const cache = new Map(); let transports = 0, checks = 0;
  const executor = createProviderExecutor({ cache, cacheScope, transport: async () => { transports++; return new Response('café'); } });
  const context = { beforeDispatch: async () => { checks++; return true; } };
  const first = await executor.execute(request, context), second = await executor.execute(request, context);
  assert.equal(first.replayed, false); assert.equal(first.attempts, 1);
  assert.equal(second.replayed, true); assert.equal(second.attempts, 0);
  assert.equal(second.bytes, 5); assert.equal(second.text, 'café');
  assert.equal(transports, 1); assert.equal(checks, 2);
  assert.equal((await executor.execute(request, { beforeDispatch: () => false })).reason, 'authority-changed');
  assert.equal((await executor.execute(request, { maxBytes: 4 })).reason, 'replay-byte-limit');
  assert.equal((await executor.execute({ ...request, account: 'tenant-2' })).replayed, false);
  assert.equal(transports, 2); await executor.close();
});

test('provider identities normalize public headers and separate scope, body, method and account', async () => {
  const key = req => providerReplayKey(req, { scope: cacheScope });
  const expected = await key(request);
  assert.equal(await key({ ...request, headers: { Authorization: 'secret', Cookie: 'private', 'X-Api-Key': 'key', apikey: 'another-key' } }), expected);
  assert.equal(await key({ ...request, headers: { Accept: ' application/json ' } }), await key({ ...request, headers: { accept: 'application/json' } }));
  for (const variant of [{ account: 'other' }, { body: 'x' }, { method: 'POST' }, { url: request.url + '?page=2' }])
    assert.notEqual(await key({ ...request, ...variant }), expected);
  assert.notEqual(await providerReplayKey(request, { scope: 'another-schema' }), expected);
  for (const url of ['https://user:password@example.test', request.url + '?api_key=hidden', request.url + '?apikey=hidden', 'file:///tmp/no'])
    await assert.rejects(key({ ...request, url }));
  await assert.rejects(providerReplayKey(request, { scope: '' }));
  await assert.rejects(providerReplayKey(request, { scope: 'scope', maxBytes: 0 }));
  await assert.rejects(providerReplayKey({ ...request, body: 'x'.repeat(100) }, { scope: 'scope', maxBytes: 50 }));
  await assert.rejects(key({ ...request, headers: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => ['x-' + i, 'v'])) }));
});

test('offline replay refuses misses, corruption, unsafe effects and invalid configuration without dispatch', async () => {
  let calls = 0; const cache = new Map();
  const executor = createProviderExecutor({ cache, cacheScope, replay: 'replay', transport: async () => { calls++; return new Response('bad'); } });
  assert.equal((await executor.execute(request)).reason, 'replay-miss');
  assert.equal((await executor.execute({ ...request, safety: 'single-send' })).reason, 'replay-unsafe');
  const key = await providerReplayKey(request, { scope: cacheScope });
  for (const entry of [{}, { format: 'jaren-provider-replay/1', key, status: 500, text: 'x' },
    { format: 'jaren-provider-replay/1', key: 'wrong', status: 200, text: 'x' }]) {
    cache.set(key, entry); assert.equal((await executor.execute(request)).reason, 'replay-entry-invalid');
  }
  cache.set(key, { format: 'jaren-provider-replay/1', key, status: 200, text: 'long' });
  assert.equal((await executor.execute(request, { maxBytes: 1 })).reason, 'replay-byte-limit');
  assert.equal(calls, 0); await executor.close();
  for (const options of [{ replay: 'replay' }, { cacheScope }, { cache }, { cache, cacheScope, replay: 'wrong' }])
    assert.throws(() => createProviderExecutor(options));
});

test('record mode refreshes, failures do not record, and cache faults retain spent transport credit', async () => {
  const cache = new Map(); let calls = 0;
  const executor = createProviderExecutor({ cache, cacheScope, replay: 'record', attempts: 1,
    transport: async () => new Response(String(++calls), { status: calls === 3 ? 500 : 200 }) });
  await executor.execute(request); await executor.execute(request);
  assert.equal(calls, 2); assert.equal([...cache.values()][0].text, '2');
  assert.equal((await executor.execute(request)).state, 'failed'); assert.equal([...cache.values()][0].text, '2');
  await executor.close();
  const broken = createProviderExecutor({ cacheScope, cache: { get: () => undefined, set: () => { throw Error('disk'); } }, transport: async () => new Response('read') });
  const failed = await broken.execute(request);
  assert.equal(failed.reason, 'replay-cache-fault'); assert.equal(failed.attempts, 1); assert.equal(failed.bytes, 4); await broken.close();
});

test('cache cancellation and deadlines retain owner credit and shutdown drains late settlement', async () => {
  let finish, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const executor = createProviderExecutor({ cacheScope, overallMs: 1000, concurrency: 1, maxQueue: 1,
    cache: { get: () => { entered(); return new Promise(resolve => { finish = resolve; }); }, set() {} } });
  const abort = new AbortController(), running = executor.execute(request, { signal: abort.signal });
  await ready; abort.abort(); assert.equal((await running).reason, 'cancelled');
  const queued = executor.execute(request);
  assert.equal((await executor.execute(request)).reason, 'queue-full');
  let drained = false; const closing = executor.close().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  finish(undefined); await closing; assert.equal((await queued).reason, 'cancelled');
  assert.equal((await executor.execute(request)).reason, 'cancelled');
  const deadline = createProviderExecutor({ cacheScope, overallMs: 15,
    cache: { get: (_key, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })), set() {} } });
  assert.equal((await deadline.execute(request)).reason, 'deadline'); await deadline.close();
  const expired = createProviderExecutor({ cacheScope, cache: new Map(), now: () => 10 });
  assert.equal((await expired.execute(request, { deadline: 9 })).reason, 'deadline'); await expired.close();
});
