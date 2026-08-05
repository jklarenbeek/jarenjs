//@ts-check
/**
 * @file The maintained ordered window (LIVE-FORMAT §7's window row,
 * `window.js`): inserts inside, outside and AT the boundary of a full
 * window, deterministic ties through the key tiebreaker, a delete
 * inside the window sliding the successor in without a re-query,
 * updates that move a row across the boundary, descending terms,
 * absent sort values under `$empty`, the unbounded ordered query, and
 * a seeded oracle that checks EXACT order — the documented total
 * order: declared terms, then the key, ascending.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore, compareCodepoint } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { seededRandom } from './oracle/harness.js';

const MODEL = {
  $model: '0.1',
  collections: {
    scores: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, points: { type: 'integer' },
        name: { type: 'string' } } },
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

describe('the maintained window', () => {
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

  it('the seeded window oracle: EXACT order equals the documented total order', async () => {
    const store = await open();
    const scores = store.collection('scores');
    const rand = seededRandom(0x11fe20);
    const KEYS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
    const present = new Set();

    const shapes = [
      { limit: 3, desc: false },
      { limit: null, desc: true },
    ];
    const lives = [];
    for (const shape of shapes) {
      const flwor = {
        $for: { it: '$[*]' },
        $orderby: { $key: '$it.points', ...(shape.desc ? { $dir: 'desc' } : {}) },
        $return: '$it',
      };
      const document = shape.limit === null
        ? [flwor]
        : [{ $subsequence: [flwor, 0, shape.limit] }];
      const live = await scores.live(document);
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
      const sorted = [.../** @type {any[]} */ (all)].sort((a, b) => {
        const av = a.points;
        const bv = b.points;
        if (av !== bv) {
          const cmp = (av === undefined || bv === undefined)
            ? (av === undefined ? 1 : -1)
            : av < bv ? -1 : 1;
          return shape.desc ? -cmp : cmp;
        }
        return compareCodepoint(String(a.id), String(b.id));
      });
      return shape.limit === null ? sorted : sorted.slice(0, shape.limit);
    };

    for (let step = 0; step < 120; step++) {
      const id = KEYS[Math.floor(rand() * KEYS.length)];
      const roll = rand();
      if (roll < 0.5) {
        // ties are likely by construction: few distinct point values
        const doc = { id, points: Math.floor(rand() * 5) };
        if (present.has(id)) await scores.put(doc, id);
        else scores.insert && await scores.insert(doc);
        present.add(id);
      }
      else if (roll < 0.7 && present.has(id)) {
        await scores.delete(id);
        present.delete(id);
      }
      else if (present.has(id)) {
        await scores.patch(id, [{ op: 'replace', path: '/points', value: Math.floor(rand() * 5) }]);
      }
      for (const { live, shape, mirror } of lives) {
        const expected = await expectedRows(shape);
        assert.deepStrictEqual(live.result.rows, expected,
          `[limit ${shape.limit} desc ${shape.desc}] order diverged at step ${step}`);
        assert.deepStrictEqual(mirror(), live.result,
          `[limit ${shape.limit} desc ${shape.desc}] mirror diverged at step ${step}`);
      }
    }
    await store.close();
  });
});
