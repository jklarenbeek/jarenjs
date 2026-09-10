import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderExecutor } from '@jarenjs/contract/provider';
import { createAttemptBudget } from '@jarenjs/core/retry';
import { fakeClock, tick } from './fixtures/provider-clock.js';

const request = { url: 'https://inventory.example/items', safety: 'safe-read' };

describe('strict provider execution policy', () => {
  it('never retries early when server delay exceeds the remaining deadline', async () => {
    const clock = fakeClock();
    let calls = 0;
    const executor = createProviderExecutor({ ...clock, overallMs: 1000, maxMs: 1000,
      transport: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '10' } }); } });
    const result = await executor.execute(request);
    assert.equal(result.reason, 'deadline');
    assert.equal(result.retryAfterMs, 10000);
    assert.equal(calls, 1);
    await executor.close();
    assert.equal(clock.pending(), 0);
  });

  it('honors the selected millisecond dialect and the exact total attempt count', async () => {
    const clock = fakeClock();
    const starts = [];
    const executor = createProviderExecutor({ ...clock, attempts: 3, retryAfter: 'milliseconds', retryAfterHeader: 'retry-after-ms',
      transport: async (_request, context) => {
        starts.push([clock.now(), context.attempt, context.maxAttempts]);
        return new Response('{}', { status: starts.length < 3 ? 429 : 200, headers: { 'retry-after-ms': '10' } });
      } });
    const pending = executor.execute(request);
    await tick();
    await clock.advance(9);
    assert.equal(starts.length, 1);
    await clock.advance(1);
    assert.equal(starts.length, 2);
    await clock.advance(10);
    assert.equal((await pending).state, 'ok');
    assert.deepEqual(starts, [[0, 1, 1], [10, 2, 1], [20, 3, 1]]);
    await executor.close();
    assert.equal(clock.pending(), 0);
  });

  it('single-send remains one dispatch across repeated outer callbacks', async () => {
    let calls = 0;
    const executor = createProviderExecutor({ transport: async () => { calls++; throw new Error('secret credential'); } });
    const budget = createAttemptBudget(3, 'single-send');
    const write = { ...request, method: 'POST', safety: 'single-send' };
    const first = await executor.execute(write, { budget });
    const second = await executor.execute(write, { budget });
    assert.equal(first.state, 'unresolved');
    assert.equal(second.reason, 'attempt-budget');
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify([first, second]).includes('secret'));
    await executor.close();
  });

  it('requires provider idempotency evidence and refuses undeclared safety', async () => {
    const executor = createProviderExecutor();
    await assert.rejects(executor.execute({ ...request, safety: 'provider-idempotent' }), { code: 'JC1012' });
    await assert.rejects(executor.execute({ url: request.url }), { code: 'JC1012' });
    await assert.rejects(executor.execute({ ...request, url: 'file:///tmp/private' }), { code: 'JC1012' });
    await executor.close();
    assert.throws(() => createProviderExecutor({ maxBytes: Infinity }), { code: 'JC1012' });
  });

  it('cancels bounded streams on byte exhaustion and refuses oversized request bodies', async () => {
    let cancelled = 0;
    let calls = 0;
    const executor = createProviderExecutor({ maxBytes: 4, maxRequestBytes: 4,
      transport: async () => { calls++; return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(3)); },
        cancel() { cancelled++; },
      })); } });
    assert.equal((await executor.execute(request)).reason, 'byte-limit');
    assert.equal(cancelled, 1);
    assert.equal((await executor.execute({ ...request, body: '12345' })).reason, 'request-byte-limit');
    assert.equal(calls, 1);
    await executor.close();
  });

  it('stops admission on cancel and awaits late transports before close settles', async () => {
    let release;
    let calls = 0;
    const executor = createProviderExecutor({ concurrency: 1,
      transport: async () => { calls++; await new Promise((r) => { release = r; }); return new Response('{}'); } });
    const first = executor.execute(request);
    const second = executor.execute(request);
    await tick();
    let closed = false;
    const closing = executor.close().then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    release();
    assert.equal((await first).state, 'cancelled');
    assert.equal((await second).state, 'cancelled');
    await closing;
    assert.equal(calls, 1);
    assert.deepEqual(executor.stats(), { active: 0, queued: 0, closed: true });
  });

  it('enforces attempt deadlines and suppresses late success', async () => {
    const clock = fakeClock();
    let release;
    const executor = createProviderExecutor({ ...clock, attempts: 1, attemptMs: 50,
      transport: async () => { await new Promise((r) => { release = r; }); return new Response('{}'); } });
    const pending = executor.execute(request);
    await tick();
    await clock.advance(50);
    release();
    assert.equal((await pending).reason, 'deadline');
    await executor.close();
    assert.equal(clock.pending(), 0);
  });

  it('dispatches the captured request even when its caller mutates a queued object', async () => {
    const seen = [];
    let release;
    const executor = createProviderExecutor({ concurrency: 1, transport: async (request) => {
      seen.push([request.url, request.headers?.accept]);
      if (seen.length === 1) await new Promise((resolve) => { release = resolve; });
      return new Response('{}');
    } });
    const first = executor.execute(request);
    await tick();
    const mutable = { ...request, headers: { accept: 'application/json' } };
    const second = executor.execute(mutable);
    mutable.url = 'https://other.example/items';
    mutable.headers.accept = 'other';
    release();
    await Promise.all([first, second]);
    assert.deepEqual(seen[1], [request.url, 'application/json']);
    await executor.close();
  });

  it('the default fetch transport disables redirects and requires explicit idempotency binding', async (t) => {
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      sent.push([url, options.redirect]);
      return new Response('{}');
    });
    const executor = createProviderExecutor();
    assert.equal((await executor.execute(request)).state, 'ok');
    assert.deepEqual(sent, [[request.url, 'manual']]);
    const idempotent = await executor.execute({ ...request, safety: 'provider-idempotent', idempotencyKey: 'key-1' });
    assert.equal(idempotent.reason, 'idempotency-transport-required');
    assert.equal(sent.length, 1);
    await executor.close();
  });

  it('does not expose exceptions from authority hooks or response accessors', async () => {
    const executor = createProviderExecutor({ transport: async () => ({
      status: 200, headers: { get() { throw new Error('private-header'); } },
    }) });
    const response = await executor.execute(request);
    const authority = await executor.execute(request, { beforeDispatch: () => { throw new Error('private-token'); } });
    assert.equal(response.reason, 'host-fault');
    assert.equal(authority.reason, 'host-fault');
    assert.ok(!JSON.stringify([response, authority]).includes('private'));
    await executor.close();
  });

  it('aborting a pending response read cancels and releases the reader', async () => {
    let cancelled = 0;
    const executor = createProviderExecutor({ transport: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled++; },
    })) });
    const controller = new AbortController();
    const pending = executor.execute(request, { signal: controller.signal });
    await tick();
    controller.abort();
    assert.equal((await pending).state, 'cancelled');
    assert.equal(cancelled, 1);
    await executor.close();
  });
});
