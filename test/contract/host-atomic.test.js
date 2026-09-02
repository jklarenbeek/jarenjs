//@ts-check
/**
 * @file The atomic settlement seam on a real store
 * (docs/CONTRACT-FORMAT.md §7.7): `acquire` opens one
 * `client.transaction(…, { mode: 'immediate' })` around `enter`, hands
 * the handler the transaction client as `ctx.host.db`, and requires
 * settlement through `createDbLedger(tx)`. A success commits the
 * handler's domain write and the claim's receipt together, and only
 * after the response was serialized; a handler throw, an invalid output
 * and a settlement that fails each roll the transaction back — neither
 * the write nor the receipt is visible, the root claim is retryable, the
 * observer saw the cause, and no success escaped. Without a required
 * settlement the root ledger's best-effort path is unchanged.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { idempotencyLedgerModel, ledgerId } from '@jarenjs/contract/ledger';
import { open, createDbLedger } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { jsonReq, json, load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
const URL = '/api/products/1/master';

const MODEL = {
  $model: '0.1',
  collections: {
    ...idempotencyLedgerModel.collections,
    products: {
      schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

/** @type {(() => any)[]} */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/**
 * A server whose acquire wraps enter in one immediate transaction with
 * a tx-bound required settlement; `sequence` records the order of the
 * domain write, the serialization and the transaction's settlement.
 * @param {Record<string, any>} handlers
 * @param {{ settlementLedger?: (tx: any) => any }} [shape]
 */
async function atomicServer(handlers, shape = {}) {
  const db = await open(MODEL, { driver: nodeDriver(), validator: null });
  cleanups.push(() => db.close());
  /** @type {string[]} */
  const sequence = [];
  /** @type {any[]} */
  const observed = [];
  const server = serveHttp(shop, { ...shopHandlers(), ...handlers }, {
    ledger: createDbLedger(db),
    onError: (e) => observed.push(e),
    acquire: (input, identity, enter) => db.transaction(async (tx) => {
      sequence.push('begin');
      try {
        const response = await enter({ host: { db: tx }, settlement: { ledger: (shape.settlementLedger ?? createDbLedger)(tx), required: true } });
        sequence.push('commit');
        return response;
      }
      catch (err) {
        sequence.push('rollback');
        throw err;
      }
    }, { mode: 'immediate' }),
  });
  return { db, server, sequence, observed };
}

