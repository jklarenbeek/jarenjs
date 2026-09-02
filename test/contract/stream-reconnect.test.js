//@ts-check
/**
 * @file The HTTP client's reconnect (docs/CONTRACT-FORMAT.md §19) on an
 * injected transport: a scripted `fetch` answering one `Response` per
 * attempt, an injected `sleep` recording every backoff, the runtime's
 * `random` pinned — so the delays, the `Last-Event-ID` headers and the
 * callbacks are exact. Absent `reconnect` opens one connection; `max: 2`
 * opens at most three; only a network loss — a rejected request, a
 * missed heartbeat, the server's JC2096, a body ending before `end` —
 * reconnects; a declared failure, a contract outcome, the server's end,
 * `stop()` and the signal are terminal; exhaustion is one JC2097 with
 * exact details; a stale attempt's settlements reach no callback; the
 * subscription's `lastSeq` follows every transition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractHostError } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';

const CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    feed: {
      kind: 'subscribe',
      input: { type: 'object', required: ['room'], properties: { room: { type: 'string' } } },
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      errors: { gone: { status: 410 } },
      http: { method: 'GET', path: '/rooms/{room}/feed' },
      policy: { stream: { resume: 'replay', heartbeatMs: 1000 } },
    },
  },
});

/** @param {number} seq @param {{ resumed?: boolean, reset?: boolean }} [flags] */
const SNAPSHOT = (seq, flags = {}) => `event: snapshot\nid: ${seq}\ndata: ${JSON.stringify({ value: { rows: [] }, resumed: flags.resumed === true, reset: flags.reset === true })}\n\n`;
/** @param {number} seq */
const PATCH = (seq) => `event: patch\nid: ${seq}\ndata: {"patch":[],"seq":${seq}}\n\n`;
/** @param {string} reason */
const END = (reason) => `event: end\ndata: {"reason":"${reason}"}\n\n`;
/** @param {any} record */
const ERROR = (record) => `event: error\ndata: ${JSON.stringify(record)}\n\n`;

/**
 * @typedef {{ reject?: unknown, status?: number, text?: string, chunks?: string[], hold?: boolean, gate?: Promise<void>,
 *   cancelled?: number, push?: (chunk: string) => boolean }} Step
 */

/**
 * A scripted transport: one step per attempt. `reject` throws the
 * fetch; `status` answers a JSON non-stream; otherwise an event-stream
 * `Response` whose body carries `chunks` then closes — `hold: true`
 * keeps it open (the silence the watchdog measures) until the request's
 * signal aborts it, and `push` enqueues later text. `gate` delays the
 * answer until the test releases it.
 * @param {Step[]} steps
 */
function scripted(steps) {
  /** @type {{ url: string, headers: Record<string, string>, signal: AbortSignal }[]} */
  const calls = [];
  const encoder = new TextEncoder();
  /** @type {(url: any, init: any) => Promise<Response>} */
  const fetch = async (url, init) => {
    const step = steps[calls.length] ?? { reject: new TypeError('unscripted attempt') };
    calls.push({ url: String(url), headers: { ...init.headers }, signal: init.signal });
    if (step.gate !== undefined) await step.gate;
    if (step.reject !== undefined) throw step.reject;
    if (step.status !== undefined) {
      return new Response(step.text ?? '', { status: step.status, headers: { 'content-type': 'application/json' } });
    }
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
        for (const chunk of step.chunks ?? []) c.enqueue(encoder.encode(chunk));
        if (!step.hold) c.close();
      },
      cancel() {
        step.cancelled = (step.cancelled ?? 0) + 1;
      },
    });
    step.push = (chunk) => {
      try {
        controller.enqueue(encoder.encode(chunk));
        return true;
      }
      catch {
        return false; // the reader is gone: a stale attempt's push lands nowhere
      }
    };
    init.signal.addEventListener('abort', () => {
      try {
        controller.error(init.signal.reason);
      }
      catch {
        // already closed or cancelled
      }
    }, { once: true });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-jaren-trace': `t${calls.length}` } });
  };
  return { fetch, calls };
}

/** A recording sleeper: every delay logged; `pending` never resolves on its own. */
function sleeper({ pending = false } = {}) {
  /** @type {number[]} */
  const delays = [];
  /** @type {(ms: number, signal?: AbortSignal) => Promise<void>} */
  const sleep = (ms, signal) => {
    delays.push(ms);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (!pending) setTimeout(resolve, 0);
    });
  };
  return { sleep, delays };
}

