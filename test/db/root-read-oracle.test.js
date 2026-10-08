//@ts-check
/**
 * @file A collection query that reads the collection root outside its
 * binding — `$`, `$.…`, `$[…]`, a nested query over `$[*]`, a variable
 * bound to the root, the root named inside a path filter — is answered
 * over the WHOLE collection, as the engine answers it: the row residual
 * evaluates one row as the collection, and a pushed conjunct, the
 * deterministic-function hatch or a window hands the engine fewer rows
 * than the root holds. Checked against `queryJson` as the oracle, by name
 * and by a seeded randomized differential, on node:sqlite, a
 * bun:sqlite-shaped binding (no registered functions) and PostgreSQL,
 * with and without a profile predicate (whose rows ARE the root). A
 * query that reads no root keeps its plan. A live registration that
 * evaluates one row at a time — rows, window, event-time buckets —
 * re-runs such a document, the reason named, and answers as the engine.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { queryJson } from '@jarenjs/json/query';
import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { adaptBunDatabase } from '@jarenjs/db/bun';

import { BunShapedDatabase } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, n: { type: 'integer' }, t: { type: 'string' },
      xs: { type: 'array', items: { type: 'integer' } } } } },
  },
};
const DATA = [
  { id: 'r1', n: 1, t: 'a', xs: [1, 5] }, { id: 'r2', n: 2, t: 'a', xs: [5] },
  { id: 'r3', n: 3, t: 'b', xs: [] }, { id: 'r4', n: 9, t: 'a', xs: [9, 1] },
  { id: 'r5', n: 2, t: 'b', xs: [2, 2] },
];
/** The profile's rows are the root a profiled query reads. */
const HIDE_R3 = { predicates: { rows: { $ne: ['$it.id', 'r3'] } } };
const visible = (profile) => profile === undefined ? DATA : DATA.filter((row) => row.id !== 'r3');

const ROOT_READ = { construct: '$',
  reason: 'the document reads the collection root outside its binding, so the engine answers it over the whole collection' };

/** One document per way a part can read the root, each beside a part the planner would otherwise narrow. */
const CASES = {
  'a count of the collection in a projection':
    [{ $for: { r: '$[*]' }, $return: { id: '$r.id', total: { $count: '$[*]' } } }],
  'the first row of the collection': [{ $for: { r: '$[*]' }, $return: { id: '$r.id', first: '$[0].id' } }],
  'a maximum over the collection under a pushed where':
    [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.n', 1] }, $return: { id: '$r.id', max: { $max: '$[*].n' } } }],
  'the same, ordered': [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.n', 1] }, $orderby: ['$r.n', '$r.id'],
    $return: { id: '$r.id', max: { $max: '$[*].n' } } }],
  'the same, in a window': [{ $subsequence: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.n', 1] },
    $orderby: ['$r.n', '$r.id'], $return: { id: '$r.id', max: { $max: '$[*].n' } } }, 1, 2] }],
  'a filter comparing with a count of the collection':
    [{ $for: { r: '$[*]' }, $where: { $lt: ['$r.n', { $count: '$[*]' }] }, $return: '$r.id' }],
  'the same beside a pushed conjunct': [{ $for: { r: '$[*]' },
    $where: { $and: [{ $eq: ['$r.t', 'a'] }, { $lt: ['$r.n', { $count: '$[*]' }] }] }, $return: '$r.id' }],
  'a nested query over the collection': [{ $for: { r: '$[*]' }, $where: { $eq: ['$r.t', 'a'] },
    $return: { id: '$r.id', peers: [{ $for: { o: '$[*]' }, $where: { $ne: ['$o.id', '$r.id'] }, $return: '$o.id' }] } }],
  'the root named inside a path filter': [{ $for: { r: '$[*]' }, $where: { $eq: ['$r.t', 'a'] },
    $return: { id: '$r.id', f: { $count: '$r.xs[?@ == $[1].xs[0]]' } } }],
  'the root itself': [{ $for: { r: '$[*]' }, $where: { $eq: ['$r.t', 'b'] }, $return: { id: '$r.id', all: '$' } }],
  'a variable bound to the root': [{ $for: { r: '$[*]' }, $let: { all: '$' }, $where: { $eq: ['$r.t', 'a'] },
    $return: { id: '$r.id', c: { $count: '$all[*]' } } }],
  'an aggregate whose filter reads the collection':
    [{ $count: { $for: { r: '$[*]' }, $where: { $lt: ['$r.n', { $count: '$[*]' }] }, $return: '$r' } }],
  'a distinct projection whose filter reads the collection':
    [{ $distinct: { $for: { r: '$[*]' }, $where: { $lt: ['$r.n', { $count: '$[*]' }] }, $return: '$r.t' } }],
};
/** The cases whose plan, with nothing registered, already handed the engine every row. */
const FETCHED_WHOLE = new Set(['a filter comparing with a count of the collection', 'a variable bound to the root',
  'an aggregate whose filter reads the collection', 'a distinct projection whose filter reads the collection']);
