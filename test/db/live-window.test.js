//@ts-check
/**
 * @file The maintained ordered window (LIVE-FORMAT §7's window row,
 * `window.js`): inserts inside, outside and AT the boundary of a full
 * window, deterministic ties through the key tiebreaker, a delete
 * inside the window sliding the successor in without a re-query,
 * updates that move a row across the boundary, descending terms,
 * absent sort values under `$empty`, the unbounded ordered query, and
 * a seeded oracle that checks EXACT order — the documented total
 * order: declared terms, then the key's text, ascending. Offset windows
 * (with and without a limit, nested windows composed as the planner
 * composes them) are maintained too, and a second seeded trial runs
 * them through three-write transactions and rollbacks; bounds that are
 * not literal non-negative integers, windowed groups, distinct
 * projections, aggregates and nested groups re-run, named, and so do
 * returns a row cannot answer alone (several items per row, a read of
 * the collection root, a registered operator).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { queryJson } from '@jarenjs/json/query';
import { createJsltRegistry, financePack } from '@jarenjs/json/jslt';
import { openStore, compareCodepoint } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';

const MODEL = {
  $model: '0.1',
  collections: {
    scores: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, points: { type: 'integer' },
        name: { type: 'string' }, history: { type: 'array', items: { type: 'integer' } } } },
      key: '/id',
      indexes: [{ name: 'by_points', path: '$.points' }],
    },
  },
};

const open = () => openStore(MODEL, { driver: nodeDriver(), capture: true });
const TOP3 = [{ $subsequence: [{
  $for: { it: '$[*]' },
  $orderby: { $key: '$it.points' },
  $return: '$it',
}, 0, 3] }];

/**
 * The documented total order over one `points` term, recomputed
 * independently of the window: an absent value is the least unless
 * `emptyGreatest`, `desc` reverses the term, and ties fall to the key's
 * text in code-point order, always ascending.
 * @param {{ desc?: boolean, emptyGreatest?: boolean }} shape
 * @returns {(a: any, b: any) => number}
 */
const totalOrder = (shape) => (a, b) => {
  const av = a.points;
  const bv = b.points;
  if (av !== bv) {
    const cmp = av === undefined || bv === undefined
      ? (av === undefined ? -1 : 1) * (shape.emptyGreatest ? -1 : 1)
      : av < bv ? -1 : 1;
    return shape.desc ? -cmp : cmp;
  }
  return compareCodepoint(String(a.id), String(b.id));
};

/**
 * A shape's windows (`[offset, limit]`, innermost first) applied one
 * after another to the rows in their total order.
 * @param {{ windows: [number, number | null][] }} shape
 * @param {any[]} sorted
 */
const applyWindows = (shape, sorted) => shape.windows.reduce(
  (rows, [offset, limit]) => rows.slice(offset, limit === null ? undefined : offset + limit), sorted);

/**
 * The live document of a shape: the phrase ordered by `points` inside
 * its windows, innermost first.
 * @param {{ windows: [number, number | null][], desc?: boolean, emptyGreatest?: boolean }} shape
 * @param {any} $return
 */
const windowDocument = (shape, $return) => [shape.windows.reduce(
  (phrase, [offset, limit]) => ({ $subsequence: limit === null ? [phrase, offset] : [phrase, offset, limit] }),
  /** @type {any} */ ({
    $for: { it: '$[*]' },
    $orderby: { $key: '$it.points', ...(shape.desc ? { $dir: 'desc' } : {}),
      ...(shape.emptyGreatest ? { $empty: 'greatest' } : {}) },
    $return,
  }))];

