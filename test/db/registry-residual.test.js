//@ts-check
/**
 * @file Ring 2 (TODO_OPS) — registered operators run in the db RESIDUAL.
 * A store opened with a registry accepts query and entity documents that
 * use registered operators, and they run CORRECTLY (JS over the fetched
 * rows), never silently wrong. The proofs:
 *
 *  - differential: the SAME document against the store equals the
 *    in-memory engine over the same rows, and the direct core function;
 *  - `explain()` names the registered operator as the residual reason,
 *    never silently — the operator also appears in the dependency list;
 *  - an entity document / multi-entity root behaves identically;
 *  - without a registry the store is unchanged (a pack operator is
 *    `JQ0002`, `capabilities.operators` is empty);
 *  - the safe profile's bounds (maxRows) still apply to a residual query
 *    using a registered operator, and the profile's `functions`
 *    allow-list still governs a registered `fn` reached via `$call`,
 *    while a first-class `op`/`agg` is host machinery allowed by default.
 *
 * Ring 2 is "correct everywhere, accelerated nowhere": every registered
 * operator is a residual here. SQL pushdown is Ring 3.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createJsltRegistry, financePack, statsPack } from '@jarenjs/json/jslt';
import { npv } from '@jarenjs/core/finance';

const COLLECTION_MODEL = {
  $model: '0.1',
  collections: {
    deals: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, rate: { type: 'number' }, klass: { type: 'string' },
          cashflows: { type: 'array', items: { type: 'number' } },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_klass', path: '$.klass' }],
    },
  },
};

const DEALS = [
  { id: 'a', rate: 0.1, klass: 'upper', cashflows: [-1000, 300, 400, 500, 300] },
  { id: 'b', rate: 0.1, klass: 'lower', cashflows: [-500, 100, 100] },
  { id: 'c', rate: 0.08, klass: 'upper', cashflows: [-2000, 900, 900, 900] },
  { id: 'd', rate: 0.05, klass: 'upper', cashflows: [-300, 200, 200] },
];

const registry = () => createJsltRegistry().use(financePack).use(statsPack);

async function dealStore(extra = {}) {
  const store = await openStore(COLLECTION_MODEL,
    { driver: nodeDriver(), operators: registry(), ...extra });
  const deals = store.collection('deals');
  for (const row of DEALS) await deals.insert(row);
  return { store, deals };
}

describe('Ring 2 — a collection query with a registered operator', () => {
  it('runs $npv in the residual and equals the in-memory engine AND core npv()', async () => {
    const { store, deals } = await dealStore();
    const document = {
      $for: { it: '$[*]' },
      $return: { id: '$it.id', npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
    };
    const got = await deals.execute(document);
    const memory = compileJsonQuery(document, registry().toOptions())(DEALS);
    assert.deepStrictEqual(got, memory, 'the store equals the in-memory engine');
    // and the value itself equals the direct core function
    assert.strictEqual(
      /** @type {any[]} */ (got).find((r) => r.id === 'a').npv,
      npv(0.1, DEALS[0].cashflows));
    await store.close();
  });

  it('explain() names the registered operator as the residual reason (never silent)', async () => {
    const { store, deals } = await dealStore();
    const document = {
      $for: { it: '$[*]' },
      $return: { npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
    };
    const ex = await deals.explain(document);
    assert.notStrictEqual(ex.residual, null, 'the query did not translate natively');
    const named = ex.residual.reasons.find((r) => r.construct === '$npv');
    assert.ok(named, 'a reason names $npv');
    assert.match(named.reason, /registered operator '\$npv' runs in the residual/);
    // the analysis dependency list surfaces the operator too
    assert.ok(ex.operators.includes('$npv'), 'explain().operators includes $npv');
    await store.close();
  });

  it('a $where over a registered operator is a set residual, barrier-named, equals memory', async () => {
    const { store, deals } = await dealStore();
    const document = {
      $for: { it: '$[*]' },
      $where: { $gt: [{ $npv: ['$it.rate', '$it.cashflows[*]'] }, 0] },
      $return: '$it.id',
    };
    const got = await deals.execute(document);
    const memory = compileJsonQuery(document, registry().toOptions())(DEALS);
    assert.deepStrictEqual(got, memory);
    const ex = await deals.explain(document);
    assert.strictEqual(ex.residual.mode, 'set');
    assert.strictEqual(ex.barriers[0].operator, '$npv',
      'the registered operator is the first-named barrier');
    await store.close();
  });

  it('a stats aggregator over a JSONPath-filtered subset (the "nearest" family) equals memory', async () => {
    const { store, deals } = await dealStore();
    const document = { $mean: '$[?(@.klass == "upper")].rate' };
    const got = await deals.execute(document);
    const memory = compileJsonQuery(document, registry().toOptions())(DEALS);
    assert.strictEqual(got, memory);
    assert.strictEqual(got, (0.1 + 0.08 + 0.05) / 3);
    await store.close();
  });

  it('a cursor (query) streams the same residual result', async () => {
    const { store, deals } = await dealStore();
    const document = {
      $for: { it: '$[*]' },
      $return: { id: '$it.id', npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
    };
    const out = [];
    for await (const item of deals.query(document)) out.push(item);
    const memory = compileJsonQuery(document, registry().toOptions())(DEALS);
    assert.deepStrictEqual(out, memory);
    await store.close();
  });
});

// ————— the entity document kind —————

const ENTITY_MODEL = {
  $model: '0.1',
  entities: {
    Deal: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          rate: { type: 'number' },
          klass: { type: 'string' },
          cashflows: { type: 'array', items: { type: 'number' } },
        },
      },
    },
  },
};

