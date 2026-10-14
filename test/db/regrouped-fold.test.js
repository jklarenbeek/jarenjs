//@ts-check
/**
 * @file A disjunction regroups by member (MODEL-FORMAT §10.1): inside one
 * `$or` — nested `$or`s flattened first — the equalities of one member
 * against string and number literals become ONE bound list, and the rays
 * of one member, one JSON type and one direction become ONE bound: the
 * least lower or the greatest upper by the engine's own order (numbers
 * by value, strings by code point), the inclusive operator winning a
 * tie. Every other item keeps its place, and an item the planner refuses
 * refuses the whole `$or`. The oracle is the engine (`pushdown: false`)
 * over a corpus of mixed-type documents, on SQLite and, under
 * `JAREN_PG_URL`, on PostgreSQL.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { liveOracle } from './oracle/replication.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' },
        t: { type: 'string' }, m: { type: 'number' }, b: { type: 'boolean' } } },
      key: '/id', indexes: [{ name: 's', path: '$.s' }, { name: 'n', path: '$.n' }],
    },
  },
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key },
      s: { type: 'string', 'x-entity': { index: true } }, n: { type: 'number', 'x-entity': { index: true } },
      t: { type: 'string' }, m: { type: 'number' }, b: { type: 'boolean' },
      at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer', index: true } } } } },
  },
};
/** The instant an entity row's `at` column holds: one hour apart, written as the engine decodes them. */
const instant = (/** @type {number} */ i) => new Date(Date.UTC(2024, 0, 1) + i * 3_600_000).toISOString();
/** Strings of one, two and three UTF-16 code units: code-unit and code-point orders differ. */
const STRINGS = ['', 'a', 'A', 'b', 'z', 'aa', 'ab', 'é', 'ß', '中', '😀', '\u{10000}', '￿'];
const NUMBERS = [-2.5, -1, 0, 0.5, 1, 2, 3, 7, 10, 1e6];
const MIXED = ['x', 5, null, true, false, { k: 1 }, [1, 'x'], undefined];
const MEMBERS = ['s', 'n', 't', 'm', 'u', 'zz'];
const RAYS = ['$lt', '$le', '$gt', '$ge'];
const ROWS = 80;
const CHAINS = 300;
/** Rows the explicit cases name: the astral row sorts above U+FFFF by code point, below it by code unit. */
const FIXED = [{ id: 'astral', s: '\u{10000}' }, { id: 'top', s: '￿' }, { id: 'emoji', s: '😀' }, { id: 'low', s: 'a' }];

/** mulberry32: one seed, one chain, so a failing chain is named by its number. */
const seeded = (/** @type {number} */ seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** @param {() => number} random @param {any[]} list */
const pick = (random, list) => list[Math.floor(random() * list.length)];

/**
 * One member's stored value: its own type mostly, else absent, null or —
 * for an unindexed collection member, which nothing validates or types
 * here — the other scalar type (SQLite's generated column of an indexed
 * member refuses a value of another type at the write).
 * @param {() => number} random @param {'string' | 'number'} type @param {boolean} typed
 */
const cell = (random, type, typed) => {
  const roll = random();
  if (roll < 0.1) return undefined;
  if (roll < 0.2) return null;
  if (roll < 0.3 && !typed) return type === 'string' ? pick(random, NUMBERS) : pick(random, STRINGS);
  return type === 'string' ? pick(random, STRINGS) : pick(random, NUMBERS);
};
/** @param {number} i @param {boolean} typed - an entity row keeps its typed columns typed */
const document = (i, typed) => {
  const random = seeded(1000 + i);
  /** @type {Record<string, any>} */
  const doc = { id: `d${i}`, s: cell(random, 'string', true), n: cell(random, 'number', true),
    t: cell(random, 'string', typed), m: cell(random, 'number', typed),
    b: random() < 0.5 ? random() < 0.5 : undefined, u: pick(random, MIXED) };
  if (typed && i % 3 !== 0) doc.at = instant(i);
  for (const name of Object.keys(doc)) if (doc[name] === undefined) delete doc[name];
  return doc;
};
/** @param {any} store */
async function seed(store) {
  await store.transaction(async (/** @type {any} */ tx) => {
    for (const doc of FIXED) {
      await tx.collection('items').put(doc);
      await tx.entity('Item').create(doc);
    }
    for (let i = 0; i < ROWS; i++) {
      await tx.collection('items').put(document(i, false));
      await tx.entity('Item').create(document(i, true));
    }
  });
}

/**
 * One item of a chain: mostly an equality or a ray against a literal on
 * either side, over any member (one absent everywhere, one untyped), of
 * either scalar type; else a null, a boolean, a `$ne` or a list.
 * @param {() => number} random @param {string} it
 */
const term = (random, it) => {
  const member = `${it}.${pick(random, MEMBERS)}`;
  const literal = pick(random, random() < 0.5 ? STRINGS : NUMBERS);
  const roll = random();
  const around = (/** @type {string} */ op) => (random() < 0.5 ? { [op]: [member, literal] } : { [op]: [literal, member] });
  if (roll < 0.4) return around('$eq');
  if (roll < 0.8) return around(pick(random, RAYS));
  if (roll < 0.85) return { $eq: [member, null] };
  if (roll < 0.9) return { $eq: [member, random() < 0.5] };
  if (roll < 0.95) return { $ne: [member, literal] };
  return { $eq: [member, { $seq: [pick(random, STRINGS), pick(random, NUMBERS)] }] };
};
/**
 * A chain of 2-60 terms: flat, nested one level per term as a client that
 * does not flatten builds it, or carrying an `$and` pair nothing regroups.
 * @param {() => number} random @param {string} it
 */
const chain = (random, it) => {
  const items = Array.from({ length: 2 + Math.floor(random() * 59) }, () => term(random, it));
  const roll = random();
  if (roll < 0.3) {
    let nested = items[0];
    for (let i = 1; i < items.length; i++) nested = random() < 0.5 ? { $or: [nested, items[i]] } : { $or: [items[i], nested] };
    return nested;
  }
  if (roll < 0.5) items.splice(Math.floor(random() * items.length), 0, { $and: [term(random, it), term(random, it)] });
  return { $or: items };
};
/** @param {any} predicate */
const overItems = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} predicate */
const overItem = (predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} value */
const sorted = (value) => [...(Array.isArray(value) ? value : value === undefined ? [] : [value])].sort();

