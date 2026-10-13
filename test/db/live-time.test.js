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

  it('a refused eventTime member is named for what it must be: an instant for the watermark, a span for the others', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const refusal = async (eventTime) => {
      try { await readings.live(bucketDoc(), { eventTime }); }
      catch (/** @type {any} */ error) { return error.message; }
      return 'registered';
    };
    assert.match(await refusal({ ...EVENT_TIME, watermark: Infinity }),
      /live eventTime\.watermark is a finite epoch in milliseconds, not Infinity /);
    assert.match(await refusal({ ...EVENT_TIME, retention: undefined }),
      /live eventTime\.retention is a finite span in milliseconds, and it is missing /);
    assert.match(await refusal({ ...EVENT_TIME, allowedLateness: '5' }),
      /live eventTime\.allowedLateness is a finite span in milliseconds, not "5" /);
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

describe("a reading the kernel refuses is the engine's own JQ2001", function () {
  for (const [label, document] of [['bucket', bucketDoc()], ['rolling', rollingDoc()]]) {
    it(`${label}: at registration, and as the error of a view a reading with no value reaches`,
      async function () {
        const store = await open();
        const readings = store.collection('readings');
        await readings.insert({ id: 'ok', series: 's', at: T0, value: 1 });
        const live = await readings.live(document, { eventTime: EVENT_TIME });
        const events = [];
        live.subscribe((event) => events.push(event));
        // `value` is optional in the schema, and the kernel reads an absent
        // reading as neither a number nor null
        await readings.insert({ id: 'bad', series: 's', at: T0 + 1000 });
        assert.strictEqual(live.state, 'errored');
        assert.strictEqual(live.error.code, 'JQ2001');
        assert.match(live.error.reason, /value: neither a finite number nor null/);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].error, live.error);
        // the same data refuses the same way when a view is registered over it
        await assert.rejects(readings.live(document, { eventTime: EVENT_TIME }),
          { code: 'JQ2001', reason: /value: neither a finite number nor null/ });
        await assert.rejects(async () => readings.execute(document, { pushdown: false }), { code: 'JQ2001' });
        await store.close();
      });
  }
});

