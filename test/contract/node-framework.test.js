//@ts-check
/**
 * @file A Node HTTP framework hosting the dispatcher over real sockets
 * (docs/CONTRACT-FORMAT.md §18–19; the README's Fastify recipes).
 *
 * The native pattern: one encapsulated Fastify plugin whose content-type
 * parser leaves the body raw, the framework's own `preHandler` guard, then
 * `nodeRequest` → `dispatcher.dispatch` → `reply.hijack()` →
 * `writeNodeResponse`. Through it:
 * - a guard's 403 answers before any stream byte, and neither `identify`
 *   nor the operation runs;
 * - a subscribe streams its snapshot and patches;
 * - a disconnect closes the source once and leaves no live callback;
 * - `Last-Event-ID` replays the later patches;
 * - a slow reader keeps the process's buffered bytes bounded until the
 *   stream's queue gives up;
 * - an upload over the operation's limit answers 413 `JC2003`, whether the
 *   limit is declared, streamed or crossed inside `readBody`;
 * - a framework-decorated principal reaches `identify` as `meta.request`.
 *
 * The hijack recipe (`toNodeHandler` from a route `onRequest`): a guard in
 * an `onRequest` hook of the route's scope runs first, and a route
 * `preHandler` never runs — the pitfall the README names, pinned.
 * `toNodeHandler(dispatcher, { request })` seeds `meta.request` from a
 * middleware-decorated `req.user`.
 *
 * Fastify and Express come from the benchmark workspace (rivals), never a
 * dependency of the package; a framework that is absent skips its tests
 * by name.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import { compileContract } from '@jarenjs/contract';
import { serveHttp, readBody } from '@jarenjs/contract/http';
import { toNodeHandler, nodeRequest, writeNodeResponse } from '@jarenjs/contract/node';

const benchmarkRequire = createRequire(new URL('../../benchmark/package.json', import.meta.url));

/**
 * Import a rival from the benchmark workspace, or `null` when it is not
 * installed there.
 * @param {string} name
 */
async function rival(name) {
  let resolved;
  try {
    resolved = benchmarkRequire.resolve(name);
  }
  catch {
    return null;
  }
  return import(pathToFileURL(resolved).href);
}

const fastifyMod = await rival('fastify');
const expressMod = await rival('express');
const NO_FASTIFY = fastifyMod === null ? 'fastify is not installed in benchmark/' : false;
const NO_EXPRESS = expressMod === null ? 'express is not installed in benchmark/' : false;

const contract = compileContract({
  $contract: '0.1',
  operations: {
    'room.feed': {
      kind: 'subscribe',
      input: { type: 'object', required: ['room'], properties: { room: { type: 'string' } } },
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      http: { method: 'GET', path: '/api/rooms/{room}/feed' },
      policy: { stream: { resume: 'replay', heartbeatMs: 1000 } },
    },
    'note.add': {
      kind: 'command',
      input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      output: { type: 'object', required: ['by', 'text'], properties: { by: { type: ['string', 'null'] }, text: { type: 'string' } } },
      http: { method: 'POST', path: '/api/notes' },
      policy: { limits: { maxBodyBytes: 1024 } },
    },
    'blob.put': {
      kind: 'command',
      input: { type: 'object', properties: { id: { type: 'string' } } },
      output: true,
      http: { method: 'PUT', path: '/api/blobs/{id}', media: 'application/octet-stream' },
      policy: { limits: { maxBodyBytes: 1024 } },
    },
  },
});

/**
 * An in-memory LIVE-shaped source; the stop/close counters prove the
 * exactly-once release, `active()` the live callbacks left.
 * @param {any} initial
 * @param {{ replay?: (seq: number) => any }} [extras]
 */
