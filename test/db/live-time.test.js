//@ts-check
/**
 * Event-time live views (LIVE-FORMAT §13): a `$resample` or `$rolling`
 * document maintained against an explicit watermark.
 *
 * Three things are proven here and nothing is assumed. **The
 * classification is deterministic** — every maintained shape and every
 * refusal is named, and a document that cannot be maintained says which
 * of its members stopped it. **The maintained answer equals a full
 * recomputation** — a shuffled stream of inserts, in-place updates,
 * instant moves and deletes is checked against `@jarenjs/core/series`
 * over the whole collection after EVERY event, which is the only oracle
 * that cannot drift with the implementation. **A too-late reading is
 * visible** — it re-reads, it emits a `lateData` record, and it is
 * never folded in as though it had arrived on time.
 *
 * No test here reads a clock. Every watermark is a number this file
 * chose, and `advance()` is the only way one moves.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { resampleSeries, rollingSeries } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
const MINUTE = 60_000;

const MODEL = {
  $model: '0.1',
  collections: {
    readings: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, series: { type: 'string' },
        at: { type: 'integer' }, value: { type: ['number', 'null'] },
      } },
      key: '/id',
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
    rowidless: {
      schema: { type: 'object', properties: { at: { type: 'integer' }, value: { type: 'number' } } },
      key: null,
      identity: 'integer',
    },
  },
};

/** A scripted fixed-offset zone, so nothing here reads the host's
 * tzdb — a named-zone view still re-runs, and the re-run has to be
 * able to EXECUTE for the reason to be observable. */
const OFFSET = 120;
const ZONE_PROVIDER = {
  toParts: (epoch) => {
    const d = new Date(epoch + OFFSET * 60_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
      milliseconds: d.getUTCMilliseconds(), offset: OFFSET };
  },
  toEpoch: (parts) => Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, parts.milliseconds ?? 0)
    - OFFSET * 60_000,
};

const open = (options = {}) =>
  openStore(MODEL, { driver: nodeDriver(), capture: true, ...options });

const EVENT_TIME = { path: '$.at', watermark: T0, allowedLateness: 10 * MINUTE,
  retention: 60 * MINUTE };

const bucketDoc = (spec = {}) =>
  [{ $resample: ['$[*]', { every: MINUTE, aggregate: 'mean', ...spec }] }];
const rollingDoc = (spec = {}) =>
  [{ $rolling: ['$[*]', { width: 5 * MINUTE, aggregate: 'mean', ...spec }] }];

/** Every stored document, in the order the kernel would see them. */
async function allRows(store) {
  return /** @type {any[]} */ (await store.collection('readings')
    .execute([{ $for: { r: '$[*]' }, $return: '$r' }]));
}