describe('a fill policy is charged to live.maxMaintained like every other result', function () {
  const FILLED = [{ $resample: ['$[*]', { every: 1000, aggregate: 'sum', fill: 'null' }] }];

  it('refuses JD2060 once the ladder between two readings far apart outgrows the bound', async function () {
    const store = await open({ live: { maxMaintained: 100 } });
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
    const live = await readings.live(FILLED, { eventTime: EVENT_TIME });
    assert.strictEqual(live.result.rows.length, 1);
    // 50 empty positions and two readings: inside the bound
    await readings.insert({ id: 'b', series: 's', at: T0 + 50_000, value: 2 });
    assert.strictEqual(live.result.rows.length, 51);
    assert.strictEqual(live.state, 'live');
    // 5,000 positions: the result alone is past the bound
    await readings.insert({ id: 'c', series: 's', at: T0 + 5_000_000, value: 3 });
    assert.strictEqual(live.state, 'errored');
    assert.strictEqual(live.error.code, 'JD2060');
    assert.match(live.error.reason, /live\.maxMaintained bound of 100/);
    // and a registration over that data refuses the same way
    await assert.rejects(readings.live(FILLED, { eventTime: EVENT_TIME }), { code: 'JD2060' });
    await store.close();
  });

  it('a window the author declared is the author\'s bound: one reading registers, as it always did', async function () {
    const store = await open({ live: { maxMaintained: 100 } });
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0 + 5000, value: 1 });
    const windowed = [{ $resample: ['$[*]', { every: 1000, aggregate: 'sum', fill: 'zero',
      start: T0, end: T0 + 1_000_000 }] }];
    const live = await readings.live(windowed, { eventTime: EVENT_TIME });
    assert.strictEqual(live.state, 'live');
    assert.strictEqual(live.result.rows.length, 1000);
    assert.deepStrictEqual(live.result.rows, await readings.execute(windowed, { pushdown: false }));
    // a window with one open end follows the data, and the data's ladder is still charged
    const halfOpen = [{ $resample: ['$[*]', { every: 1000, aggregate: 'sum', fill: 'zero', start: T0 }] }];
    await readings.insert({ id: 'b', series: 's', at: T0 + 5_000_000, value: 2 });
    await assert.rejects(readings.live(halfOpen, { eventTime: EVENT_TIME }), { code: 'JD2060' });
    await store.close();
  });

  it('refuses a declared window holding more buckets than one fill may emit, in a view and in a query', async function () {
    const store = await open();
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
    const wide = bucketDoc({ every: 1, aggregate: 'sum', fill: 'zero', start: 0, end: 1e12 });
    const refusal = { code: 'JQ0003', reason: /the window holds 1000000000000 buckets of '1', more than the 100000 a 'zero' fill may emit/ };
    await assert.rejects(async () => readings.live(wide, { eventTime: EVENT_TIME }), refusal);
    await assert.rejects(async () => readings.execute(wide), refusal);
    await assert.rejects(async () => readings.execute(wide, { pushdown: false }), refusal);
    await store.close();
  });

  it('a ladder that follows the data is refused past the kernel cap, as the same query is', async function () {
    const store = await open({ live: { maxMaintained: 1_000_000, maxBytes: 1e9 } });
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
    const halfOpen = [{ $resample: ['$[*]', { every: 1000, aggregate: 'sum', fill: 'zero', start: T0 }] }];
    const live = await readings.live(halfOpen, { eventTime: EVENT_TIME });
    assert.strictEqual(live.result.rows.length, 1);
    // the ladder to this reading is 150,001 buckets: past the cap, well inside maxMaintained
    await readings.insert({ id: 'b', series: 's', at: T0 + 150_000_000, value: 2 });
    assert.strictEqual(live.state, 'errored');
    assert.strictEqual(live.error.code, 'JQ2001');
    assert.match(live.error.message, /the window holds 150001 buckets of '1000', more than the 100000 a 'zero' fill may emit/);
    await assert.rejects(async () => readings.live(halfOpen, { eventTime: EVENT_TIME }), { code: 'JQ2001' });
    await assert.rejects(async () => readings.execute(halfOpen, { pushdown: false }), { code: 'JQ2001' });
    await store.close();
  });

  it('the bound is inclusive: the readings plus the ladder may fill it, and not one more', async function () {
    for (const [gap, state, rows] of [[97_000, 'live', 98], [98_000, 'errored', 1]]) {
      const store = await open({ live: { maxMaintained: 100 } });
      const readings = store.collection('readings');
      await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
      const live = await readings.live(FILLED, { eventTime: EVENT_TIME });
      await readings.insert({ id: 'b', series: 's', at: T0 + gap, value: 2 });
      assert.strictEqual(live.state, state, `a gap of ${gap} ms`);
      assert.strictEqual(live.result.rows.length, rows, `a gap of ${gap} ms`);
      await store.close();
    }
  });

  it('an omit fill counts the folded buckets and the rows it keeps, as before', async function () {
    const store = await open({ live: { maxMaintained: 100 } });
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
    await readings.insert({ id: 'b', series: 's', at: T0 + 5_000_000, value: 2 });
    const live = await readings.live(bucketDoc({ every: 1000 }), { eventTime: EVENT_TIME });
    assert.strictEqual(live.result.rows.length, 2);
    assert.strictEqual(live.state, 'live');
    await store.close();
  });
});

describe('an event-time view keeps its own copy of a reading', function () {
  for (const [label, document] of [['bucket', bucketDoc({ aggregate: 'sum' })], ['rolling', rollingDoc({ aggregate: 'sum' })]]) {
    it(`${label}: an observer that rewrites its record does not change what a later fold adds`,
      async function () {
        const store = await open();
        const readings = store.collection('readings');
        const live = await readings.live(document, { eventTime: EVENT_TIME });
        store.observe((record) => {
          for (const operation of record.patch) {
            if (operation.value !== null && typeof operation.value === 'object') operation.value.value = 1000;
          }
        });
        await readings.insert({ id: 'a', series: 's', at: T0 + 1000, value: 1 });
        await readings.insert({ id: 'b', series: 's', at: T0 + 2000, value: 2 });
        assert.deepStrictEqual(live.result.rows.map((row) => row.value), label === 'bucket' ? [3] : [1, 3]);
        await store.close();
      });
  }
});

