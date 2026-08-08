//@ts-check
/**
 * @file Ring 3 — SQL pushdown of the pushable-scalar registry
 * subset. A `pushable:'scalar'` registered operator (`$sqrt`, `$pow`, …)
 * used in a WHERE predicate registers as a SQLite deterministic UDF and
 * the plan emits the call, so SQLite drives the row iteration and the
 * operator runs inside the callback instead of every candidate crossing
 * into the residual. This is a speed optimisation over Ring 2 — never a
 * correctness change: the residual keeps every result correct.
 *
 * The suite is DRIVER-AWARE so the one file proves the whole matrix:
 * where the driver has user functions (node:sqlite) the operator pushes
 * (native/UDF); where it does not (bun:sqlite) the SAME operator runs in
 * the residual (Ring 2) — and both return the identical answer. The
 * honest ceiling is asserted too: a `pushable:false` operator (`$npv`,
 * whole-series) never becomes a UDF, and a profiled (untrusted) document
 * never triggers host-side registration.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createJsltRegistry, mathPack, financePack } from '@jarenjs/json/jslt';

const MODEL = {
  $model: '0.1',
  collections: {
    pts: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, x: { type: 'number' }, active: { type: 'boolean' },
          cashflows: { type: 'array', items: { type: 'number' } },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_active', path: '$.active' }],
    },
  },
};

const DATA = [
  { id: 'a', x: 16, active: true, cashflows: [-100, 60, 60] },
  { id: 'b', x: 4, active: true, cashflows: [-100, 20, 20] },
  { id: 'c', x: 25, active: false, cashflows: [-100, 80, 80] },
  { id: 'd', x: 1, active: true, cashflows: [-100, 10] },
  { id: 'e', x: 9, active: true, cashflows: [-50, 40, 40] },
];

const registry = () => createJsltRegistry().use(mathPack).use(financePack);
const mem = (doc) => compileJsonQuery(doc, registry().toOptions())(DATA);

async function freshStore(extra = {}) {
  const store = await openStore(MODEL, { driver: nodeDriver(), operators: registry(), ...extra });
  const coll = store.collection('pts');
  for (const row of DATA) await coll.insert(row);
  return { store, coll };
}

describe('Ring 3 — the per-driver capability matrix', () => {
  it('node reports scalar AND aggregate UDF support; pushableOperators is the scalar subset', async () => {
    const { store } = await freshStore();
    assert.strictEqual(store.capabilities.userFunctions, true, 'node has scalar UDFs');
    assert.strictEqual(store.capabilities.aggregateFunctions, true, 'node has aggregate UDFs');
    assert.ok(store.capabilities.pushableOperators.includes('$sqrt'), 'a scalar op is pushable');
    assert.ok(!store.capabilities.pushableOperators.includes('$npv'),
      'a whole-series op is NOT pushable (pushable:false)');
    await store.close();
  });

  it('without a registry, nothing is pushable', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    assert.deepStrictEqual(store.capabilities.pushableOperators, []);
    await store.close();
  });
});

describe('Ring 3 — scalar pushdown (driver-aware differential)', () => {
  it('$sqrt in a WHERE pushes to a UDF where supported, the residual elsewhere — same answer', async () => {
    const { store, coll } = await freshStore();
    const doc = { $for: { it: '$[*]' }, $where: { $gt: [{ $sqrt: '$it.x' }, 2] }, $return: '$it' };
    const got = await coll.execute(doc);
    assert.deepStrictEqual(got, mem(doc), 'correct regardless of push vs residual');

    const ex = await coll.explain(doc);
    if (store.capabilities.userFunctions) {
      assert.strictEqual(ex.residual, null, 'a bare-return pushed query is native');
      assert.ok(ex.udfs.length >= 1, 'a deterministic UDF was registered');
      assert.match(ex.sql, /jaren_p_/, 'the UDF call is in the SQL (runs inside SQLite)');
      assert.ok(store.stats().udfRegistrations >= 1);
    }
    else {
      assert.notStrictEqual(ex.residual, null, 'bun: the operator is the residual');
      assert.strictEqual(ex.udfs.length, 0, 'bun: no UDF');
    }
    await store.close();
  });

  it('pushed answer == forced-residual answer == in-memory (the differential)', async () => {
    const { store, coll } = await freshStore();
    const doc = { $for: { it: '$[*]' }, $where: { $gt: [{ $sqrt: '$it.x' }, 2] }, $return: '$it.id' };
    const pushed = await coll.execute(doc);
    const residual = await coll.execute(doc, { pushdown: false });
    assert.deepStrictEqual(pushed, residual, 'push and forced-residual agree');
    assert.deepStrictEqual(residual, mem(doc), 'and both equal the in-memory engine');
    await store.close();
  });

  it('a native predicate AND a pushed predicate both narrow at SQL, still correct', async () => {
    const { store, coll } = await freshStore();
    const doc = {
      $for: { it: '$[*]' },
      $where: { $and: [{ $eq: ['$it.active', true] }, { $gt: [{ $sqrt: '$it.x' }, 2] }] },
      $return: '$it.id',
    };
    assert.deepStrictEqual(await coll.execute(doc), mem(doc));
    if (store.capabilities.userFunctions) {
      const ex = await coll.explain(doc);
      assert.match(ex.sql, /jaren_p_/, 'the UDF conjunct is in the WHERE beside the native one');
    }
    await store.close();
  });

  it('a binary scalar op ($pow) pushes and is correct', async () => {
    const { store, coll } = await freshStore();
    const doc = { $for: { it: '$[*]' }, $where: { $lt: [{ $pow: ['$it.x', 0.5] }, 3] }, $return: '$it.id' };
    assert.deepStrictEqual(await coll.execute(doc), mem(doc));
    await store.close();
  });
});

describe('Ring 3 — explain honesty (pushed ≠ residual)', () => {
  it('a pushed operator is NOT named as a residual reason; a projection operator IS', async () => {
    const { store, coll } = await freshStore();
    if (!store.capabilities.userFunctions) { await store.close(); return; }

    // $sqrt only in the (pushed) WHERE, a projected return → row mode: the
    // $sqrt does NOT run in the residual, so it must not be named there
    const whereDoc = { $for: { it: '$[*]' }, $where: { $gt: [{ $sqrt: '$it.x' }, 2] }, $return: '$it.id' };
    const e1 = await coll.explain(whereDoc);
    assert.ok(!e1.residual.reasons.some((r) => r.construct === '$sqrt'),
      'a pushed $sqrt is not named as a residual reason');
    assert.ok(e1.udfs.length >= 1, 'it is in the UDF list instead');

    // $sqrt in the projection → it DOES run in the row residual, named
    const projDoc = { $for: { it: '$[*]' }, $return: { r: { $sqrt: '$it.x' } } };
    const e2 = await coll.explain(projDoc);
    assert.ok(e2.residual.reasons.some((r) => r.construct === '$sqrt'),
      'a projection $sqrt runs in the residual and is named');
    assert.strictEqual(e2.udfs.length, 0, 'a projection is never a UDF');
    assert.deepStrictEqual(await coll.execute(projDoc), mem(projDoc));
    await store.close();
  });
});

describe('Ring 3 — the honest ceiling and profile safety', () => {
  it('a pushable:false operator ($npv) never becomes a UDF — stays the residual', async () => {
    const { store, coll } = await freshStore();
    const doc = {
      $for: { it: '$[*]' },
      $where: { $gt: [{ $npv: [0.1, '$it.cashflows[*]'] }, 0] },
      $return: '$it.id',
    };
    const ex = await coll.explain(doc);
    assert.strictEqual(ex.udfs.length, 0, '$npv is pushable:false — never pushed');
    assert.notStrictEqual(ex.residual, null, 'it is the residual');
    assert.deepStrictEqual(await coll.execute(doc), mem(doc));
    await store.close();
  });

  it('the safe profile prevents host-side UDF registration for a scalar operator', async () => {
    const { store, coll } = await freshStore({ profile: 'safe' });
    const doc = { $for: { it: '$[*]' }, $where: { $gt: [{ $sqrt: '$it.x' }, 2] }, $return: '$it.id' };
    const ex = await coll.explain(doc);
    assert.strictEqual(ex.udfs.length, 0, 'no UDF registered for an untrusted document');
    assert.strictEqual(store.stats().udfRegistrations, 0);
    // still correct — via the residual (Ring 2)
    assert.deepStrictEqual(await coll.execute(doc), mem(doc));
    await store.close();
  });

  it('forced-residual mode (pushdown:false) registers no UDF either', async () => {
    const { store, coll } = await freshStore();
    const doc = { $for: { it: '$[*]' }, $where: { $gt: [{ $sqrt: '$it.x' }, 2] }, $return: '$it.id' };
    await coll.execute(doc, { pushdown: false });
    assert.strictEqual(store.stats().udfRegistrations, 0, 'pushdown:false pushes nothing');
    await store.close();
  });
});
