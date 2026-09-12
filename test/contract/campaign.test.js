//@ts-check
/**
 * @file The end state, demonstrated in one story: a consumer with a
 * `$contract` document serves it over `node:http`, calls it from a
 * headless `@jarenjs/app` with structured failure, subscribes to a
 * `@jarenjs/db` live query across the wire, hands it to a model as
 * tools, publishes its OpenAPI/types/docs with `--check` green, and
 * knows its revision — with `packages/contract/package.json` declaring
 * exactly `core`, `json`, `validate` and `emit` (emit reached only from
 * the `./project` subpath). The `app`, `db` and `ai` imports below are
 * test-side composition, which is the point: the package cooperates by
 * generated documents and duck-typed handler values, never an import.
 *
 * The shop contract is the fixture extended with one `subscribe`
 * operation over a real in-memory `@jarenjs/db` store (capture on), so
 * the command the app dispatches is the same write the subscription
 * sees come back as a LIVE-FORMAT patch.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';


import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect, createContractSubscription } from '@jarenjs/contract/app';
import { contractTools } from '@jarenjs/contract/project';
import { load } from './helpers.js';

const CLI = fileURLToPath(new URL('../../packages/contract/src/cli.js', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../packages/contract/package.json', import.meta.url));

/** The shop fixture extended with the live half of the story. */
const DOC = (() => {
  const doc = load('./fixtures/shop.contract.json');
  doc.operations['catalog.live'] = {
    kind: 'subscribe',
    output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
    doc: 'The product rows, live: a snapshot, then LIVE-FORMAT patches.',
  };
  return doc;
})();

