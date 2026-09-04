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
import { DatabaseSync } from 'node:sqlite';

import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

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
    // a pushed $sqrt and one projected member path: nothing runs in the
    // residual at all, so no reason names the $sqrt
    assert.strictEqual(e1.residual, null, 'a pushed $sqrt is not named as a residual reason');
    assert.strictEqual(e1.mode, 'native');
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

// ————— Ring 3 for AGGREGATES —————

/**
 * A node:sqlite driver whose aggregate primitive is the caller's: a
 * counting wrapper, or `null` for a handle that has none at all — which
 * `adaptNodeDatabase` then reports as `aggregateFunctions: false`
 * rather than declaring a capability the handle cannot honour.
 * @param {((name: string, spec: any, db: any) => any) | null} aggregate
 */
function nodeAggregateDriver(aggregate) {
  const db = new DatabaseSync(':memory:');
  const handle = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    function: (name, options, fn) => db.function(name, options, fn),
    createSession: (options) => (options === undefined
      ? db.createSession() : db.createSession(options)),
    close: () => db.close(),
  };
  if (aggregate !== null) handle.aggregate = (name, spec) => aggregate(name, spec, db);
  return { open: (options) => adaptNodeDatabase(handle, { queueTimeout: options?.queueTimeout }) };
}

describe('a registered aggregate lowers to a SQL aggregate, or stays where it is', () => {
  const AGG_MODEL = {
    $model: '0.1',
    collections: {
      rows: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            n: { type: 'number' },
            maybe: { type: ['number', 'null'] },
            label: { type: 'string' },
          },
        },
        key: '/id',
        indexes: [{ name: 'by_n', path: '$.n' }],
      },
    },
  };
  const AGG_DATA = [
    { id: 'r1', n: 2, label: 'a' },
    { id: 'r2', n: 4, label: 'b' },
    { id: 'r3', n: 9, label: 'c' },
    { id: 'r4', n: 9, label: 'd' },
  ];
  const stats = () => createJsltRegistry().use(statsPack);
  const OPERATORS = ['$mean', '$median', '$variance', '$stddev'];

  const openAgg = async (rows = AGG_DATA, extra = {}, side = 'indexed') => {
    const model = side === 'unindexed'
      ? { ...AGG_MODEL, collections: { rows: { ...AGG_MODEL.collections.rows, indexes: [] } } }
      : AGG_MODEL;
    const store = await openStore(model,
      { driver: nodeDriver(), operators: stats(), ...extra });
    const coll = store.collection('rows');
    for (const row of rows) await coll.insert(row);
    return { store, coll, rows };
  };
  const resident = (document, rows) =>
    compileJsonQuery(document, stats().toOptions())(structuredClone(rows));

  it('every declared aggregate matches the engine at many, duplicate, one and zero rows, indexed and not', async () => {
    // a row whose member is ABSENT contributes no item to the engine's
    // sequence and a NULL the SQL fold skips: the same multiset
    const ABSENT = [...AGG_DATA, { id: 'r5', label: 'e' }];
    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      for (const rows of [AGG_DATA, ABSENT, [AGG_DATA[2], AGG_DATA[3]], [AGG_DATA[0]], []]) {
        const { store, coll } = await openAgg(rows, {}, side);
        for (const operator of OPERATORS) {
          const document = { [operator]: { $for: { it: '$[*]' }, $return: '$it.n' } };
          const explained = await Promise.resolve(coll.explain(document));
          assert.strictEqual(explained.mode, 'native',
            `${operator} over ${rows.length} row(s), ${side}: ${JSON.stringify(explained.residual)}`);
          assert.match(explained.sql, side === 'indexed'
            ? /^SELECT jaren_a_[a-z0-9]+\("gx_n"\) AS "value" FROM "rows"$/
            : /^SELECT jaren_a_[a-z0-9]+\(jsonb_extract\("doc", '\$\."n"'\)\) AS "value" FROM "rows"$/,
          `${operator}, ${side}`);
          assert.deepStrictEqual(
            await Promise.resolve(coll.execute(document)),
            resident(document, rows),
            `${operator} over ${rows.length} row(s), ${side}`);
        }
        await store.close();
      }
    }
  });

  it('a grouping folds in the engine, and answers what the engine answers', async () => {
    const { store, coll } = await openAgg();
    const document = {
      $for: { it: '$[*]' },
      $groupby: { g: '$it.n' },
      $orderby: ['$g'],
      $return: { g: '$g', m: { $mean: '$it.n' } },
    };
    const explained = await Promise.resolve(coll.explain(document));
    assert.strictEqual(explained.mode, 'set', 'a grouping is not the closed bucket shape');
    assert.doesNotMatch(explained.sql, /jaren_a_/, 'no aggregate is registered for a grouped fold');
    assert.deepStrictEqual(await Promise.resolve(coll.execute(document)),
      resident(document, AGG_DATA));
    await store.close();
  });

  it('a narrowed selection folds only the rows it kept, and an empty selection folds none', async () => {
    const { store, coll } = await openAgg();
    for (const bound of [3, 100]) {
      const document = { $mean: {
        $for: { it: '$[*]' }, $where: { $gt: ['$it.n', bound] }, $return: '$it.n' } };
      const explained = await Promise.resolve(coll.explain(document));
      assert.strictEqual(explained.mode, 'native');
      assert.match(explained.sql, /WHERE/);
      assert.deepStrictEqual(await Promise.resolve(coll.execute(document)),
        resident(document, AGG_DATA));
    }
    await store.close();
  });

  it('one registration per store, whatever the run count', async () => {
    let registrations = 0;
    const { store, coll } = await openAgg(AGG_DATA, {
      driver: nodeAggregateDriver((name, spec, db) => {
        registrations++;
        return db.aggregate(name, spec);
      }) });
    const document = { $mean: { $for: { it: '$[*]' }, $return: '$it.n' } };
    for (let i = 0; i < 4; i++) await Promise.resolve(coll.execute(document));
    await Promise.resolve(coll.execute({ $median: { $for: { it: '$[*]' }, $return: '$it.n' } }));
    assert.strictEqual(registrations, 2, 'one per operator, not one per run');
    await store.close();
  });

  it('a non-numeric or null-admitting path, and a scalar of the same name, stay in the engine', async () => {
    const { store, coll } = await openAgg();
    // a string member: the engine ERRORS, so the plan must not answer
    const overString = { $mean: { $for: { it: '$[*]' }, $return: '$it.label' } };
    const explainedString = await Promise.resolve(coll.explain(overString));
    assert.strictEqual(explainedString.mode, 'set');
    // the registry names itself first (Ring 2), the planner's own cause
    // follows — both are reported, neither replaces the other
    assert.match(explainedString.residual.reasons.map((r) => r.reason).join(' | '),
      /singular schema-typed path/);
    // a member the schema lets hold null: SQL cannot tell a stored null
    // from an absent member, and the engine's sequence can
    const overNullable = { $mean: { $for: { it: '$[*]' }, $return: '$it.maybe' } };
    assert.strictEqual((await Promise.resolve(coll.explain(overNullable))).mode, 'set');
    // a SCALAR operator of the same name is not interchangeable with the
    // aggregate: a registry whose `$mean` is a scalar op never becomes a
    // SQL aggregate
    const scalarMean = {
      name: 'shadow',
      entries: { $mean: { kind: 'op', signature: ['number'], result: 'number',
        fn: (value) => value, pushable: 'scalar' } },
    };
    const shadowed = await openStore(AGG_MODEL,
      { driver: nodeDriver(), operators: createJsltRegistry().use(scalarMean) });
    for (const row of AGG_DATA) await shadowed.collection('rows').insert(row);
    const asScalar = { $for: { it: '$[*]' }, $return: { m: { $mean: '$it.n' } } };
    const explainedScalar = await Promise.resolve(shadowed.collection('rows').explain(asScalar));
    assert.strictEqual(explainedScalar.mode, 'row', 'a scalar operator projects per row');
    assert.doesNotMatch(explainedScalar.sql, /jaren_a_/, 'no aggregate was registered for it');
    await shadowed.close();
    await store.close();
  });

  it('a driver without an aggregate API keeps the same answer in the residual', async () => {
    const store = await openStore(AGG_MODEL,
      { driver: nodeAggregateDriver(null), operators: stats() });
    assert.strictEqual(store.capabilities.aggregateFunctions, false);
    const coll = store.collection('rows');
    for (const row of AGG_DATA) await coll.insert(row);
    const document = { $mean: { $for: { it: '$[*]' }, $return: '$it.n' } };
    const explained = await Promise.resolve(coll.explain(document));
    assert.strictEqual(explained.mode, 'set', 'no aggregate API: the engine folds');
    assert.deepStrictEqual(await Promise.resolve(coll.execute(document)),
      resident(document, AGG_DATA), 'and answers the same value');
    assert.throws(() => coll.query(document, { strict: true }), (error) =>
      /** @type {any} */ (error).code === 'JD0010');
    await store.close();
  });

  it('a profile forbids the registration, so the same document folds in the engine', async () => {
    const { store, coll } = await openAgg();
    const document = { $mean: { $for: { it: '$[*]' }, $return: '$it.n' } };
    const profile = { maxRows: 100 };
    const explained = await Promise.resolve(coll.explain(document, { profile }));
    assert.strictEqual(explained.mode, 'set',
      'a foreign document must not cause a host-side registration');
    assert.deepStrictEqual(await Promise.resolve(coll.execute(document, { profile })),
      resident(document, AGG_DATA));
    await assert.rejects(async () => coll.execute(document, { profile, strict: true }),
      (error) => /** @type {any} */ (error).code === 'JD0010');
    // and without the profile the same store still promotes it
    assert.strictEqual((await Promise.resolve(coll.explain(document))).mode, 'native');
    await store.close();
  });

  it('a pack that declares the wrong shape pushable is refused at open, by name', async () => {
    for (const entry of [
      { kind: 'agg', signature: ['seq<number>', 'number'], result: 'number', fn: () => 1, pushable: 'aggregate' },
      { kind: 'op', signature: ['number'], result: 'number', fn: () => 1, pushable: 'aggregate' },
      { kind: 'agg', signature: ['seq<number>'], result: 'seq<number>', fn: () => [1], pushable: 'aggregate' },
    ]) {
      assert.throws(() => openStore(AGG_MODEL, { driver: nodeDriver(),
        operators: createJsltRegistry().use({ name: 'bad', entries: { $bad: entry } }) }),
      (error) => error instanceof TypeError && /'\$bad' declares pushable: 'aggregate'/.test(error.message),
      JSON.stringify(entry.signature));
    }
  });
});