describe('a floating sum or mean answers what a fresh run answers, bit for bit', function () {
  const FLOATS = [['a', 5, 0.7], ['b', 2, 0.01], ['c', 4, 0.3], ['d', 5, 0.6]];

  it('a rolling sum over readings sharing an instant is the fresh run, not the view\'s own order', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { width: 3 * MINUTE, aggregate: 'sum' };
    const live = await readings.live(rollingDoc(spec), { eventTime: EVENT_TIME });
    assert.deepStrictEqual(live.mode, { strategy: 'rolling', mode: 'incremental' });
    for (const [id, minute, value] of FLOATS)
      await readings.insert({ id, series: 's', at: T0 + minute * MINUTE, value });
    const fresh = rollingSeries(await allRows(store), spec);
    assert.deepStrictEqual(fresh.map((row) => row.value), [0.01, 0.31, 1.5999999999999999, 1.5999999999999999]);
    assert.deepStrictEqual(live.result.rows, fresh);
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.match(live.mode.reason, /^'sum' — rows sharing an instant add in the order they reached the view/);
    await store.close();
  });

  it('a bucket sum over rows sharing an instant adds them in store order after an update', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'sum' };
    const live = await readings.live(bucketDoc(spec), { eventTime: EVENT_TIME });
    for (const [id, value] of [['x', 0.1], ['y', 0.2], ['z', 0.3]])
      await readings.insert({ id, series: 's', at: T0, value });
    // the update leaves x where the store holds it, first; the view moved it last
    await readings.put({ id: 'x', series: 'moved', at: T0, value: 0.1 }, 'x');
    const fresh = resampleSeries(await allRows(store), spec);
    assert.strictEqual(fresh[0].value, 0.6000000000000001);
    assert.deepStrictEqual(live.result.rows, fresh);
    await store.close();
  });

  for (const [label, document, kernel, spec] of [
    ['bucket sum', bucketDoc({ aggregate: 'sum' }), resampleSeries, { every: MINUTE, aggregate: 'sum' }],
    ['bucket mean', bucketDoc({ aggregate: 'mean' }), resampleSeries, { every: MINUTE, aggregate: 'mean' }],
    ['rolling sum', rollingDoc({ aggregate: 'sum' }), rollingSeries, { width: 5 * MINUTE, aggregate: 'sum' }],
    ['rolling mean', rollingDoc({ aggregate: 'mean' }), rollingSeries, { width: 5 * MINUTE, aggregate: 'mean' }],
  ]) {
    it(`${label}: 120 shuffled writes of decimal readings agree with the kernel after every one`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const random = mulberry32(0x18d18);
      const live = await readings.live(document, { eventTime: EVENT_TIME });
      /** @type {string[]} */
      const alive = [];
      let next = 0;
      const instant = () => T0 + Math.floor(random() * 12) * 30_000;
      const reading = () => Math.round(random() * 1000) / 100;
      for (let step = 0; step < 120; step++) {
        const roll = random();
        if (alive.length === 0 || roll < 0.55) {
          const id = `k${next++}`;
          await readings.insert({ id, series: 's', at: instant(), value: reading() });
          alive.push(id);
        }
        else if (roll < 0.85) {
          const id = alive[Math.floor(random() * alive.length)];
          await readings.put({ id, series: 's', at: instant(), value: reading() }, id);
        }
        else {
          await readings.delete(alive.splice(Math.floor(random() * alive.length), 1)[0]);
        }
        assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec), `step ${step}`);
      }
      await store.close();
    });
  }

  it('readings whose every partial sum is exact stay maintained: integers and binary fractions', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'sum' };
    const bucket = await readings.live(bucketDoc(spec), { eventTime: EVENT_TIME });
    const rolling = await readings.live(rollingDoc({ aggregate: 'mean' }), { eventTime: EVENT_TIME });
    for (const [i, value] of [0.5, 0.25, 3, 0.125, -7.75, 1024.5].entries())
      await readings.insert({ id: `q${i}`, series: 's', at: T0 + i * 20_000, value });
    assert.deepStrictEqual(bucket.mode, { strategy: 'bucket', mode: 'incremental' });
    assert.deepStrictEqual(rolling.mode, { strategy: 'rolling', mode: 'incremental' });
    assert.deepStrictEqual(bucket.result.rows, resampleSeries(await allRows(store), spec));
    assert.strictEqual(bucket.stats().recomputes > 0, true);
    await store.close();
  });

  for (const [label, document, kernel, spec] of [
    ['bucket', bucketDoc({ aggregate: 'sum' }), resampleSeries, { every: MINUTE, aggregate: 'sum' }],
    ['rolling', rollingDoc({ aggregate: 'mean' }), rollingSeries, { width: 5 * MINUTE, aggregate: 'mean' }],
  ]) {
    it(`${label}: a decimal that is replaced or deleted no longer counts, and the view stays maintained`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const live = await readings.live(document, { eventTime: EVENT_TIME });
      // one decimal alone is exact; the second beside it would not be
      await readings.insert({ id: 'a', series: 's', at: T0, value: 0.1 });
      await readings.put({ id: 'a', series: 's', at: T0, value: 5 }, 'a');
      await readings.delete('a');
      await readings.insert({ id: 'c', series: 's', at: T0 + 2 * MINUTE, value: 0.3 });
      await readings.delete('c');
      await readings.insert({ id: 'd', series: 's', at: T0 + 2 * MINUTE, value: 0.7 });
      assert.deepStrictEqual(live.mode.mode, 'incremental');
      assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec));
      await store.close();
    });
  }

  it('min, max and count have no order to disagree on and stay maintained over decimals', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const lives = [];
    for (const aggregate of ['min', 'max', 'count']) {
      lives.push(await readings.live(bucketDoc({ aggregate }), { eventTime: EVENT_TIME }));
      lives.push(await readings.live(rollingDoc({ aggregate }), { eventTime: EVENT_TIME }));
    }
    for (const [id, minute, value] of FLOATS)
      await readings.insert({ id, series: 's', at: T0 + minute * MINUTE, value });
    assert.deepStrictEqual(lives.map((live) => live.mode.mode), Array(6).fill('incremental'));
    await store.close();
  });

  it('a registration over stored decimals runs by re-reading from the first row, the reason named', async function () {
    const store = await open();
    const readings = store.collection('readings');
    for (const [id, minute, value] of FLOATS)
      await readings.insert({ id, series: 's', at: T0 + minute * MINUTE, value });
    const spec = { width: 3 * MINUTE, aggregate: 'sum' };
    const live = await readings.live(rollingDoc(spec), { eventTime: EVENT_TIME });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.deepStrictEqual(live.result.rows, rollingSeries(await allRows(store), spec));
    // the registration stays a re-run: the decimals leaving does not hand it back
    for (const [id] of FLOATS) await readings.delete(id);
    await readings.insert({ id: 'whole', series: 's', at: T0, value: 4 });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.deepStrictEqual(live.result.rows, rollingSeries(await allRows(store), spec));
    await store.close();
  });

  it('a sum whose integers could pass 2^53 together is a fresh run, as the whole-query accumulator is', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { every: MINUTE, aggregate: 'sum' };
    const live = await readings.live(bucketDoc(spec), { eventTime: EVENT_TIME });
    await readings.insert({ id: 'a', series: 's', at: T0, value: 2 ** 51 });
    await readings.insert({ id: 'b', series: 's', at: T0, value: 2 ** 51 });
    assert.strictEqual(live.mode.mode, 'incremental');
    await readings.insert({ id: 'c', series: 's', at: T0, value: 3 });
    assert.strictEqual(live.mode.mode, 'rerun');
    assert.deepStrictEqual(live.result.rows, resampleSeries(await allRows(store), spec));
    await store.close();
  });

  it('a registration that demands incremental maintenance is refused by decimals it cannot add as a fresh run does (JD0051)', async function () {
    const store = await open();
    const readings = store.collection('readings');
    await readings.insert({ id: 'a', series: 's', at: T0, value: 0.1 });
    await readings.insert({ id: 'b', series: 's', at: T0, value: 0.2 });
    await assert.rejects(readings.live(rollingDoc({ aggregate: 'sum' }),
      { eventTime: EVENT_TIME, mode: 'incremental' }), { code: 'JD0051' });
    const live = await readings.live(bucketDoc({ aggregate: 'mean' }),
      { eventTime: EVENT_TIME, mode: 'incremental' }).catch((error) => error);
    assert.strictEqual(live.code, 'JD0051');
    const whole = await readings.live(rollingDoc({ aggregate: 'max' }),
      { eventTime: EVENT_TIME, mode: 'incremental' });
    assert.strictEqual(whole.mode.mode, 'incremental');
    // the same decimals at distinct instants are added in instant order by both: nothing to refuse
    await readings.put({ id: 'b', series: 's', at: T0 + MINUTE, value: 0.2 }, 'b');
    for (const document of [rollingDoc({ aggregate: 'sum' }), bucketDoc({ aggregate: 'mean' })]) {
      const live = await readings.live(document, { eventTime: EVENT_TIME, mode: 'incremental' });
      assert.strictEqual(live.mode.mode, 'incremental');
    }
    await store.close();
  });

  for (const [label, document, kernel, spec] of [
    ['bucket sum', bucketDoc({ every: 5 * MINUTE, aggregate: 'sum' }), resampleSeries, { every: 5 * MINUTE, aggregate: 'sum' }],
    ['bucket mean', bucketDoc({ every: 5 * MINUTE, aggregate: 'mean' }), resampleSeries, { every: 5 * MINUTE, aggregate: 'mean' }],
    ['rolling sum', rollingDoc({ width: 3 * MINUTE, aggregate: 'sum' }), rollingSeries, { width: 3 * MINUTE, aggregate: 'sum' }],
    ['rolling mean', rollingDoc({ width: 3 * MINUTE, aggregate: 'mean' }), rollingSeries, { width: 3 * MINUTE, aggregate: 'mean' }],
  ]) {
    it(`${label}: decimal readings at distinct instants stay maintained and equal the kernel after every write`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const random = mulberry32(0xd157);
      const live = await readings.live(document, { eventTime: EVENT_TIME });
      /** @type {Map<string, number>} */
      const at = new Map();
      const taken = new Set();
      const free = () => {
        for (;;) {
          const instant = T0 + Math.floor(random() * 30) * MINUTE + Math.floor(random() * 1000) * 13;
          if (!taken.has(instant)) return instant;
        }
      };
      for (let step = 0; step < 150; step++) {
        const id = `k${Math.floor(random() * 14)}`;
        if (at.has(id) && random() < 0.25) {
          taken.delete(at.get(id));
          at.delete(id);
          await readings.delete(id);
        }
        else {
          taken.delete(at.get(id));
          const instant = free();
          at.set(id, instant);
          taken.add(instant);
          await readings.put({ id, series: 's', at: instant, value: Math.round(random() * 1000) / 100 }, id);
        }
        assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec), `step ${step}`);
      }
      assert.deepStrictEqual(live.mode, { strategy: label.startsWith('bucket') ? 'bucket' : 'rolling', mode: 'incremental' });
      assert.strictEqual(live.stats().reruns, 0);
      await store.close();
    });
  }

  it('a rolling view over decimals folds the series again but shares every row the fold answers as before', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const spec = { width: 3 * MINUTE, aggregate: 'mean' };
    const live = await readings.live(rollingDoc(spec), { eventTime: EVENT_TIME });
    for (let i = 0; i < 40; i++)
      await readings.insert({ id: `r${i}`, series: 's', at: T0 + i * MINUTE, value: Math.round(i * 7.3) / 10 });
    const before = live.result.rows;
    const folds = live.stats().recomputes;
    const events = [];
    live.subscribe((event) => events.push(event));
    await readings.put({ id: 'r39', series: 's', at: T0 + 39 * MINUTE, value: 1.1 }, 'r39');
    assert.strictEqual(live.stats().recomputes, folds + 1);
    assert.strictEqual(events[0].patch.length, 1);
    assert.strictEqual(live.result.rows[0], before[0]);
    assert.strictEqual(live.result.rows[38], before[38]);
    assert.deepStrictEqual(live.result.rows, rollingSeries(await allRows(store), spec));
    assert.strictEqual(live.mode.mode, 'incremental');
    await store.close();
  });

  it('a decimal bucket view at distinct instants stays incremental, with no re-run, as the series grows 8x', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const perWrite = async (size, from) => {
      await store.sync.transaction(() => {
        for (let i = from; i < size; i++)
          store.sync.collection('readings').insert({ id: `r${i}`, series: 's', at: T0 + i * 1000, value: Math.round(i * 7.3) / 10 });
      });
    };
    let live;
    let loaded = 0;
    for (const size of [1000, 8000]) {
      await perWrite(size, loaded);
      loaded = size;
      if (live !== undefined) live.close();
      live = await readings.live(bucketDoc({ every: 60_000, aggregate: 'mean' }),
        { eventTime: { ...EVENT_TIME, watermark: T0 + size * 1000 }, mode: 'incremental' });
      assert.deepStrictEqual(live.mode, { strategy: 'bucket', mode: 'incremental' });
      for (let n = 0; n < 40; n++) {
        const i = size - 1 - (n % 20);
        await readings.put({ id: `r${i}`, series: 's', at: T0 + i * 1000, value: Math.round((i + n) * 3.7) / 10 }, `r${i}`);
      }
      // a write the view cannot fold exactly re-runs the whole series; a
      // decimal at its own instant folds, so no write here re-runs
      assert.deepStrictEqual(live.mode, { strategy: 'bucket', mode: 'incremental' });
      assert.strictEqual(live.stats().reruns, 0);
    }
    await store.close();
  });

  for (const [label, document, spec, kernel] of [
    ['bucket', bucketDoc({ aggregate: 'sum' }), { every: MINUTE, aggregate: 'sum' }, resampleSeries],
    ['rolling', rollingDoc({ aggregate: 'sum' }), { width: 5 * MINUTE, aggregate: 'sum' }, rollingSeries],
  ]) {
    it(`${label}: a handed-over view still reports late data and counts it`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const live = await readings.live(document,
        { eventTime: { ...EVENT_TIME, watermark: T0 + 100 * MINUTE, allowedLateness: 10 * MINUTE } });
      const events = [];
      live.subscribe((event) => events.push(event));
      await readings.insert({ id: 'a', series: 's', at: T0 + 95 * MINUTE, value: 21.4 });
      await readings.insert({ id: 'b', series: 's', at: T0 + 95 * MINUTE, value: 21.7 });
      assert.strictEqual(live.mode.mode, 'rerun');
      assert.strictEqual(live.stats().lateData, 0);
      await readings.insert({ id: 'late', series: 's', at: T0 + MINUTE, value: 3.3 });
      assert.strictEqual(events.length, 3);
      assert.strictEqual(events[2].lateData.reason, 'late-data');
      assert.strictEqual(events[2].lateData.key, 'late');
      assert.strictEqual(live.stats().lateData, 1);
      assert.strictEqual(live.mode.mode, 'rerun');
      assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec));
      // the next on-time write is a fresh run again, and a second late one counts again
      await readings.insert({ id: 'c', series: 's', at: T0 + 96 * MINUTE, value: 0.1 });
      assert.strictEqual(events[3].lateData, undefined);
      await readings.delete('late');
      assert.strictEqual(events[4].lateData.key, 'late');
      assert.strictEqual(live.stats().lateData, 2);
      assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec));
      await store.close();
    });

    it(`${label}: rows that shared an instant and no longer do are not a tie`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const live = await readings.live(document, { eventTime: EVENT_TIME, mode: 'incremental' });
      await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
      await readings.insert({ id: 'b', series: 's', at: T0, value: 2 });
      await readings.put({ id: 'b', series: 's', at: T0 + 30_000, value: 2 }, 'b');
      await readings.insert({ id: 'c', series: 's', at: T0 + 45_000, value: 0.1 });
      await readings.insert({ id: 'd', series: 's', at: T0 + 50_000, value: 0.2 });
      assert.strictEqual(live.state, 'live');
      assert.strictEqual(live.mode.mode, 'incremental');
      assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec));
      await store.close();
    });

    it(`${label}: a late-data re-read counts the readings afresh, so exact integers are not mistaken for inexact`, async function () {
      const store = await open();
      const readings = store.collection('readings');
      const live = await readings.live(document,
        { eventTime: { ...EVENT_TIME, watermark: T0 + 100 * MINUTE, allowedLateness: 10 * MINUTE } });
      // four terms of up to 2^50 add exactly; a stale count would see seven
      for (let i = 0; i < 2; i++)
        await readings.insert({ id: `r${i}`, series: 's', at: T0 + (95 + i) * MINUTE, value: 2 ** 50 });
      await readings.insert({ id: 'late', series: 's', at: T0 + MINUTE, value: 1 });
      assert.strictEqual(live.stats().lateData, 1);
      assert.strictEqual(live.mode.mode, 'incremental');
      // two readings now share an instant: exact sums stay maintained
      await readings.insert({ id: 'twin', series: 's', at: T0 + 95 * MINUTE, value: 1 });
      assert.strictEqual(live.mode.mode, 'incremental');
      assert.deepStrictEqual(live.result.rows, kernel(await allRows(store), spec));
      await store.close();
    });
  }

  it('a view demanding incremental maintenance errors, as the accumulator does, once a decimal reaches it', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const live = await readings.live(rollingDoc({ aggregate: 'sum' }),
      { eventTime: EVENT_TIME, mode: 'incremental' });
    await readings.insert({ id: 'a', series: 's', at: T0, value: 1 });
    // a decimal at another instant is added in instant order by both, and answers right
    await readings.insert({ id: 'b', series: 's', at: T0 + MINUTE, value: 0.1 });
    assert.strictEqual(live.state, 'live');
    assert.strictEqual(live.mode.mode, 'incremental');
    await readings.insert({ id: 'c', series: 's', at: T0, value: 0.1 });
    assert.strictEqual(live.state, 'errored');
    assert.strictEqual(live.error.code, 'JD0051');
    await store.close();
  });

  it('the watermark keeps moving and the stats keep counting after the hand-over', async function () {
    const store = await open();
    const readings = store.collection('readings');
    const live = await readings.live(rollingDoc({ aggregate: 'sum' }), { eventTime: EVENT_TIME });
    await readings.insert({ id: 'a', series: 's', at: T0, value: 0.1 });
    await readings.insert({ id: 'a2', series: 's', at: T0, value: 0.2 });
    assert.strictEqual(live.mode.mode, 'rerun');
    live.advance(T0 + MINUTE);
    assert.strictEqual(live.stats().watermark, T0 + MINUTE);
    await readings.insert({ id: 'b', series: 's', at: T0 + 2 * MINUTE, value: 0.2 });
    assert.strictEqual(live.stats().reruns >= 1, true);
    await store.close();
  });
});