/** Recording callbacks: one line per event. */
function recording() {
  /** @type {string[]} */
  const events = [];
  /** @type {any[]} */
  const outcomes = [];
  return {
    events,
    outcomes,
    callbacks: {
      onSnapshot: (/** @type {any} */ value, /** @type {any} */ info) => {
        events.push(`snapshot:${info.seq}${info.resumed ? ':resumed' : ''}${info.reset ? ':reset' : ''}`);
      },
      onPatch: (/** @type {any} */ e) => {
        events.push(`patch:${e.seq}`);
      },
      onError: (/** @type {any} */ o) => {
        outcomes.push(o);
        events.push(`error:${o.kind}:${o.error.code}`);
      },
      onEnd: (/** @type {any} */ i) => {
        events.push(`end:${i.reason}`);
      },
    },
  };
}

/**
 * @param {Step[]} steps
 * @param {{ pending?: boolean }} [shape]
 */
function harness(steps, shape = {}) {
  const transport = scripted(steps);
  const clock = sleeper(shape);
  const client = openHttpClient(CONTRACT, {
    baseUrl: 'http://contract.local',
    fetch: transport.fetch,
    sleep: clock.sleep,
    runtime: { random: () => 0.5 }, // jitter: floor(0.5 × 250) = 125 ms
  });
  return { client, calls: transport.calls, delays: clock.delays, ...recording() };
}

/** Poll (bounded) until a condition holds. @param {() => boolean} until @param {number} [ms] */
async function wait(until, ms = 2000) {
  for (let i = 0; i < ms / 5 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('client.subscribe reconnect — the budget', () => {
  it('absent: one connection; a rejected request is the JC2051 network outcome, no backoff', async () => {
    const h = harness([{ reject: new TypeError('fetch failed') }]);
    h.client.subscribe('feed', { room: 'r' }, h.callbacks);
    await wait(() => h.events.length === 1);
    await tick();
    assert.deepStrictEqual(h.events, ['error:network:JC2051']);
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.delays, []);
  });

  it('max: 0 is the same as absent', async () => {
    const h = harness([{ reject: new TypeError('fetch failed') }]);
    h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 0 } });
    await wait(() => h.events.length === 1);
    await tick();
    assert.deepStrictEqual(h.events, ['error:network:JC2051']);
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.delays, []);
  });

  it('max: 2 — two losses then success: the shared backoff, the resume header, every callback once, no error in between', async () => {
    const h = harness([
      { reject: new TypeError('fetch failed') },
      { chunks: [SNAPSHOT(5), PATCH(6)] }, // then the body ends before an end event
      { chunks: [PATCH(7), PATCH(8), END('done')] },
    ]);
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 } });
    await wait(() => h.events.includes('end:done'));
    assert.deepStrictEqual(h.events, ['snapshot:5', 'patch:6', 'patch:7', 'patch:8', 'end:done']);
    assert.strictEqual(h.calls.length, 3);
    assert.deepStrictEqual(h.delays, [1125, 2125], '1,000 × 2^n + 125 ms of pinned jitter');
    assert.deepStrictEqual(h.calls.map((c) => c.headers['last-event-id']), [undefined, undefined, '6']);
    assert.ok(h.calls.every((c) => c.headers.accept === 'text/event-stream'));
    assert.strictEqual(sub.lastSeq, 8);
  });

  it('exhaustion: max: 2 opens three connections, then ONE JC2097 with exact details', async () => {
    const h = harness([
      { reject: new TypeError('fetch failed') },
      { reject: new TypeError('fetch failed') },
      { reject: new TypeError('fetch failed') },
    ]);
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 } });
    await wait(() => h.events.length === 1);
    await tick();
    assert.deepStrictEqual(h.events, ['error:network:JC2097']);
    assert.strictEqual(h.calls.length, 3);
    assert.deepStrictEqual(h.delays, [1125, 2125]);
    const [outcome] = h.outcomes;
    assert.strictEqual(outcome.kind, 'network');
    assert.strictEqual(outcome.error.retryable, false);
    assert.deepStrictEqual(outcome.error.details, { attempts: 2, lastCode: 'JC2051' });
    assert.match(outcome.error.message, /after 2 attempts \(last: JC2051\)/);
    assert.strictEqual(sub.lastSeq, null);
  });

  it('exhaustion after progress: a body that keeps ending before `end` is a loss each time; JC2097 names it and lastSeq holds the last delivered', async () => {
    const h = harness([
      { chunks: [SNAPSHOT(1), PATCH(2)] },
      { chunks: [PATCH(3)] },
    ]);
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 1 } });
    await wait(() => h.events.length === 4);
    await tick();
    assert.deepStrictEqual(h.events, ['snapshot:1', 'patch:2', 'patch:3', 'error:network:JC2097']);
    assert.deepStrictEqual(h.outcomes[0].error.details, { attempts: 1, lastCode: 'JC2051' });
    assert.deepStrictEqual(h.calls.map((c) => c.headers['last-event-id']), [undefined, '2']);
    assert.strictEqual(sub.lastSeq, 3);
  });
});