describe('Ring 2 — an entity document with a registered operator', () => {
  it('runs in the residual over the fetched root and agrees with memory', async () => {
    const store = await openStore(ENTITY_MODEL,
      { driver: nodeDriver(), operators: registry() });
    const Deal = store.entity('Deal');
    for (const row of DEALS) await Deal.create(row);

    // the multi-entity root query surface (`$.Entity[*]` bindings)
    const document = {
      $for: { d: '$.Deal[*]' },
      $return: { id: '$d.id', npv: { $npv: ['$d.rate', '$d.cashflows[*]'] } },
    };
    const got = await store.execute(document);
    const memory = compileJsonQuery(document, registry().toOptions())({ Deal: DEALS });
    assert.deepStrictEqual(got, memory, 'the entity residual equals the in-memory engine');

    const ex = await store.explain(document);
    assert.strictEqual(ex.mode, 'set');
    assert.ok(ex.reasons.some((r) => r.construct === '$npv'),
      'explain names the registered operator');
    await store.close();
  });
});

// ————— the opt-in boundary: no registry ⇒ unchanged —————

describe('Ring 2 — without a registry the store is unchanged', () => {
  it('a pack operator is JQ0002 and capabilities.operators is empty', async () => {
    const store = await openStore(COLLECTION_MODEL, { driver: nodeDriver() });
    const deals = store.collection('deals');
    await deals.insert(DEALS[0]);
    assert.deepStrictEqual(store.capabilities.operators, []);
    // execute is value-or-promise (sync on the node driver); the async
    // wrapper turns a synchronous compile throw into a rejection
    await assert.rejects(
      async () => deals.execute({
        $for: { it: '$[*]' },
        $return: { npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
      }),
      (e) => { assert.match(String(/** @type {Error} */ (e).message), /JQ0002/); return true; });
    await store.close();
  });

  it('capabilities.operators lists the registered vocabulary when a registry is threaded', async () => {
    const { store } = await dealStore();
    assert.ok(store.capabilities.operators.includes('$npv'));
    assert.ok(store.capabilities.operators.includes('$mean'));
    await store.close();
  });

  it('a bad operators option is a synchronous TypeError (API misuse)', () => {
    assert.throws(
      () => openStore(COLLECTION_MODEL, { driver: nodeDriver(), operators: { nope: true } }),
      (e) => { assert.ok(e instanceof TypeError); assert.match(e.message, /must be a registry/); return true; });
  });
});

// ————— the safe profile still governs a residual over a registered op —————

describe('Ring 2 — the safe profile bounds still apply', () => {
  it('a first-class registered operator is allowed by default under a profile', async () => {
    const { store, deals } = await dealStore({ profile: 'safe' });
    const document = {
      $for: { it: '$[*]' },
      $return: { id: '$it.id', npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
    };
    const got = await deals.execute(document);
    const memory = compileJsonQuery(document, registry().toOptions())(DEALS);
    assert.deepStrictEqual(got, memory, 'no JD0011 — the operator is host machinery');
    await store.close();
  });

  it('maxRows still bounds a residual query using a registered operator (JD2007)', async () => {
    // 4 rows, a maxRows of 2: the residual fetches maxRows+1 and refuses
    const { store, deals } = await dealStore({ profile: { maxRows: 2 } });
    const document = {
      $for: { it: '$[*]' },
      $return: { npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } },
    };
    await assert.rejects(
      async () => deals.execute(document),
      (e) => { assert.strictEqual(/** @type {any} */ (e).code, 'JD2007'); return true; });
    await store.close();
  });

  it("the profile's functions allow-list still governs a registered fn reached via $call", async () => {
    const clampPack = { name: 'util', entries: {
      clamp: { kind: 'fn', fn: (x, lo, hi) => Math.max(lo, Math.min(hi, x)) } } };
    const reg = () => createJsltRegistry().use(clampPack);
    const document = { $for: { it: '$[*]' }, $return: { c: { $call: ['clamp', '$it.rate', 0, 0.09] } } };

    // undeclared under the profile → JD0011
    const guarded = await openStore(COLLECTION_MODEL,
      { driver: nodeDriver(), operators: reg(), profile: 'safe' });
    const gd = guarded.collection('deals');
    for (const row of DEALS) await gd.insert(row);
    await assert.rejects(
      async () => gd.execute(document),
      (e) => { assert.strictEqual(/** @type {any} */ (e).code, 'JD0011'); return true; });
    await guarded.close();

    // declared → allowed, and correct
    const allowed = await openStore(COLLECTION_MODEL,
      { driver: nodeDriver(), operators: reg(), profile: { functions: ['clamp'] } });
    const ad = allowed.collection('deals');
    for (const row of DEALS) await ad.insert(row);
    const got = await ad.execute(document);
    const memory = compileJsonQuery(document, reg().toOptions())(DEALS);
    assert.deepStrictEqual(got, memory);
    await allowed.close();
  });
});

// ————— the raw seam (registry-free) —————

describe('Ring 2 — the raw functions/extensions seam', () => {
  it('accepts raw options.extensions without a registry', async () => {
    const reg = registry();
    const store = await openStore(COLLECTION_MODEL,
      { driver: nodeDriver(), extensions: reg.toOptions().extensions });
    const deals = store.collection('deals');
    for (const row of DEALS) await deals.insert(row);
    const document = { $for: { it: '$[*]' }, $return: { npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } } };
    const got = await deals.execute(document);
    const memory = compileJsonQuery(document, reg.toOptions())(DEALS);
    assert.deepStrictEqual(got, memory);
    assert.ok(store.capabilities.operators.includes('$npv'));
    await store.close();
  });
});