function liveSource(initial, extras = {}) {
  let document = initial;
  /** @type {Set<(emission: any) => void>} */
  const cbs = new Set();
  const counts = { stops: 0, closes: 0 };
  const sub = /** @type {any} */ ({
    get result() {
      return document;
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
      if (next !== undefined) document = next;
      for (const cb of [...cbs]) cb(emission);
    },
  };
}

/** Poll (bounded) until a condition holds. @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 800 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

/**
 * An accumulating reader over an SSE response body.
 * @param {Response} response
 */
function sseReader(response) {
  const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    get text() {
      return text;
    },
    /** Read until the accumulated text satisfies `have` (bounded ~4s). @param {(text: string) => boolean} have */
    async until(have) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !have(text)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.ok(have(text), `the SSE stream never carried the expected event: ${JSON.stringify(text)}`);
      return text;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/** @type {ReturnType<typeof liveSource>} */
let source = liveSource({ rows: [] });
let feedCalls = 0;
/** @type {any[]} the identify metas, in order */
const metas = [];
/** @type {unknown[]} */
const hosts = [];

const dispatcher = serveHttp(contract, {
  'room.feed': (input, ctx) => {
    feedCalls += 1;
    hosts.push(ctx.host);
    return source.sub;
  },
  'note.add': (input, ctx) => ({ by: /** @type {any} */ (ctx.host)?.user ?? null, text: /** @type {any} */ (input).text }),
  'blob.put': async (input, ctx) => {
    const bytes = await readBody(/** @type {any} */ (ctx).body, { signal: ctx.signal });
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: String(bytes.byteLength) };
  },
}, {
  trace: () => 'fw-trace',
  identify: (meta) => {
    metas.push(meta);
    return { host: meta.request };
  },
  streamLimits: { queue: { events: 64, bytes: 256 * 1024 } },
});

const AUTH = { authorization: 'Bearer ok' };

/** The last `reply.raw` the native route wrote — the slow-reader probe reads its buffer. @type {any} */
let lastRes = null;

/**
 * The native pattern, as the README writes it: the contract's routes in
 * one encapsulated plugin whose parser leaves the body raw, the
 * framework's own guard, then the packaged writer.
 * @param {any} fastify
 */
function nativeApp(fastify) {
  const app = fastify();
  const server = dispatcher;
  // a route outside the plugin keeps fastify's own parsing
  app.post('/legacy', async (/** @type {any} */ req) => ({ got: req.body.name }));
  // the slow-reader probe reads the buffer of the response the recipe writes
  app.addHook('onRequest', async (/** @type {any} */ req, /** @type {any} */ reply) => { lastRes = reply.raw; });
  // —— the recipe ——
  app.register(async (scope) => {
    // this scope's routes keep the body raw: the dispatcher reads it under
    // the operation's own limit (the parsers of the rest of the app stay)
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (req, payload, done) => done(null));
    scope.decorateRequest('user', null);
    // the framework's own guard, in its own lifecycle, before anything streams
    scope.addHook('preHandler', async (req, reply) => {
      if (req.headers.authorization !== 'Bearer ok') return reply.code(403).send({ error: 'forbidden' });
      req.user = { user: 'ada' };
    });
    scope.all('/*', async (req, reply) => {
      const incoming = nodeRequest(server, req.raw, reply.raw);
      const response = await server.dispatch({ ...incoming, request: req.user });
      reply.hijack();
      writeNodeResponse(reply.raw, response, { from: incoming });
    });
  });
  // —— end of the recipe ——
  return app;
}

/**
 * Listen, and close the app (and its keep-alive sockets) afterwards.
 * @param {any} app
 */
