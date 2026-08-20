//@ts-check
/**
 * @file The stream binding over the port carrier (docs/CONTRACT-FORMAT.md
 * §18.2): subscribe/unsubscribe/push frames over a real `MessageChannel`
 * pair and the in-memory broadcast fake — snapshot then patches with
 * strictly increasing seq, resumption under `replay` and `snapshot`,
 * pre-stream failures as error push frames (`JC2071` for an unknown or
 * non-subscribe op, `JC2006` for invalid input, `JC2070` for a handler
 * fault, `JC2091` for an invalid snapshot), the server's `close()`
 * pushing `end` (`server-shutdown`), unsubscribe releasing the
 * subscription exactly once, and TWO clients on one channel holding
 * independent subscriptions — one's unsubscribe cannot touch the
 * other's. Every server-emitted frame validates against the grammar
 * artifact.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { compileContract, ContractHostError } from '@jarenjs/contract';
import { servePort, openPortClient } from '@jarenjs/contract/port';
import { load } from './helpers.js';

const CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    'data.live': {
      kind: 'subscribe',
      input: { type: 'object', required: ['collection'], properties: { collection: { type: 'string' } } },
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      policy: { stream: { resume: 'replay' } },
    },
    'data.rows': { kind: 'read', output: { type: 'array' } },
  },
});

const validateFrame = new JarenValidator().addFormats(jsonFormats)
  .compile(load('../../packages/contract/schemas/jaren-contract-port.schema.json'));

/** @type {{ close: () => void }[]} */
const open = [];
after(() => { for (const closable of open) closable.close(); });

/** @template {{ close: () => void }} T @param {T} closable @returns {T} */
function track(closable) {
  open.push(closable);
  return closable;
}

/** A MessageChannel pair with every server-emitted frame grammar-checked. */
function pair() {
  const { port1, port2 } = new MessageChannel();
  /** @type {any[]} */
  const emitted = [];
  const raw = port1.postMessage.bind(port1);
  port1.postMessage = (/** @type {any} */ message) => {
    assert.strictEqual(validateFrame(message), true, `a server frame must match the grammar: ${JSON.stringify(message)}`);
    emitted.push(message);
    raw(message);
  };
  track({ close: () => { port1.close(); port2.close(); } });
  return { server: port1, client: port2, emitted };
}

/** The broadcast fake: delivery to every OTHER peer, never the sender. */
function fakeBroadcast() {
  /** @type {Set<any>} */
  const peers = new Set();
  const join = () => {
    /** @type {Set<(event: any) => void>} */
    const listeners = new Set();
    const peer = {
      /** @param {any} message */
      postMessage(message) {
        const data = structuredClone(message);
        for (const other of peers) {
          if (other !== peer) other.deliver(data);
        }
      },
      /** @param {string} type @param {(event: any) => void} fn */
      addEventListener(type, fn) {
        if (type === 'message') listeners.add(fn);
      },
      /** @param {string} type @param {(event: any) => void} fn */
      removeEventListener(type, fn) {
        void type;
        listeners.delete(fn);
      },
      /** @param {any} data */
      deliver(data) {
        queueMicrotask(() => {
          for (const fn of listeners) fn({ data });
        });
      },
    };
    peers.add(peer);
    return peer;
  };
  return { join };
}

/**
 * An in-memory LIVE-shaped source with stop/close counters.
 * @param {any} initial
 * @param {{ replay?: (seq: number) => any }} [extras]
 */
function makeSource(initial, extras = {}) {
  let doc = initial;
  /** @type {Set<(emission: any) => void>} */
  const cbs = new Set();
  const counts = { stops: 0, closes: 0 };
  const sub = /** @type {any} */ ({
    get result() {
      return doc;
    },
    subscribe(/** @type {(emission: any) => void} */ cb) {
      cbs.add(cb);
      return () => {
        counts.stops += 1;
        cbs.delete(cb);
      };
    },
    close() {
      counts.closes += 1;
    },
    ...extras,
  });
  return {
    sub,
    counts,
    active: () => cbs.size,
    emit: (/** @type {any} */ emission, /** @type {any} */ next) => {
      if (next !== undefined) doc = next;
      for (const cb of [...cbs]) cb(emission);
    },
  };
}

/** Poll (bounded) until a condition holds. @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

/**
 * A recording subscription over a client.
 * @param {any} client
 * @param {any} [input]
 * @param {any} [options]
 */
