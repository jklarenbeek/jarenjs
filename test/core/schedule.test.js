import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '@jarenjs/core/schedule';
import { backoffDelay, parseRetryAfter, sleep, createAttemptBudget } from '@jarenjs/core/retry';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('bounded shared scheduling', () => {
  it('rotates scopes and drains workers before close resolves', async () => {
    const scheduler = createScheduler({ concurrency: 1, maxQueue: 4 });
    const starts = [];
    let release;
    const first = scheduler.run(async () => { starts.push('a0'); await new Promise((r) => { release = r; }); }, { scope: 'a' });
    await tick();
    const a = scheduler.run(() => starts.push('a1'), { scope: 'a' });
    const b = scheduler.run(() => starts.push('b0'), { scope: 'b' });
    release();
    await Promise.all([first, a, b]);
    assert.deepEqual(starts, ['a0', 'b0', 'a1']);
    let done = false;
    const pending = scheduler.run(async () => { await new Promise((r) => { release = r; }); done = true; });
    await tick();
    const closing = scheduler.close();
    await tick();
    assert.equal(done, false);
    release();
    await Promise.all([pending, closing]);
    assert.equal(done, true);
    await assert.rejects(scheduler.run(() => {}), /closed/);
  });

  it('uses per-scope spacing, observed delays and an injected clock', async () => {
    let now = 0;
    const scheduler = createScheduler({ concurrency: 1, spacingMs: 10, now: () => now,
      sleep: async (ms) => { now += ms; } });
    const times = [];
    await scheduler.run(() => times.push(now), { scope: 'a' });
    scheduler.observe('a', 25);
    await scheduler.run(() => times.push(now), { scope: 'b' });
    await scheduler.run(() => times.push(now), { scope: 'a' });
    await scheduler.run(() => times.push(now), { scope: 'a' });
    assert.deepEqual(times, [0, 0, 25, 35]);
    await scheduler.close();
  });

  it('bounds the queue and refuses cancelled or expired work without starts', async () => {
    const scheduler = createScheduler({ concurrency: 1, maxQueue: 1, now: () => 10 });
    let release;
    const pending = scheduler.run(() => new Promise((r) => { release = r; }));
    await tick();
    const controller = new AbortController();
    const queued = scheduler.run(() => assert.fail('cancelled worker started'), { signal: controller.signal });
    const rejected = assert.rejects(queued, /cancelled/);
    await assert.rejects(scheduler.run(() => {}), /queue-full/);
    controller.abort();
    await rejected;
    await assert.rejects(scheduler.run(() => assert.fail('expired worker started'), { deadline: 10 }), /deadline/);
    release();
    await pending;
    await scheduler.close();
    assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, closed: true });
  });

  it('validates bounds and drains after worker rejection', async () => {
    for (const options of [{ concurrency: 0 }, { maxQueue: Infinity }, { spacingMs: -1 }])
      assert.throws(() => createScheduler(options), TypeError);
    const scheduler = createScheduler();
    await assert.rejects(scheduler.run(() => { throw new Error('worker'); }), /worker/);
    await scheduler.run(() => 1);
    await scheduler.close();
  });

  it('serves every queued scope before repeating one and bounds retained rate scopes', async () => {
    const scheduler = createScheduler({ concurrency: 1 });
    const starts = [];
    await Promise.all(['a', 'a', 'b', 'b', 'c', 'c'].map((scope) => scheduler.run(() => starts.push(scope), { scope })));
    assert.deepEqual(starts, ['a', 'b', 'c', 'a', 'b', 'c']);
    await scheduler.close();
    const bounded = createScheduler({ now: () => 0, maxScopes: 1 });
    bounded.observe('a', 100);
    await assert.rejects(bounded.run(() => assert.fail(), { scope: 'b' }), /scope-limit/);
    assert.throws(() => bounded.observe('b', 100), /scope-limit/);
    await bounded.close();
  });

  it('rechecks cancellation and time after synchronous workers', async () => {
    let now = 0;
    const controller = new AbortController();
    const scheduler = createScheduler({ concurrency: 3, now: () => now });
    const first = scheduler.run(() => { now = 10; controller.abort(); });
    const second = assert.rejects(scheduler.run(() => assert.fail(), { deadline: 5 }), /deadline/);
    const third = assert.rejects(scheduler.run(() => assert.fail(), { signal: controller.signal }), /cancelled/);
    await Promise.all([first, second, third]);
    await scheduler.close();
  });

  it('a failed clock sleeper closes admission and drains its queued work', async () => {
    const scheduler = createScheduler({ now: () => 0, spacingMs: 10,
      sleep: async () => { throw new Error('timer failed'); } });
    await scheduler.run(() => 1, { scope: 'a' });
    await assert.rejects(scheduler.run(() => assert.fail(), { scope: 'a' }), /timer failed/);
    await scheduler.close();
    assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, closed: true });
  });
});

describe('shared retry policies', () => {
  it('preserves both compatibility formulas and honors strict Retry-After', () => {
    for (const random of [0, 0.25, 0.999]) for (const attempt of [1, 2, 8]) {
      assert.equal(backoffDelay({ policy: 'ai-compat', baseMs: 500, maxMs: 8000, random: () => random }, attempt),
        Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + 0.5 * random));
      assert.equal(backoffDelay({ policy: 'contract-compat', baseMs: 1000, maxMs: 8000, random: () => random }, attempt),
        Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(random * 250));
    }
    assert.equal(backoffDelay({ policy: 'ai-compat', maxMs: 1000 }, 1, 10000), 1000);
    assert.equal(backoffDelay({ maxMs: 1000 }, 1, 10000), 10000);
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter('2', { dialect: 'milliseconds' }), 2);
    assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', { now: 1000 }), 2000);
    assert.equal(parseRetryAfter('invalid'), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('2', { dialect: 'none' }), undefined);
  });
  it('shares a total attempt budget and aborts timers', async () => {
    const budget = createAttemptBudget(2, 'single-send');
    assert.equal(budget.take(), true);
    assert.equal(budget.take(), false);
    assert.equal(budget.used, 1);
    assert.equal(budget.remaining, 0);
    assert.throws(() => createAttemptBudget(0), TypeError);
    assert.throws(() => createAttemptBudget(2, 'unsafe'), TypeError);
    await sleep(1);
    const controller = new AbortController();
    const waiting = sleep(10000, controller.signal);
    controller.abort(new Error('stop'));
    await assert.rejects(waiting, /stop/);
    await assert.rejects(sleep(1, controller.signal), /stop/);
  });
});
