//@ts-check
/**
 * @file The stream binding over SSE, on a real wire: `toNodeHandler`
 * behind `node:http` on 127.0.0.1:0 driven by `client.subscribe` and
 * raw `fetch` — snapshot then patches with strictly increasing ids,
 * heartbeat comment lines, the one-shot JSON read without the accept
 * header, resumption under `replay` and `snapshot`, the dispatcher's
 * `close()` ending with `server-shutdown`, disconnect running the
 * subscription's `stop()`/`close()` exactly once, an invalid snapshot
 * ending the stream with `JC2091`, and the client-side classifications
 * a compliant server never produces (`JC2090`, `JC2092`, `JC2094`)
 * against a hand-rolled hostile server. The `toFetchHandler` path is
 * proven on the same dispatcher with a streamed `Response` body.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';

import { compileContract, ContractHostError, ContractFailure } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
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
    tiny: {
      kind: 'subscribe',
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      policy: { stream: { maxPatchBytes: 64 } },
    },
  },
});

/**
 * An in-memory LIVE-shaped source: `result` is the maintained document,
 * `emit` delivers one emission (applying `next` first when given), the
 * stop/close counters prove the exactly-once rule.
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

/** @type {ReturnType<typeof makeSource>} */
let source;
/** @type {ReturnType<typeof serveHttp>} */
let dispatcher;
/** @type {http.Server} */
let server;
/** @type {string} */
let origin;
/** @type {ReturnType<typeof openHttpClient>} */
let client;
/** @type {((input: any, ctx: any) => any) | null} */
let feedOverride = null;