function record(client, input = { collection: 'notes' }, options = {}) {
  /** @type {{ snapshots: any[], patches: any[], errors: any[], ends: any[] }} */
  const seen = { snapshots: [], patches: [], errors: [], ends: [] };
  const sub = client.subscribe('data.live', input, {
    onSnapshot: (/** @type {any} */ value, /** @type {any} */ info) => seen.snapshots.push({ value, ...info }),
    onPatch: (/** @type {any} */ emission) => seen.patches.push(emission),
    onError: (/** @type {any} */ outcome) => seen.errors.push(outcome),
    onEnd: (/** @type {any} */ info) => seen.ends.push(info),
    ...options,
  });
  return { seen, sub };
}

describe('stream over port — a MessageChannel pair', () => {
  it('snapshot then patches; unsubscribe releases the subscription exactly once', async () => {
    const { server, client: clientPort } = pair();
    const source = makeSource({ rows: [] });
    track(servePort(CONTRACT, { 'data.live': () => source.sub, 'data.rows': () => [] }, { channel: server }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    assert.strictEqual(client.capabilities.stream, true);
    const { seen, sub } = record(client);
    await wait(() => seen.snapshots.length === 1);
    assert.deepStrictEqual(seen.snapshots[0], { value: { rows: [] }, seq: 0, resumed: false });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 1 }], seq: 3 }, { rows: [1] });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 2 }], seq: 5 }, { rows: [1, 2] });
    await wait(() => seen.patches.length === 2);
    assert.deepStrictEqual(seen.patches.map((p) => p.seq), [3, 5]);
    sub.stop();
    await wait(() => source.counts.closes === 1);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    assert.strictEqual(source.active(), 0);
    assert.deepStrictEqual(seen.errors, []);
  });

  it('resume replay yields only the later patches; a refused resume yields a fresh snapshot', async () => {
    const { server, client: clientPort } = pair();
    const replaying = makeSource({ rows: [1, 2] }, {
      replay: (/** @type {number} */ seq) => [{ patch: [{ op: 'add', path: '/rows/-', value: 2 }], seq: seq + 1 }],
    });
    track(servePort(CONTRACT, { 'data.live': () => replaying.sub, 'data.rows': () => [] }, { channel: server }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    const resumed = record(client, { collection: 'notes' }, { lastSeq: 7 });
    await wait(() => resumed.seen.patches.length === 1);
    assert.deepStrictEqual(resumed.seen.snapshots, []);
    assert.strictEqual(resumed.seen.patches[0].seq, 8);
    resumed.sub.stop();

    const fresh = makeSource({ rows: ['fresh'] }, { replay: () => null });
    const { server: s2, client: c2 } = pair();
    track(servePort(CONTRACT, { 'data.live': () => fresh.sub, 'data.rows': () => [] }, { channel: s2 }));
    const client2 = track(openPortClient(CONTRACT, { channel: c2 }));
    const refused = record(client2, { collection: 'notes' }, { lastSeq: 7 });
    await wait(() => refused.seen.snapshots.length === 1);
    assert.deepStrictEqual(refused.seen.snapshots[0], { value: { rows: ['fresh'] }, seq: 0, resumed: false });
    refused.sub.stop();
    await wait(() => fresh.counts.closes === 1);
  });

  it('pre-stream failures arrive as error push frames: invalid input, a handler fault, an invalid snapshot', async () => {
    const { server, client: clientPort } = pair();
    const bad = makeSource({ nope: true });
    /** @type {unknown[]} */
    const observed = [];
    track(servePort(CONTRACT, {
      'data.live': (/** @type {any} */ input) => (input.collection === 'boom' ? Promise.reject(new Error('kaput')) : bad.sub),
      'data.rows': () => [],
    }, { channel: server, onError: (err) => observed.push(err) }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));

    const invalid = record(client, { collection: 5 });
    await wait(() => invalid.seen.errors.length === 1);
    assert.strictEqual(invalid.seen.errors[0].error.code, 'JC2050', 'refused pre-send, nothing posted');

    const fault = record(client, { collection: 'boom' });
    await wait(() => fault.seen.errors.length === 1);
    assert.strictEqual(fault.seen.errors[0].kind, 'contract');
    assert.strictEqual(fault.seen.errors[0].error.code, 'JC2093');
    assert.strictEqual(fault.seen.errors[0].error.details.code, 'JC2070');

    const snap = record(client);
    await wait(() => snap.seen.errors.length === 1);
    assert.strictEqual(snap.seen.errors[0].error.code, 'JC2093');
    assert.strictEqual(snap.seen.errors[0].error.details.code, 'JC2091');
    assert.deepStrictEqual(bad.counts, { stops: 1, closes: 1 });
    assert.ok(observed.length >= 2, 'the causes reached onError');
  });

  it("a request frame naming a subscribe op is JC2071; invoke of one throws JC1005; subscribe of a read throws JC1010", async () => {
    const { server, client: clientPort } = pair();
    const source = makeSource({ rows: [] });
    track(servePort(CONTRACT, { 'data.live': () => source.sub, 'data.rows': () => [] }, { channel: server }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    await assert.rejects(async () => client.invoke('data.live', { collection: 'notes' }),
      (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1005');
    assert.throws(() => client.subscribe('data.rows', null, {}),
      (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1010');
    // a hand-built request frame naming the subscribe op is answered JC2071
    /** @type {any[]} */
    const frames = [];
    clientPort.addEventListener('message', (/** @type {any} */ event) => frames.push(event.data));
    clientPort.postMessage({ jaren: 'contract/0.1', id: 'other:1', op: 'data.live', input: { collection: 'notes' } });
    await wait(() => frames.some((f) => f.ok === false));
    const answer = frames.find((f) => f.ok === false);
    assert.strictEqual(answer.error.code, 'JC2071');
  });

  it("a caller's signal stops the subscription silently — the abort listener detaches and the server releases", async () => {
    const { server, client: clientPort } = pair();
    const source = makeSource({ rows: [] });
    track(servePort(CONTRACT, { 'data.live': () => source.sub, 'data.rows': () => [] }, { channel: server }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    const controller = new AbortController();
    const { seen } = record(client, { collection: 'notes' }, { signal: controller.signal });
    await wait(() => seen.snapshots.length === 1);
    controller.abort();
    await wait(() => source.counts.closes === 1);
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 1 }], seq: 2 }, { rows: [1] });
    await new Promise((r) => setTimeout(r, 25));
    assert.deepStrictEqual(seen.patches, [], 'nothing lands after the abort');
    assert.deepStrictEqual(seen.errors, []);
    assert.deepStrictEqual(seen.ends, [], 'a local abort is silent');
  });

  it('an unsubscribe that races the handler settlement still releases the subscription', async () => {
    const { server, client: clientPort } = pair();
    const source = makeSource({ rows: [] });
    /** @type {(value: any) => void} */
    let settle = () => {};
    track(servePort(CONTRACT, {
      'data.live': () => new Promise((resolve) => { settle = resolve; }),
      'data.rows': () => [],
    }, { channel: server }));
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    const { seen, sub } = record(client);
    // the subscribe frame is in flight; stop before the handler settles
    await new Promise((r) => setTimeout(r, 25));
    sub.stop();
    await new Promise((r) => setTimeout(r, 25));
    settle(source.sub);
    await wait(() => source.counts.closes === 1);
    assert.strictEqual(source.counts.stops, 0, 'never subscribed — released before any stream started');
    assert.deepStrictEqual(seen.snapshots, []);
    assert.deepStrictEqual(seen.errors, []);
  });

  it("the server's close() pushes end (server-shutdown) to every live subscription", async () => {
    const { server, client: clientPort } = pair();
    const source = makeSource({ rows: [] });
    const portServer = servePort(CONTRACT, { 'data.live': () => source.sub, 'data.rows': () => [] }, { channel: server });
    const client = track(openPortClient(CONTRACT, { channel: clientPort }));
    const { seen } = record(client);
    await wait(() => seen.snapshots.length === 1);
    portServer.close();
    await wait(() => seen.ends.length === 1);
    assert.deepStrictEqual(seen.ends, [{ reason: 'server-shutdown' }]);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });
});

describe('stream over port — two clients on one shared channel', () => {
  it('each holds its own subscription; an unsubscribe from one does not affect the other', async () => {
    const bus = fakeBroadcast();
    /** @type {ReturnType<typeof makeSource>[]} */
    const sources = [];
    track(servePort(CONTRACT, {
      'data.live': () => {
        const source = makeSource({ rows: [] });
        sources.push(source);
        return source.sub;
      },
      'data.rows': () => [],
    }, { channel: bus.join() }));
    const a = track(openPortClient(CONTRACT, { channel: bus.join() }));
    const b = track(openPortClient(CONTRACT, { channel: bus.join() }));
    const seenA = record(a);
    const seenB = record(b);
    await wait(() => seenA.seen.snapshots.length === 1 && seenB.seen.snapshots.length === 1);
    assert.strictEqual(sources.length, 2, 'two registrations, one per client');

    // A unsubscribes; B keeps receiving
    seenA.sub.stop();
    await wait(() => sources[0].counts.closes === 1);
    assert.deepStrictEqual(sources[1].counts, { stops: 0, closes: 0 }, "B's subscription is untouched");
    sources[1].emit({ patch: [{ op: 'add', path: '/rows/-', value: 'b' }], seq: 2 }, { rows: ['b'] });
    await wait(() => seenB.seen.patches.length === 1);
    assert.deepStrictEqual(seenA.seen.patches, [], 'A hears nothing after its stop');
    assert.deepStrictEqual(seenB.seen.patches[0].seq, 2);
  });
});