/**
 * The cases, once per engine.
 * @param {{ store: () => any, placeholders: (sql: string) => number, instantSeek?: RegExp }} engine
 */
function cases(engine) {
  const items = () => engine.store().collection('items');

  it(`${CHAINS} random chains of 2-60 terms answer as the engine does, natively, over the collection and the entity`, { timeout: 120_000 }, async () => {
    for (let number = 1; number <= CHAINS; number++) {
      const predicate = chain(seeded(number), '$it');
      const label = `chain ${number}: ${JSON.stringify(predicate).slice(0, 200)}`;
      const engineRows = sorted(await items().execute(overItems(predicate), { pushdown: false }));
      assert.deepEqual(sorted(await items().execute(overItems(predicate))), engineRows, label);
      assert.equal((await items().explain(overItems(predicate))).mode, 'native', label);
      const store = engine.store();
      const engineItems = sorted(await store.execute(overItem(predicate), { pushdown: false }));
      assert.deepEqual(sorted(await store.execute(overItem(predicate))), engineItems, label);
      assert.equal((await store.explain(overItem(predicate))).mode, 'native', label);
      assert.deepEqual(sorted((await store.entity('Item').load({ where: predicate })).map((/** @type {any} */ row) => row.id)),
        engineItems, label);
    }
  });

  it('two lower rays on a string fold to the least bound by code point, which keeps the astral rows', async () => {
    const predicate = { $or: [{ $gt: ['$it.s', '￿'] }, { $gt: ['$it.s', '\u{10000}'] }] };
    const one = { $gt: ['$it.s', '￿'] };
    const expected = sorted(await items().execute(overItems(predicate), { pushdown: false }));
    assert.ok(expected.includes('astral') && expected.includes('emoji') && !expected.includes('top'));
    assert.deepEqual(sorted(await items().execute(overItems(predicate))), expected);
    const plan = await items().explain(overItems(predicate));
    assert.equal(plan.mode, 'native');
    assert.deepEqual(plan.params, [{ literal: '￿' }]);
    assert.equal(plan.sql, (await items().explain(overItems(one))).sql);
    const store = engine.store();
    assert.deepEqual(sorted(await store.execute(overItem(predicate))), expected);
    const entityPlan = await store.explain(overItem(predicate));
    assert.equal(entityPlan.sql, (await store.explain(overItem(one))).sql);
    assert.equal(engine.placeholders(entityPlan.sql), 1);
  });

  it('an item the planner refuses refuses the whole disjunction: the engine answers it, its error included', async () => {
    const predicate = { $or: [{ $eq: ['$it.s', 'a'] }, { $eq: ['$it.s', 'b'] }, { $gt: [{ $add: ['$it.s', 1] }, 5] }] };
    for (const [target, query] of [[items(), overItems(predicate)], [engine.store(), overItem(predicate)]]) {
      const plan = await target.explain(query);
      if (plan.mode === 'native') {
        // the deterministic-function hatch: the whole `$or` is ONE function
        // in the statement, with no list of the equalities beside it
        assert.equal(plan.udfs.length, 1);
        assert.doesNotMatch(plan.sql, /json_each|jsonb_array_elements/);
      }
      else {
        assert.equal(reasonId((plan.reasons ?? plan.residual.reasons)[0].reason), 'predicate.operands');
      }
      await assert.rejects(async () => target.execute(query), { code: 'JQ2001' });
      await assert.rejects(async () => target.execute(query, { pushdown: false }), { code: 'JQ2001' });
    }
  });

  /**
   * One predicate on every path, against the engine: the collection and
   * the entity natively, and the entity's `load({ where })`.
   * @param {any} predicate @param {string} label
   */
  const agrees = async (predicate, label) => {
    const store = engine.store();
    const expected = sorted(await items().execute(overItems(predicate), { pushdown: false }));
    assert.deepEqual(sorted(await items().execute(overItems(predicate))), expected, label);
    assert.equal((await items().explain(overItems(predicate))).mode, 'native', label);
    const rows = sorted(await store.execute(overItem(predicate), { pushdown: false }));
    assert.deepEqual(sorted(await store.execute(overItem(predicate))), rows, label);
    assert.equal((await store.explain(overItem(predicate))).mode, 'native', label);
    assert.deepEqual(sorted((await store.entity('Item').load({ where: predicate })).map((/** @type {any} */ row) => row.id)), rows, label);
    return expected;
  };

  it('an infinity never becomes a bound, and NaN binds nothing: the other items keep their place', async () => {
    const n = (/** @type {string} */ op, /** @type {number} */ value) => ({ [op]: ['$it.n', value] });
    for (const [label, predicate, placeholders] of /** @type {[string, any, number][]} */ ([
      ['NaN first', { $or: [n('$gt', NaN), n('$gt', 5)] }, 1],
      ['NaN second', { $or: [n('$gt', 5), n('$gt', NaN)] }, 1],
      ['NaN inclusive first', { $or: [n('$ge', NaN), n('$gt', 5)] }, 1],
      ['NaN inclusive second', { $or: [n('$gt', 5), n('$ge', NaN)] }, 1],
      ['NaN equality', { $or: [n('$eq', NaN), n('$eq', 7)] }, 1],
      ['Infinity upper', { $or: [n('$lt', Infinity), n('$lt', 5)] }, 2],
      ['-Infinity lower', { $or: [n('$gt', -Infinity), n('$gt', 5)] }, 2],
      ['Infinity equality', { $or: [n('$eq', Infinity), n('$eq', 7)] }, 2],
      ['-0 equality', { $or: [n('$eq', -0), n('$eq', 7)] }, 1],
      ['-0 ray', { $or: [n('$gt', -0), n('$gt', 0)] }, 1],
    ])) {
      const expected = await agrees(predicate, label);
      assert.ok(expected.length > 0, label);
      assert.equal((await items().explain(overItems(predicate))).params.length, placeholders, label);
    }
  });

  it('a NaN literal binds nothing: every comparison, negation and disjunction with it equals the engine on every path', async () => {
    // NaN equals nothing and orders against nothing, and differs from every
    // present member; neither engine binds it so (SQLite stores NULL, which a
    // negation turns into an unanswered row; PostgreSQL sorts it above every number)
    for (const member of ['s', 'n', 't', 'm', 'b']) {
      for (const op of ['$eq', '$ne', '$lt', '$le', '$gt', '$ge']) {
        const base = { [op]: [`$it.${member}`, NaN] };
        const flipped = { [op]: [NaN, `$it.${member}`] };
        const beside = { $or: [base, { $gt: [`$it.${member}`, 5] }] };
        for (const [label, predicate] of /** @type {[string, any][]} */ ([
          ['plain', base], ['flipped', flipped], ['negated', { $not: base }], ['beside a ray', beside],
          ['negated beside a ray', { $not: beside }], ['conjoined', { $and: [base, { $lt: [`$it.${member}`, 100] }] }],
        ])) {
          const expected = await agrees(predicate, `${op} ${member} ${label}`);
          if (label === 'negated' && op !== '$ne') assert.ok(expected.length >= ROWS, `${op} ${member}: every row`);
        }
      }
    }
    // a differing NaN is the existence test, and the statement carries no value for it
    assert.deepEqual(await agrees({ $ne: ['$it.n', NaN] }, 'ne'), await agrees({ $exists: '$it.n' }, 'exists'));
    assert.deepEqual((await items().explain(overItems({ $gt: ['$it.n', NaN] }))).params, []);
    assert.deepEqual((await items().explain(overItems({ $ne: ['$it.n', NaN] }))).params, []);
  });

  it('a lone surrogate beside other terms keeps the disjunction in the engine: a driver binds it as U+FFFD', async () => {
    const predicate = { $or: [{ $eq: ['$it.s', '\ud800'] }, { $eq: ['$it.s', 'b'] }, { $gt: ['$it.n', 8] }] };
    const store = engine.store();
    const expected = sorted(await items().execute(overItems(predicate), { pushdown: false }));
    assert.ok(expected.length > 0);
    assert.deepEqual(sorted(await items().execute(overItems(predicate))), expected);
    const rows = sorted(await store.execute(overItem(predicate), { pushdown: false }));
    assert.deepEqual(sorted(await store.execute(overItem(predicate))), rows);
    for (const plan of [await items().explain(overItems(predicate)), await store.explain(overItem(predicate))]) {
      if (plan.mode === 'native') {
        // the deterministic-function hatch: the whole `$or` is one function, which reads the literal as written
        assert.equal(plan.udfs.length, 1);
        assert.ok(!plan.params.some((/** @type {any} */ param) => param.literal === '\ud800'));
      }
      else assert.equal(reasonId((plan.reasons ?? plan.residual.reasons)[0].reason), 'predicate.loneSurrogate');
    }
  });

  it('instant equalities keep their epoch narrowing beside other terms: no list, the column\'s index seeks', async () => {
    const store = engine.store();
    for (const [label, predicate] of /** @type {[string, any][]} */ ([
      ['beside a ray', { $or: [{ $eq: ['$it.at', instant(1)] }, { $eq: ['$it.at', instant(2)] }, { $gt: ['$it.n', 8] }] }],
      ['alone', { $or: [{ $eq: ['$it.at', instant(1)] }, { $eq: ['$it.at', instant(2)] }] }],
    ])) {
      const rows = sorted(await store.execute(overItem(predicate), { pushdown: false }));
      assert.ok(rows.includes('d1') && rows.includes('d2'), label);
      assert.deepEqual(sorted(await store.execute(overItem(predicate))), rows, label);
      assert.deepEqual(sorted((await store.entity('Item').load({ where: predicate })).map((/** @type {any} */ row) => row.id)), rows, label);
      const plan = await store.explain(overItem(predicate));
      assert.equal(plan.mode, 'native', label);
      assert.doesNotMatch(plan.sql, /json_each|jsonb_array_elements/, label);
      assert.equal((plan.sql.match(/"at" >= /g) ?? []).length, 2, `${label}: one epoch range per instant`);
      // SQLite seeks the all-instant shape through its index; beside a ray
      // on another column it prices a scan, exactly as it did unregrouped
      if (engine.instantSeek !== undefined && label === 'alone') assert.match(plan.scanNarrative, engine.instantSeek, label);
    }
  });
}

