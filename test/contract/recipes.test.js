//@ts-check
/**
 * @file The three README recipes, executed: Fastify, Hono and Express
 * each mount the dispatcher in ≤15 lines and answer the same requests
 * the same way — JSON, an idempotent PUT, 404, 400, opaque bytes, HEAD,
 * the operation's declared body limit (`JC2003`), and a live SSE
 * subscription whose peer disconnect and dispatcher `close()` release
 * the source exactly once. The frameworks are imported from the
 * BENCHMARK workspace only (`benchmark/package.json` devDependencies) —
 * the package declares none of them; a rival that is not installed skips
 * its test by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { toNodeHandler } from '@jarenjs/contract/node';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { load, shopHandlers } from './helpers.js';

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

// the shop fixture plus a subscribe operation — extended in memory so the
// checked projection artifacts (shop.d.ts, shop.openapi.json, …) stay
// what the fixture on disk projects
const doc = load('./fixtures/shop.contract.json');
const shop = compileContract({
  ...doc,
  operations: {
    ...doc.operations,
    'catalog.watch': {
      kind: 'subscribe',
      output: { type: 'object', required: ['revision'], properties: { revision: { type: 'integer' } } },
      http: { method: 'GET', path: '/api/catalog/live' },
      policy: { stream: { heartbeatMs: 1000 } },
    },
  },
});

/**
 * An in-memory LIVE-shaped source (the stream-sse.test.js shape); the
 * stop/close counters prove the exactly-once release through each recipe.
 * @param {any} initial
 */
function liveSource(initial) {
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
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
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
      assert.ok(have(text), 'the SSE stream never carried the expected event');
      return text;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/** @type {ReturnType<typeof liveSource>} */
let source = liveSource({ revision: 1 });

const dispatcher = serveHttp(shop, { ...shopHandlers(), 'catalog.watch': () => source.sub },
  { ledger: createMemoryLedger(), trace: () => 'recipe-trace' });
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };

/**
 * The requests every recipe must answer identically.
 * @param {string} origin
 */