/** Documents that read the root only through their binding, with the plan each keeps. */
const CONTROLS = [
  { document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.n', 1] }, $return: '$r.id' }], mode: 'native' },
  { document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.n', 1] }, $return: { id: '$r.id', next: { $add: ['$r.n', 1] } } }],
    mode: 'row' },
  { document: [{ $for: { r: '$[*]' }, $return: { id: '$r.id', unit: '$$USD', next: { $add: ['$r.n', 1] } } }], mode: 'row' },
  { document: [{ $subsequence: [{ $for: { r: '$[*]' }, $orderby: ['$r.n', '$r.id'], $return: '$r.id' }, 1, 2] }],
    mode: 'native' },
];

/** The stores a case runs on: node:sqlite, and the bun:sqlite-shaped binding, which registers no functions. */
const DRIVERS = [
  ['node:sqlite', () => nodeDriver()],
  ['bun:sqlite-shaped', () => ({ name: 'bun-shaped', dialect: /** @type {any} */ (undefined),
    open: () => adaptBunDatabase(new BunShapedDatabase(':memory:')) })],
];

/** The engine's answer, or the code it refuses with. */
function outcome(fn) {
  try {
    const value = fn();
    return value instanceof Promise
      ? value.then((v) => ({ value: v }), (error) => ({ code: error.code ?? String(error) }))
      : { value };
  }
  catch (error) {
    return { code: /** @type {any} */ (error).code ?? String(error) };
  }
}

async function seeded(driver, profile) {
  const store = await openStore(MODEL, { driver, ...(profile === undefined ? {} : { profile }) });
  await store.transaction(async (tx) => { for (const row of DATA) await tx.collection('rows').put(row); });
  return store;
}

describe('a query that reads the collection root is answered over the whole collection', () => {
  for (const [label, driver] of DRIVERS) {
    for (const profile of [undefined, HIDE_R3]) {
      it(`${label}${profile === undefined ? '' : ', under a profile predicate'}: every named case answers as the engine`, async () => {
        const store = await seeded(driver(), profile);
        try {
          const rows = store.collection('rows');
          // the statement every case runs: the whole collection, under the profile alone
          const whole = (await rows.explain(CASES['a count of the collection in a projection'])).sql;
          for (const [name, document] of Object.entries(CASES)) {
            assert.deepEqual(await rows.execute(document), queryJson(document, visible(profile)), name);
            const explained = await rows.explain(document);
            assert.equal(explained.mode, 'set', name);
            assert.equal(explained.sql, whole, name);
            assert.deepEqual(explained.prefilters, [], name);
            // a plan that fetched every row already keeps its own reason
            if (!FETCHED_WHOLE.has(name)) {
              assert.deepEqual(explained.residual.reasons, [ROOT_READ], name);
              assert.equal(reasonId(explained.residual.reasons[0].reason), 'plan.rootRead', name);
            }
          }
          for (const { document, mode } of CONTROLS) {
            assert.equal((await rows.explain(document)).mode, mode, JSON.stringify(document));
            assert.deepEqual(await rows.execute(document), queryJson(document, visible(profile)));
          }
        }
        finally { await store.close(); }
      });
    }
  }

  it('strict mode refuses the whole-collection residual by its reason', async () => {
    const store = await seeded(nodeDriver());
    try {
      await assert.rejects(async () => store.collection('rows').execute(CASES['the same beside a pushed conjunct'], { strict: true }),
        { code: 'JD0010', message: `JD0010: strict mode refused a residual: '$' — ${ROOT_READ.reason} at /collections/rows` });
    }
    finally { await store.close(); }
  });
});

// ————— the seeded differential —————

/** @param {number} seed */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random collection of `count` rows over the model's members. */
function randomRows(rand, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const xs = [];
    for (let j = Math.floor(rand() * 3); j > 0; j--) xs.push(Math.floor(rand() * 6));
    rows.push({ id: `k${String(i).padStart(2, '0')}`, n: Math.floor(rand() * 6), t: rand() < 0.5 ? 'a' : 'b', xs });
  }
  return rows;
}

