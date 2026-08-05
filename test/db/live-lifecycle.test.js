//@ts-check
/**
 * @file Live-query lifecycle and bounds (LIVE-FORMAT §12): `close()`
 * releases the registration and refuses further subscriptions while
 * the last result stays readable; closing the STORE closes every live
 * query first; both bounds fire as coded errors — `maxQueries` at
 * registration (JD0052), `maxMaintained` at registration or
 * mid-maintenance (JD2060, delivered to subscribers, then closed) —
 * never as silent degradation; a throwing subscriber is isolated; and
 * the leak proof: after closing, the measured live set (forced GC in
 * a subprocess) retains nothing of the maintained state.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, n: { type: 'integer' }, blob: { type: 'string' } } },
      key: '/id',
      indexes: [],
    },
  },
};
const ALL = [{ $for: { it: '$[*]' }, $return: '$it' }];

describe('lifecycle', () => {
  it('close() releases the registration; the last result stays readable', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const rows = store.collection('rows');
    await rows.insert({ id: 'a', n: 1 });
    const live = await rows.live(ALL);
    const events = [];
    live.subscribe((event) => events.push(event));
    assert.strictEqual(store.stats().liveQueries, 1);

    live.close();
    assert.strictEqual(live.state, 'closed');
    assert.strictEqual(store.stats().liveQueries, 0);
    await rows.insert({ id: 'b', n: 2 });
    assert.strictEqual(events.length, 0, 'a closed query maintains nothing');
    assert.deepStrictEqual(live.result.rows, [{ id: 'a', n: 1 }],
      'the last maintained result stays readable');
    assert.throws(() => live.subscribe(() => {}), /closed/);
    live.close(); // idempotent
    await store.close();
  });

  it('closing the store closes every live query', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const first = await store.collection('rows').live(ALL);
    const second = await store.collection('rows').live(ALL, { mode: 'rerun' });
    assert.strictEqual(store.stats().liveQueries, 2);
    await store.close();
    assert.strictEqual(first.state, 'closed');
    assert.strictEqual(second.state, 'closed');
  });

  it('a throwing subscriber is isolated from the write and its siblings', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const rows = store.collection('rows');
    const live = await rows.live(ALL);
    const seen = [];
    live.subscribe(() => { throw new Error('subscriber bug'); });
    const stop = live.subscribe((event) => seen.push(event.seq));
    await rows.insert({ id: 'a', n: 1 });
    assert.deepStrictEqual(seen, [1], 'the sibling still heard the emission');
    assert.deepStrictEqual(await rows.get('a'), { id: 'a', n: 1 },
      'the write itself was never at risk');
    stop();
    await rows.insert({ id: 'b', n: 1 });
    assert.deepStrictEqual(seen, [1], 'unsubscribed');
    await store.close();
  });
});

describe('bounds (coded, never degrading)', () => {
  it('maxQueries refuses the registration past the bound with JD0052', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: true, live: { maxQueries: 2 } });
    await store.collection('rows').live(ALL);
    const second = await store.collection('rows').live(ALL);
    await assert.rejects(() => store.collection('rows').live(ALL),
      (error) => /** @type {any} */ (error).code === 'JD0052'
        && /2/.test(/** @type {any} */ (error).message));
    second.close();
    await store.collection('rows').live(ALL); // a freed slot is usable again
    await store.close();
  });

  it('maxMaintained refuses an oversized registration with JD2060', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: true, live: { maxMaintained: 3 } });
    const rows = store.collection('rows');
    for (let i = 0; i < 5; i++) await rows.insert({ id: `r${i}`, n: i });
    await assert.rejects(() => rows.live(ALL),
      (error) => /** @type {any} */ (error).code === 'JD2060'
        && /3/.test(/** @type {any} */ (error).message));
    assert.strictEqual(store.stats().liveQueries, 0);
    await store.close();
  });

  it('crossing maxMaintained mid-maintenance delivers the error and CLOSES', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: true, live: { maxMaintained: 3 } });
    const rows = store.collection('rows');
    await rows.insert({ id: 'a', n: 1 });
    const live = await rows.live(ALL);
    const events = [];
    live.subscribe((event) => events.push(event));
    await rows.insert({ id: 'b', n: 2 });
    await rows.insert({ id: 'c', n: 3 });
    assert.strictEqual(live.state, 'live');
    await rows.insert({ id: 'd', n: 4 }); // the fourth entry crosses 3
    assert.strictEqual(live.state, 'errored');
    assert.strictEqual(/** @type {any} */ (live.error).code, 'JD2060');
    const last = events[events.length - 1];
    assert.strictEqual(/** @type {any} */ (last).error.code, 'JD2060',
      'subscribers heard the failure — degraded silence is forbidden');
    assert.strictEqual(store.stats().liveQueries, 0);
    // the store keeps working; the data was never at risk
    assert.deepStrictEqual((await rows.get('d')), { id: 'd', n: 4 });
    await store.close();
  });

  it('the accumulator state counts toward the bound (contributions are the cost)', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: true, live: { maxMaintained: 2 } });
    const rows = store.collection('rows');
    for (let i = 0; i < 3; i++) await rows.insert({ id: `r${i}`, n: i });
    await assert.rejects(
      () => rows.live({ $count: { $for: { it: '$[*]' }, $return: '$it' } }),
      (error) => /** @type {any} */ (error).code === 'JD2060',
      'a count maintains one contribution per row — the state is the cost');
    await store.close();
  });
});

describe('the leak proof', () => {
  it('closing releases the maintained state (measured live set after forced GC)', () => {
    const script = `
      import { openStore } from '@jarenjs/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const MODEL = ${JSON.stringify(MODEL)};
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
      const rows = store.collection('rows');
      const blob = 'x'.repeat(500);
      await store.transaction(async () => {
        for (let i = 0; i < 2000; i++) {
          await rows.insert({ id: 'r' + i, n: i, blob });
        }
      });
      const round = async () => {
        const live = await rows.live(
          [{ $for: { it: '$[*]' }, $return: '$it' }]);
        if (live.result.rows.length !== 2000) throw new Error('bad fill');
        live.close();
      };
      // one warm-up round puts the one-time allocations (statement
      // cache, compiled evaluators) INSIDE the baseline: what remains
      // is per-round retention, which must be zero
      await round();
      globalThis.gc();
      globalThis.gc();
      const baseline = process.memoryUsage().heapUsed;
      for (let i = 0; i < 8; i++) await round();
      globalThis.gc();
      globalThis.gc();
      console.log(JSON.stringify({
        delta: process.memoryUsage().heapUsed - baseline,
        open: store.stats().liveQueries,
      }));
      await store.close();
    `;
    const out = spawnSync(process.execPath,
      ['--expose-gc', '--no-warnings=ExperimentalWarning',
        '--input-type=module', '-e', script],
      { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    const measured = JSON.parse(out.stdout.trim().split('\n').pop() ?? '');
    assert.strictEqual(measured.open, 0);
    // eight closed 2000-row maintained results (~1 MB each if
    // retained) must leave the live set flat past the warmed baseline
    assert.ok(measured.delta < 1_500_000,
      `closed live queries retained ${measured.delta} bytes over 8 rounds`);
  });
});
