//@ts-check
/**
 * @file The geofence (LIVE-FORMAT §7's spatial rows): a live query
 * whose `$where` is a spatial predicate over a derived index is
 * MAINTAINED per row — the fetch narrows through the pushed box or
 * cell range and every touched row is re-evaluated by the engine's
 * exact predicate — so a moving point emits `add` when it enters the
 * region, `remove` when it leaves, and nothing while it moves within.
 * Asserted on the emitted patches, never on a re-read. An ordering by
 * `$distance` and a spatial aggregate re-run with the reason named,
 * and a region that arrives as an external still narrows the initial
 * fetch through the index.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const INDEXES = [
  { name: 'by_box', path: '$.at', derive: 'bbox' },
  { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
];
const MODEL = (indexes = INDEXES) => ({
  $model: '0.1',
  collections: {
    places: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, at: { type: ['array', 'object'] },
        },
      },
      key: '/id',
      indexes,
    },
  },
});
const REGION = {
  type: 'Polygon',
  coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]],
};
const OUTSIDE_WEST = [3.5, 52.5];
const INSIDE = [4.5, 52.5];
const INSIDE_MOVED = [4.6, 52.6];
const OUTSIDE_EAST = [5.5, 52.5];

const open = (indexes) => openStore(MODEL(indexes), { driver: nodeDriver(), capture: true });
const flwor = (where, ret = '$it', extra = {}) =>
  ({ $for: { it: '$[*]' }, $where: where, ...extra, $return: ret });
const WITHIN_EXTERNAL = { $within: ['$it.at', '$region'] };

/** Register, collect emissions, and return both. */
async function watch(collection, document, externals) {
  const live = await collection.live([document], { externals });
  const events = [];
  live.subscribe((event) => events.push(event));
  return { live, events };
}

describe('the geofence — a moving point against a region', () => {
  it('emits add on entering, remove on leaving, and NOTHING while moving within', async () => {
    const store = await open();
    const places = store.collection('places');
    const { live, events } = await watch(places, flwor(WITHIN_EXTERNAL, '$it.id'), { region: REGION });
    assert.deepStrictEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
    assert.deepStrictEqual(live.result.rows, []);

    await places.insert({ id: 'van', name: 'delivery', at: OUTSIDE_WEST });
    assert.deepStrictEqual(events, [], 'a point outside the fence is silent');
    await places.put({ id: 'van', name: 'delivery', at: INSIDE }, 'van');
    await places.put({ id: 'van', name: 'delivery', at: INSIDE_MOVED }, 'van');
    await places.put({ id: 'van', name: 'delivery', at: OUTSIDE_EAST }, 'van');
    assert.deepStrictEqual(events.map((event) => event.patch), [
      [{ op: 'add', path: '/rows/0', value: 'van' }],
      [{ op: 'remove', path: '/rows/0' }],
    ], 'enter, (silent move within), leave');
    assert.deepStrictEqual(live.result.rows, []);
    // every write was delivered; only two changed the result
    assert.strictEqual(live.stats().records, 4);
    assert.strictEqual(live.stats().emissions, 2);
    await store.close();
  });

  it('with the whole document returned, a move within is a replace carrying the new position', async () => {
    const store = await open();
    const places = store.collection('places');
    await places.insert({ id: 'van', name: 'delivery', at: INSIDE });
    const { live, events } = await watch(places, flwor(WITHIN_EXTERNAL), { region: REGION });
    assert.deepStrictEqual(live.result.rows.map((row) => row.id), ['van']);
    await places.put({ id: 'van', name: 'delivery', at: INSIDE_MOVED }, 'van');
    assert.deepStrictEqual(events.map((event) => event.patch), [
      [{ op: 'replace', path: '/rows/0', value: { id: 'van', name: 'delivery', at: INSIDE_MOVED } }],
    ]);
    await store.close();
  });

  it('a bounded $distance is a circular fence, maintained the same way', async () => {
    const store = await open();
    const places = store.collection('places');
    const fence = flwor({ $le: [{ $distance: ['$it.at', INSIDE] }, 5_000] }, '$it.id');
    const { live, events } = await watch(places, fence, {});
    assert.deepStrictEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
    await places.insert({ id: 'bike', at: [4.52, 52.52] }); // ~2.6 km away
    await places.put({ id: 'bike', at: [4.6, 52.6] }, 'bike'); // ~13 km away
    assert.deepStrictEqual(events.map((event) => event.patch), [
      [{ op: 'add', path: '/rows/0', value: 'bike' }],
      [{ op: 'remove', path: '/rows/0' }],
    ]);
    await store.close();
  });

  it('a nine-cell neighbourhood fence (the proximity spelling) is maintained too', async () => {
    const store = await open();
    const places = store.collection('places');
    // the cell of [4.5, 52.5] at precision 6 and its eight neighbours
    const fence = flwor({ $exists: { '$index-of': [
      { '$geohash-neighbours': 'u174wm' }, { $geohash: ['$it.at', 6] }] } }, '$it.id');
    const { live, events } = await watch(places, fence, {});
    assert.deepStrictEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
    await places.insert({ id: 'bike', at: [4.5, 52.5] });
    await places.put({ id: 'bike', at: [4.6, 52.6] }, 'bike');
    assert.deepStrictEqual(events.map((event) => event.patch), [
      [{ op: 'add', path: '/rows/0', value: 'bike' }],
      [{ op: 'remove', path: '/rows/0' }],
    ]);
    await store.close();
  });

  it('demanding incremental mode is honoured for a refined spatial predicate', async () => {
    const store = await open();
    const places = store.collection('places');
    const live = await places.live([flwor(WITHIN_EXTERNAL)],
      { externals: { region: REGION }, mode: 'incremental' });
    assert.strictEqual(live.mode.mode, 'incremental');
    await store.close();
  });
});

