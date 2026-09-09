#!/usr/bin/env node

/**
 * JarenJS live-layer benchmark — phase C. What this program
 * is actually proud of, measured, with the losses printed beside the
 * wins:
 *
 *  1. Incremental versus RE-RUN maintenance on the SAME query shape —
 *     the D14 honesty measurement: how much does incremental actually
 *     buy, at a few table sizes?
 *  2. Capture overhead: write cost with capture off / journal / session
 *     (the capture-overhead claim, re-measured here in one place).
 *  3. Live-query update latency versus the local-first reactive stores:
 *     RxDB (an IndexedDB/memory reactive database) and TinyBase (a
 *     tiny, extremely fast in-memory store with a reactive queries
 *     module). TinyBase WILL win raw update latency — it is not a SQL
 *     database and does not persist the same way; that fact is printed
 *     next to the number.
 *  4. The end-to-end path: write → capture patch → live maintenance →
 *     one emitted patch set, measured as a whole, because that
 *     composition is the claim.
 *  5. Job throughput: jobs/second at a stated concurrency.
 *
 * LiveStore, the third rival named in the plan, is OMITTED: its
 * @livestore/livestore → electric-sql peer pins React and refuses to
 * resolve in this workspace (npm ERESOLVE). Stated, not hidden — the
 * same discipline the toml/markdown suites use when a rival is
 * unavailable.
 *
 * Usage:
 *   node benchmark/live.js [--quick] [--output json --filepath f]
 */

import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { openStore } from '../packages/db/src/index.js';
import { nodeDriver } from '../packages/db/src/drivers/node.js';

const args = process.argv.slice(2);
const flags = {
  quick: args.includes('--quick'),
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, title: { type: 'string' },
        points: { type: 'integer' } } },
      key: '/id',
      indexes: [{ name: 'by_points', path: '$.points' }],
    },
  },
};
const WHERE_BIG = [{ $for: { it: '$[*]' },
  $where: { $gt: ['$it.points', 50] }, $return: '$it' }];

/** The event-time corpus: one reading a second from a fixed instant,
 * values rounded to a multiple of 1/4096 so a maintained fold and a
 * fresh one are equal bit for bit rather than nearly. */
const SERIES_MODEL = {
  $model: '0.1',
  collections: {
    readings: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, series: { type: 'string' },
        at: { type: 'integer' }, value: { type: 'number' } } },
      key: '/id',
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
  },
};
const SERIES_T0 = 1_767_225_600_000;
const seriesValue = (i) => Math.round(4096 * Math.sin(i / 31)) / 4096 + (i % 7);

