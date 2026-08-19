//@ts-check
/**
 * @file The three README recipes, executed: Fastify, Hono and Express
 * each mount the dispatcher in ≤15 lines and answer the same request the
 * same way. The frameworks are imported from the BENCHMARK workspace
 * only (`benchmark/package.json` devDependencies) — the package declares
 * none of them; a rival that is not installed skips its test by name.
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

const shop = compileContract(load('./fixtures/shop.contract.json'));
const dispatcher = serveHttp(shop, shopHandlers(), { ledger: createMemoryLedger(), trace: () => 'recipe-trace' });
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
}

const fastifyMod = await rival('fastify');
const honoMod = await rival('hono');
const expressMod = await rival('express');

describe('README recipes', () => {
  it('Fastify: a catch-all route with the raw body handed to dispatch', { skip: fastifyMod === null ? 'fastify is not installed in benchmark/' : false }, async () => {
    const fastify = fastifyMod.default ?? fastifyMod;
    // —— the recipe ——
    const app = fastify();
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
    app.all('/*', async (req, reply) => {
      const r = await dispatcher.dispatch({ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null });
      reply.code(r.status).headers(r.headers);
      return r.body === null ? reply.send() : reply.send(r.body);
    });
    // —— end of the recipe ——
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      await exercise(origin);
    }
    finally {
      await app.close();
    }
  });

  it('Hono: the fetch handler is the whole app', { skip: honoMod === null ? 'hono is not installed in benchmark/' : false }, async () => {
    const Hono = honoMod.Hono ?? honoMod.default.Hono;
    // —— the recipe ——
    const app = new Hono();
    app.all('*', (c) => toFetchHandler(dispatcher)(c.req.raw));
    // —— end of the recipe ——
    // hono runs on any WHATWG host; here it is driven through node:http by hand
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length === 0 || req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const response = await app.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: /** @type {any} */ (req.headers), body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
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

  it('Express: the node handler is mounted as middleware', { skip: expressMod === null ? 'express is not installed in benchmark/' : false }, async () => {
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
