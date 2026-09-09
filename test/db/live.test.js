//@ts-check
/**
 * @file Live queries (LIVE-FORMAT §§7–9): the incremental strategies
 * — rows, projection, accumulators with the min/max fallback, and
 * per-group deltas — plus classification honesty (`live.mode` with
 * reasons), member-level invalidation pruning, transaction
 * coalescing, and THE structural-sharing contract: after a single-row
 * change every unaffected row is reference-identical. The seeded
 * oracle at the end holds the maintained result equal to a fresh
 * re-query after EVERY mutation, with a consumer mirror maintained
 * solely by `applyJSONPatch` — the capture layer's discipline (a
 * consumer rebuilds from the emitted patches alone, never from a
 * re-read) applied to maintenance.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' },
        age: { type: 'integer' }, dept: { type: 'string' },
        pay: { type: 'number' }, bio: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};

const open = () => openStore(MODEL, { driver: nodeDriver(), capture: true });
const WHERE_ADULT = { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 18] }, $return: '$it' };

describe('live set-level SQL promotions', () => {
  const group = { $for: { it: '$[*]' }, $groupby: { dept: '$it.dept' },
    $return: { dept: '$dept', count: { $count: '$it' } } };
  const cases = [
    ['group count', { $count: group }],
    ['distinct', { $distinct: { $for: { it: '$[*]' }, $return: '$it.dept' } }],
    ['multiple group keys', { ...group, $groupby: { dept: '$it.dept', age: '$it.age' },
      $return: { dept: '$dept', age: '$age', count: { $count: '$it' } } }],
  ];
  for (const [name, document] of cases) it(`${name} preserves set semantics through captured writes`, async () => {
    const store = await open();
    try {
      const users = store.collection('users');
      for (const row of [{ id: 'a', dept: 'x', age: 30 }, { id: 'b', dept: 'x', age: 30 },
        { id: 'c', dept: 'y', age: 40 }]) await users.insert(row);
      assert.strictEqual((await users.explain(document)).mode, 'native');
      const live = await users.live(document);
      let mirror = live.result;
      live.subscribe(({ patch }) => { mirror = applyJSONPatch(mirror, patch); });
      const verify = async () => {
        assert.deepStrictEqual(live.result.rows, await users.execute([document], { pushdown: false }));
        assert.deepStrictEqual(mirror, live.result);
      };
      await verify();
      await users.insert({ id: 'd', dept: 'x', age: 30 });
      await verify();
      await users.put({ id: 'a', dept: 'z', age: 30 }, 'a');
      await verify();
      await users.delete('c');
      await verify();
      assert.strictEqual(live.mode.strategy, 'rerun');
    }
    finally { await store.close(); }
  });
});

describe('live rows (where + select)', () => {
  it('maintains inserts, flips, deletes and in-place updates', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', name: 'ada', age: 36 });
    await users.insert({ id: 'b', name: 'kid', age: 8 });
    const live = await users.live([WHERE_ADULT]);
    assert.deepStrictEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
    assert.deepStrictEqual(live.result.rows, [{ id: 'a', name: 'ada', age: 36 }]);

    const events = [];
    live.subscribe((event) => events.push(event));
    await users.insert({ id: 'c', name: 'lin', age: 64 });
    await users.put({ id: 'b', name: 'kid', age: 21 }, 'b'); // flips in
    await users.delete('a');
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['c', 'b']);
    assert.deepStrictEqual(events.map((event) => event.patch), [
      [{ op: 'add', path: '/rows/1', value: { id: 'c', name: 'lin', age: 64 } }],
      [{ op: 'add', path: '/rows/2', value: { id: 'b', name: 'kid', age: 21 } }],
      [{ op: 'remove', path: '/rows/0' }],
    ]);
    await store.close();
  });

  it('REFERENCE IDENTITY: a single-row change leaves every other row identical', async () => {
    const store = await open();
    const users = store.collection('users');
    for (let i = 0; i < 6; i++) {
      await users.insert({ id: `u${i}`, name: `n${i}`, age: 20 + i });
    }
    const live = await users.live([WHERE_ADULT]);
    const before = [...live.result.rows];
    await users.put({ id: 'u3', name: 'renamed', age: 23 }, 'u3');
    const after = live.result.rows;
    assert.notStrictEqual(after, before, 'the rows array itself is fresh per emission');
    for (let i = 0; i < 6; i++) {
      if (i === 3) {
        assert.notStrictEqual(after[i], before[i]);
        assert.strictEqual(after[i].name, 'renamed');
      }
      else {
        assert.strictEqual(after[i], before[i],
          `row ${i} must be the same reference`);
      }
    }
    await store.close();
  });

  it('a projection recomputes only the affected row; a no-op update emits nothing', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', name: 'ada', age: 36, bio: 'x' });
    await users.insert({ id: 'b', name: 'bob', age: 40, bio: 'y' });
    const live = await users.live([{
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 18] },
      $return: { who: '$it.name' },
    }]);
    assert.deepStrictEqual(live.result.rows, [{ who: 'ada' }, { who: 'bob' }]);
    const events = [];
    live.subscribe((event) => events.push(event));
    const bobBefore = live.result.rows[1];

    // a change the projection does not read: re-evaluated, value-equal,
    // reference kept, nothing emitted
    await users.put({ id: 'a', name: 'ada', age: 36, bio: 'CHANGED' }, 'a');
    assert.strictEqual(events.length, 0, 'a projection-invisible update is silent');
    await users.put({ id: 'a', name: 'ADA', age: 36, bio: 'CHANGED' }, 'a');
    assert.deepStrictEqual(events, [{
      patch: [{ op: 'replace', path: '/rows/0', value: { who: 'ADA' } }], seq: 4,
    }]);
    assert.strictEqual(live.result.rows[1], bobBefore, 'the other projected row is shared');
    await store.close();
  });

  it('a consumer applying the patches holds the exact result document', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', name: 'ada', age: 36 });
    const live = await users.live([WHERE_ADULT]);
    let mirror = live.result;
    live.subscribe(({ patch }) => {
      mirror = applyJSONPatch(mirror, patch);
    });
    await users.insert({ id: 'b', name: 'bob', age: 40 });
    await users.put({ id: 'a', name: 'ada!', age: 36 }, 'a');
    await users.delete('b');
    assert.deepStrictEqual(mirror, live.result);
    assert.deepStrictEqual(mirror.rows, [{ id: 'a', name: 'ada!', age: 36 }]);
    await store.close();
  });

  it('coalescing: a transaction touching many rows emits ONE event', async () => {
    const store = await open();
    const live = await store.collection('users').live([WHERE_ADULT]);
    const events = [];
    live.subscribe((event) => events.push(event));
    await store.transaction(async (tx) => {
      const inside = tx.collection('users');
      for (let i = 0; i < 50; i++) {
        await inside.insert({ id: `t${i}`, name: `n${i}`, age: 30 });
      }
      await inside.delete('t7');
    });
    assert.strictEqual(events.length, 1, 'one record, one emission');
    assert.strictEqual(live.result.rows.length, 49);
    assert.strictEqual(events[0].patch.length, 49);
    await store.close();
  });
});

describe('live accumulators', () => {
  const count = { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 18] }, $return: '$it' } };

  it('count and sum run incrementally with contribution-answered deletes', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', age: 30, pay: 10 });
    await users.insert({ id: 'b', age: 10, pay: 99 });
    const liveCount = await users.live(count);
    const liveSum = await users.live(
      { $sum: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 18] }, $return: '$it.pay' } });
    assert.deepStrictEqual(liveCount.result.rows, [1]);
    assert.deepStrictEqual(liveSum.result.rows, [10]);
    await users.insert({ id: 'c', age: 40, pay: 5 });
    await users.delete('a');
    await users.put({ id: 'b', age: 20, pay: 99 }, 'b'); // flips in
    assert.deepStrictEqual(liveCount.result.rows, [2]);
    assert.deepStrictEqual(liveSum.result.rows, [104]);
    await store.close();
  });

  it('an update the aggregate does not read is pruned by member deps', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', age: 30, name: 'ada' });
    const live = await users.live(count);
    const events = [];
    live.subscribe((event) => events.push(event));
    await users.put({ id: 'a', age: 30, name: 'renamed' }, 'a');
    assert.strictEqual(events.length, 0, 'a name change cannot move an age count');
    const stats = live.stats();
    assert.strictEqual(stats.records, 1, 'the record was seen');
    assert.strictEqual(stats.matched, 0, 'and skipped by the member set');
    await store.close();
  });

  it('min/max: extremum removal falls back over retained contributions', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', age: 30, pay: 10 });
    await users.insert({ id: 'b', age: 30, pay: 50 });
    await users.insert({ id: 'c', age: 30, pay: 50 });
    const liveMax = await users.live({ $max: { $for: { it: '$[*]' }, $return: '$it.pay' } });
    assert.deepStrictEqual(liveMax.result.rows, [50]);
    await users.delete('b');
    assert.deepStrictEqual(liveMax.result.rows, [50], 'a tie holder remains');
    assert.strictEqual(liveMax.stats().fallbacks, 1,
      'the extremum left one holder — the fallback recomputed');
    await users.delete('c');
    assert.deepStrictEqual(liveMax.result.rows, [10]);
    assert.strictEqual(liveMax.stats().fallbacks, 2);
    await users.delete('a');
    assert.deepStrictEqual(liveMax.result.rows, [],
      'an empty max is an empty result — the engine rule made visible');
    await store.close();
  });

  it('avg follows value updates through point-reads', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', age: 30, pay: 10 });
    await users.insert({ id: 'b', age: 30, pay: 30 });
    const live = await users.live({ $avg: { $for: { it: '$[*]' }, $return: '$it.pay' } });
    assert.deepStrictEqual(live.result.rows, [20]);
    await users.put({ id: 'a', age: 30, pay: 50 }, 'a');
    assert.deepStrictEqual(live.result.rows, [40]);
    await store.close();
  });
});

describe('live per-group deltas', () => {
  const GROUPED = {
    $for: { it: '$[*]' },
    $groupby: { g: '$it.dept' },
    $return: {
      key: { $default: ['$g', null] },
      n: { $count: '$it' },
      total: { $sum: '$it.pay' },
    },
  };

  it('maintains groups: deltas, appearance, disappearance, first-appearance order', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', dept: 'x', pay: 10 });
    await users.insert({ id: 'b', dept: 'y', pay: 20 });
    await users.insert({ id: 'c', dept: 'x', pay: 5 });
    const live = await users.live(GROUPED);
    assert.deepStrictEqual(live.mode, { strategy: 'group', mode: 'incremental' });
    assert.deepStrictEqual(live.result.rows, [
      { key: 'x', n: 2, total: 15 },
      { key: 'y', n: 1, total: 20 },
    ]);
    const untouched = live.result.rows[1];

    await users.put({ id: 'a', dept: 'x', pay: 100 }, 'a');
    assert.deepStrictEqual(live.result.rows[0], { key: 'x', n: 2, total: 105 });
    assert.strictEqual(live.result.rows[1], untouched,
      'the y group row is reference-identical — per-group deltas');

    await users.put({ id: 'c', dept: 'z', pay: 5 }, 'c'); // moves groups
    assert.deepStrictEqual(live.result.rows, [
      { key: 'x', n: 1, total: 100 },
      { key: 'y', n: 1, total: 20 },
      { key: 'z', n: 1, total: 5 },
    ]);
    await users.delete('b'); // y group vanishes
    assert.deepStrictEqual(live.result.rows.map((row) => row.key), ['x', 'z']);
    await store.close();
  });

  it('null-valued and ABSENT group keys stay separate groups (the engine identity)', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', dept: null, pay: 1 });
    await users.insert({ id: 'b', pay: 2 });
    await users.insert({ id: 'c', dept: null, pay: 4 });
    const live = await users.live(GROUPED);
    assert.deepStrictEqual(live.result.rows, [
      { key: null, n: 2, total: 5 },
      { key: null, n: 1, total: 2 },
    ], 'two distinct groups both rendering null through $default');
    await store.close();
  });
});

describe('classification honesty (live.mode)', () => {
  it('names the forcing construct for shapes outside the table', async () => {
    const store = await open();
    const users = store.collection('users');
    const cases = [
      [[{ $for: { it: '$[*]' }, $where: { $gt: [{ $add: ['$it.age', 1] }, 30] }, $return: '$it' }],
        /\$gt.*translate/],
      [[{ $subsequence: [{ $for: { it: '$[*]' }, $return: '$it' }, 0, 5] }],
        /limit without an order/],
      [[{ $subsequence: [{ $for: { it: '$[*]' }, $orderby: { $key: '$it.age' }, $return: '$it' }, 2, 5] }],
        /offset window/],
      [{ $count: { $subsequence: [{ $for: { it: '$[*]' }, $return: '$it' }, 0, 5] } },
        /windowed aggregate/],
      [[{ $for: { it: '$[*]' }, $groupby: { g: '$it.dept' },
        $return: { key: { $default: ['$g', null] }, deep: { $count: '$it' }, odd: '$it' } }],
      /group|residual|\$groupby/],
    ];
    for (const [document, expected] of cases) {
      const live = await users.live(document);
      assert.strictEqual(live.mode.mode, 'rerun');
      assert.match(String(live.mode.reason), expected);
      live.close();
    }
    await store.close();
  });

  it('rerun still maintains a correct result, with reuse for unchanged rows', async () => {
    const store = await open();
    const users = store.collection('users');
    await users.insert({ id: 'a', name: 'ada', age: 36 });
    await users.insert({ id: 'b', name: 'bob', age: 40 });
    // an untranslatable where: arithmetic inside the predicate
    const live = await users.live([{
      $for: { it: '$[*]' },
      $where: { $gt: [{ $add: ['$it.age', 1] }, 38] },
      $return: '$it',
    }]);
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b']);
    const bob = live.result.rows[0];
    await users.insert({ id: 'c', name: 'cy', age: 60 });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b', 'c']);
    assert.strictEqual(live.result.rows[0], bob,
      're-run reuses value-equal previous rows — sharing survives the mode');
    assert.strictEqual(live.stats().reruns, 1);
    await store.close();
  });

  it("demanding 'incremental' on a re-run shape refuses with JD0051", async () => {
    const store = await open();
    await assert.rejects(
      () => store.collection('users').live(
        [{ $for: { it: '$[*]' }, $where: { $gt: [{ $add: ['$it.age', 1] }, 30] }, $return: '$it' }],
        { mode: 'incremental' }),
      (error) => /** @type {any} */ (error).code === 'JD0051');
    await store.close();
  });

  it("mode 'rerun' forces re-run for a maintainable shape", async () => {
    const store = await open();
    const live = await store.collection('users').live([WHERE_ADULT], { mode: 'rerun' });
    assert.deepStrictEqual(live.mode,
      { strategy: 'rerun', mode: 'rerun', reason: 'rerun was requested' });
    await store.close();
  });

  it('live queries without capture refuse with JD0050', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    assert.strictEqual(store.capabilities.live, false);
    await assert.rejects(() => store.collection('users').live([WHERE_ADULT]),
      (error) => /** @type {any} */ (error).code === 'JD0050');
    await store.close();
  });
});