describe('a valid eventTime on a document that is not temporal declares nothing', function () {
  for (const [label, document] of [
    ['an ordinary selection', [{ $for: { r: '$[*]' }, $return: '$r' }]],
    ['a $resample over a projecting operand',
      [{ $resample: [{ $for: { r: '$[*]' }, $return: { at: '$r.at', value: '$r.value' } }, { every: MINUTE, aggregate: 'sum' }] }]],
  ]) {
    it(`${label} registers the view the document would get without it, and answers as a fresh run does`,
      async function () {
        const store = await open();
        const readings = store.collection('readings');
        const live = await readings.live(document, { eventTime: EVENT_TIME });
        const plain = await readings.live(document);
        assert.deepStrictEqual(live.mode, plain.mode);
        assert.strictEqual(live.advance, undefined);
        assert.strictEqual(live.stats().watermark, undefined);
        for (const [id, minute, value] of [['a', 1, 2], ['b', 1, 3], ['c', 7, 5]]) {
          await readings.insert({ id, series: 's', at: T0 + minute * MINUTE, value });
          assert.deepStrictEqual(live.result.rows, await readings.execute(document));
        }
        await readings.delete('a');
        assert.deepStrictEqual(live.result.rows, await readings.execute(document));
        await store.close();
      });
  }
});