describe('the maintained window', () => {
  it('enforces retained-row credits when an insert leaves the visible window unchanged', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 2 } });
    try {
      const scores = store.collection('scores');
      await scores.insert({ id: 'a', points: 0 });
      const live = await scores.live([{ $subsequence: [TOP3[0].$subsequence[0], 0, 1] }]);
      const events = [];
      live.subscribe((event) => events.push(event));
      await scores.insert({ id: 'z1', points: 1 });
      await scores.insert({ id: 'z2', points: 2 });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].error.code, 'JD2060');
      assert.strictEqual(store.stats().liveQueries, 0);
      assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a']);
    }
    finally { await store.close(); }
  });
  it('inserts inside, outside and at the boundary of a full window', async () => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, points] of [['a', 10], ['b', 20], ['c', 30], ['d', 40]]) {
      await scores.insert({ id, points });
    }
    const live = await scores.live(TOP3);
    assert.deepStrictEqual(live.mode, { strategy: 'window', mode: 'incremental' });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'b', 'c']);
    const events = [];
    live.subscribe((event) => events.push(event));

    await scores.insert({ id: 'e', points: 99 });
    assert.strictEqual(events.length, 0,
      'an insert sorting beyond a full window emits nothing');

    await scores.insert({ id: 'f', points: 15 }); // inside: evicts c
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'f', 'b']);
    assert.deepStrictEqual(events[0].patch, [
      { op: 'remove', path: '/rows/2' },
      { op: 'add', path: '/rows/1', value: { id: 'f', points: 15 } },
    ]);

    await scores.insert({ id: 'g', points: 20 }); // boundary tie with b: key g > b → outside
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'f', 'b'],
    'a boundary tie resolves by key — g sorts after b and stays outside');
    await store.close();
  });

  it('a delete inside the window slides the successor in — no re-query', async () => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, points] of [['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50]]) {
      await scores.insert({ id, points });
    }
    const live = await scores.live(TOP3);
    const events = [];
    live.subscribe((event) => events.push(event));
    await scores.delete('b');
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'c', 'd'],
      'd slid in from beyond the visible boundary');
    assert.deepStrictEqual(events[0].patch, [
      { op: 'remove', path: '/rows/1' },
      { op: 'add', path: '/rows/2', value: { id: 'd', points: 40 } },
    ]);
    await store.close();
  });

  it('an update moves a row across the boundary in both directions', async () => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, points] of [['a', 10], ['b', 20], ['c', 30], ['d', 40]]) {
      await scores.insert({ id, points });
    }
    const live = await scores.live(TOP3);
    await scores.put({ id: 'a', points: 100 }, 'a'); // leaves the window
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b', 'c', 'd']);
    await scores.put({ id: 'a', points: 25 }, 'a'); // comes back mid-window
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b', 'a', 'c']);
    await store.close();
  });

  it('ties are deterministic: equal sort values order by key, ascending, always', async () => {
    const store = await open();
    const scores = store.collection('scores');
    // inserted in scrambled key order, all the same points
    for (const id of ['m', 'c', 'x', 'a']) await scores.insert({ id, points: 7 });
    const live = await scores.live(TOP3);
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'c', 'm'],
      'the initial fill already wears the key tie order, not insertion order');
    await scores.insert({ id: 'b', points: 7 });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['a', 'b', 'c']);
    await store.close();
  });

  it('descending order and a filtered window maintain together', async () => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, points] of [['a', 10], ['b', 20], ['c', 30], ['d', 5]]) {
      await scores.insert({ id, points });
    }
    const live = await scores.live([{ $subsequence: [{
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.points', 8] },
      $orderby: { $key: '$it.points', $dir: 'desc' },
      $return: '$it',
    }, 0, 2] }]);
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['c', 'b']);
    await scores.put({ id: 'd', points: 95 }, 'd'); // flips into the filter, tops the order
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['d', 'c']);
    await scores.put({ id: 'c', points: 6 }, 'c'); // drops out of the filter
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['d', 'b']);
    await store.close();
  });

  it('an unbounded ordered query maintains the whole sorted result', async () => {
    const store = await open();
    const scores = store.collection('scores');
    await scores.insert({ id: 'b', points: 2 });
    await scores.insert({ id: 'a', points: 9 });
    const live = await scores.live([{
      $for: { it: '$[*]' }, $orderby: { $key: '$it.points' }, $return: '$it' }]);
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b', 'a']);
    await scores.insert({ id: 'c', points: 5 });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['b', 'c', 'a']);
    await store.close();
  });

  it('a projected window emits the projection, ordered by the source', async () => {
    const store = await open();
    const scores = store.collection('scores');
    await scores.insert({ id: 'a', points: 30, name: 'ada' });
    await scores.insert({ id: 'b', points: 10, name: 'bob' });
    const live = await scores.live([{ $subsequence: [{
      $for: { it: '$[*]' },
      $orderby: { $key: '$it.points' },
      $return: { who: '$it.name' },
    }, 0, 2] }]);
    assert.deepStrictEqual(live.result.rows, [{ who: 'bob' }, { who: 'ada' }]);
    await scores.insert({ id: 'c', points: 20, name: 'cy' });
    assert.deepStrictEqual(live.result.rows, [{ who: 'bob' }, { who: 'cy' }]);
    await store.close();
  });

  it('an order term that indexes an array from its end sorts by the item execute reads', async () => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, history] of [['a', [5, 1]], ['b', [2, 9]], ['c', [7, 4]]]) {
      await scores.insert({ id, points: 0, history });
    }
    const document = [{ $for: { it: '$[*]' }, $orderby: ['$it.history[-1]', '$it.id'], $return: '$it.id' }];
    const live = await scores.live(document);
    assert.deepStrictEqual(live.mode, { strategy: 'window', mode: 'incremental' });
    assert.deepStrictEqual(await scores.execute(document), ['a', 'c', 'b']);
    assert.deepStrictEqual(live.result.rows, ['a', 'c', 'b']);
    await scores.put({ id: 'b', points: 0, history: [9, 0] });
    assert.deepStrictEqual(await scores.execute(document), ['b', 'a', 'c']);
    assert.deepStrictEqual(live.result.rows, ['b', 'a', 'c']);
    await store.close();
  });

  it('an order term over a member named like an inherited method reads only the row\'s own member', async () => {
    const store = await openStore({ $model: '0.1', collections: { rows: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, valueOf: { type: 'integer' }, constructor: { type: 'string' } } } } } },
    { driver: nodeDriver(), capture: true });
    try {
      const rows = store.collection('rows');
      await rows.insert({ id: 'a', valueOf: 5, constructor: 'm' });
      await rows.insert({ id: 'b', valueOf: 1, constructor: 'z' });
      const documents = [
        [{ $for: { it: '$[*]' }, $orderby: ['$it.valueOf', '$it.id'], $return: '$it.id' }],
        [{ $for: { it: '$[*]' }, $orderby: [{ $key: '$it.constructor', $empty: 'greatest' }, '$it.id'], $return: '$it.id' }],
      ];
      const lives = [];
      for (const document of documents) lives.push(await rows.live(document));
      // the row lacks both members: an absent sort value, not Object.prototype's
      await rows.insert({ id: 'c' });
      assert.deepStrictEqual(await rows.execute(documents[0]), ['c', 'b', 'a']);
      assert.deepStrictEqual(await rows.execute(documents[1]), ['a', 'b', 'c']);
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.mode, { strategy: 'window', mode: 'incremental' });
        assert.deepStrictEqual(live.result.rows, await rows.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('the seeded window oracle: EXACT order equals the documented total order', async () => {
    const store = await open();
    const scores = store.collection('scores');
    const rand = mulberry32(0x11fe20);
    const KEYS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
    const present = new Set();

    // top-k, unbounded descending, offset windows with and without a
    // limit, absent values greatest, and a window nested in another
    const shapes = [
      { windows: [[0, 3]] },
      { windows: [], desc: true },
      { windows: [[2, 3]] },
      { windows: [[1, null]], desc: true },
      { windows: [[3, 2]], emptyGreatest: true },
      { windows: [[1, 3], [1, 5]] },
    ];
    const lives = [];
    for (const shape of /** @type {any[]} */ (shapes)) {
      const live = await scores.live(windowDocument(shape, '$it'));
      assert.deepStrictEqual(live.mode, { strategy: 'window', mode: 'incremental' });
      let mirror = live.result;
      live.subscribe(({ patch }) => {
        mirror = applyJSONPatch(mirror, patch);
      });
      lives.push({ live, shape, mirror: () => mirror });
    }

    // the documented total order, recomputed independently in the test
    const expectedRows = async (shape) => {
      const all = await scores.execute(
        [{ $for: { it: '$[*]' }, $return: '$it' }]);
      return applyWindows(shape, [.../** @type {any[]} */ (all)].sort(totalOrder(shape)));
    };

    for (let step = 0; step < 120; step++) {
      const id = KEYS[Math.floor(rand() * KEYS.length)];
      const roll = rand();
      if (roll < 0.5) {
        // ties are likely by construction: few distinct point values,
        // and a sixth of the rows carry none
        const points = Math.floor(rand() * 6);
        const doc = points === 5 ? { id } : { id, points };
        if (present.has(id)) await scores.put(doc, id);
        else scores.insert && await scores.insert(doc);
        present.add(id);
      }
      else if (roll < 0.7 && present.has(id)) {
        await scores.delete(id);
        present.delete(id);
      }
      else if (present.has(id)) {
        await scores.patch(id, [{ op: 'add', path: '/points', value: Math.floor(rand() * 5) }]);
      }
      for (const { live, shape, mirror } of lives) {
        const expected = await expectedRows(shape);
        assert.deepStrictEqual(live.result.rows, expected,
          `[${JSON.stringify(shape)}] order diverged at step ${step}`);
        assert.deepStrictEqual(mirror(), live.result,
          `[${JSON.stringify(shape)}] mirror diverged at step ${step}`);
      }
    }
    await store.close();
  });
});