describe('entity live queries re-run (declared, not attempted)', () => {
  const ENTITY_MODEL = {
    $model: '0.1',
    entities: {
      User: {
        schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' } } },
      },
      Post: {
        schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          author: { type: 'string' },
          authorRef: { 'x-entity': { relation: { to: 'User', via: 'author', onDelete: 'cascade' } } } } },
      },
    },
  };

  it('a multi-entity document maintains through re-runs; unrelated entities are pruned', async () => {
    const store = await openStore(ENTITY_MODEL,
      { driver: nodeDriver(), capture: true });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await store.entity('Post').create({ id: 'p1', author: 'u1' });
    const live = await store.live({ User: [{ $for: { u: '$.User[*]' }, $return: '$u.name' }] });
    assert.deepStrictEqual(live.mode, {
      strategy: 'rerun', mode: 'rerun',
      reason: 'entity dependency plan: only a FLWOR over entity arrays is translated',
    });
    assert.deepStrictEqual(live.result.rows, [{ User: ['ada'] }]);
    await store.entity('User').create({ id: 'u2', name: 'bob' });
    assert.deepStrictEqual(live.result.rows, [{ User: ['ada', 'bob'] }]);
    const before = live.stats().reruns;
    await store.entity('Post').create({ id: 'p2', author: 'u2' });
    assert.strictEqual(live.stats().reruns, before,
      'a Post write does not re-run a User-only document');
    await store.close();
  });

  it('a document naming no entity root is API misuse', async () => {
    const store = await openStore(ENTITY_MODEL,
      { driver: nodeDriver(), capture: true });
    await assert.rejects(() => store.live([WHERE_ADULT]), TypeError);
    await store.close();
  });

  it('registration is admitted at the store gate: no initial result before an open transaction settles, a rolled-back row never appears, a committed one appears once', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver(), capture: true });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    const NAMES = { User: [{ $for: { u: '$.User[*]' }, $orderby: ['$u.name'], $return: '$u.name' }] };
    const settledWithin = (promise, ms = 25) => Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
    let release = () => {};
    // rollback: the staged row is never the initial result
    const undone = store.transaction(async (tx) => {
      await tx.entity('User').create({ id: 'u2', name: 'bob' });
      await new Promise((resolve) => { release = resolve; });
      throw new Error('undo');
    }).catch(() => 'rolled back');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const registering = store.live(NAMES);
    assert.strictEqual(await settledWithin(registering), false, 'the initial query waits for the open transaction');
    release();
    assert.strictEqual(await undone, 'rolled back');
    const live = await registering;
    assert.deepStrictEqual(live.result.rows, [{ User: ['ada'] }], 'the rolled-back row never appears');
    // commit: the row appears exactly once, through the registration's own initial query
    const kept = store.transaction(async (tx) => {
      await tx.entity('User').create({ id: 'u3', name: 'cyd' });
      await new Promise((resolve) => { release = resolve; });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.live(NAMES);
    assert.strictEqual(await settledWithin(second), false);
    release();
    await kept;
    const committed = await second;
    assert.deepStrictEqual(committed.result.rows, [{ User: ['ada', 'cyd'] }]);
    assert.deepStrictEqual(live.result.rows, [{ User: ['ada', 'cyd'] }], 'the earlier registration was maintained by the commit');
    assert.strictEqual(store.stats().liveQueries, 2);
    // a refused registration leaves the registry unchanged
    await assert.rejects(() => store.live([WHERE_ADULT]), TypeError);
    await assert.rejects(() => store.live({ Nope: [{ $for: { n: '$.Nope[*]' }, $return: '$n' }] }));
    assert.strictEqual(store.stats().liveQueries, 2);
    live.close();
    committed.close();
    await store.close();
  });
});