const MODEL = {
  $model: '0.1',
  collections: {
    products: {
      schema: {
        type: 'object',
        required: ['id', 'name', 'price'],
        properties: { id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' } },
      },
      key: '/id',
    },
  },
};

const SCAN = [{ $for: { it: '$[*]' }, $return: '$it' }];
const sync = (/** @type {() => void} */ flush) => flush();

/** Drain microtasks, then wait (bounded) until `until` holds. */
async function drain(until = () => true) {
  for (let i = 0; i < 16; i++) await Promise.resolve();
  for (let n = 0; n < 400 && !until(); n++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe('the campaign story — one contract, every end', () => {
  const contract = compileContract(DOC);

  /** @type {any} */ let store;
  /** @type {any} */ let dispatcher;
  /** @type {http.Server} */ let server;
  /** @type {string} */ let baseUrl;
  /** @type {any} */ let client;
  /** @type {{ op: string, input: any }[]} */ const handled = [];

  before(async () => {
    store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    await store.collection('products').insert({ id: 1, name: 'first', price: 5 });

    dispatcher = serveHttp(contract, {
      'catalog.load': async (/** @type {any} */ input) => {
        handled.push({ op: 'catalog.load', input });
        const rows = await store.collection('products').execute(SCAN);
        return { revision: 1, products: rows };
      },
      'product.save': async (/** @type {any} */ input) => {
        handled.push({ op: 'product.save', input });
        await store.collection('products').put(input.product, input.id);
        return input.product;
      },
      'product.search': async (/** @type {any} */ input) => {
        handled.push({ op: 'product.search', input });
        return /** @type {any[]} */ (await store.collection('products').execute(SCAN))
          .filter((row) => input.q === undefined || row.name.includes(input.q));
      },
      'product.remove': () => true,
      'image.bytes': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) }),
      'catalog.live': () => store.collection('products').live(SCAN),
    }, { ledger: createMemoryLedger() });

    server = http.createServer(toNodeHandler(dispatcher));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = openHttpClient(contract, { baseUrl });
  });

  after(async () => {
    client.close();
    dispatcher.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await store.close();
  });

  it('a headless app reads, commands with idempotency (twice in one tick — one request, the result lands) and watches the live query over the wire', async () => {
    const { slice, actions, subs, schema } = contractAppBinding(contract, {
      ops: ['catalog.load', 'product.save', 'catalog.live'],
    });
    const validate = new JarenValidator().compile({ type: 'object', required: ['contract'], properties: { contract: schema } });
    /** @type {any[]} */
    const appErrors = [];
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
      onError: (/** @type {any} */ err) => appErrors.push(err),
    });
    const slot = (/** @type {string} */ op) => app.getState().contract[op];

    try {
      // the subscription: live before anything else, so the command's
      // write below is a patch it must see
      app.dispatch('contract/catalog.live/start');
      await drain(() => slot('catalog.live').value !== null);
      assert.strictEqual(slot('catalog.live').status, 'live');
      assert.deepStrictEqual(slot('catalog.live').value, { rows: [{ id: 1, name: 'first', price: 5 }] });

      // the read
      app.dispatch('contract/catalog.load/start');
      await drain(() => slot('catalog.load').status === 'done');
      const read = slot('catalog.load');
      assert.deepStrictEqual(read.value, { revision: 1, products: [{ id: 1, name: 'first', price: 5 }] });
      assert.deepStrictEqual([read.meta.op, read.meta.attempt, typeof read.meta.trace], ['catalog.load', 1, 'string']);

      // the command, dispatched TWICE in one tick — product.save declares
      // idempotency (the server holds a ledger) and task `exhaust`, so the
      // 03A rule must hold: one request reaches the server AND its result
      // lands in the slot
      const product = { id: 2, name: 'second', price: 9 };
      const before2 = handled.filter((h) => h.op === 'product.save').length;
      app.dispatch('contract/product.save/start', { id: 2, revision: 1, product });
      app.dispatch('contract/product.save/start', { id: 2, revision: 1, product });
      await drain(() => slot('product.save').status === 'done');
      assert.strictEqual(handled.filter((h) => h.op === 'product.save').length, before2 + 1, 'exhaust: one request');
      assert.deepStrictEqual(slot('product.save').value, product, 'the single completion landed');

      // the subscription saw the command's write as a patch
      await drain(() => slot('catalog.live').seq > 0 && slot('catalog.live').value.rows.length === 2);
      assert.deepStrictEqual(slot('catalog.live').value.rows.map((/** @type {any} */ row) => row.id), [1, 2]);
      assert.ok(slot('catalog.live').seq > 0, 'a LIVE-FORMAT patch arrived with its seq');

      // structured failure stays JSON in state: an input the schema
      // refuses never leaves the client
      app.dispatch('contract/product.save/start', { id: 'x' });
      await drain(() => slot('product.save').status === 'error');
      assert.deepStrictEqual([slot('product.save').kind, slot('product.save').error.code], ['contract', 'JC2050']);

      assert.deepStrictEqual(appErrors, [], 'validateState accepted every generated transition');
    }
    finally {
      app.destroy();
    }
  });

  it('the same client projects the operations as plain definitions, and one executes', async () => {
    const tools = contractTools(contract, client);
    assert.deepStrictEqual(tools.map((/** @type {any} */ t) => t.name),
      ['catalog_load', 'product_save', 'product_search', 'product_remove'],
      'opaque and subscribe operations are excluded by default');
    const outcome = /** @type {any} */ (await tools.find(t => t.name === 'product_search').execute( { q: 'second' }));
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.value, [{ id: 2, name: 'second', price: 9 }]);
  });

  it('the CLI emits OpenAPI, types and docs to a directory and --check answers 0 for all three', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-campaign-'));
    try {
      fs.writeFileSync(path.join(dir, 'shop.json'), JSON.stringify(DOC));
      const cli = (/** @type {string[]} */ args) =>
        spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
      const emit = [
        ['openapi', '--contract', 'shop.json', '--out', 'api/', '--info-title', 'Shop', '--info-version', '5'],
        ['types', '--contract', 'shop.json', '--out', 'shop.d.ts'],
        ['docs', '--contract', 'shop.json', '--out', 'docs/'],
      ];
      for (const args of emit) {
        const written = cli(args);
        assert.strictEqual(written.status, 0, `${args[0]} wrote: ${written.stderr}`);
        const checked = cli([...args, '--check']);
        assert.strictEqual(checked.status, 0, `${args[0]} --check is current: ${checked.stderr}`);
      }
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the revision the compile computes is the revision the wire serves', async () => {
    const wellKnown = await fetch(`${baseUrl}/.well-known/jaren-contract`);
    assert.strictEqual(wellKnown.status, 200);
    const description = /** @type {any} */ (await wellKnown.json());
    const revision = await contract.revision();
    assert.match(revision, /^[0-9a-f]{64}$/);
    assert.strictEqual(description.revision, revision);
  });

  it('the manifest declares exactly core, json, validate and emit', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.dependencies).sort(),
      ['@jarenjs/core', '@jarenjs/emit', '@jarenjs/json', '@jarenjs/validate']);
  });
});