describe('event-time classification', function () {
  it('maintains a fixed bucket ladder and a fixed rolling window', async function () {
    const store = await open();
    const bucket = await store.collection('readings').live(bucketDoc(), { eventTime: EVENT_TIME });
    assert.deepStrictEqual(bucket.mode, { strategy: 'bucket', mode: 'incremental' });
    const rolling = await store.collection('readings').live(rollingDoc(), { eventTime: EVENT_TIME });
    assert.deepStrictEqual(rolling.mode, { strategy: 'rolling', mode: 'incremental' });
    await store.close();
  });

  it('re-runs, with the reason, for every shape it does not maintain', async function () {
    const store = await open({ zoneProvider: ZONE_PROVIDER });
    const readings = store.collection('readings');
    const reasons = {};
    const reasonOf = async (label, document, options = { eventTime: EVENT_TIME }) => {
      const live = await readings.live(document, options);
      assert.strictEqual(live.mode.mode, 'rerun', label);
      reasons[label] = live.mode.reason;
      live.close();
    };
    await reasonOf('no watermark', bucketDoc(), {});
    await reasonOf('calendar width', bucketDoc({ every: 'P1M' }));
    await reasonOf('named zone', bucketDoc({ every: 'PT1M', zone: 'Test/Fixed' }));
    await reasonOf('locf fill', bucketDoc({ fill: 'locf' }));
    await reasonOf('linear fill', bucketDoc({ fill: 'linear' }));
    await reasonOf('first aggregate', bucketDoc({ aggregate: 'first' }));
    await reasonOf('calendar rolling', rollingDoc({ width: 'P1M' }));
    await reasonOf('short retention', rollingDoc(),
      { eventTime: { ...EVENT_TIME, retention: 2 * MINUTE } });
    await reasonOf('windowed', [{ $subsequence: [bucketDoc()[0], 0, 5] }]);
    await reasonOf('mismatched path', bucketDoc({ at: '$.on' }));

    assert.match(reasons['no watermark'], /eventTime with a finite watermark/);
    assert.match(reasons['calendar width'], /calendar ladder walks a wall clock/);
    assert.match(reasons['named zone'], /named zone/);
    assert.match(reasons['locf fill'], /from its neighbours/);
    assert.match(reasons['linear fill'], /from its neighbours/);
    assert.match(reasons['first aggregate'], /position in the series/);
    assert.match(reasons['calendar rolling'], /calendar ladder/);
    assert.match(reasons['short retention'], /does not cover/);
    assert.match(reasons['windowed'], /windowed temporal view/);
    assert.match(reasons['mismatched path'], /eventTime\.path names 'at'/);
    await store.close();
  });

  it("a retention covering the window plus the lateness is the boundary", async function () {
    const store = await open();
    const at = async (retention) => {
      const live = await store.collection('readings').live(rollingDoc(),
        { eventTime: { ...EVENT_TIME, allowedLateness: MINUTE, retention } });
      const strategy = live.mode.strategy;
      live.close();
      return strategy;
    };
    assert.strictEqual(await at(6 * MINUTE - 1), 'rerun');
    assert.strictEqual(await at(6 * MINUTE), 'rolling');
    await store.close();
  });

  it('a collection with no document key re-runs', async function () {
    const store = await open();
    const live = await store.collection('rowidless').live(bucketDoc(),
      { eventTime: { ...EVENT_TIME, path: '$.at' } });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.match(live.mode.reason, /document key/);
    await store.close();
  });

  it('refuses an eventTime declaration it does not admit (JD0053)', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const refusal = async (eventTime) => {
      await assert.rejects(() => readings.live(bucketDoc(), { eventTime }),
        (/** @type {any} */ error) => error.code === 'JD0053');
    };
    await refusal({ ...EVENT_TIME, lateness: 5 });        // near miss on a member name
    await refusal({ ...EVENT_TIME, watermark: 'now' });
    await refusal({ ...EVENT_TIME, watermark: Infinity });
    await refusal({ ...EVENT_TIME, retention: undefined });
    await refusal({ ...EVENT_TIME, retention: 0 });
    await refusal({ ...EVENT_TIME, allowedLateness: -1 });
    await refusal({ ...EVENT_TIME, path: '$.readings[*].at' });
    await store.close();
  });

  it('demanded incrementality refuses a shape that re-runs (JD0051)', async function () {
    const store = await open();
    await assert.rejects(
      () => store.collection('readings').live(bucketDoc({ fill: 'locf' }),
        { eventTime: EVENT_TIME, mode: 'incremental' }),
      (/** @type {any} */ error) => error.code === 'JD0051');
    await store.close();
  });
});

describe('the watermark only advances', function () {
  it('moves forward on demand and refuses to go back', async function () {
    const store = await open();
    const live = await store.collection('readings').live(bucketDoc(), { eventTime: EVENT_TIME });
    assert.strictEqual(live.stats().watermark, T0);
    live.advance(T0 + MINUTE);
    assert.strictEqual(live.stats().watermark, T0 + MINUTE);
    assert.throws(() => live.advance(T0), /only advances/);
    assert.throws(() => live.advance(Number.NaN), /finite epoch/);
    assert.throws(() => live.advance('later'), /finite epoch/);
    assert.strictEqual(live.stats().watermark, T0 + MINUTE);
    await store.close();
  });

  it('is absent on a view with no event time', async function () {
    const store = await open();
    const live = await store.collection('readings')
      .live([{ $for: { r: '$[*]' }, $return: '$r' }]);
    assert.strictEqual(live.advance, undefined);
    await store.close();
  });
});

