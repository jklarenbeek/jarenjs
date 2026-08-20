//@ts-check
/**
 * @file The generated subscription documents in a headless app
 * (docs/CONTRACT-FORMAT.md §11.4), over the live contract of
 * docs/APP-INTEGRATION.md run VERBATIM: `start` stores the input and
 * flips the slot live (guarded — a second start while live is a no-op),
 * the app's own reconciliation runs the `contract-stream` handler, the
 * snapshot and each host-applied patch land through the id- and
 * seq-guarded actions, a stale-id dispatch and a seq regression are
 * provable no-ops in state, `stop` runs the subscription cleanup (the
 * client's stop, exactly once), an error outcome and a server end land
 * in the slot, and `validateState` accepts every generated transition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { compileContract } from '@jarenjs/contract';
import { contractAppBinding, createContractEffect, createContractSubscription } from '@jarenjs/contract/app';

const DOC = new URL('../../packages/contract/docs/APP-INTEGRATION.md', import.meta.url);

/** The doc's third json block: the live contract. */
function liveContractDoc() {
  const md = readFileSync(DOC, 'utf8');
  const found = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  return found[2];
}

const contract = compileContract(liveContractDoc());
const sync = (/** @type {() => void} */ flush) => flush();

/** Drain microtasks so subscription starts and dispatches settle. */
async function drain() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

/**
 * A fake stream client: `subscribe` records the call and hands the test
 * the callbacks to drive; `stop` counts.
 */
function fakeClient() {
  /** @type {{ op: string, input: any, callbacks: any, stops: number }[]} */
  const sessions = [];
  return {
    sessions,
    client: /** @type {any} */ ({
      contract,
      capabilities: { stream: true },
      invoke: () => Promise.reject(new Error('not under test')),
      subscribe: (/** @type {string} */ op, /** @type {any} */ input, /** @type {any} */ callbacks) => {
        const session = { op, input, callbacks, stops: 0 };
        sessions.push(session);
        return { stop: () => { session.stops += 1; } };
      },
    }),
  };
}

/** Mount the doc's composition headless. */
function mount() {
  const { slice, actions, subs, schema } = contractAppBinding(contract);
  const { sessions, client } = fakeClient();
  const validate = new JarenValidator().compile({ type: 'object', required: ['contract'], properties: { contract: schema } });
  /** @type {any[]} */
  const errors = [];
  const app = createApp({
    state: { contract: slice },
    view: [{ match: '$', body: ['main', {}] }],
    actions,
    subs,
  }, {
    schedule: sync,
    effects: { contract: createContractEffect(client, { createTaskEffect }) },
    subs: { 'contract-stream': createContractSubscription(client) },
    validateState: (/** @type {any} */ s) => validate(s),
    onError: (/** @type {any} */ err) => errors.push(err),
  });
  const slot = () => app.getState().contract['board.feed'];
  return { app, sessions, slot, errors };
}