const ROW_TERMS = ['$r.id', { $add: ['$r.n', 1] }, '$r.t', { $count: '$r.xs[*]' }];
const ROOT_TERMS = [
  { $count: '$[*]' }, { $default: ['$[0].id', null] }, { $default: [{ $max: '$[*].n' }, null] }, { $sum: '$[*].n' },
  { $count: '$[?@.n > 2]' }, { $count: '$r.xs[?@ == $[0].n]' },
  [{ $for: { o: '$[*]' }, $where: { $lt: ['$o.n', '$r.n'] }, $return: '$o.id' }],
];
const WHERES = [
  { $gt: ['$r.n', 2] }, { $eq: ['$r.t', 'a'] }, { $gt: [{ $add: ['$r.n', 1] }, 3] },
  { $lt: ['$r.n', { $count: '$[?@.t == "a"]' }] }, { $ge: ['$r.n', { $default: [{ $avg: '$[*].n' }, 0] }] },
];

/** One random document: a phrase over the collection, its parts drawn from row and root reads, and
 * whether a part reads the root beside the binding. */
function randomDocument(rand) {
  let rooted = false;
  const pick = (items) => {
    const item = items[Math.floor(rand() * items.length)];
    if (ROOT_TERMS.includes(item) || WHERES.indexOf(item) >= 3) rooted = true;
    return item;
  };
  const term = () => (rand() < 0.5 ? pick(ROW_TERMS) : pick(ROOT_TERMS));
  /** @type {any} */
  const phrase = { $for: { r: '$[*]' } };
  const where = rand();
  if (where < 0.35) phrase.$where = pick(WHERES);
  else if (where < 0.6) phrase.$where = { $and: [pick(WHERES), pick(WHERES)] };
  const ordered = rand() < 0.4;
  if (ordered) phrase.$orderby = ['$r.n', '$r.id'];
  const shape = rand();
  let document;
  if (shape < 0.15) document = { $count: { ...phrase, $return: '$r' } };
  else if (shape < 0.25) document = { $max: { ...phrase, $return: '$r.n' } };
  else {
    phrase.$return = rand() < 0.3 ? term() : { id: '$r.id', a: term(), b: term() };
    document = ordered && rand() < 0.5 ? { $subsequence: [phrase, Math.floor(rand() * 3), 1 + Math.floor(rand() * 3)] } : phrase;
  }
  return { document: rand() < 0.5 ? [document] : document, rooted };
}

/**
 * Run `trials` random documents against a store holding `rows` in that
 * order, the engine over the rows a profile leaves as the oracle.
 * @returns {Promise<{ checks: number, rootReads: number, mismatches: string[] }>}
 */
async function differential(store, rows, seed, trials) {
  const rand = mulberry32(seed);
  const collection = store.collection('rows');
  const mismatches = [];
  let rootReads = 0;
  for (let trial = 0; trial < trials; trial++) {
    const { document, rooted } = randomDocument(rand);
    const expected = outcome(() => queryJson(document, rows));
    const actual = await outcome(() => collection.execute(document));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches.push(`${JSON.stringify(document)}\n  engine ${JSON.stringify(expected)}\n  store  ${JSON.stringify(actual)}`);
    }
    if (rooted) rootReads++;
  }
  return { checks: trials, rootReads, mismatches };
}