describe('the maintenance oracle (seeded)', () => {
  const multiset = (rows) => rows.map((row) => JSON.stringify(row)).sort();

  it('every strategy equals a fresh re-query after every mutation', async () => {
    const store = await open();
    const users = store.collection('users');
    const rand = mulberry32(0x11fe19);
    const DEPTS = ['x', 'y', 'z', null];

    const documents = {
      rows: [WHERE_ADULT],
      projected: [{ $for: { it: '$[*]' }, $where: { $lt: ['$it.age', 50] },
        $return: { who: '$it.name', pay: '$it.pay' } }],
      count: { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 18] }, $return: '$it' } },
      sum: { $sum: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 18] }, $return: '$it.pay' } },
      avg: { $avg: { $for: { it: '$[*]' }, $return: '$it.pay' } },
      min: { $min: { $for: { it: '$[*]' }, $return: '$it.pay' } },
      max: { $max: { $for: { it: '$[*]' }, $return: '$it.pay' } },
      group: [{
        $for: { it: '$[*]' }, $groupby: { g: '$it.dept' },
        $return: { key: { $default: ['$g', null] }, n: { $count: '$it' },
          total: { $sum: '$it.pay' }, top: { $max: '$it.pay' } },
      }],
      rerun: [{ $for: { it: '$[*]' },
        $where: { $gt: [{ $add: ['$it.pay', 0] }, 25] }, $return: '$it' }],
    };
    /** @type {Record<string, any>} */
    const lives = {};
    /** @type {Record<string, any>} */
    const mirrors = {};
    for (const [label, document] of Object.entries(documents)) {
      lives[label] = await users.live(document);
      mirrors[label] = lives[label].result;
      lives[label].subscribe(({ patch }) => {
        mirrors[label] = applyJSONPatch(mirrors[label], patch);
      });
    }

    const KEYS = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    const present = new Set();
    const randomDoc = (id) => ({
      id,
      name: `n${Math.floor(rand() * 100)}`,
      age: Math.floor(rand() * 60),
      pay: Math.floor(rand() * 100),
      ...(rand() < 0.8 ? { dept: DEPTS[Math.floor(rand() * DEPTS.length)] ?? undefined } : {}),
    });

    for (let step = 0; step < 160; step++) {
      const id = KEYS[Math.floor(rand() * KEYS.length)];
      const roll = rand();
      if (roll < 0.45) {
        const doc = JSON.parse(JSON.stringify(randomDoc(id)));
        if (present.has(id)) await users.put(doc, id);
        else await users.insert(doc);
        present.add(id);
      }
      else if (roll < 0.65 && present.has(id)) {
        await users.delete(id);
        present.delete(id);
      }
      else if (roll < 0.8) {
        await store.transaction(async (tx) => {
          const inside = tx.collection('users');
          const first = JSON.parse(JSON.stringify(randomDoc('txA')));
          const second = JSON.parse(JSON.stringify(randomDoc('txB')));
          if (present.has('txA')) await inside.put(first, 'txA');
          else await inside.insert(first);
          if (present.has('txB')) await inside.put(second, 'txB');
          else await inside.insert(second);
          present.add('txA').add('txB');
        });
      }
      else if (present.has(id)) {
        await users.patch(id, [{ op: 'replace', path: '/pay', value: Math.floor(rand() * 100) }]);
      }

      for (const [label, live] of Object.entries(lives)) {
        const fresh = await users.execute(documents[label]);
        const expected = fresh === undefined ? []
          : Array.isArray(documents[label]) ? fresh : [fresh];
        const actual = live.result.rows;
        assert.deepStrictEqual(multiset(actual), multiset(expected),
          `[${label}] diverged from the re-query at step ${step}`);
        assert.deepStrictEqual(mirrors[label], live.result,
          `[${label}] the patch mirror diverged at step ${step}`);
      }
    }
    const stats = Object.fromEntries(
      Object.entries(lives).map(([label, live]) => [label, live.stats().emissions]));
    for (const label of Object.keys(documents)) {
      assert.ok(stats[label] > 10, `[${label}] the oracle actually exercised emissions`);
    }
    await store.close();
  });
});