describe('the generated subscription in a headless app (the doc example, verbatim)', () => {
  it('start → live with the input stored; the subscription starts with the resolved props; a second start is a no-op', async () => {
    const { app, sessions, slot } = mount();
    assert.deepStrictEqual(slot(), { id: 0, status: 'idle', kind: null, input: null, value: null, error: null, meta: null, seq: 0 });
    assert.strictEqual(sessions.length, 0, 'idle: no subscription runs');

    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    assert.deepStrictEqual(slot(), { id: 1, status: 'live', kind: null, input: { room: 'r1' }, value: null, error: null, meta: null, seq: 0 });
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].op, 'board.feed');
    assert.deepStrictEqual(sessions[0].input, { room: 'r1' });

    // the guard: a second start while live changes nothing, starts nothing
    app.dispatch('contract/board.feed/start', { room: 'r2' });
    await drain();
    assert.strictEqual(slot().id, 1);
    assert.deepStrictEqual(slot().input, { room: 'r1' });
    assert.strictEqual(sessions.length, 1);
    app.destroy();
  });

  it('snapshot → value + seq; each patch applies host-side and lands seq-guarded; stale ids and seq regressions are no-ops', async () => {
    const { app, sessions, slot } = mount();
    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    const feed = sessions[0].callbacks;

    feed.onSnapshot({ rows: [{ id: 'a' }] }, { seq: 0, resumed: false });
    await drain();
    assert.deepStrictEqual(slot().value, { rows: [{ id: 'a' }] });
    assert.strictEqual(slot().seq, 0);

    feed.onPatch({ patch: [{ op: 'add', path: '/rows/-', value: { id: 'b' } }], seq: 4 });
    await drain();
    assert.deepStrictEqual(slot().value, { rows: [{ id: 'a' }, { id: 'b' }] });
    assert.strictEqual(slot().seq, 4);

    // a seq regression is ignored by the action's own guard
    feed.onPatch({ patch: [{ op: 'remove', path: '/rows/0' }], seq: 3 });
    await drain();
    assert.deepStrictEqual(slot().value, { rows: [{ id: 'a' }, { id: 'b' }] });
    assert.strictEqual(slot().seq, 4);

    // a stale instance (an old id) cannot write: restart, then let the
    // OLD session dispatch — the id guard rejects it
    app.dispatch('contract/board.feed/stop');
    await drain();
    assert.strictEqual(sessions[0].stops, 1, 'stop ran the subscription cleanup exactly once');
    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(slot().id, 2);
    feed.onPatch({ patch: [{ op: 'remove', path: '/rows/0' }], seq: 9 });
    await drain();
    assert.deepStrictEqual(slot().value, { rows: [{ id: 'a' }, { id: 'b' }] }, "the stale session's patch is a no-op");
    assert.strictEqual(slot().seq, 4);
    app.destroy();
  });

  it('an error outcome lands in the slot; a server end lands as a network-kind channel-closed outcome; reset releases', async () => {
    const { app, sessions, slot, errors } = mount();
    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    sessions[0].callbacks.onError({
      ok: false,
      kind: 'contract',
      error: { code: 'JC2092', message: 'seq order', status: null, details: null, retryable: false },
      meta: { op: 'board.feed', attempt: null, trace: null, revision: null, etag: null, notModified: false },
    });
    await drain();
    assert.strictEqual(slot().status, 'error');
    assert.strictEqual(slot().kind, 'contract');
    assert.strictEqual(slot().error.code, 'JC2092');
    // status left 'live' → the app's reconciliation stopped the subscription
    assert.strictEqual(sessions[0].stops, 1);

    app.dispatch('contract/board.feed/reset');
    await drain();
    assert.strictEqual(slot().status, 'idle');
    assert.strictEqual(slot().kind, null);
    assert.strictEqual(slot().error, null);

    // a fresh instance; the server ends the stream
    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    sessions[1].callbacks.onEnd({ reason: 'server-shutdown' });
    await drain();
    assert.strictEqual(slot().status, 'error');
    assert.strictEqual(slot().kind, 'network');
    assert.strictEqual(slot().error.code, 'JC2074');
    assert.deepStrictEqual(errors, [], 'no transition was refused by validateState');
    app.destroy();
  });

  it('a patch that does not apply stops the stream and lands a contract outcome', async () => {
    const { app, sessions, slot } = mount();
    app.dispatch('contract/board.feed/start', { room: 'r1' });
    await drain();
    sessions[0].callbacks.onSnapshot({ rows: [] }, { seq: 0, resumed: false });
    await drain();
    sessions[0].callbacks.onPatch({ patch: [{ op: 'remove', path: '/rows/7' }], seq: 2 });
    await drain();
    assert.strictEqual(slot().status, 'error');
    assert.strictEqual(slot().kind, 'contract');
    assert.strictEqual(slot().error.code, 'JC2053');
    assert.strictEqual(sessions[0].stops, 1, 'the corrupt stream was stopped');
    app.destroy();
  });
});