describe('a seeded differential against the engine: random phrases mixing row and root reads', () => {
  for (const [label, driver] of DRIVERS) {
    for (const [seed, profiled] of [[11, false], [12, true], [13, false]]) {
      it(`${label}, seed ${seed}${profiled ? ', under a profile predicate' : ''}`, async () => {
        const rows = randomRows(mulberry32(seed * 7), 9);
        const profile = profiled ? { predicates: { rows: { $ne: ['$it.t', 'b'] } } } : undefined;
        const store = await openStore(MODEL, { driver: driver(), ...(profile === undefined ? {} : { profile }) });
        try {
          await store.transaction(async (tx) => { for (const row of rows) await tx.collection('rows').put(row); });
          const { checks, rootReads, mismatches } = await differential(store,
            profiled ? rows.filter((row) => row.t !== 'b') : rows, seed, 160);
          assert.deepEqual(mismatches, [], `${mismatches.length} of ${checks} differ`);
          assert.ok(rootReads > checks / 4, `the corpus reads the root (${rootReads} of ${checks})`);
        }
        finally { await store.close(); }
      });
    }
  }

  it('PostgreSQL, seeds 21 and 22, one under a profile predicate',
    { skip: !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, async () => {
      const pg = (await import('pg')).default;
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
      try {
        for (const [seed, profiled] of [[21, false], [22, true]]) {
          // a fresh schema per seed: the oracle reads the rows in the order they were first written
          const schema = `jaren_root_read_${process.pid}_${seed}`;
          const rows = randomRows(mulberry32(seed * 7), 9);
          const profile = profiled ? { predicates: { rows: { $ne: ['$it.t', 'b'] } } } : undefined;
          const kept = profiled ? rows.filter((row) => row.t !== 'b') : rows;
          /** @type {any} */
          let store = null;
          try {
            await pool.query(`CREATE SCHEMA "${schema}"`);
            store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }),
              ...(profile === undefined ? {} : { profile }) });
            await store.transaction(async (/** @type {any} */ tx) => {
              for (const row of rows) await tx.collection('rows').put(row);
            });
            for (const [name, document] of Object.entries(CASES)) {
              assert.deepEqual(await outcome(() => store.collection('rows').execute(document)),
                { value: queryJson(document, kept) }, name);
            }
            const { checks, mismatches } = await differential(store, kept, seed, 100);
            assert.deepEqual(mismatches, [], `${mismatches.length} of ${checks} differ`);
          }
          finally {
            try { if (store !== null) await store.close(); }
            finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
          }
        }
      }
      finally { await pool.end(); }
    });
});

// ————— live registrations that evaluate one row at a time —————

const ROW_ALONE = 'a projection that reads the collection root re-runs (a row is evaluated alone)';

describe('a live registration that evaluates one row at a time re-runs a document reading the root', () => {
  const documents = [
    CASES['a count of the collection in a projection'],
    CASES['the first row of the collection'],
    CASES['a maximum over the collection under a pushed where'],
    CASES['the root named inside a path filter'],
    [{ $for: { r: '$[*]' }, $where: { $lt: ['$r.n', { $count: '$[*]' }] }, $return: '$r.id' }],
  ];
  it('rows: re-runs, refuses a demanded incremental mode, and answers as the engine after every write', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    try {
      const rows = store.collection('rows');
      const held = [];
      for (const row of DATA.slice(0, 3)) { await rows.put(row); held.push(row); }
      const lives = [];
      for (const document of documents) {
        const live = await rows.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: ROW_ALONE }, JSON.stringify(document));
        await assert.rejects(async () => rows.live(document, { mode: 'incremental' }), { code: 'JD0051' });
        lives.push(live);
      }
      for (const row of DATA.slice(3)) {
        await rows.put(row);
        held.push(row);
        for (const [index, live] of lives.entries()) {
          assert.deepEqual(live.result.rows, queryJson(documents[index], held), JSON.stringify(documents[index]));
        }
      }
    }
    finally { await store.close(); }
  });

  it('an event-time bucket whose filter reads the root re-runs, and answers as execute', async () => {
    const MINUTE = 60_000;
    const T0 = 1_767_225_600_000;
    const SERIES = { $model: '0.1', collections: { readings: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, at: { type: 'integer' }, value: { type: 'number' }, kind: { type: 'string' } } } } } };
    const store = await openStore(SERIES, { driver: nodeDriver(), capture: true });
    try {
      const readings = store.collection('readings');
      for (let i = 0; i < 4; i++) await readings.put({ id: `v${i}`, at: T0 + i * 10_000, value: i * 10, kind: 'a' });
      const document = [{ $resample: [{ $for: { x: '$[*]' },
        $where: { $and: [{ $eq: ['$x.kind', 'a'] }, { $ge: ['$x.value', { $avg: '$[*].value' }] }] }, $return: '$x' },
      { every: MINUTE, aggregate: 'count' }] }];
      const eventTime = { path: '$.at', watermark: T0, allowedLateness: 10 * MINUTE, retention: 60 * MINUTE };
      const live = await readings.live(document, { eventTime });
      assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
        reason: "'$resample' — a filter that reads the collection root re-runs (a row is evaluated alone)" });
      for (const [id, value] of [['w1', 1], ['w2', 50], ['w3', 25]]) {
        await readings.put({ id, at: T0 + 50_000, value, kind: 'a' });
        assert.deepEqual(live.result.rows, await readings.execute(document));
      }
      assert.deepEqual(live.result.rows, queryJson(document, await readings.all()));
    }
    finally { await store.close(); }
  });
});