/** Median of per-call nanoseconds over `iterations`, warmed. */
function timeMedian(fn, iterations) {
  fn();
  fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function timeMedianAsync(fn, iterations) {
  await fn();
  await fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const formatNs = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms`
  : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`);

const SIZES = flags.quick ? [1_000] : [1_000, 10_000];
const ITERS = flags.quick ? 60 : 200;

async function seedStore(size, options) {
  const store = await openStore(MODEL, { driver: nodeDriver(), ...options });
  const notes = store.sync.collection('notes');
  store.sync.transaction(() => {
    for (let i = 0; i < size; i++) {
      notes.insert({ id: `n${i}`, title: `note ${i}`, points: i % 100 });
    }
  });
  return store;
}

// ————— 1. incremental vs re-run —————

async function incrementalVsRerun() {
  const rows = [];
  for (const size of SIZES) {
    for (const mode of ['auto', 'rerun']) {
      const store = await seedStore(size, { capture: true });
      const notes = store.collection('notes');
      const live = await notes.live(WHERE_BIG, mode === 'rerun' ? { mode: 'rerun' } : {});
      let flip = 0;
      const perWrite = await timeMedianAsync(async () => {
        // a write that flips one row across the threshold, then back
        const id = `n${flip % size}`;
        flip += 1;
        await notes.put({ id, title: 't', points: flip % 2 === 0 ? 80 : 10 }, id);
      }, ITERS);
      rows.push({
        name: `${mode === 'rerun' ? 're-run' : 'incremental'} — where over ${size} rows`,
        results: [perWrite],
        note: mode === 'rerun' ? 'O(table): re-executes the whole query per commit'
          : `O(result): ${live.mode.strategy} strategy, one shared rows array`,
      });
      live.close();
      await store.close();
    }
  }
  // the ratio, per size, is the honesty headline
  const ratios = SIZES.map((size) => {
    const inc = rows.find((r) => r.name.startsWith('incremental') && r.name.endsWith(`${size} rows`));
    const rer = rows.find((r) => r.name.startsWith('re-run') && r.name.endsWith(`${size} rows`));
    return { size, ratio: rer.results[0] / inc.results[0] };
  });
  return { title: 'Incremental vs re-run maintenance (per single-row write, median)', rows, ratios };
}

// ————— 1b. event-time views: maintained vs re-run —————

/**
 * The §13 claim, measured the same way §7's was: what does maintaining
 * a `$resample` ladder or a `$rolling` window cost per write, against
 * re-running the same document?
 *
 * The ANSWER is gated before the timing. A maintained view whose rows
 * differ from `resampleSeries` / `rollingSeries` over the whole
 * collection is not a fast live query, it is a wrong one — so each
 * shape is checked against the kernel after a write and the run exits
 * non-zero if it disagrees. Only then is anything timed.
 */
async function eventTimeViews() {
  const { resampleSeries, rollingSeries } = await import('../packages/core/src/series/index.js');
  const rows = [];
  const ratios = [];
  const SHAPES = [
    { label: 'bucket (60 s ladder, mean)', kernel: resampleSeries,
      spec: { every: 60_000, aggregate: 'mean' },
      document: (spec) => [{ $resample: ['$[*]', spec] }] },
    { label: 'rolling (5 min window, mean)', kernel: rollingSeries,
      spec: { width: 300_000, aggregate: 'mean' },
      document: (spec) => [{ $rolling: ['$[*]', spec] }] },
  ];
  for (const size of SIZES) {
    for (const shape of SHAPES) {
      for (const mode of ['auto', 'rerun']) {
        // a bucket view holds one entry per reading PLUS one per
        // bucket, so ten thousand readings on a 60 s ladder is 10,167
        // entries — over §12's default ceiling. The bound is raised
        // deliberately here, which is the only way it is ever raised.
        const store = await openStore(SERIES_MODEL,
          { driver: nodeDriver(), capture: true, live: { maxMaintained: 100_000 } });
        const readings = store.sync.collection('readings');
        store.sync.transaction(() => {
          for (let i = 0; i < size; i++) {
            readings.insert({ id: `r${i}`, series: 's', at: SERIES_T0 + i * 1000,
              value: seriesValue(i) });
          }
        });
        const async_ = store.collection('readings');
        // the watermark is a NUMBER this program chose: the newest
        // instant in the corpus, so every write below is punctual and
        // this measures maintenance rather than the late-data re-read
        const eventTime = { path: '$.at', watermark: SERIES_T0 + size * 1000,
          allowedLateness: 60_000, retention: 3_600_000 };
        const live = await async_.live(shape.document(shape.spec),
          mode === 'rerun' ? { mode: 'rerun' } : { eventTime });
        if (mode !== 'rerun' && live.mode.mode !== 'incremental') {
          console.error(`\nEVENT TIME: ${shape.label} classified ${live.mode.mode} — ${live.mode.reason}`);
          process.exit(1);
        }
        // every write lands inside the lateness this view allows —
        // which is what a live view over a running series actually
        // sees. The late path is a re-read by design and is measured
        // by its own counter, not smuggled into this row's median.
        const recent = Math.max(1, Math.floor(eventTime.allowedLateness / 1000) - 5);
        let n = 0;
        const write = async () => {
          const i = size - 1 - (n % Math.min(recent, size));
          n += 1;
          await async_.put({ id: `r${i}`, series: 's', at: SERIES_T0 + i * 1000,
            value: seriesValue(i + n) }, `r${i}`);
        };
        await write();
        const all = await async_.execute([{ $for: { r: '$[*]' }, $return: '$r' }]);
        const expected = shape.kernel(all, shape.spec);
        if (!isDeepStrictEqual(live.result.rows, expected)) {
          console.error(`\nEVENT TIME ANSWER WRONG: ${shape.label} (${mode}) at ${size} rows`);
          process.exit(1);
        }
        const perWrite = await timeMedianAsync(write, ITERS);
        rows.push({
          name: `${mode === 'rerun' ? 're-run' : 'maintained'} — ${shape.label}, ${size} rows`,
          results: [perWrite],
          note: mode === 'rerun'
            ? 'O(table): re-reads and re-folds the whole series per commit'
            : `${live.mode.strategy} state; ${live.stats().recomputes} folds, `
              + `${live.stats().lateData} late`,
        });
        if (mode === 'rerun') {
          const maintained = rows[rows.length - 2].results[0];
          ratios.push({ size, shape: shape.label, ratio: perWrite / maintained });
        }
        live.close();
        await store.close();
      }
    }
  }
  return { title: 'Event-time views: maintained vs re-run (per single-row write, median)',
    rows, ratios };
}

// ————— 2. capture overhead —————

async function captureOverhead() {
  const rows = [];
  const size = 1_000;
  for (const [label, options, note] of [
    ['capture off', {}, 'no transaction wrapper, no changeset'],
    ['journal', { capture: { mode: 'journal' } }, 'write-path record buffer'],
    ['session', { capture: { mode: 'session' } }, 'SQLite session changeset per commit'],
    ['session + log', { capture: { mode: 'session', log: true } }, 'plus the persisted _jaren_changes row'],
  ]) {
    const store = await seedStore(size, options);
    const notes = store.sync.collection('notes');
    let n = size;
    const perInsert = timeMedian(() => {
      notes.insert({ id: `x${n}`, title: 't', points: 42 });
      n += 1;
    }, ITERS);
    rows.push({ name: `single insert — ${label}`, results: [perInsert], note });
    await store.close();
  }
  return { title: 'Capture overhead (single-op commit, median)', rows };
}

// ————— 3. live update latency vs rivals —————

async function jarenLiveLatency(size) {
  const store = await seedStore(size, { capture: true });
  const notes = store.collection('notes');
  const live = await notes.live(WHERE_BIG);
  let seen = 0;
  live.subscribe(() => { seen += 1; });
  let flip = 0;
  const perUpdate = await timeMedianAsync(async () => {
    const id = `n${flip % size}`;
    flip += 1;
    await notes.put({ id, title: 't', points: flip % 2 === 0 ? 80 : 10 }, id);
  }, ITERS);
  live.close();
  await store.close();
  void seen;
  return perUpdate;
}

async function rxdbLiveLatency(size) {
  // NO dev-mode plugin (it demands a validator-wrapped storage) —
  // the db.js suite runs RxDB the same bare way
  const { createRxDatabase } = await import('rxdb');
  const { getRxStorageMemory } = await import('rxdb/plugins/storage-memory');
  // `ignoreDuplicate` is dev-mode-only (DB9) — a unique name per run
  // is the production-safe way, as db.js does
  const db = await createRxDatabase({
    name: `live${Date.now()}${size}`,
    storage: getRxStorageMemory(),
  });
  await db.addCollections({
    notes: {
      schema: {
        version: 0, primaryKey: 'id', type: 'object',
        properties: {
          id: { type: 'string', maxLength: 24 },
          title: { type: 'string', maxLength: 40 },
          points: { type: 'number', minimum: 0, maximum: 200, multipleOf: 1 },
        },
        required: ['id', 'points'],
        indexes: ['points'],
      },
    },
  });
  const docs = [];
  for (let i = 0; i < size; i++) docs.push({ id: `n${i}`, title: `note ${i}`, points: i % 100 });
  await db.notes.bulkInsert(docs);
  const query = db.notes.find({ selector: { points: { $gt: 50 } } });
  let seen = 0;
  const sub = query.$.subscribe(() => { seen += 1; });
  let flip = 0;
  const perUpdate = await timeMedianAsync(async () => {
    const id = `n${flip % size}`;
    flip += 1;
    const doc = await db.notes.findOne(id).exec();
    if (doc) await doc.patch({ points: flip % 2 === 0 ? 80 : 10 });
  }, Math.min(ITERS, 80));
  sub.unsubscribe();
  await db.close();
  void seen;
  return perUpdate;
}

async function tinybaseLiveLatency(size) {
  const { createStore } = await import('tinybase');
  const { createQueries } = await import('tinybase/queries');
  const store = createStore();
  const table = {};
  for (let i = 0; i < size; i++) table[`n${i}`] = { title: `note ${i}`, points: i % 100 };
  store.setTable('notes', table);
  const queries = createQueries(store);
  queries.setQueryDefinition('big', 'notes', ({ select, where }) => {
    select('title'); select('points');
    where((getCell) => getCell('points') > 50);
  });
  let seen = 0;
  const listenerId = queries.addResultTableListener('big', () => { seen += 1; });
  let flip = 0;
  const perUpdate = timeMedian(() => {
    const id = `n${flip % size}`;
    flip += 1;
    store.setCell('notes', id, 'points', flip % 2 === 0 ? 80 : 10);
  }, ITERS);
  queries.delListener(listenerId);
  void seen;
  return perUpdate;
}

async function liveLatency() {
  const rows = [];
  const size = flags.quick ? 1_000 : 10_000;
  const jaren = await jarenLiveLatency(size);
  rows.push({ name: `jaren live-query update — ${size} rows`, results: [jaren],
    note: 'incremental maintenance + one RFC 6902 patch, over SQLite (persists)' });

  let rxdb = null;
  try {
    rxdb = await rxdbLiveLatency(size);
    rows.push({ name: `RxDB reactive query update — ${size} rows`, results: [rxdb],
      note: 'memory storage, reactive query subscription' });
  }
  catch (error) {
    rows.push({ name: 'RxDB — omitted', results: [0], note: `run failed: ${error.message}` });
  }

  let tinybase = null;
  try {
    tinybase = await tinybaseLiveLatency(size);
    rows.push({ name: `TinyBase reactive query update — ${size} rows`, results: [tinybase],
      note: 'in-memory only; NOT a SQL database and does not persist the same way — '
        + 'the honest cost of durability is the gap' });
  }
  catch (error) {
    rows.push({ name: 'TinyBase — omitted', results: [0], note: `run failed: ${error.message}` });
  }

  return { title: `Live-query update latency vs local-first stores (${size} rows, median)`, rows,
    losses: { tinybase: tinybase !== null && tinybase < jaren, rxdb: rxdb !== null && rxdb < jaren } };
}

// ————— 4. the end-to-end path —————

async function endToEnd() {
  const store = await seedStore(1_000, { capture: true });
  const notes = store.collection('notes');
  const live = await notes.live(WHERE_BIG);
  let delivered = 0;
  live.subscribe(() => { delivered += 1; });
  let flip = 0;
  const perPath = await timeMedianAsync(async () => {
    const id = `n${flip % 1_000}`;
    flip += 1;
    await notes.put({ id, title: 't', points: flip % 2 === 0 ? 80 : 10 }, id);
  }, ITERS);
  live.close();
  await store.close();
  return { title: 'End-to-end: write → capture patch → live maintenance → emitted patch',
    rows: [{ name: 'the whole composition, per write', results: [perPath],
      note: `${delivered} patch sets delivered; this is the claim measured as one thing` }] };
}

// ————— 5. job throughput —————

async function jobThroughput() {
  const rows = [];
  for (const concurrency of [1, 4]) {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    const jobs = flags.quick ? 500 : 2_000;
    for (let i = 0; i < jobs; i++) {
      await store.jobs.enqueue('work', { n: i }, { id: `j${i}` });
    }
    const worker = store.jobs.createWorker({
      handlers: { work: (payload) => ({ ok: payload.n }) },
      concurrency, pollInterval: 5,
    });
    const start = process.hrtime.bigint();
    worker.start();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if ((await store.jobs.counts()).done === jobs) break;
    }
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    rows.push({ name: `job queue throughput — concurrency ${concurrency}`,
      results: [Math.round(jobs / seconds)],
      unit: 'jobs/s', note: 'one SQLite writer; synchronous handlers' });
    await worker.stop();
    await store.close();
  }
  return { title: 'Durable job queue throughput', rows };
}