describe('required settlement inside a real transaction', () => {
  it('a success commits the domain write and the receipt together, after the response was serialized', async () => {
    const { db, server, sequence, observed } = await atomicServer({
      'product.save': async (input, ctx) => {
        await ctx.host.db.collections.products.insert({ id: input.id, name: input.product.name, price: input.product.price });
        sequence.push('write');
        return { id: input.id, name: input.product.name, price: input.product.price };
      },
    });
    const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(sequence, ['begin', 'write', 'commit']);
    assert.deepStrictEqual(observed, []);
    assert.strictEqual((await db.collections.products.get(1))?.name, 'x');
    const receipt = await db.collections.ledger.get(ledgerId('product.save', '', 'k'));
    assert.strictEqual(receipt?.status, 'committed');
    assert.strictEqual(receipt?.response.status, 200);
    assert.strictEqual(receipt?.response.body, response.body, 'the receipt is the serialized response');
    // the replay comes from the receipt, never the handler
    const replay = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(replay.headers['idempotent-replayed'], 'true');
    assert.strictEqual(replay.body, response.body);
    assert.deepStrictEqual(sequence, ['begin', 'write', 'commit'], 'the replay entered no transaction');
  });

  it('a declared failure commits its receipt inside the same transaction; the retry replays it', async () => {
    const { db, server, sequence } = await atomicServer({
      'product.save': (input, ctx) => ctx.fail('conflict', {}, { current: { id: 1, name: 'x', price: 1 } }),
    });
    const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(response.status, 409);
    assert.deepStrictEqual(sequence, ['begin', 'commit']);
    const receipt = await db.collections.ledger.get(ledgerId('product.save', '', 'k'));
    assert.strictEqual(receipt?.status, 'failed');
    assert.strictEqual(receipt?.retryable, false);
    const replay = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(replay.status, 409);
    assert.strictEqual(replay.headers['idempotent-replayed'], 'true');
  });

  for (const [name, handlers, shape] of /** @type {const} */ ([
    ['a handler throw', { 'product.save': async (input, ctx) => { await ctx.host.db.collections.products.insert({ id: 1, name: 'ghost' }); throw new Error('handler broke'); } }, {}],
    ['an invalid output', { 'product.save': async (input, ctx) => { await ctx.host.db.collections.products.insert({ id: 1, name: 'ghost' }); return { nope: true }; } }, {}],
    ['a settlement that fails', { 'product.save': async (input, ctx) => { await ctx.host.db.collections.products.insert({ id: 1, name: 'ghost' }); return { id: 1, name: 'x', price: 1 }; } },
      { settlementLedger: (/** @type {any} */ tx) => ({ ...createDbLedger(tx), commit: () => Promise.reject(new Error('settlement broke')) }) }],
  ])) {
    it(`${name} rolls back: neither the write nor the receipt is visible, the root claim is retryable, the cause is observed, no success escaped`, async () => {
      const { db, server, sequence, observed } = await atomicServer(handlers, shape);
      const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
      assert.strictEqual(response.status, 500, name);
      assert.strictEqual(json(response).code, name === 'an invalid output' ? 'JC2010' : 'JC2008');
      assert.deepStrictEqual(sequence, ['begin', 'rollback']);
      assert.strictEqual(await db.collections.products.get(1), undefined, 'the domain write rolled back');
      const record = await db.collections.ledger.get(ledgerId('product.save', '', 'k'));
      assert.strictEqual(record?.status, 'failed', 'the root claim was released outside the transaction');
      assert.strictEqual(record?.retryable, true);
      assert.strictEqual(record?.response, null, 'no receipt of a success');
      assert.ok(observed.length >= 1, 'the cause reached the observer');
      // the retry runs the handler again under the same key
      const again = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
      assert.strictEqual(again.headers['idempotent-replayed'], undefined);
      assert.deepStrictEqual(sequence, ['begin', 'rollback', 'begin', 'rollback']);
    });
  }

  it('a pre-handler precondition refusal rolls back without running the handler and releases the key retryable', async () => {
    let ran = false;
    const { db, server, sequence } = await atomicServer({ 'product.save': () => { ran = true; return { id: 1, name: 'x', price: 1 }; } });
    const guarded = serveHttp(shop, { ...shopHandlers(), 'product.save': () => { ran = true; return { id: 1, name: 'x', price: 1 }; } }, {
      ledger: createDbLedger(db),
      preconditions: { 'product.save': () => 'r9' },
      acquire: (input, identity, enter) => db.transaction(async (tx) => {
        sequence.push('begin');
        try {
          return await enter({ host: { db: tx }, settlement: { ledger: createDbLedger(tx), required: true } });
        }
        catch (err) {
          sequence.push('rollback');
          throw err;
        }
      }, { mode: 'immediate' }),
    });
    void server;
    const response = await guarded.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k', 'if-match': '"r1"' }));
    assert.strictEqual(response.status, 412);
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(sequence, ['begin', 'rollback']);
    const record = await db.collections.ledger.get(ledgerId('product.save', '', 'k'));
    assert.strictEqual(record?.status, 'failed');
    assert.strictEqual(record?.retryable, true);
  });

  it('without a required settlement the root ledger settles best-effort as before; a settlement on a non-idempotent operation is accepted and unused', async () => {
    const db = await open(MODEL, { driver: nodeDriver(), validator: null });
    cleanups.push(() => db.close());
    const server = serveHttp(shop, { ...shopHandlers(), 'catalog.load': () => ({ revision: 1, products: [] }) }, {
      ledger: createDbLedger(db),
      acquire: (input, identity, enter) => enter({ host: { db }, settlement: { ledger: createDbLedger(db), required: true } }),
    });
    const read = await server.dispatch({ method: 'GET', url: '/api/catalog', headers: {}, body: null });
    assert.strictEqual(read.status, 200);
    const saved = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(saved.status, 200);
    assert.strictEqual((await db.collections.ledger.get(ledgerId('product.save', '', 'k')))?.status, 'committed');
  });
});