describe('client.subscribe reconnect — what reconnects', () => {
  it('a body ending before `end` reconnects from the last delivered seq — the seq a reset snapshot advanced included', async () => {
    const h = harness([
      { chunks: [SNAPSHOT(5), PATCH(6)] },
      { chunks: [SNAPSHOT(9, { resumed: true, reset: true }), PATCH(10)] },
      { chunks: [PATCH(11), END('done')] },
    ]);
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 } });
    await wait(() => h.events.includes('end:done'));
    assert.deepStrictEqual(h.events, ['snapshot:5', 'patch:6', 'snapshot:9:resumed:reset', 'patch:10', 'patch:11', 'end:done']);
    assert.deepStrictEqual(h.calls.map((c) => c.headers['last-event-id']), [undefined, '6', '10']);
    assert.strictEqual(sub.lastSeq, 11);
  });

  it("the server's JC2096 reconnects; the resume header carries the seq held when the consumer fell behind", async () => {
    const h = harness([
      { chunks: [SNAPSHOT(1), ERROR({ code: 'JC2096', message: 'slow', requestId: 'r1', retryable: true })] },
      { chunks: [PATCH(2), END('done')] },
    ]);
    h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 1 } });
    await wait(() => h.events.includes('end:done'));
    assert.deepStrictEqual(h.events, ['snapshot:1', 'patch:2', 'end:done']);
    assert.deepStrictEqual(h.calls.map((c) => c.headers['last-event-id']), [undefined, '1']);
    assert.deepStrictEqual(h.delays, [1125]);
  });

  it('a missed heartbeat (JC2094) reconnects; the silent attempt is released before the next opens', async () => {
    const h = harness([
      { chunks: [SNAPSHOT(1)], hold: true }, // then: silence
      { chunks: [PATCH(2), END('done')] },
    ]);
    h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 1 } });
    await wait(() => h.events.includes('end:done'), 4000);
    assert.deepStrictEqual(h.events, ['snapshot:1', 'patch:2', 'end:done']);
    assert.strictEqual(h.calls[0].signal.aborted, true, 'the silent request is aborted');
    assert.strictEqual(h.calls[1].headers['last-event-id'], '1');
  });

  it('a stale attempt reaches nothing: its late bytes land nowhere, its reader is its own, a newer reader is untouched', async () => {
    const stale = /** @type {Step} */ ({ chunks: [SNAPSHOT(1)], hold: true });
    const fresh = /** @type {Step} */ ({ chunks: [SNAPSHOT(3, { resumed: true })], hold: true });
    const h = harness([stale, fresh]);
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 1 } });
    await wait(() => h.events.length === 2, 4000);
    assert.deepStrictEqual(h.events, ['snapshot:1', 'snapshot:3:resumed']);
    assert.strictEqual(/** @type {any} */ (stale.push)(PATCH(2)), false, 'the stale body is cancelled');
    await tick();
    assert.deepStrictEqual(h.events, ['snapshot:1', 'snapshot:3:resumed']);
    assert.strictEqual(sub.lastSeq, 3);
    assert.strictEqual(fresh.cancelled, undefined, 'the newer reader is not the stale attempt\'s to close');
    sub.stop();
    await tick();
    assert.strictEqual(fresh.cancelled, 1);
    assert.strictEqual(h.calls.length, 2);
  });
});