describe('maintained buckets equal a full recomputation', function () {
  it('follows inserts, in-place updates, instant moves and deletes', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'mean' };
    const live = await readings.live(bucketDoc(), { eventTime: EVENT_TIME });
    const events = [];
    live.subscribe((event) => events.push(event));

    const check = async () => assert.deepStrictEqual(live.result.rows,
      resampleSeries(await allRows(store), spec));

    await readings.insert({ id: 'a', series: 's', at: T0 + 10_000, value: 4 });
    await check();
    await readings.insert({ id: 'b', series: 's', at: T0 + 20_000, value: 8 });
    await check(); // same bucket: the mean moves, no row appears
    assert.deepStrictEqual(live.result.rows, [{ at: T0, value: 6, count: 2 }]);
    await readings.insert({ id: 'c', series: 's', at: T0 + 3 * MINUTE, value: 1 });
    await check();
    await readings.put({ id: 'b', series: 's', at: T0 + 20_000, value: 16 }, 'b');
    await check(); // an in-place value change
    await readings.put({ id: 'b', series: 's', at: T0 + 3 * MINUTE + 1, value: 16 }, 'b');
    await check(); // an instant that crosses a boundary: two buckets move
    await readings.delete('c');
    await check();
    await readings.delete('a');
    await readings.delete('b');
    await check();
    assert.deepStrictEqual(live.result.rows, []);
    assert.ok(events.every((event) => event.lateData === undefined));
    await store.close();
  });

  it('counts source rows, gaps included, and reports an all-gap bucket as measured',
    async function () {
      const store = await open();
      const readings = store.collection('readings');
      const live = await readings.live(bucketDoc({ aggregate: 'sum' }), { eventTime: EVENT_TIME });
      await readings.insert({ id: 'g1', series: 's', at: T0 + 1000, value: null });
      await readings.insert({ id: 'g2', series: 's', at: T0 + 2000, value: null });
      assert.deepStrictEqual(live.result.rows, [{ at: T0, value: null, count: 2 }]);
      assert.deepStrictEqual(live.result.rows,
        resampleSeries(await allRows(store), { every: MINUTE, aggregate: 'sum' }));
      await store.close();
    });

  it("a fill policy emits the ladder's empty positions, and only those", async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'mean', fill: 'zero' };
    const live = await readings.live(bucketDoc({ fill: 'zero' }), { eventTime: EVENT_TIME });
    await readings.insert({ id: 'a', series: 's', at: T0, value: 4 });
    await readings.insert({ id: 'b', series: 's', at: T0 + 4 * MINUTE, value: 6 });
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
    assert.deepStrictEqual(live.result.rows.map((row) => row.value), [4, 0, 0, 0, 6]);
    await readings.delete('b');
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
    await store.close();
  });

  it("an explicit window emits exactly its own span", async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'count', fill: 'null',
      start: T0, end: T0 + 3 * MINUTE };
    const live = await readings.live(bucketDoc(
      { aggregate: 'count', fill: 'null', start: T0, end: T0 + 3 * MINUTE }),
    { eventTime: EVENT_TIME });
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
    await readings.insert({ id: 'in', series: 's', at: T0 + MINUTE, value: 1 });
    await readings.insert({ id: 'out', series: 's', at: T0 + 9 * MINUTE, value: 1 });
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
    assert.deepStrictEqual(live.result.rows.map((row) => row.count), [0, 1, 0]);
    await store.close();
  });

  it("the operand's own filter narrows what is maintained", async function () {
    const store = await open();
    const readings = store.collection('readings');
    const document = [{ $resample: [
      { $for: { r: '$[*]' }, $where: { $eq: ['$r.series', 's'] }, $return: '$r' },
      { every: MINUTE, aggregate: 'sum' }] }];
    const live = await readings.live(document, { eventTime: EVENT_TIME });
    assert.strictEqual(live.mode.strategy, 'bucket');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 4 });
    await readings.insert({ id: 'b', series: 'other', at: T0, value: 100 });
    assert.deepStrictEqual(live.result.rows, [{ at: T0, value: 4, count: 1 }]);
    // flipping a row INTO the filter is an ordinary update
    await readings.put({ id: 'b', series: 's', at: T0, value: 100 }, 'b');
    assert.deepStrictEqual(live.result.rows, [{ at: T0, value: 104, count: 2 }]);
    await store.close();
  });
});

