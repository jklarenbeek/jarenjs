//@ts-check
/**
 * @file Worker lifecycle under hostile handler outcomes.
 *
 * A handler is host code, and a long-running process needs two promises
 * kept about it. First, nothing a handler returns or throws may break the
 * claim-execute loop: a loop that rejects stops draining the queue and
 * says nothing, so a result JSON cannot express and a rejection whose
 * `message` throws when read must both become ordinary failed attempts.
 * Second, shutdown is bounded: handlers get an `AbortSignal`, and a
 * handler that ignores it cannot hold `stop()` — or `store.close()`, or
 * the database file — open for the life of the process. And bounded
 * means CANCELLED, not abandoned: a loop `stop()` could not drain must
 * never claim, write, or arm a poll timer again once its handler
 * finally settles — its job recovers by lease expiry instead.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, describeValue, serializeResult } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    x: {
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

const open = () => openStore(MODEL, { driver: nodeDriver(), jobs: true });

/** Poll until `read()` satisfies `done`, or fail after `ms`. */
const until = async (read, done, ms = 5_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `timed out at ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('total normalization of handler outcomes', () => {
  it('describeValue survives every value an error can be', () => {
    assert.strictEqual(describeValue(new Error('plain')), 'plain');
    assert.strictEqual(describeValue('a string'), 'a string');
    assert.strictEqual(describeValue(null), 'null');
    assert.strictEqual(describeValue(undefined), 'undefined');
    assert.strictEqual(describeValue(Symbol('s')), 'Symbol(s)');
    // a getter that throws, the shape that used to reject the loop
    const hostile = { get message() { throw new Error('nope'); } };
    assert.strictEqual(describeValue(hostile), '[unreportable value]');
    // no prototype, so no toString to fall back on
    assert.strictEqual(describeValue(Object.create(null)), '[unreportable value]');
  });

  it('serializeResult refuses what JSON cannot express, without throwing', () => {
    assert.deepStrictEqual(serializeResult({ a: 1 }), { text: '{"a":1}' });
    assert.deepStrictEqual(serializeResult(null), { text: null });
    assert.deepStrictEqual(serializeResult(undefined), { text: null });
    const cyclic = /** @type {any} */ ({});
    cyclic.self = cyclic;
    assert.ok('reason' in serializeResult(cyclic));
    assert.ok('reason' in serializeResult(10n));
    assert.ok('reason' in serializeResult(() => {}), 'a function stringifies to undefined');
    assert.ok('reason' in serializeResult({ toJSON() { throw new Error('boom'); } }));
  });

  it('an unserializable RESULT fails the attempt, not the worker', async () => {
    const store = await open();
    const worker = store.jobs.createWorker({
      handlers: { bad: () => ({ big: 10n }), good: () => ({ ok: true }) },
      pollInterval: 5, maxAttempts: 1,
    });
    worker.start();
    await store.jobs.enqueue('bad', null, { id: 'b', maxAttempts: 1 });
    await until(() => store.jobs.get('b'),
      (job) => job.state === 'dead' || job.state === 'failed');

    // the loop is still claiming: a later job still runs
    await store.jobs.enqueue('good', null, { id: 'g' });
    const good = await until(() => store.jobs.get('g'), (job) => job.state === 'done');
    assert.deepStrictEqual(good.result, { ok: true });
    assert.deepStrictEqual(await worker.stop(), { drained: true, inFlight: 0 });
    await store.close();
  });

  it('a hostile REJECTION fails the attempt, not the worker', async () => {
    const store = await open();
    const worker = store.jobs.createWorker({
      handlers: {
        hostile: () => Promise.reject({ get message() { throw new Error('nope'); } }),
        good: () => ({ ok: true }),
      },
      pollInterval: 5,
    });
    worker.start();
    await store.jobs.enqueue('hostile', null, { id: 'h', maxAttempts: 1 });
    const dead = await until(() => store.jobs.get('h'),
      (job) => job.state === 'dead' || job.state === 'failed');
    assert.strictEqual(typeof dead.lastError, 'string');

    await store.jobs.enqueue('good', null, { id: 'g2' });
    await until(() => store.jobs.get('g2'), (job) => job.state === 'done');
    await worker.stop();
    await store.close();
  });
});

describe('bounded shutdown', () => {
  it('handlers receive an AbortSignal that fires on stop()', async () => {
    const store = await open();
    /** @type {any} */
    let observed = null;
    let aborted = false;
    const started = new Promise((resolve) => {
      const worker = store.jobs.createWorker({
        handlers: {
          slow: (_payload, ctx) => new Promise((settle) => {
            observed = ctx.signal;
            ctx.signal.addEventListener('abort', () => { aborted = true; settle(null); });
            resolve(undefined);
          }),
        },
        pollInterval: 5,
      });
      worker.start();
      store.jobs.enqueue('slow', null, { id: 's' }).then(() => {}, () => {});
      /** @type {any} */ (globalThis).__worker = worker;
    });
    await started;
    assert.ok(observed instanceof AbortSignal, 'the handler gets a real signal');
    assert.strictEqual(observed.aborted, false);
    const outcome = await /** @type {any} */ (globalThis).__worker.stop();
    assert.strictEqual(aborted, true, 'stop() aborts in-flight handlers');
    assert.deepStrictEqual(outcome, { drained: true, inFlight: 0 });
    await store.close();
    delete /** @type {any} */ (globalThis).__worker;
  });

  /** A store whose only worker is wedged in a handler that never settles
   * and never listens for its signal. Resolves once it is really in the
   * handler, so the wedge is a fact and not a race. */
  const wedgedStore = async () => {
    const store = await open();
    /** @type {any} */
    let worker;
    const inHandler = new Promise((resolve) => {
      worker = store.jobs.createWorker({
        handlers: { wedge: () => new Promise(() => resolve(undefined)) },
        pollInterval: 5,
      });
      worker.start();
    });
    await store.jobs.enqueue('wedge', null, { id: 'w' });
    await inHandler;
    return { store, worker };
  };

  it('stop() returns within its grace period and names what it left', async () => {
    const { store, worker } = await wedgedStore();
    assert.deepStrictEqual(await worker.stop({ graceMs: 20 }),
      { drained: false, inFlight: 1 });
    // the handle is still released, which is the point of the bound
    await store.close({ graceMs: 20 });
  });

  it('close() releases the handle and REPORTS the handler it left', async () => {
    const { store } = await wedgedStore();
    await assert.rejects(() => store.close({ graceMs: 20 }),
      (error) => /** @type {any} */ (error).code === 'JD2062');
    // JD2062 is a REPORT, not a refusal: the connection really did close,
    // which is why a second close finds nothing left to close
    await assert.rejects(() => store.close({ graceMs: 20 }),
      /database is not open/);
  });

  it('stop() CANCELS the loop it could not drain', async () => {
    const store = await open();
    /** @type {(value: any) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    /** @type {() => void} */
    let entered = () => {};
    const inHandler = new Promise((resolve) => { entered = () => resolve(undefined); });
    const worker = store.jobs.createWorker({
      handlers: { hold: () => { entered(); return gate; } },
      pollInterval: 5,
    });
    worker.start();
    await store.jobs.enqueue('hold', null, { id: 'c' });
    await inHandler;
    assert.deepStrictEqual(await worker.stop({ graceMs: 20 }),
      { drained: false, inFlight: 1 });

    // the handler settles AFTER the caller was told stop() gave up: the
    // cancelled loop must not write the completion — the lease expiry
    // (§5) is the designated recovery, not a race with store.close()
    release({ late: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(worker.stats().inFlight, 0, 'the handler did settle');
    assert.strictEqual(worker.stats().completions, 0, 'no completion write');
    assert.strictEqual((await store.jobs.get('c')).state, 'leased',
      'the job is left to lease-expiry recovery');

    // ...and it must not claim again either: a claimable job stays pending
    await store.jobs.enqueue('hold', null, { id: 'l' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(worker.stats().claims, 1,
      'the cancelled loop claims nothing more');
    assert.strictEqual((await store.jobs.get('l')).state, 'pending');

    // a restart opens a NEW session with fresh loops; the cancelled
    // loop stays dead instead of reviving as an extra claimer
    worker.start();
    await until(() => store.jobs.get('l'), (job) => job.state === 'done');
    assert.deepStrictEqual(await worker.stop(), { drained: true, inFlight: 0 });
    await store.close();
  });
});