async function exercise(origin) {
  const read = await fetch(`${origin}/api/catalog`);
  assert.strictEqual(read.status, 200);
  assert.strictEqual(read.headers.get('x-jaren-trace'), 'recipe-trace');
  assert.deepStrictEqual(await read.json(), { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
  const save = await fetch(`${origin}/api/products/1/master`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': `${origin}-1` }, body: JSON.stringify(SAVE),
  });
  assert.strictEqual(save.status, 200);
  assert.deepStrictEqual(await save.json(), { id: 1, name: 'x', price: 1 });
  const missing = await fetch(`${origin}/nope`);
  assert.strictEqual(missing.status, 404);
  assert.strictEqual((await missing.json()).code, 'JC2001');
  const bad = await fetch(`${origin}/product.remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await bad.json()).code, 'JC2006');
  const image = await fetch(`${origin}/api/images/3`);
  assert.strictEqual(image.headers.get('content-type'), 'application/octet-stream');
  assert.deepStrictEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const head = await fetch(`${origin}/api/catalog`, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(await head.text(), '');

  // a body over the operation's declared limit answers the contract's
  // 413 (product.remove declares maxBodyBytes: 4096); the declared
  // content-length refuses it before a byte is read
  const over = await fetch(`${origin}/product.remove`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, pad: 'x'.repeat(8192) }),
  });
  assert.strictEqual(over.status, 413);
  assert.strictEqual((await over.json()).code, 'JC2003');

  // a live SSE subscription over the real socket: snapshot, then a patch
  source = liveSource({ revision: 1 });
  const controller = new AbortController();
  const live = await fetch(`${origin}/api/catalog/live`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  assert.strictEqual(live.status, 200);
  assert.match(String(live.headers.get('content-type')), /text\/event-stream/);
  assert.strictEqual(live.headers.get('x-jaren-trace'), 'recipe-trace');
  const first = sseReader(live);
  await first.until((t) => t.includes('event: snapshot'));
  source.emit({ patch: [{ op: 'replace', path: '/revision', value: 2 }], seq: 5 }, { revision: 2 });
  await first.until((t) => t.includes('event: patch'));
  assert.match(first.text, /event: snapshot\nid: 0\ndata: \{"value":\{"revision":1\},"resumed":false\}\n\n/);
  assert.match(first.text, /event: patch\nid: 5\ndata: \{"patch":\[\{"op":"replace","path":"\/revision","value":2\}\],"seq":5\}\n\n/);

  // the peer's disconnect releases the live source exactly once
  controller.abort();
  await wait(() => source.counts.closes === 1);
  assert.strictEqual(source.active(), 0);

  // the dispatcher's close() ends a live stream with server-shutdown —
  // and survives it: only the live stoppers drain, dispatch continues
  const second = await fetch(`${origin}/api/catalog/live`, { headers: { accept: 'text/event-stream' } });
  const ender = sseReader(second);
  await ender.until((t) => t.includes('event: snapshot'));
  dispatcher.close();
  await ender.until((t) => t.includes('event: end'));
  assert.match(ender.text, /event: end\ndata: \{"reason":"server-shutdown"\}\n\n/);
  ender.cancel();
  await wait(() => source.counts.closes === 2);
}

const fastifyMod = await rival('fastify');
const honoMod = await rival('hono');
const expressMod = await rival('express');

describe('README recipes', () => {
  it('Fastify: hijack before parsing; the node adapter carries body limits, SSE and abort', { skip: fastifyMod === null ? 'fastify is not installed in benchmark/' : false, timeout: 30_000 }, async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    // —— the recipe ——
    const app = fastify();
    const handler = toNodeHandler(dispatcher);
    app.all('/*', {
      onRequest: (req, reply, done) => { reply.hijack(); handler(req.raw, reply.raw); done(); },
    }, () => {});
    // —— end of the recipe ——
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      await exercise(origin);
    }
    finally {
      // a hijacked request never completes in fastify's own bookkeeping,
      // so its keep-alive socket is never "idle" — close() would wait
      // out the 72s keep-alive timeout without this (the same
      // closeAllConnections the express/hono teardowns need)
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('Fastify: the contract, not fastify, answers above fastify\'s own bodyLimit', { skip: fastifyMod === null ? 'fastify is not installed in benchmark/' : false, timeout: 30_000 }, async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    const app = fastify();
    const handler = toNodeHandler(dispatcher);
    app.all('/*', {
      onRequest: (/** @type {any} */ req, /** @type {any} */ reply, /** @type {any} */ done) => { reply.hijack(); handler(req.raw, reply.raw); done(); },
    }, () => {});
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      // 1.5 MiB against product.save's default 1 MiB: were fastify still
      // parsing, its own bodyLimit (also 1 MiB) would answer
      // FST_ERR_CTP_BODY_TOO_LARGE in fastify's error shape — hijacked,
      // the contract refuses it as a coded JC2003
      const over = await fetch(`${origin}/api/products/1/master`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'big-1' },
        body: `{"revision":1,"product":{"id":1,"name":"x","price":1,"tags":["${'x'.repeat(1_572_864)}"]}}`,
      });
      assert.strictEqual(over.status, 413);
      assert.strictEqual((await over.json()).code, 'JC2003');
    }
    finally {
      // a hijacked request never completes in fastify's own bookkeeping,
      // so its keep-alive socket is never "idle" — close() would wait
      // out the 72s keep-alive timeout without this (the same
      // closeAllConnections the express/hono teardowns need)
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('Fastify: a legacy route registered beside the recipe keeps its parsed body', { skip: fastifyMod === null ? 'fastify is not installed in benchmark/' : false, timeout: 30_000 }, async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    const app = fastify();
    // the legacy route first, its parsers untouched — the recipe removes
    // none (the old removeAllContentTypeParsers defect); the static path
    // beats the wildcard by specificity, not by registration order
    app.post('/legacy', async (/** @type {any} */ req) => ({ got: req.body.name }));
    const handler = toNodeHandler(dispatcher);
    app.all('/*', {
      onRequest: (/** @type {any} */ req, /** @type {any} */ reply, /** @type {any} */ done) => { reply.hijack(); handler(req.raw, reply.raw); done(); },
    }, () => {});
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const legacy = await fetch(`${origin}/legacy`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'parsed' }),
      });
      assert.strictEqual(legacy.status, 200);
      assert.deepStrictEqual(await legacy.json(), { got: 'parsed' });
      const contract = await fetch(`${origin}/api/catalog`);
      assert.strictEqual(contract.status, 200);
      assert.strictEqual(contract.headers.get('x-jaren-trace'), 'recipe-trace');
    }
    finally {
      // a hijacked request never completes in fastify's own bookkeeping,
      // so its keep-alive socket is never "idle" — close() would wait
      // out the 72s keep-alive timeout without this (the same
      // closeAllConnections the express/hono teardowns need)
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('Hono: the fetch handler is the whole app', { skip: honoMod === null ? 'hono is not installed in benchmark/' : false, timeout: 30_000 }, async () => {
    const Hono = honoMod.Hono ?? honoMod.default.Hono;
    // —— the recipe ——
    const app = new Hono();
    app.all('*', (c) => toFetchHandler(dispatcher)(c.req.raw));
    // —— end of the recipe ——
    // hono runs on any WHATWG host; here it is driven through node:http
    // by hand — the response body is PUMPED, not buffered, so an SSE
    // stream flows and a dropped peer cancels it through the reader
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length === 0 || req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const response = await app.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: /** @type {any} */ (req.headers), body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      res.on('close', () => {
        reader.cancel().catch(() => {});
      });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.destroyed) res.write(value);
        }
      }
      catch {
        // the peer went away mid-stream; cancel released the subscription
      }
      if (!res.destroyed) res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    try {
      await exercise(`http://127.0.0.1:${port}`);
      // and directly, the way a WHATWG host calls it
      const direct = await app.fetch(new Request('http://x/api/catalog'));
      assert.strictEqual(direct.status, 200);
    }
    finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('Express: the node handler is mounted as middleware', { skip: expressMod === null ? 'express is not installed in benchmark/' : false, timeout: 30_000 }, async () => {
    const express = expressMod.default ?? expressMod;
    // —— the recipe ——
    const app = express();
    app.use(toNodeHandler(dispatcher));
    // —— end of the recipe ——
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    try {
      await exercise(`http://127.0.0.1:${port}`);
    }
    finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('the rivals live only in the benchmark workspace', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../packages/contract/package.json', import.meta.url), 'utf8'));
    for (const name of ['fastify', 'hono', 'express']) {
      assert.strictEqual(pkg.dependencies?.[name], undefined);
      assert.strictEqual(pkg.devDependencies?.[name], undefined);
    }
    const bench = JSON.parse(readFileSync(new URL('../../benchmark/package.json', import.meta.url), 'utf8'));
    assert.ok(bench.devDependencies.hono && bench.devDependencies.fastify && bench.devDependencies.express);
  });
});