describe('offset windows', () => {
  // points b 1, c 3, d 3, a 5, e 9: c and d tie and order by key
  const F = { $for: { it: '$[*]' }, $orderby: { $key: '$it.points' }, $return: '$it.id' };
  const MAINTAINED = { strategy: 'window', mode: 'incremental' };
  const seeded = async (rows = [['a', 5], ['b', 1], ['c', 3], ['d', 3], ['e', 9]]) => {
    const store = await open();
    const scores = store.collection('scores');
    for (const [id, points] of rows) await scores.insert({ id, points });
    return { store, scores };
  };
  /** Demand incrementality, then follow one insert above every offset
   * below (`f` at points 2), checking the rows against `execute`. */
  const maintains = async (document, before, after) => {
    const { store, scores } = await seeded();
    try {
      (await scores.live(document, { mode: 'incremental' })).close();
      const live = await scores.live(document);
      assert.deepStrictEqual(live.mode, MAINTAINED);
      assert.deepStrictEqual(live.result.rows, before);
      assert.deepStrictEqual(await scores.execute(document), before);
      const events = [];
      live.subscribe((event) => events.push(event));
      await scores.insert({ id: 'f', points: 2 });
      assert.deepStrictEqual(live.result.rows, after);
      assert.deepStrictEqual(await scores.execute(document), after);
      assert.strictEqual(events.length, 1, 'one committed change, one emission');
    }
    finally { await store.close(); }
  };

  it('an offset window over an orderBy is maintained, and incremental mode accepts it', async () => {
    await maintains([{ $subsequence: [F, 1, 2] }], ['c', 'd'], ['f', 'c']);
  });

  it('an offset with no limit keeps every row past it', async () => {
    await maintains([{ $subsequence: [F, 2] }], ['d', 'a', 'e'], ['c', 'd', 'a', 'e']);
  });

  it('nested windows compose as the planner composes them: an outer offset counts within the inner window', async () => {
    await maintains([{ $subsequence: [{ $subsequence: [F, 1, 3] }, 1, 5] }], ['d', 'a'], ['c', 'd']);
    const { store, scores } = await seeded(
      Array.from({ length: 20 }, (_, i) => [`r${String(i).padStart(2, '0')}`, i]));
    try {
      const document = [{ $subsequence: [{ $subsequence: [F, 2, 5] }, 4, 10] }];
      const live = await scores.live(document);
      assert.deepStrictEqual(live.mode, MAINTAINED);
      assert.deepStrictEqual(live.result.rows, ['r06']);
      await scores.insert({ id: 'x', points: -1 }); // every row shifts one place
      assert.deepStrictEqual(live.result.rows, ['r05']);
      assert.deepStrictEqual(await scores.execute(document), ['r05']);
    }
    finally { await store.close(); }
  });

  it('a window bound that is not a non-negative integer re-runs with the planner reason', async () => {
    const { store, scores } = await seeded();
    try {
      const documents = [
        [{ $subsequence: [F, 1.5, 2] }],
        [{ $subsequence: [F, 0, 2.5] }],
        [{ $subsequence: [F, -1, 2] }],
      ];
      const lives = [];
      for (const document of documents) {
        const live = await scores.live(document);
        assert.deepStrictEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
          reason: "'$subsequence' — window bounds must be literal numbers to push (non-negative integers)" });
        lives.push(live);
      }
      await scores.insert({ id: 'f', points: 2 });
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.result.rows, await scores.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('an offset over a group, a distinct projection, an aggregate or a nested group still re-runs beside a maintained offset window', async () => {
    const { store, scores } = await seeded();
    try {
      const cases = [
        [[{ $subsequence: [F, 1, 2] }], MAINTAINED],
        [[{ $subsequence: [{ $for: { it: '$[*]' }, $groupby: { g: '$it.name' },
          $return: { key: '$g', n: { $count: '$it' } } }, 1, 2] }],
        { strategy: 'rerun', mode: 'rerun', reason: 'a windowed group re-runs' }],
        [[{ $subsequence: [{ $distinct: { $for: { it: '$[*]' }, $return: '$it.name' } }, 1, 2] }],
          { strategy: 'rerun', mode: 'rerun',
            reason: 'this grouping or distinct projection needs set-level maintenance' }],
        [[{ $count: { $subsequence: [F, 1, 2] } }],
          { strategy: 'rerun', mode: 'rerun', reason: 'a windowed aggregate maintains no accumulator' }],
      ];
      for (const [document, mode] of cases) {
        const live = await scores.live(document);
        assert.deepStrictEqual(live.mode, mode);
        live.close();
      }
      const nested = await scores.live([{ $subsequence: [{ $for: { row: '$[*]' },
        $groupby: { name: '$row.name' },
        $return: { name: '$name', points: [{ $for: { leaf: '$row' }, $groupby: { p: '$leaf.points' },
          $return: { p: '$p', n: { $count: '$leaf' } } }] } }, 1, 3] }]);
      assert.strictEqual(nested.mode.strategy, 'rerun');
      assert.ok(typeof nested.mode.reason === 'string' && nested.mode.reason.length > 0,
        'a nested group under an offset names its reason');
    }
    finally { await store.close(); }
  });

  it('enforces retained-row credits on an offset window: every matching row is an entry', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 2 } });
    try {
      const scores = store.collection('scores');
      await scores.insert({ id: 'a', points: 0 });
      await scores.insert({ id: 'b', points: 1 });
      const live = await scores.live([{ $subsequence: [F, 1, 1] }]);
      assert.deepStrictEqual(live.mode, MAINTAINED);
      const events = [];
      live.subscribe((event) => events.push(event));
      await scores.insert({ id: 'z1', points: 2 }); // past the visible row: unchanged
      await scores.insert({ id: 'z2', points: 3 });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].error.code, 'JD2060');
      assert.strictEqual(store.stats().liveQueries, 0);
      assert.deepStrictEqual(live.result.rows, ['b']);
    }
    finally { await store.close(); }
  });

  it('an offset window over more matching rows than live.maxMaintained refuses JD2060 as a top window does; mode rerun serves it', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 5 } });
    try {
      const scores = store.collection('scores');
      for (let i = 0; i < 6; i++) await scores.insert({ id: `r${i}`, points: i });
      const document = [{ $subsequence: [F, 4, 2] }];
      for (const windowed of [document, [{ $subsequence: [F, 0, 2] }]]) {
        await assert.rejects(() => scores.live(windowed), { code: 'JD2060' });
      }
      assert.strictEqual(store.stats().liveQueries, 0);
      const rerun = await scores.live(document, { mode: 'rerun' });
      assert.deepStrictEqual(rerun.result.rows, ['r4', 'r5']);
      assert.strictEqual(store.stats().liveQueries, 1);
    }
    finally { await store.close(); }
  });

  it('a bound quoted with $const is the same literal: maintained at every nesting level', async () => {
    for (const [document, before, after] of [
      [[{ $subsequence: [F, { $const: 0 }, 2] }], ['b', 'c'], ['b', 'f']],
      [[{ $subsequence: [F, { $const: 1 }, 2] }], ['c', 'd'], ['f', 'c']],
      [[{ $subsequence: [F, 1, { $const: 2 }] }], ['c', 'd'], ['f', 'c']],
      [[{ $subsequence: [{ $subsequence: [F, 1, 3] }, { $const: 1 }, 5] }], ['d', 'a'], ['c', 'd']],
      [[{ $subsequence: [{ $subsequence: [F, { $const: 1 }, 3] }, 1, 5] }], ['d', 'a'], ['c', 'd']],
    ]) await maintains(document, before, after);
  });

  it('an ordered return yielding several items per row re-runs, windowed or not', async () => {
    const store = await open();
    try {
      const scores = store.collection('scores');
      for (const row of [{ id: 'a', points: 5, tags: ['x', 'y'] }, { id: 'b', points: 1, tags: [] },
        { id: 'c', points: 3, tags: ['z'] }, { id: 'd', points: 3, tags: ['p', 'q', 'r'] }, { id: 'e', points: 9 }]) {
        await scores.insert(row);
      }
      const many = { $for: { it: '$[*]' }, $orderby: { $key: '$it.points' }, $return: '$it.tags[*]' };
      const documents = [[{ $subsequence: [many, 1, 2] }], [{ $subsequence: [many, 0, 3] }], [many]];
      const lives = [];
      for (const document of documents) {
        const live = await scores.live(document);
        assert.deepStrictEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
          reason: 'a one-to-many projection under an order re-runs' });
        assert.deepStrictEqual(live.result.rows, await scores.execute(document));
        lives.push(live);
      }
      await scores.insert({ id: 'f', points: 2, tags: ['s', 't'] });
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.result.rows, await scores.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('an ordered return that reads the collection root re-runs: one row alone is not the collection', async () => {
    const { store, scores } = await seeded();
    try {
      const documents = [
        [{ $subsequence: [{ ...F, $return: { id: '$it.id', n: { $count: '$[*]' } } }, 1, 2] }],
        [{ $subsequence: [{ ...F, $return: { id: '$it.id', first: '$[0].id' } }, 0, 2] }],
      ];
      const lives = [];
      for (const document of documents) {
        const live = await scores.live(document);
        assert.deepStrictEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
          reason: 'a projection that reads the collection root re-runs (a row is evaluated alone)' });
        assert.deepStrictEqual(live.result.rows, await scores.execute(document));
        lives.push(live);
      }
      await scores.insert({ id: 'f', points: 2 });
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.result.rows, await scores.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('a return the live evaluator cannot compile alone (a registered operator) re-runs, named, instead of refusing registration', async () => {
    const DEALS = { $model: '0.1', collections: { deals: {
      schema: { type: 'object', properties: { id: { type: 'string' }, rate: { type: 'number' },
        cashflows: { type: 'array', items: { type: 'number' } } } },
      key: '/id', indexes: [{ name: 'by_rate', path: '$.rate' }] } } };
    const store = await openStore(DEALS, { driver: nodeDriver(), capture: true,
      operators: createJsltRegistry().use(financePack) });
    try {
      const deals = store.collection('deals');
      await deals.insert({ id: 'a', rate: 0.1, cashflows: [-1000, 300, 400, 500, 300] });
      await deals.insert({ id: 'c', rate: 0.08, cashflows: [-2000, 900, 900, 900] });
      await deals.insert({ id: 'd', rate: 0.05, cashflows: [-300, 200, 200] });
      const npv = { $for: { it: '$[*]' }, $orderby: { $key: '$it.rate' },
        $return: { id: '$it.id', npv: { $npv: ['$it.rate', '$it.cashflows[*]'] } } };
      const documents = [[{ $subsequence: [npv, 1, 2] }], [{ $subsequence: [npv, 0, 2] }], [npv]];
      const lives = [];
      for (const document of documents) {
        const live = await deals.live(document);
        assert.strictEqual(live.mode.strategy, 'rerun');
        assert.match(String(live.mode.reason), /registered operator '\$npv'/);
        assert.deepStrictEqual(live.result.rows, await deals.execute(document));
        lives.push(live);
      }
      await deals.insert({ id: 'b', rate: 0.07, cashflows: [-500, 100, 100] });
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.result.rows, await deals.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('an ordered query inside a one-item array constructor re-runs: its one row is the whole ordered array', async () => {
    const { store, scores } = await seeded();
    try {
      const documents = [[[F]], [[{ $subsequence: [F, 0, 2] }]], [[{ $subsequence: [F, 1, 2] }]]];
      const lives = [];
      for (const document of documents) {
        const live = await scores.live(document);
        assert.strictEqual(live.mode.strategy, 'rerun');
        assert.deepStrictEqual(live.result.rows, await scores.execute(document));
        lives.push(live);
      }
      await scores.insert({ id: 'f', points: 2 });
      for (const [index, live] of lives.entries()) {
        assert.deepStrictEqual(live.result.rows, await scores.execute(documents[index]));
      }
    }
    finally { await store.close(); }
  });

  it('seeded offset windows: single writes, three-write transactions and rollbacks keep the documented total order', async () => {
    const rand = mulberry32(0x0ff5e7);
    const KEYS = Array.from({ length: 9 }, (_, i) => `k${i}`);
    const RETURN = { id: '$it.id', p: '$it.points' };
    // the engine's projection of rows already in the reference order
    const project = (rows) => queryJson([{ $for: { it: '$[*]' }, $return: RETURN }], rows) ?? [];
    for (let trial = 0; trial < 40; trial++) {
      /** @type {[number, number | null][]} */
      const windows = [];
      for (let depth = rand() < 0.3 ? 2 : 1; depth > 0; depth--) {
        windows.push([Math.floor(rand() * 4), rand() < 0.25 ? null : 1 + Math.floor(rand() * 4)]);
      }
      const shape = { windows, desc: rand() < 0.5, emptyGreatest: rand() < 0.5 };
      const store = await open();
      try {
        const scores = store.collection('scores');
        const live = await scores.live(windowDocument(shape, RETURN), { mode: 'incremental' });
        let mirror = live.result;
        let emissions = 0;
        const errors = [];
        live.subscribe(({ patch, error }) => {
          emissions++;
          if (error === undefined) mirror = applyJSONPatch(mirror, patch);
          else errors.push(error);
        });
        // one write: points 0–3 or none, or a delete
        const write = async (collection) => {
          const id = KEYS[Math.floor(rand() * KEYS.length)];
          if (rand() < 0.25) { await collection.delete(id); return; }
          const points = Math.floor(rand() * 5);
          await collection.put(points === 4 ? { id } : { id, points }, id);
        };
        for (let step = 0; step < 40; step++) {
          const label = `[${JSON.stringify(shape)}] trial ${trial} step ${step}`;
          const before = emissions;
          const roll = rand();
          if (roll < 0.15) {
            const undone = await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('scores'));
              throw new Error('undo');
            }).catch((error) => {
              // only the deliberate rollback: a store error is a failure
              if (error.message !== 'undo') throw error;
              return 'rolled back';
            });
            assert.strictEqual(undone, 'rolled back');
            assert.strictEqual(emissions, before, `${label}: a rolled-back transaction emits nothing`);
          }
          else if (roll < 0.45) {
            await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('scores'));
            });
          }
          else await write(scores);
          assert.ok(emissions - before <= 1, `${label}: one committed change, at most one emission`);
          assert.deepStrictEqual(errors, [], `${label}: no error event`);
          const all = await scores.execute([{ $for: { it: '$[*]' }, $return: '$it' }]);
          const expected = project(applyWindows(shape, [.../** @type {any[]} */ (all)].sort(totalOrder(shape))));
          assert.deepStrictEqual(live.result.rows, expected, `${label}: order diverged`);
          assert.deepStrictEqual(mirror, live.result, `${label}: mirror diverged`);
        }
        live.close();
      }
      finally { await store.close(); }
    }
  });
});