describe('the geofence — what re-runs, and why', () => {
  it('an ordering by $distance re-runs, naming the ordering (not the refinement)', async () => {
    const store = await open();
    const places = store.collection('places');
    await places.insert({ id: 'a', at: [4.2, 52.2] });
    await places.insert({ id: 'b', at: [4.8, 52.8] });
    const nearest = flwor(WITHIN_EXTERNAL, '$it.id',
      { $orderby: [{ $key: { $distance: ['$it.at', [4.75, 52.75]] } }] });
    const { live, events } = await watch(places, nearest, { region: REGION });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.strictEqual(live.mode.strategy, 'rerun');
    assert.match(live.mode.reason, /^'\$orderby'/);
    assert.match(live.mode.reason, /ordering translates only over singular schema-typed paths/);
    assert.deepStrictEqual(live.result.rows, ['b', 'a']);
    await places.put({ id: 'a', at: [4.76, 52.76] }, 'a'); // now the nearest
    assert.deepStrictEqual(live.result.rows, ['a', 'b']);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(live.result.rows, await places.execute(nearest, { externals: { region: REGION } }));
    await store.close();
  });

  it('an ordering over a member beside a refinement re-runs with its own reason', async () => {
    const store = await open();
    const places = store.collection('places');
    const ordered = flwor(WITHIN_EXTERNAL, '$it.id', { $orderby: ['$it.name'] });
    const { live } = await watch(places, ordered, { region: REGION });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.match(live.mode.reason, /^'\$orderby' — an ordering over a refined spatial selection re-runs/);
    await store.close();
  });

  it('a spatial aggregate re-runs, saying why, and stays correct', async () => {
    const store = await open();
    const places = store.collection('places');
    const count = { $count: flwor(WITHIN_EXTERNAL) };
    const { live } = await watch(places, count, { region: REGION });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.match(live.mode.reason, /^a spatial aggregate re-runs/);
    assert.deepStrictEqual(live.result.rows, [0]);
    await places.insert({ id: 'a', at: INSIDE });
    await places.insert({ id: 'b', at: OUTSIDE_EAST });
    assert.deepStrictEqual(live.result.rows, [1]);
    await store.close();
  });

  it('a spatial predicate the planner REFUSED re-runs, naming the refusal', async () => {
    const store = await open([]); // no derived index: nothing to narrow through
    const places = store.collection('places');
    const { live } = await watch(places, flwor(WITHIN_EXTERNAL, '$it.id'), { region: REGION });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.match(live.mode.reason, /^'\$within' — no derived spatial index on this member/);
    await store.close();
  });

  it('the demanded incremental mode refuses an ordering by $distance with the reason', async () => {
    const store = await open();
    const places = store.collection('places');
    const nearest = flwor(WITHIN_EXTERNAL, '$it.id',
      { $orderby: [{ $key: { $distance: ['$it.at', [4.75, 52.75]] } }] });
    await assert.rejects(
      places.live([nearest], { externals: { region: REGION }, mode: 'incremental' }),
      (error) => error.code === 'JD0051' && /\$orderby/.test(error.message));
    await store.close();
  });
});

describe('the geofence — an external region', () => {
  it('narrows the initial fetch through the index and stays correct across maintenance', async () => {
    const store = await open();
    const places = store.collection('places');
    for (let i = 0; i < 40; i++) {
      // a grid across and beyond the region; roughly a quarter lands inside
      await places.insert({ id: `g${i}`, name: `n${i}`, at: [3.5 + (i % 8) * 0.3, 51.5 + Math.floor(i / 8) * 0.4] });
    }
    // the SQL-narrowed source the rows strategy initializes from is the
    // same document shape, so its plan is what the registration ran
    const explained = await places.explain(flwor(WITHIN_EXTERNAL), { externals: { region: REGION } });
    assert.match(explained.scanNarrative, /SEARCH places USING INDEX places_by_box/);
    assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.exact]), [['$within', false]]);
    assert.deepStrictEqual(explained.params.map((p) => p.derived?.external), ['region', 'region', 'region', 'region']);

    const { live, events } = await watch(places, flwor(WITHIN_EXTERNAL), { region: REGION });
    const fresh = async () => places.execute(flwor(WITHIN_EXTERNAL), { externals: { region: REGION } });
    assert.deepStrictEqual(live.result.rows, await fresh());
    assert.ok(live.result.rows.length > 0 && live.result.rows.length < 40);

    let mirror = live.result;
    live.subscribe(({ patch }) => { mirror = applyJSONPatch(mirror, patch); });
    await places.put({ id: 'g0', name: 'n0', at: INSIDE }, 'g0'); // enters
    await places.put({ id: 'g9', name: 'n9', at: OUTSIDE_WEST }, 'g9'); // may leave
    await places.delete('g10');
    await places.insert({ id: 'new', name: 'new', at: INSIDE_MOVED });
    await places.put({ id: 'new', name: 'renamed', at: INSIDE_MOVED }, 'new'); // replace in place
    const expected = await fresh();
    assert.deepStrictEqual([...live.result.rows].sort((a, b) => a.id.localeCompare(b.id)),
      [...expected].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepStrictEqual(mirror, live.result, 'a consumer rebuilt from the patches alone agrees');
    assert.ok(events.length >= 3);
    await store.close();
  });
});
