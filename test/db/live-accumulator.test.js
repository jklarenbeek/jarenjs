//@ts-check
/**
 * @file Live whole-collection accumulators over an `integer` member
 * (LIVE-FORMAT §7): a sum or an average answers from its retained terms
 * only while every partial sum is exact — the bound the query path checks
 * beside a pushed sum, the largest magnitude times the number of terms
 * within ±(2^53 - 1). Past it a fresh run answers the engine's
 * left-to-right addition in the order it reads the rows, so the
 * registration re-runs from then on, the reason named in `live.mode`; one
 * that demanded incremental maintenance refuses `JD0051` instead; a term
 * that is not an integer counts as past the bound. A stored `null` term is
 * skipped by the sum, the average and the extrema, as the native aggregate
 * skips it. A seeded trial over terms around 2^53 and
 * 2^62, null and missing, holds every registration equal to a fresh run
 * after every committed change — or errored with the code the fresh run
 * raises.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';
import { liveOracle } from './oracle/replication.js';

const MODEL = {
  $model: '0.1',
  collections: {
    nums: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, n: { type: 'integer' }, k: { type: 'integer' } } },
      key: '/id',
    },
    words: {
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } },
      key: '/id',
    },
  },
};
const open = () => openStore(MODEL, { driver: nodeDriver(), capture: true });
const B = Number.MAX_SAFE_INTEGER;
const TERMS = { $for: { it: '$[*]' }, $return: '$it.n' };
const ACCUMULATION = "'accumulation' — integer accumulation exceeded its runtime exactness bound";
const MAINTAINED = { strategy: 'accumulator', mode: 'incremental' };
const RERUN = { strategy: 'rerun', mode: 'rerun', reason: ACCUMULATION };

/** A document's result as `live.result.rows` holds it.
 * @param {any} document @param {any} result */
const asRows = (document, result) => (Array.isArray(document) ? result
  : result === undefined ? [] : [result]);

describe('integer sums and averages past the exactness bound', () => {
  it('a sum or an average whose terms leave the bound re-runs from then on, the reason named, and answers what execute answers', async () => {
    const store = await open();
    try {
      const nums = store.collection('nums');
      await nums.insert({ id: 'a', k: 1 });
      await nums.insert({ id: 'b', n: 1, k: 1 });
      await nums.insert({ id: 'c', n: 2, k: 1 });
      const watches = [];
      for (const document of [{ $sum: TERMS }, [{ $avg: TERMS }]]) {
        const live = await nums.live(document);
        assert.deepEqual(live.mode, MAINTAINED);
        watches.push({ live, oracle: liveOracle(live, async () => asRows(document, await nums.execute(document))) });
      }
      const check = async () => { for (const { oracle } of watches) await oracle.check(); };
      await check();
      // the largest term times the number of terms passes 2^53 - 1
      await nums.put({ id: 'b', n: B, k: 1 }, 'b');
      await check();
      // a term on the row read first: a fresh run adds it first, and
      // (-2 + B) + 2 is exact where (B + 2) - 2 is not
      await nums.patch('a', [{ op: 'add', path: '/n', value: -2 }]);
      assert.deepEqual(watches[0].live.result.rows, [B]);
      await check();
      // back inside the bound, the registration still re-runs
      await nums.delete('b');
      await check();
      for (const { live, oracle } of watches) {
        assert.deepEqual(live.mode, RERUN);
        assert.equal(live.stats().reruns, 3);
        oracle.close();
      }
    }
    finally { await store.close(); }
  });

  it('a registration past the bound re-runs from the start, and one that demands incremental maintenance refuses JD0051', async () => {
    const store = await open();
    try {
      const nums = store.collection('nums');
      await nums.insert({ id: 'a', n: B, k: 1 });
      await nums.insert({ id: 'b', n: 2, k: 1 });
      const document = { $sum: TERMS };
      const live = await nums.live(document);
      assert.deepEqual(live.mode, RERUN);
      assert.deepEqual(live.result.rows, [await nums.execute(document)]);
      await assert.rejects(async () => nums.live(document, { mode: 'incremental' }),
        { code: 'JD0051', message: `JD0051: the demanded incremental mode is unavailable: ${ACCUMULATION}` });
      // inside the bound a demanded registration is maintained, and the
      // write that crosses the bound errors it with the same refusal
      await nums.delete('a');
      const demanded = await nums.live(document, { mode: 'incremental' });
      assert.deepEqual(demanded.mode, MAINTAINED);
      /** @type {any[]} */
      const errors = [];
      demanded.subscribe(({ error }) => { if (error !== undefined) errors.push(error); });
      await nums.insert({ id: 'a', n: B, k: 1 });
      assert.deepEqual(errors.map((error) => error.code), ['JD0051']);
      assert.equal(demanded.state, 'errored');
      assert.equal(live.state, 'live');
      assert.deepEqual(live.result.rows, [await nums.execute(document)]);
    }
    finally { await store.close(); }
  });

  it('a stored null term is skipped by the sum, the average and the extrema, as execute skips it', async () => {
    const store = await open();
    try {
      const nums = store.collection('nums');
      await nums.insert({ id: 'a', n: 4 });
      await nums.insert({ id: 'b', n: null });
      await nums.insert({ id: 'c', n: 6 });
      await nums.insert({ id: 'd' });
      /** @type {[string, number][]} */
      const answers = [['$count', 3], ['$sum', 10], ['$avg', 5], ['$min', 4], ['$max', 6]];
      for (const [op, expected] of answers) {
        const document = { [op]: TERMS };
        const live = await nums.live(document);
        assert.deepEqual(live.mode, MAINTAINED);
        assert.equal(await nums.execute(document), expected, op);
        assert.deepEqual(live.result.rows, [expected], op);
        live.close();
      }
    }
    finally { await store.close(); }
  });

  it('a term that is not an integer, which an integer member stores as given, counts as past the bound', async () => {
    const store = await open();
    try {
      const nums = store.collection('nums');
      for (const [id, n] of [['a', 0.1], ['b', 0.2], ['c', 0.3]]) await nums.insert({ id, n });
      const document = { $sum: TERMS };
      const live = await nums.live(document);
      // SQL's compensated sum, where a running double sum is 0.6000000000000001
      assert.equal(await nums.execute(document), 0.6);
      assert.deepEqual(live.mode, RERUN);
      assert.deepEqual(live.result.rows, [0.6]);
    }
    finally { await store.close(); }
  });
});

