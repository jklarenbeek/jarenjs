//@ts-check
/**
 * @file `contractTools`: the tool definitions register into a real
 * plain operation execution (the contract validates at dispatch; the package never
 * does — the grep in this file pins that) and `execute` round-trips
 * through a `serveHttp` dispatcher to the same outcome `client.invoke`
 * resolves; names map `.` → `_` under OpenAI's constraint and a
 * collision is `JC1008`; each `inputSchema` is self-contained (its
 * `$defs` inlined — a fresh validator with no registered documents
 * compiles it); opaque operations are skipped by default and refused
 * when named.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import { compileContract, ContractHostError } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { contractTools } from '@jarenjs/contract/project';


import { load, shopHandlers } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');

/** A client wired straight into a dispatcher over the shop handlers. */
function openShop() {
  const contract = compileContract(shop);
  const server = serveHttp(contract, shopHandlers(), { ledger: createMemoryLedger() });
  const handler = toFetchHandler(server);
  const client = openHttpClient(contract, { fetch: (/** @type {any} */ url, /** @type {any} */ init) => handler(new Request(`http://shop.local${url}`, init)) });
  return { contract, client };
}

describe('contractTools — the definitions', () => {
  const { contract, client } = openShop();
  const tools = contractTools(contract, client);

  it('lists every public invokable operation in document order, named with . → _, described by doc', () => {
    assert.deepStrictEqual(tools.map((t) => t.name), ['catalog_load', 'product_save', 'product_search', 'product_remove'],
      'the opaque image.bytes is not a tool');
    assert.strictEqual(tools[0].description, 'The whole catalog snapshot.');
    assert.strictEqual(tools[1].description, 'command operation product.save (PUT /api/products/{id}/master)', 'no doc: a derived summary');
    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.strictEqual(typeof tool.execute, 'function');
    }
  });

  it('gives each tool a self-contained inputSchema — a fresh validator with no registered documents compiles it', () => {
    const save = tools.find((t) => t.name === 'product_save');
    assert.ok(save !== undefined);
    assert.deepStrictEqual(Object.keys(save.inputSchema.$defs), ['Product'], 'the reachable def is inlined');
    const validate = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(save.inputSchema);
    assert.strictEqual(validate({ id: 1, revision: 2, product: { id: 1, name: 'a', price: 1 } }).valid, true);
    assert.strictEqual(validate({ id: 1, revision: 2, product: { id: 1 } }).valid, false, 'the inlined Product still constrains');
    const search = tools.find((t) => t.name === 'product_search');
    assert.strictEqual('$defs' in /** @type {any} */ (search).inputSchema, false, 'nothing reachable, nothing inlined');
  });

  it('narrows by ops, refuses an opaque or unknown one there, and refuses collisions and bad names with JC1008', () => {
    assert.deepStrictEqual(contractTools(contract, client, { ops: ['product.search'] }).map((t) => t.name), ['product_search']);
    assert.throws(() => contractTools(contract, client, { ops: ['image.bytes'] }),
      (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1008' && /opaque/.test(e.message));
    assert.throws(() => contractTools(contract, client, { ops: ['nope'] }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => contractTools(contract, client, { name: () => 'same' }),
      (/** @type {any} */ e) => e.code === 'JC1008' && /both map to the tool name 'same'/.test(e.message));
    assert.throws(() => contractTools(contract, client, { name: (/** @type {string} */ id) => `bad name ${id}` }),
      (/** @type {any} */ e) => e.code === 'JC1008' && /\^\[a-zA-Z0-9_-\]\{1,64\}\$/.test(e.message));
    assert.throws(() => contractTools(contract, /** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1008' && /invoke/.test(e.message));
    assert.throws(() => contractTools(/** @type {any} */ (shop), client), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});

describe('contractTools — through a real server', () => {
  it('direct execute answers the same outcome client.invoke resolves', async () => {
    const { contract, client } = openShop();
    const tools = contractTools(contract, client);
    assert.deepStrictEqual(tools.map((t) => t.name), ['catalog_load', 'product_save', 'product_search', 'product_remove']);

    const viaTool = await tools.find(t => t.name === 'product_save').execute( { id: 7, revision: 1, product: { id: 7, name: 'x', price: 2 } });
    const direct = await client.invoke('product.save', { id: 7, revision: 1, product: { id: 7, name: 'x', price: 2 } });
    assert.strictEqual(viaTool.ok, true);
    assert.deepStrictEqual(viaTool.value, { id: 7, name: 'x', price: 2 });
    assert.deepStrictEqual(viaTool.value, direct.ok ? direct.value : null, 'the tool answers what invoke answers');
    assert.deepStrictEqual(Object.keys(viaTool.meta), ['op', 'attempt', 'trace', 'revision', 'etag', 'notModified']);

    // the toolbox's own schema guard answers the validation errors, before any request
    const invalid = await tools.find(t => t.name === 'product_save').execute( { id: 'seven' });
    assert.equal(invalid.ok, false, 'the contract refuses invalid input before invoking the handler');

    // a failed outcome is still a RESOLVED value — a tool never rejects
    const outcome = await tools.find(t => t.name === 'catalog_load').execute( {});
    assert.strictEqual(outcome.ok, true);
  });

  it('an input-less operation invokes with null whatever the model sent', async () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: { 'health.check': { kind: 'read', output: { type: 'object' }, http: { method: 'GET', path: '/health' } } },
    });
    const server = serveHttp(contract, { 'health.check': () => ({ ok: true }) });
    const handler = toFetchHandler(server);
    const client = openHttpClient(contract, { fetch: (/** @type {any} */ url, /** @type {any} */ init) => handler(new Request(`http://x${url}`, init)) });
    const [tool] = contractTools(contract, client);
    assert.deepStrictEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    const outcome = await tool.execute({});
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.value, { ok: true });
  });
});

describe('contractTools — the no-import rule (D1)', () => {
  it('packages/contract/src never imports @jarenjs/ai, and only src/project imports @jarenjs/emit', () => {
    const src = fileURLToPath(new URL('../../packages/contract/src', import.meta.url));
    /** @param {string} dir @returns {string[]} */
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    const files = walk(src).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.strictEqual(/from '@jarenjs\/ai/.test(text), false, file);
      if (!file.split(sep).join('/').includes('/project/')) {
        assert.strictEqual(/from '@jarenjs\/emit/.test(text), false, file);
      }
    }
  });
});