describe('client.subscribe reconnect — what is terminal', () => {
  /** @param {Step[]} steps @param {string[]} expected */
  async function terminal(steps, expected) {
    const h = harness(steps);
    h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 } });
    await wait(() => h.events.length === expected.length);
    await tick();
    assert.deepStrictEqual(h.events, expected);
    assert.strictEqual(h.calls.length, 1, 'one connection');
    assert.deepStrictEqual(h.delays, [], 'no backoff');
    return h;
  }

  it('a declared failure — retryable or not — does not reconnect', async () => {
    const h = await terminal([{ chunks: [SNAPSHOT(1), ERROR({ code: 'gone', message: 'm', requestId: 'r', retryable: true })] }],
      ['snapshot:1', 'error:failure:gone']);
    assert.strictEqual(h.outcomes[0].error.retryable, true);
  });

  it('a contract outcome (a seq regression) does not reconnect', async () => {
    await terminal([{ chunks: [SNAPSHOT(1), PATCH(5), PATCH(5)] }], ['snapshot:1', 'patch:5', 'error:contract:JC2092']);
  });

  it('a non-stream answer (JC2090) and a declared status answer do not reconnect', async () => {
    await terminal([{ status: 200, text: '{"rows":[]}' }], ['error:contract:JC2090']);
    await terminal([{ status: 410, text: '{"code":"gone","message":"m","requestId":"r"}' }], ['error:failure:gone']);
  });

  it("the server's end is final", async () => {
    await terminal([{ chunks: [SNAPSHOT(1), END('done')] }], ['snapshot:1', 'end:done']);
  });

  it('stop() during the backoff opens nothing more and calls nothing', async () => {
    const h = harness([{ reject: new TypeError('fetch failed') }, { chunks: [SNAPSHOT(1)] }], { pending: true });
    const sub = h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 } });
    await wait(() => h.delays.length === 1);
    sub.stop();
    await tick();
    assert.deepStrictEqual(h.events, []);
    assert.strictEqual(h.calls.length, 1);
  });

  it('the signal during an attempt is silent; a request that answers after stop() is discarded unread', async () => {
    const held = /** @type {Step} */ ({ chunks: [SNAPSHOT(1)], hold: true });
    const h = harness([held]);
    const controller = new AbortController();
    h.client.subscribe('feed', { room: 'r' }, { ...h.callbacks, reconnect: { max: 2 }, signal: controller.signal });
    await wait(() => h.events.length === 1);
    controller.abort();
    await tick();
    assert.deepStrictEqual(h.events, ['snapshot:1']);
    assert.strictEqual(h.calls[0].signal.aborted, true, 'the request is aborted — what a transport tears down on');
    assert.deepStrictEqual(h.delays, []);

    let release = () => {};
    const late = /** @type {Step} */ ({ chunks: [SNAPSHOT(1)], gate: new Promise((r) => { release = r; }) });
    const g = harness([late]);
    const sub = g.client.subscribe('feed', { room: 'r' }, { ...g.callbacks, reconnect: { max: 2 } });
    await wait(() => g.calls.length === 1);
    sub.stop();
    release();
    await tick();
    assert.deepStrictEqual(g.events, []);
    assert.strictEqual(late.cancelled, 1, 'the late body is released, never read');
  });
});

describe('client.subscribe — the subscription\'s lastSeq and the option', () => {
  it('lastSeq: null before the first event, the passed value until an event moves it, then every snapshot and patch', async () => {
    const held = /** @type {Step} */ ({ chunks: [], hold: true });
    const h = harness([held]);
    const fresh = h.client.subscribe('feed', { room: 'r' }, h.callbacks);
    assert.strictEqual(fresh.lastSeq, null);
    fresh.stop();

    const other = harness([held]);
    const sub = other.client.subscribe('feed', { room: 'r' }, { ...other.callbacks, lastSeq: 3 });
    assert.strictEqual(sub.lastSeq, 3);
    await wait(() => other.calls.length === 1);
    assert.strictEqual(other.calls[0].headers['last-event-id'], '3');
    /** @type {(chunk: string) => boolean} */
    const push = /** @type {any} */ (held.push);
    push(SNAPSHOT(5, { resumed: true }));
    await wait(() => sub.lastSeq === 5);
    push(PATCH(6));
    await wait(() => sub.lastSeq === 6);
    push(SNAPSHOT(6, { resumed: true, reset: true })); // a reset may land AT the cursor
    await wait(() => other.events.length === 3);
    assert.strictEqual(sub.lastSeq, 6);
    push(PATCH(7));
    await wait(() => sub.lastSeq === 7);
    assert.deepStrictEqual(other.events, ['snapshot:5:resumed', 'patch:6', 'snapshot:6:resumed:reset', 'patch:7']);
    sub.stop();
    assert.strictEqual(sub.lastSeq, 7, 'the cursor outlives the stream');
  });

  it('reconnect must be { max } with a non-negative integer: JC1008 before anything is sent', () => {
    const h = harness([]);
    for (const reconnect of [{ max: -1 }, { max: 1.5 }, {}, 'x', { max: '2' }]) {
      assert.throws(() => h.client.subscribe('feed', { room: 'r' }, { reconnect: /** @type {any} */ (reconnect) }),
        (/** @type {any} */ err) => err instanceof ContractHostError && err.code === 'JC1008');
    }
    assert.strictEqual(h.calls.length, 0);
  });
});