async function main() {
  const tables = [];
  const incRerun = await incrementalVsRerun();
  tables.push(incRerun);
  const eventTime = await eventTimeViews();
  tables.push(eventTime);
  tables.push(await captureOverhead());
  const latency = await liveLatency();
  tables.push(latency);
  tables.push(await endToEnd());
  const jobs = await jobThroughput();
  tables.push(jobs);

  for (const table of tables) {
    console.log(`\n${table.title}`);
    for (const row of table.rows) {
      const value = row.unit === 'jobs/s'
        ? `${row.results[0]} jobs/s` : formatNs(row.results[0]);
      console.log(`  ${row.name.padEnd(56)} ${value.padStart(12)}`
        + `${row.note ? `  (${row.note})` : ''}`);
    }
  }
  console.log('\nincremental speedups:');
  for (const { size, ratio } of incRerun.ratios) {
    console.log(`  ${size} rows: ${ratio.toFixed(1)}× vs re-run`);
  }
  console.log('\nevent-time speedups (answer checked against the kernel first):');
  for (const { size, shape, ratio } of eventTime.ratios) {
    console.log(`  ${String(size).padEnd(6)} ${shape.padEnd(28)} ${ratio.toFixed(1)}× vs re-run`);
  }

  if (flags.output === 'json' && flags.filepath) {
    const meta = {
      runtime: `node ${process.version}`,
      sizes: SIZES,
      incrementalRatios: incRerun.ratios,
      eventTimeRatios: eventTime.ratios,
      liveLosses: latency.losses,
      omitted: ['LiveStore (electric-sql React peer conflict — ERESOLVE)'],
    };
    // the website's chart adapter needs a `columns` array per table
    // (the series names); every live row carries one measurement
    const jsonTables = tables.map((table) => ({
      title: table.title,
      columns: [table.rows[0]?.unit === 'jobs/s' ? 'jobs/s' : 'ns'],
      rows: table.rows.map((row) => ({
        name: row.name, results: row.results, note: row.note,
      })),
    }));
    writeFileSync(flags.filepath, JSON.stringify({ meta, tables: jsonTables }, null, 1));
    console.log(`\nwrote ${flags.filepath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