async function listen(app) {
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    origin: String(origin),
    port: /** @type {import('node:net').AddressInfo} */ (app.server.address()).port,
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

describe('Fastify — the native pattern (nodeRequest + writeNodeResponse)', { skip: NO_FASTIFY }, () => {
  /** @type {Awaited<ReturnType<typeof listen>>} */
  let host;
  before(async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    host = await listen(nativeApp(fastify));
  });
  after(async () => {
    await host.close();
  });

  it('a preHandler 403 answers before any stream byte: neither identify nor the operation runs', async () => {
    source = liveSource({ rows: [] });
    const before = { feedCalls, metas: metas.length };
    const refused = await fetch(`${host.origin}/api/rooms/r1/feed`, { headers: { accept: 'text/event-stream' } });
    assert.strictEqual(refused.status, 403);
    assert.match(String(refused.headers.get('content-type')), /application\/json/);
    assert.deepStrictEqual(await refused.json(), { error: 'forbidden' });
    assert.strictEqual(feedCalls, before.feedCalls, 'the subscribe handler never ran');
    assert.strictEqual(metas.length, before.metas, 'identify never ran');
    assert.strictEqual(source.active(), 0);
    assert.deepStrictEqual(source.counts, { stops: 0, closes: 0 });
  });

  it('a subscribe streams snapshot and patches; the principal reaches identify as meta.request; a disconnect closes the source once', async () => {
    source = liveSource({ rows: [] });
    const controller = new AbortController();
    const live = await fetch(`${host.origin}/api/rooms/r1/feed`, { headers: { accept: 'text/event-stream', ...AUTH }, signal: controller.signal });
    assert.strictEqual(live.status, 200);
    assert.match(String(live.headers.get('content-type')), /text\/event-stream/);
    assert.strictEqual(live.headers.get('x-jaren-trace'), 'fw-trace');
    const reader = sseReader(live);
    await reader.until((t) => t.includes('event: snapshot'));
    assert.deepStrictEqual(metas[metas.length - 1].request, { user: 'ada' });
    assert.strictEqual(metas[metas.length - 1].carrier, 'http');
    assert.deepStrictEqual(hosts[hosts.length - 1], { user: 'ada' }, 'identify made it the handler\'s host');
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 1 }], seq: 1 }, { rows: [1] });
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 2 }], seq: 2 }, { rows: [1, 2] });
    await reader.until((t) => t.includes('id: 2\n'));
    assert.match(reader.text, /event: snapshot\nid: 0\ndata: \{"value":\{"rows":\[\]\},"resumed":false,"reset":false,"earliestAvailable":null,"highWatermark":null\}\n\n/);
    assert.match(reader.text, /event: patch\nid: 1\ndata: \{"patch":\[\{"op":"add","path":"\/rows\/-","value":1\}\],"seq":1\}\n\n/);
    assert.match(reader.text, /event: patch\nid: 2\n/);
    controller.abort();
    await wait(() => source.counts.closes === 1);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'stopped and closed exactly once');
    assert.strictEqual(source.active(), 0, 'no live callback remains');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'and never again');
  });

  it('Last-Event-ID replays the later patches, with no snapshot, then continues live', async () => {
    source = liveSource({ rows: [1, 2, 3, 4] }, {
      replay: (/** @type {number} */ seq) => ({
        items: [2, 3, 4].filter((n) => n > seq).map((n) => ({ patch: [{ op: 'add', path: '/rows/-', value: n }], seq: n })),
        next: 4, earliestAvailable: 1, highWatermark: 4, hasMore: false, resetRequired: false,
      }),
    });
    const controller = new AbortController();
    const live = await fetch(`${host.origin}/api/rooms/r1/feed`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '1', ...AUTH }, signal: controller.signal,
    });
    assert.strictEqual(live.status, 200);
    const reader = sseReader(live);
    await reader.until((t) => t.includes('id: 4\n'));
    assert.deepStrictEqual([...reader.text.matchAll(/event: (\w+)\nid: (\d+)/g)].map((m) => `${m[1]}:${m[2]}`), ['patch:2', 'patch:3', 'patch:4']);
    source.emit({ patch: [{ op: 'add', path: '/rows/-', value: 5 }], seq: 5 }, { rows: [1, 2, 3, 4, 5] });
    await reader.until((t) => t.includes('id: 5\n'));
    assert.ok(!reader.text.includes('event: snapshot'), 'a replayed stream starts with patches');
    controller.abort();
    await wait(() => source.counts.closes === 1);
  });

  it('a slow reader keeps the process\'s buffered bytes bounded by the socket\'s high-water mark; the queue then gives up and the source closes once', async () => {
    source = liveSource({ rows: [] });
    const socket = net.connect(host.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /api/rooms/r1/feed HTTP/1.1\r\nhost: 127.0.0.1\r\naccept: text/event-stream\r\nauthorization: Bearer ok\r\n\r\n`);
    // read up to the snapshot with a listener — breaking out of the socket's
    // async iterator would destroy it
    socket.setEncoding('utf8');
    await new Promise((resolve) => {
      let head = '';
      /** @param {string} chunk */
      const onData = (chunk) => {
        head += chunk;
        if (!head.includes('event: snapshot')) return;
        socket.off('data', onData);
        // the reader stops reading: nothing more leaves the socket's receive buffer
        socket.pause();
        resolve(undefined);
      };
      socket.on('data', onData);
    });
    const res = lastRes;
    assert.ok(res !== null);
    const value = 'x'.repeat(8 * 1024);
    const frameBytes = Buffer.byteLength(`event: patch\nid: 999999\ndata: ${JSON.stringify({ patch: [{ op: 'add', path: '/rows/-', value }], seq: 999999 })}\n\n`);
    let maxBuffered = 0;
    let emitted = 0;
    for (let seq = 1; seq <= 8000 && source.counts.closes === 0; seq++) {
      source.emit({ patch: [{ op: 'add', path: '/rows/-', value }], seq });
      emitted += frameBytes;
      if (typeof res.writableLength === 'number') maxBuffered = Math.max(maxBuffered, res.writableLength);
      await new Promise((r) => setImmediate(r));
    }
    const bound = res.writableHighWaterMark + 2 * frameBytes;
    assert.ok(maxBuffered <= bound, `the process buffered ${maxBuffered} bytes; the pump may hold at most ${bound}`);
    await wait(() => source.counts.closes === 1);
    socket.destroy();
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'the slow consumer was released exactly once');
    assert.ok(emitted > 256 * 1024, `the stream gave up only after the queue's bound was passed (${emitted} bytes emitted)`);
  });

  it('an upload over maxBodyBytes answers 413 JC2003 — declared, streamed, and crossed inside readBody', async () => {
    const declared = await fetch(`${host.origin}/api/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ text: 'x'.repeat(2048) }),
    });
    assert.strictEqual(declared.status, 413);
    assert.strictEqual((await declared.json()).code, 'JC2003');
    for (const [method, path, type] of [['POST', '/api/notes', 'application/json'], ['PUT', '/api/blobs/b1', 'application/octet-stream']]) {
      // chunked: no content-length, so the limit is crossed while reading
      const answer = await new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: host.port, method, path, headers: { 'content-type': type, 'transfer-encoding': 'chunked', ...AUTH } });
        request.on('response', (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection, body: JSON.parse(text) }));
        });
        request.on('error', reject);
        for (let i = 0; i < 8; i++) request.write(i === 0 ? '{"text":"' + 'x'.repeat(247) : 'x'.repeat(256));
        request.end('"}');
      });
      assert.strictEqual(/** @type {any} */ (answer).status, 413, `${method} ${path}`);
      assert.strictEqual(/** @type {any} */ (answer).body.code, 'JC2003');
      assert.strictEqual(/** @type {any} */ (answer).connection, 'close', 'an upload left unread closes the connection');
    }
    // under the limit, both run — the principal on the command
    const note = await fetch(`${host.origin}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: '{"text":"hi"}' });
    assert.deepStrictEqual(await note.json(), { by: 'ada', text: 'hi' });
    const blob = await fetch(`${host.origin}/api/blobs/b1`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...AUTH }, body: new Uint8Array(1000) });
    assert.strictEqual(await blob.text(), '1000');
  });

  it('a route outside the plugin keeps fastify\'s own parsing', async () => {
    const legacy = await fetch(`${host.origin}/legacy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'parsed' }) });
    assert.strictEqual(legacy.status, 200);
    assert.deepStrictEqual(await legacy.json(), { got: 'parsed' });
  });
});

describe('Fastify — the hijack recipe (toNodeHandler from onRequest)', { skip: NO_FASTIFY }, () => {
  it('a guard in an onRequest hook of the route\'s scope runs before the hijack; a route preHandler never runs', async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    const app = fastify();
    let preHandlers = 0;
    app.register(async (/** @type {any} */ scope) => {
      // —— the recipe ——
      // a guard that must run before a stream is an onRequest hook of the
      // route's scope: the route's own onRequest hijacks, and nothing of
      // fastify's lifecycle after the hijack runs
      scope.addHook('onRequest', async (/** @type {any} */ req, /** @type {any} */ reply) => {
        if (req.headers.authorization !== 'Bearer ok') return reply.code(403).send({ error: 'forbidden' });
      });
      const handler = toNodeHandler(dispatcher);
      scope.all('/api/*', {
        onRequest: (/** @type {any} */ req, /** @type {any} */ reply, /** @type {any} */ done) => { reply.hijack(); handler(req.raw, reply.raw); done(); },
        // the pitfall, pinned: a preHandler here would never run
        preHandler: async () => { preHandlers += 1; },
      }, () => {});
      // —— end of the recipe ——
    });
    const host = await listen(app);
    try {
      source = liveSource({ rows: [] });
      const before = feedCalls;
      const refused = await fetch(`${host.origin}/api/rooms/r1/feed`, { headers: { accept: 'text/event-stream' } });
      assert.strictEqual(refused.status, 403);
      assert.strictEqual(feedCalls, before, 'the guard answered before the dispatcher saw the request');
      const controller = new AbortController();
      const live = await fetch(`${host.origin}/api/rooms/r1/feed`, { headers: { accept: 'text/event-stream', ...AUTH }, signal: controller.signal });
      assert.strictEqual(live.status, 200);
      const reader = sseReader(live);
      await reader.until((t) => t.includes('event: snapshot'));
      assert.strictEqual(preHandlers, 0, 'the hijack ended fastify\'s lifecycle: the preHandler never ran');
      assert.strictEqual(metas[metas.length - 1].request, null, 'toNodeHandler without a seed: meta.request is null');
      controller.abort();
      await wait(() => source.counts.closes === 1);
    }
    finally {
      await host.close();
    }
  });
});

describe('toNodeHandler — the per-request seed', () => {
  it('request: (req) => req.user delivers a middleware-decorated principal to identify as meta.request', async () => {
    const handler = toNodeHandler(dispatcher, { request: (req) => /** @type {any} */ (req).user });
    const server = http.createServer((req, res) => {
      /** @type {any} */ (req).user = req.headers.authorization === 'Bearer ok' ? { user: 'grace' } : undefined;
      handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    try {
      const signed = await fetch(`${origin}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: '{"text":"hi"}' });
      assert.deepStrictEqual(await signed.json(), { by: 'grace', text: 'hi' });
      assert.deepStrictEqual(metas[metas.length - 1].request, { user: 'grace' });
      // a seed answering undefined is carried as given; identify decides what it means
      const anonymous = await fetch(`${origin}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
      assert.deepStrictEqual(await anonymous.json(), { by: null, text: 'hi' });
      assert.strictEqual(metas[metas.length - 1].request, null);
    }
    finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('a seed that throws answers a plain 500 and never reaches the dispatcher; a seed that is not a function is refused at construction', async () => {
    const before = metas.length;
    const handler = toNodeHandler(dispatcher, { request: () => { throw new Error('no session store'); } });
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const r = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/notes`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
      assert.strictEqual(r.status, 500);
      assert.strictEqual(await r.text(), 'the request seed failed');
      assert.strictEqual(metas.length, before);
    }
    finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
    assert.throws(() => toNodeHandler(dispatcher, { request: /** @type {any} */ ('user') }), TypeError);
    assert.throws(() => toNodeHandler(dispatcher, /** @type {any} */ (null)), TypeError);
    assert.throws(() => nodeRequest(/** @type {any} */ ({}), /** @type {any} */ ({}), /** @type {any} */ ({})), TypeError);
    assert.throws(() => writeNodeResponse(/** @type {any} */ ({}), /** @type {any} */ ({}), /** @type {any} */ (5)), TypeError);
  });

  it('Express: the same seed behind app.use, the principal a middleware set', { skip: NO_EXPRESS }, async () => {
    const express = expressMod.default ?? expressMod;
    const app = express();
    app.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      req.user = { user: 'linus' };
      next();
    });
    app.use(toNodeHandler(dispatcher, { request: (req) => /** @type {any} */ (req).user }));
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const r = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/notes`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hey"}' });
      assert.deepStrictEqual(await r.json(), { by: 'linus', text: 'hey' });
    }
    finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });
});

describe('the identify meta on the other carriers', () => {
  it('meta.request is null on port and local — the member exists on every carrier', async () => {
    const { servePort, openPortClient } = await import('@jarenjs/contract/port');
    const { openLocalClient } = await import('@jarenjs/contract/local');
    const small = compileContract({ $contract: '0.1', operations: { 'who.am': { kind: 'read', output: true } } });
    /** @type {any[]} */
    const seen = [];
    const identify = (/** @type {any} */ meta) => {
      seen.push(meta);
      return { host: null };
    };
    const local = openLocalClient(small, { 'who.am': () => true }, { identify });
    await local.invoke('who.am', null);
    const { port1, port2 } = new MessageChannel();
    const server = servePort(small, { 'who.am': () => true }, { channel: port1, identify });
    const client = openPortClient(small, { channel: port2 });
    try {
      await client.invoke('who.am', null);
    }
    finally {
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
    assert.deepStrictEqual(seen.map((m) => [m.carrier, Object.hasOwn(m, 'request'), m.request]), [['local', true, null], ['port', true, null]]);
  });
});