describe('a disjunction regrouped by member (SQLite)', () => {
  /** @type {any} */
  let store;
  before(async () => {
    store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    await seed(store);
  });
  after(async () => { await store?.close(); });
  cases({ store: () => store, placeholders: (sql) => (sql.match(/\?/g) ?? []).length,
    instantSeek: /SEARCH t0 USING INDEX Item_at/ });

  it('a live registration over a regrouped filter is maintained across writes', async () => {
    const liveStore = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:', capture: true });
    try {
      await seed(liveStore);
      const rows = liveStore.collection('items');
      const document = overItems({ $or: [{ $eq: ['$it.s', 'a'] }, { $eq: ['$it.s', 'b'] }, { $gt: ['$it.n', 5] }, { $gt: ['$it.n', 1] }] });
      const live = await rows.live(document, { mode: 'auto' });
      try {
        assert.equal(live.mode.strategy, 'rows');
        const oracle = liveOracle(live, () => rows.execute([document]));
        await oracle.check();
        await rows.put({ id: 'w1', s: 'b', n: 0 });
        await oracle.check();
        await rows.put({ id: 'low', s: 'q', n: 2 });
        await oracle.check();
        await rows.put({ id: 'w1', s: 'q', n: 0 });
        await oracle.check();
        assert.ok(oracle.emissions >= 2, `${oracle.emissions} emissions`);
        oracle.close();
      }
      finally { live.close(); }
    }
    finally { await liveStore.close(); }
  });
});

describe('a disjunction regrouped by member (PostgreSQL)', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_regroup_${process.pid}`;

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await seed(store);
  });
  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  cases({ store: () => store, placeholders: (sql) => new Set(sql.match(/\$\d+/g) ?? []).size });
});