describe('maintained rolling windows equal a full recomputation', function () {
  it('follows a stream of writes, window for window', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { width: 5 * MINUTE, aggregate: 'mean' };
    const live = await readings.live(rollingDoc(), { eventTime: EVENT_TIME });
    const check = async () => assert.deepStrictEqual(live.result.rows,
      rollingSeries(await allRows(store), spec));

    for (let i = 0; i < 8; i++) {
      await readings.insert({ id: `r${i}`, series: 's', at: T0 + i * MINUTE, value: i });
      await check();
    }
    // a reading arriving BETWEEN two others re-answers every window it
    // reaches forward into, and no window it does not
    await readings.insert({ id: 'mid', series: 's', at: T0 + 3 * MINUTE + 1, value: 50 });
    await check();
    await readings.put({ id: 'r5', series: 's', at: T0 + 5 * MINUTE, value: -20 }, 'r5');
    await check();
    await readings.put({ id: 'r2', series: 's', at: T0 + 7 * MINUTE + 30_000, value: 2 }, 'r2');
    await check();
    await readings.delete('mid');
    await check();
    await store.close();
  });

  it('withholds a value under minPeriods and keeps the real count', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { width: 5 * MINUTE, aggregate: 'mean', minPeriods: 3 };
    const live = await readings.live(rollingDoc({ minPeriods: 3 }), { eventTime: EVENT_TIME });
    for (let i = 0; i < 4; i++)
      await readings.insert({ id: `r${i}`, series: 's', at: T0 + i * MINUTE, value: i });
    assert.deepStrictEqual(live.result.rows, rollingSeries(await allRows(store), spec));
    assert.deepStrictEqual(live.result.rows.map((row) => row.value), [null, null, 1, 1.5]);
    await store.close();
  });

  it('gives two readings at one instant one window and one answer', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { width: 5 * MINUTE, aggregate: 'count' };
    const live = await readings.live(rollingDoc({ aggregate: 'count' }),
      { eventTime: EVENT_TIME });
    await readings.insert({ id: 'a', series: 's', at: T0 + MINUTE, value: 1 });
    await readings.insert({ id: 'b', series: 's', at: T0 + MINUTE, value: 2 });
    assert.deepStrictEqual(live.result.rows, rollingSeries(await allRows(store), spec));
    assert.deepStrictEqual(live.result.rows, [
      { at: T0 + MINUTE, value: 2, count: 2 }, { at: T0 + MINUTE, value: 2, count: 2 }]);
    await store.close();
  });
});

describe('a differential stream against the kernel', function () {
  for (const [label, document, spec, kernel] of [
    ['bucket', bucketDoc({ aggregate: 'sum' }), { every: MINUTE, aggregate: 'sum' }, resampleSeries],
    ['bucket/zero', bucketDoc({ aggregate: 'min', fill: 'zero' }),
      { every: MINUTE, aggregate: 'min', fill: 'zero' }, resampleSeries],
    ['rolling', rollingDoc({ aggregate: 'max' }), { width: 5 * MINUTE, aggregate: 'max' },
      rollingSeries],
  ]) {
    it(`${label}: 200 shuffled writes agree after every one of them`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const random = mulberry32(0x5e21e5);
      const live = await readings.live(document, { eventTime: EVENT_TIME });
      assert.strictEqual(live.mode.mode, 'incremental');
      /** @type {string[]} */
      const alive = [];
      let next = 0;
      // every instant lands inside the lateness the view allows, so
      // this stream measures maintenance rather than the late path
      const instant = () => T0 + Math.floor(random() * 20) * 30_000;
      for (let step = 0; step < 200; step++) {
        const roll = random();
        if (alive.length === 0 || roll < 0.55) {
          const id = `k${next++}`;
          await readings.insert({ id, series: 's', at: instant(),
            value: random() < 0.15 ? null : Math.round(random() * 64) });
          alive.push(id);
        }
        else if (roll < 0.85) {
          const id = alive[Math.floor(random() * alive.length)];
          await readings.put({ id, series: 's', at: instant(),
            value: random() < 0.15 ? null : Math.round(random() * 64) }, id);
        }
        else {
          const id = alive.splice(Math.floor(random() * alive.length), 1)[0];
          await readings.delete(id);
        }
        assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec),
          `step ${step}`);
      }
      assert.strictEqual(live.stats().lateData, 0);
      await store.close();
    });
  }
});