describe('the extrema of a string member', () => {
  it('order text by code point, as execute does: a private-use character before an astral one', async () => {
    const store = await open();
    try {
      const words = store.collection('words');
      await words.insert({ id: 'a', s: '\uE000' });
      await words.insert({ id: 'b', s: '\u{1F600}' });
      const STRINGS = { $for: { it: '$[*]' }, $return: '$it.s' };
      const min = await words.live({ $min: STRINGS });
      const max = await words.live({ $max: STRINGS });
      assert.deepEqual([min.mode, max.mode], [MAINTAINED, MAINTAINED]);
      const answers = async () => [[await words.execute({ $min: STRINGS })], [await words.execute({ $max: STRINGS })]];
      assert.deepEqual(await answers(), [['\uE000'], ['\u{1F600}']]);
      assert.deepEqual([min.result.rows, max.result.rows], await answers());
      await words.insert({ id: 'c', s: '\uFFFD' });
      assert.deepEqual([min.result.rows, max.result.rows], await answers());
      await words.delete('b');
      assert.deepEqual(await answers(), [['\uE000'], ['\uFFFD']]);
      assert.deepEqual([min.result.rows, max.result.rows], await answers());
    }
    finally { await store.close(); }
  });
});

describe('the integer accumulator trial (seeded)', () => {
  const POSITIVE = { $gt: ['$it.k', 0] };
  /** @type {Record<string, any>} */
  const DOCUMENTS = {
    sum: { $sum: TERMS },
    average: { $avg: TERMS },
    'filtered sum': { $sum: { ...TERMS, $where: POSITIVE } },
    'filtered average': [{ $avg: { ...TERMS, $where: POSITIVE } }],
  };
  const SMALL = [0, 1, -2, 3, -5, 8];
  const LARGE = [B, B - 2, -B, 2 ** 52 + 1, -(2 ** 52) - 3, 2 ** 62, -(2 ** 62), 2 ** 62 + 2 ** 10, 3 * 2 ** 61];
  const KEYS = Array.from({ length: 8 }, (_, i) => `n${i}`);

  it('terms around 2^53 and 2^62, null and missing: every registration equals a fresh run after every committed change', async () => {
    const rand = mulberry32(53);
    /** @param {any[]} values */
    const pick = (values) => values[Math.floor(rand() * values.length)];
    /** A term: mostly small, sometimes past the bound, sometimes null or missing. */
    const term = () => {
      const roll = rand();
      return roll < 0.1 ? pick(LARGE) : roll < 0.2 ? null : roll < 0.3 ? undefined : pick(SMALL);
    };
    /** @param {string} id */
    const row = (id) => {
      const n = term();
      return { id, ...(n === undefined ? {} : { n }), k: Math.floor(rand() * 3) };
    };
    /** One write: a put, or on a present row a delete, a change of its
     * term (added, replaced or removed) or of its filter member.
     * @param {any} collection @param {Map<string, any>} docs */
    const write = async (collection, docs) => {
      const id = pick(KEYS);
      const roll = rand();
      const doc = docs.get(id);
      if (doc === undefined || roll < 0.3) {
        const next = row(id);
        await collection.put(next, id);
        docs.set(id, next);
      }
      else if (roll < 0.45) {
        await collection.delete(id);
        docs.delete(id);
      }
      else if (roll < 0.85) {
        const n = term();
        if (n === undefined && Object.hasOwn(doc, 'n')) {
          await collection.patch(id, [{ op: 'remove', path: '/n' }]);
          delete doc.n;
        }
        else {
          const value = n === undefined ? 0 : n;
          await collection.patch(id, [{ op: 'add', path: '/n', value }]);
          doc.n = value;
        }
      }
      else {
        const k = Math.floor(rand() * 3);
        await collection.patch(id, [{ op: 'replace', path: '/k', value: k }]);
        doc.k = k;
      }
    };
    /** @param {Map<string, any>} docs */
    const copy = (docs) => new Map([...docs].map(([id, doc]) => [id, { ...doc }]));
    const counts = { maintained: 0, rerunning: 0, raised: 0, rollbacks: 0 };
    for (let trial = 0; trial < 25; trial++) {
      const store = await open();
      try {
        const nums = store.collection('nums');
        let docs = new Map();
        for (const id of KEYS.slice(0, 5)) {
          const next = row(id);
          await nums.insert(next);
          docs.set(id, next);
        }
        /** @param {any} watch */
        const register = async (watch) => {
          watch.live = await nums.live(watch.document);
          watch.oracle = liveOracle(watch.live,
            async () => asRows(watch.document, await nums.execute(watch.document)));
        };
        /** @type {any[]} */
        const watches = [];
        for (const [name, document] of Object.entries(DOCUMENTS)) {
          const watch = { name, document, live: null, oracle: null, raised: false };
          try { await register(watch); }
          catch (error) {
            // past the bound beside a null term the fresh run raises too
            assert.equal(/** @type {any} */ (error).code, 'JQ2001', name);
            watch.live = { state: 'errored', error };
            watch.raised = true;
          }
          watches.push(watch);
        }
        for (let step = 0; step < 30; step++) {
          const label = `trial ${trial} step ${step}`;
          const before = watches.map(({ oracle }) => oracle?.emissions);
          const roll = rand();
          if (roll < 0.15) {
            const staged = copy(docs);
            const undone = await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('nums'), staged);
              throw new Error('undo');
            }).catch((error) => {
              // only the deliberate rollback: a store error is a failure
              if (error.message !== 'undo') throw error;
              return 'rolled back';
            });
            assert.equal(undone, 'rolled back');
            assert.deepEqual(watches.map(({ oracle }) => oracle?.emissions), before,
              `${label}: a rolled-back transaction emits nothing`);
            counts.rollbacks++;
          }
          else if (roll < 0.4) {
            const staged = copy(docs);
            await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('nums'), staged);
            });
            docs = staged;
          }
          else await write(nums, docs);
          for (const watch of watches) {
            let raised;
            try { await nums.execute(watch.document); }
            catch (error) { raised = /** @type {any} */ (error).code; }
            if (raised !== undefined) {
              // a fresh run that raises passes only when the live query
              // is errored with the same code
              assert.equal(watch.live.state, 'errored', `[${watch.name}] ${label}: the fresh run raised ${raised}`);
              assert.equal(watch.live.error.code, raised, `[${watch.name}] ${label}`);
              watch.raised = true;
              counts.raised++;
              continue;
            }
            // only a fresh run that raised may have errored the live query
            if (watch.live.state !== 'live') {
              assert.ok(watch.raised, `[${watch.name}] ${label}: errored (${watch.live.error?.code}) where the fresh run answers`);
              await register(watch);
            }
            watch.raised = false;
            await watch.oracle.check().catch((/** @type {any} */ error) => {
              throw new Error(`[${watch.name}] ${label}: ${error.message}`);
            });
            if (watch.live.mode.mode === 'rerun') {
              assert.deepEqual(watch.live.mode, RERUN, `[${watch.name}] ${label}`);
              counts.rerunning++;
            }
            else counts.maintained++;
          }
        }
      }
      finally { await store.close(); }
    }
    // every path was taken: maintained answers, registrations re-running
    // past the bound, and fresh runs raising beside a null term
    assert.ok(counts.maintained > 500 && counts.rerunning > 500 && counts.raised > 100
      && counts.rollbacks > 50, JSON.stringify(counts));
  });
});