before(async () => {
  source = makeSource({ rows: [] });
  dispatcher = serveHttp(CONTRACT, {
    feed: (input, ctx) => (feedOverride !== null ? feedOverride(input, ctx) : source.sub),
    tiny: () => source.sub,
  }, { trace: () => 'trace-1' });
  server = http.createServer(toNodeHandler(dispatcher));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${address.port}`;
  client = openHttpClient(CONTRACT, { baseUrl: origin });
});

after(async () => {
  client.close();
  dispatcher.close();
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

/**
 * One subscription with recording callbacks.
 * @param {any} [input]
 * @param {any} [options]
 */
function record(input = { room: 'r1' }, options = {}) {
  /** @type {{ snapshots: any[], patches: any[], errors: any[], ends: any[] }} */
  const seen = { snapshots: [], patches: [], errors: [], ends: [] };
  const sub = client.subscribe('feed', input, {
    onSnapshot: (value, info) => seen.snapshots.push({ value, ...info }),
    onPatch: (emission) => seen.patches.push(emission),
    onError: (outcome) => seen.errors.push(outcome),
    onEnd: (info) => seen.ends.push(info),
    ...options,
  });
  return { seen, sub };
}

describe('stream over SSE — the happy path on a real node:http wire', () => {
  it('snapshot then patches, strictly increasing seq, forwarded verbatim; stop() releases exactly once', async () => {
    source = makeSource({ rows: [] });
    const { seen, sub } = record();
    await wait(() => seen.snapshots.length === 1);
    assert.deepStrictEqual(seen.snapshots[0], { value: { rows: [] }, seq: 0, resumed: false });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: { id: 'n1' } }], seq: 4 }, { rows: [{ id: 'n1' }] });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: { id: 'n2' } }], seq: 7 }, { rows: [{ id: 'n1' }, { id: 'n2' }] });
    await wait(() => seen.patches.length === 2);
    assert.deepStrictEqual(seen.patches.map((p) => p.seq), [4, 7]);
    assert.deepStrictEqual(seen.patches[0].patch, [{ op: 'add', path: '/rows/-', value: { id: 'n1' } }]);
    assert.deepStrictEqual(seen.errors, []);
    sub.stop();
    await wait(() => source.counts.closes === 1);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'stop() then close(), exactly once');
    assert.strictEqual(source.active(), 0);
  });

  it('the raw SSE text carries the event names, the seq as the id, and heartbeat comment lines', async () => {
    source = makeSource({ rows: [1] });
    const controller = new AbortController();
    const response = await fetch(`${origin}/rooms/r1/feed`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    assert.strictEqual(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    assert.strictEqual(response.headers.get('x-jaren-trace'), 'trace-1');
    const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    source.emit({ patch: [{ op: 'replace', path: '/rows/0', value: 2 }], seq: 9 }, { rows: [2] });
    // the heartbeat interval is 1000ms; read until one arrived
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(text.includes(':\n') && text.includes('event: patch'))) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: snapshot\nid: 0\ndata: \{"value":\{"rows":\[1\]\},"resumed":false\}\n\n/);
    assert.match(text, /event: patch\nid: 9\ndata: \{"patch":\[\{"op":"replace","path":"\/rows\/0","value":2\}\],"seq":9\}\n\n/);
    assert.match(text, /\n:\n\n/, 'a heartbeat comment line');
    await wait(() => source.counts.closes === 1);
  });

  it('a client without accept: text/event-stream gets the snapshot as plain JSON, and invoke() serves the same one-shot read', async () => {
    source = makeSource({ rows: [{ id: 'a' }] });
    const plain = await fetch(`${origin}/rooms/r1/feed`);
    assert.strictEqual(plain.status, 200);
    assert.match(String(plain.headers.get('content-type')), /application\/json/);
    assert.deepStrictEqual(await plain.json(), { rows: [{ id: 'a' }] });
    assert.deepStrictEqual(source.counts, { stops: 0, closes: 1 }, 'the one-shot read releases the subscription');
    const outcome = await client.invoke('feed', { room: 'r1' });
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) assert.deepStrictEqual(outcome.value, { rows: [{ id: 'a' }] });
    assert.strictEqual(source.counts.closes, 2);
  });

  it('resume replay: Last-Event-ID + a replay-capable handler yields only the later patches, no snapshot', async () => {
    source = makeSource({ rows: [1, 2, 3] }, {
      replay: (/** @type {number} */ seq) => [
        { patch: [{ op: 'add', path: '/rows/-', value: 2 }], seq: seq + 1 },
        { patch: [{ op: 'add', path: '/rows/-', value: 3 }], seq: seq + 2 },
      ],
    });
    const { seen, sub } = record({ room: 'r1' }, { lastSeq: 10 });
    await wait(() => seen.patches.length === 2);
    assert.deepStrictEqual(seen.snapshots, [], 'a replayed stream starts with patches');
    assert.deepStrictEqual(seen.patches.map((p) => p.seq), [11, 12]);
    sub.stop();
    await wait(() => source.counts.closes === 1);
  });

  it('resume refused: a replay that answers null yields a fresh snapshot with resumed: false', async () => {
    source = makeSource({ rows: ['fresh'] }, { replay: () => null });
    const response = await fetch(`${origin}/rooms/r1/feed`, { headers: { accept: 'text/event-stream', 'last-event-id': '10' } });
    const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    assert.match(text, /event: snapshot\nid: 0\ndata: \{"value":\{"rows":\["fresh"\]\},"resumed":false\}/);
    await wait(() => source.counts.closes === 1);
  });

  it('disconnect: the peer goes away and the subscription is released exactly once', async () => {
    source = makeSource({ rows: [] });
    const controller = new AbortController();
    const response = await fetch(`${origin}/rooms/r1/feed`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
    await reader.read();
    assert.strictEqual(source.active(), 1);
    controller.abort();
    await wait(() => source.counts.closes === 1);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    assert.strictEqual(source.active(), 0);
  });

  it("the dispatcher's close() ends every live stream with server-shutdown", async () => {
    source = makeSource({ rows: [] });
    const { seen } = record();
    await wait(() => seen.snapshots.length === 1);
    dispatcher.close();
    await wait(() => seen.ends.length === 1);
    assert.deepStrictEqual(seen.ends, [{ reason: 'server-shutdown' }]);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('an emission over maxPatchBytes is replaced by a fresh snapshot at that seq', async () => {
    source = makeSource({ rows: [] });
    /** @type {any[]} */
    const events = [];
    const sub = client.subscribe('tiny', null, {
      onSnapshot: (value, info) => events.push({ kind: 'snapshot', value, seq: info.seq }),
      onPatch: (emission) => events.push({ kind: 'patch', seq: emission.seq }),
    });
    await wait(() => events.length === 1);
    const big = { op: 'add', path: '/rows/-', value: 'x'.repeat(200) };
    source.emit({ patch: [big], seq: 3 }, { rows: ['x'.repeat(200)] });
    await wait(() => events.length === 2);
    assert.deepStrictEqual(events[1], { kind: 'snapshot', value: { rows: ['x'.repeat(200)] }, seq: 3 });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 1 }], seq: 4 }, { rows: ['x'.repeat(200), 1] });
    await wait(() => events.length === 3);
    assert.deepStrictEqual(events[2], { kind: 'patch', seq: 4 });
    sub.stop();
    await wait(() => source.counts.closes === 1);
  });
});

describe('stream over SSE — failures', () => {
  it('an invalid snapshot ends the stream with an error event carrying JC2091; the client reports JC2093 with the record in details', async () => {
    source = makeSource({ nope: true });
    const { seen } = record();
    await wait(() => seen.errors.length === 1);
    const outcome = seen.errors[0];
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.kind, 'contract');
    assert.strictEqual(outcome.error.code, 'JC2093');
    assert.strictEqual(outcome.error.details.code, 'JC2091');
    assert.strictEqual(outcome.meta.trace, 'trace-1');
    assert.deepStrictEqual(seen.snapshots, []);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'the failed stream still releases exactly once');
  });

  it('a declared failure settles pre-stream as its declared status, and lands as a failure outcome', async () => {
    feedOverride = (input, ctx) => ctx.fail('gone', {}, { at: 1 });
    try {
      const { seen } = record();
      await wait(() => seen.errors.length === 1);
      const outcome = seen.errors[0];
      assert.strictEqual(outcome.kind, 'failure');
      assert.strictEqual(outcome.error.code, 'gone');
      assert.strictEqual(outcome.error.status, 410);
      assert.deepStrictEqual(outcome.error.details, { at: 1 });
    }
    finally {
      feedOverride = null;
    }
  });

  it('an invalid input is refused pre-send (JC2050), and a non-subscribe operation throws JC1010', async () => {
    const { seen } = record({ room: 5 });
    await wait(() => seen.errors.length === 1);
    assert.strictEqual(seen.errors[0].error.code, 'JC2050');
    const readContract = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true } } });
    const readClient = openHttpClient(readContract, { baseUrl: origin });
    assert.throws(() => readClient.subscribe('a', null, {}), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1010');
    assert.throws(() => client.subscribe('nope', null, {}), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1005');
  });

  it('a handler that answers a non-subscription is JC2010 pre-stream; the client classifies the 500', async () => {
    feedOverride = () => ({ not: 'a subscription' });
    try {
      const { seen } = record();
      await wait(() => seen.errors.length === 1);
      assert.strictEqual(seen.errors[0].kind, 'failure');
      assert.strictEqual(seen.errors[0].error.code, 'JC2010');
      assert.strictEqual(seen.errors[0].error.status, 500);
    }
    finally {
      feedOverride = null;
    }
  });
});

describe('stream over SSE — the hostile-server classifications', () => {
  /**
   * A raw server answering one canned exchange.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handle
   */
  async function hostile(handle) {
    const raw = http.createServer(handle);
    raw.listen(0, '127.0.0.1');
    await once(raw, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (raw.address());
    return {
      client: openHttpClient(CONTRACT, { baseUrl: `http://127.0.0.1:${address.port}` }),
      close: async () => {
        raw.closeAllConnections();
        raw.close();
        await once(raw, 'close');
      },
    };
  }

  it('JC2090 — a 200 that is not an event stream', async () => {
    const h = await hostile((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"rows":[]}');
    });
    try {
      /** @type {any[]} */
      const errors = [];
      h.client.subscribe('feed', { room: 'r1' }, { onError: (o) => errors.push(o) });
      await wait(() => errors.length === 1);
      assert.strictEqual(errors[0].kind, 'contract');
      assert.strictEqual(errors[0].error.code, 'JC2090');
    }
    finally {
      await h.close();
    }
  });

  it('JC2092 — a seq that does not strictly increase ends the stream', async () => {
    const h = await hostile((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: snapshot\nid: 0\ndata: {"value":{"rows":[]},"resumed":false}\n\n');
      res.write('event: patch\nid: 5\ndata: {"patch":[],"seq":5}\n\n');
      res.write('event: patch\nid: 5\ndata: {"patch":[],"seq":5}\n\n');
    });
    try {
      /** @type {any[]} */
      const errors = [];
      /** @type {any[]} */
      const patches = [];
      h.client.subscribe('feed', { room: 'r1' }, { onError: (o) => errors.push(o), onPatch: (p) => patches.push(p) });
      await wait(() => errors.length === 1);
      assert.strictEqual(patches.length, 1);
      assert.strictEqual(errors[0].error.code, 'JC2092');
    }
    finally {
      await h.close();
    }
  });

  it('JC2094 — silence beyond twice the heartbeat interval is a retryable network outcome', async () => {
    const h = await hostile((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: snapshot\nid: 0\ndata: {"value":{"rows":[]},"resumed":false}\n\n');
      // then: silence
    });
    try {
      /** @type {any[]} */
      const errors = [];
      h.client.subscribe('feed', { room: 'r1' }, { onError: (o) => errors.push(o) });
      await wait(() => errors.length === 1);
      assert.strictEqual(errors[0].kind, 'network');
      assert.strictEqual(errors[0].error.code, 'JC2094');
      assert.strictEqual(errors[0].error.retryable, true);
    }
    finally {
      await h.close();
    }
  });
});

describe('stream over the fetch adapter', () => {
  it('toFetchHandler answers a streamed Response body carrying the same events', async () => {
    source = makeSource({ rows: ['f'] });
    const handler = toFetchHandler(dispatcher);
    const controller = new AbortController();
    const response = await handler(new Request('http://contract.local/rooms/r1/feed', {
      headers: { accept: 'text/event-stream' }, signal: controller.signal,
    }));
    assert.strictEqual(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 'g' }], seq: 2 }, { rows: ['f', 'g'] });
    while (!(text.includes('event: patch'))) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /event: snapshot\nid: 0\ndata: \{"value":\{"rows":\["f"\]\},"resumed":false\}/);
    assert.match(text, /event: patch\nid: 2\n/);
    await reader.cancel();
    await wait(() => source.counts.closes === 1);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('a handler may still return ContractFailure through the boundary factory', () => {
    // pinned: the settlement classification of §17.1 rides the shared
    // pipeline — the value identity, not a shape read
    const failure = ContractFailure('gone', {}, null);
    assert.strictEqual(failure.code, 'gone');
  });
});