describe('a reading behind the boundary is visible, never lost', function () {
  it('names the instant, re-reads, and still answers what a fresh query would',
    async function () {
      const store = await open();
      const readings = store.collection('readings');
      const spec = { every: MINUTE, aggregate: 'sum' };
      const live = await readings.live(bucketDoc({ aggregate: 'sum' }),
        { eventTime: { path: '$.at', watermark: T0 + 60 * MINUTE,
          allowedLateness: 5 * MINUTE, retention: 30 * MINUTE } });
      const events = [];
      live.subscribe((event) => events.push(event));

      await readings.insert({ id: 'ontime', series: 's', at: T0 + 58 * MINUTE, value: 3 });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].lateData, undefined);

      await readings.insert({ id: 'late', series: 's', at: T0 + 2 * MINUTE, value: 7 });
      assert.strictEqual(events.length, 2);
      assert.deepStrictEqual(events[1].lateData, {
        reason: 'late-data', at: T0 + 2 * MINUTE, key: 'late',
        watermark: T0 + 60 * MINUTE, allowedLateness: 5 * MINUTE,
        boundary: T0 + 55 * MINUTE,
      });
      // the row is IN the answer: re-running is how it gets there
      assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
      assert.strictEqual(live.stats().lateData, 1);
      assert.strictEqual(live.stats().reruns, 1);
      await store.close();
    });

  it("says nothing about a reading outside the view's own window", async function () {
    const store = await open();
    const readings = store.collection('readings');
    const live = await readings.live(bucketDoc({ aggregate: 'count', start: T0 + 50 * MINUTE }),
      { eventTime: { path: '$.at', watermark: T0 + 60 * MINUTE,
        allowedLateness: 5 * MINUTE, retention: 30 * MINUTE } });
    await readings.insert({ id: 'ontime', series: 's', at: T0 + 58 * MINUTE, value: 1 });
    const events = [];
    live.subscribe((event) => events.push(event));
    // behind the boundary AND before the window this view declares: it
    // belongs to no bucket here, so it is not this view's late data
    await readings.insert({ id: 'outside', series: 's', at: T0 + MINUTE, value: 1 });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(live.stats().lateData, 0);
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store),
      { every: MINUTE, aggregate: 'count', start: T0 + 50 * MINUTE }));
    await store.close();
  });

  it('an advanced watermark makes a previously punctual reading late', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const live = await readings.live(rollingDoc(),
      { eventTime: { path: '$.at', watermark: T0, allowedLateness: 0,
        retention: 10 * MINUTE } });
    const events = [];
    live.subscribe((event) => events.push(event));
    await readings.insert({ id: 'a', series: 's', at: T0 + MINUTE, value: 1 });
    assert.strictEqual(events[0].lateData, undefined);
    live.advance(T0 + 10 * MINUTE);
    await readings.insert({ id: 'b', series: 's', at: T0 + 2 * MINUTE, value: 2 });
    assert.strictEqual(events[1].lateData.at, T0 + 2 * MINUTE);
    assert.strictEqual(events[1].lateData.watermark, T0 + 10 * MINUTE);
    assert.deepStrictEqual(live.result.rows,
      rollingSeries(await allRows(store), { width: 5 * MINUTE, aggregate: 'mean' }));
    await store.close();
  });

  it('a DELETE of an old reading is late too, and is never acknowledged as applied',
    async function () {
      const store = await open();
      const readings = store.collection('readings');
      await readings.insert({ id: 'old', series: 's', at: T0, value: 5 });
      const live = await readings.live(bucketDoc({ aggregate: 'sum' }),
        { eventTime: { path: '$.at', watermark: T0 + 60 * MINUTE, allowedLateness: 0,
          retention: 30 * MINUTE } });
      const events = [];
      live.subscribe((event) => events.push(event));
      await readings.delete('old');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].lateData.at, T0);
      assert.deepStrictEqual(live.result.rows, []);
      await store.close();
    });
});

describe('the emitted patch keeps its §9 promises', function () {
  it('shares every unaffected row by reference and diffs the rest', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const live = await readings.live(bucketDoc({ aggregate: 'sum' }), { eventTime: EVENT_TIME });
    for (let i = 0; i < 5; i++)
      await readings.insert({ id: `r${i}`, series: 's', at: T0 + i * MINUTE, value: i });
    const before = live.result.rows;
    const events = [];
    live.subscribe((event) => events.push(event));
    await readings.put({ id: 'r2', series: 's', at: T0 + 2 * MINUTE, value: 99 }, 'r2');
    const after = live.result.rows;
    assert.deepStrictEqual(events[0].patch,
      [{ op: 'replace', path: '/rows/2', value: { at: T0 + 2 * MINUTE, value: 99, count: 1 } }]);
    for (const i of [0, 1, 3, 4])
      assert.strictEqual(after[i], before[i], `row ${i} lost its identity`);
    await store.close();
  });

  it('a record that changes nothing emits nothing', async function () {
    const store = await open();
    const readings = store.collection('readings');
    await store.collection('rowidless').insert({ at: T0, value: 1 });
    const live = await readings.live(bucketDoc(), { eventTime: EVENT_TIME });
    const events = [];
    live.subscribe((event) => events.push(event));
    await store.collection('rowidless').insert({ at: T0, value: 2 });
    assert.strictEqual(events.length, 0);
    await store.close();
  });
});
