//@ts-check
/**
 * @file The temporal corpus, run through SQLite — four times.
 *
 * `test/json/fixtures/series-corpus.json` records, for every case, the
 * answer a PLAIN reference gives it — a map keyed by bucket, a fresh
 * sum per window, a linear scan per match, written in
 * `scripts/lib/series-corpus.js` and touching no kernel. Order 04 made
 * the validated query vocabulary a second executor of those cases.
 * This file makes the STORE the third, fourth and fifth: `node:sqlite`,
 * the real wasm build, and both of them again with pushdown forced off,
 * so the plan is compared against the engine answering alone rather
 * than against itself.
 *
 * Every case runs under two mappings — a collection that declares the
 * composite `(series, at)` index D9 fixes, and one that declares
 * nothing — and both must equal what the references recorded. An index
 * narrows; it never decides, and a physical mapping is not allowed to
 * be visible in an answer.
 *
 * Answers are not enough. A temporal plan that silently fell to the
 * whole-collection residual would agree forever and read the whole
 * table forever, so every case also asserts the MODE it takes, the
 * reason its plan names, and — against the database's own
 * `EXPLAIN QUERY PLAN` — whether the fetch actually seeks. That table
 * is kept complete against the corpus in both directions.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';

import { resampleSeries } from '@jarenjs/core/series';

import { deepEquals } from './oracle/harness.js';
import { tempDbPath } from './helpers.js';
import {
  readSeriesCorpus, seriesMappings, seriesCollectionCase, SERIES_COLLECTION,
} from '../../scripts/lib/series-corpus.js';

const CORPUS = readSeriesCorpus();
const MAPPINGS = seriesMappings();

/** Every case a collection can carry, already projected. */
const PROJECTED = CORPUS.cases
  .map((entry) => ({ entry, projected: seriesCollectionCase(entry, CORPUS.samples) }))
  .filter((row) => row.projected !== null);

/**
 * The plan every case takes on the INDEXED mapping: the document's
 * mode, the temporal record's mode, the reason codes in order, and
 * whether the database's own plan output says the fetch seeks.
 *
 * Complete against the corpus in both directions: a case with no row
 * fails, and a row naming a case the corpus lost fails too.
 * @type {Record<string, [string, string, string[], boolean]>}
 */
const PLANS = {
  'range/interior-minute': ['native', 'native', [], true],
  'range/half-open-edges': ['native', 'native', [], true],
  'range/starts-before-corpus': ['native', 'native', [], true],
  'range/entirely-after-corpus': ['native', 'native', [], true],
  'bucket/fixed-minute': ['native', 'native', [], true],
  'asof/on-a-sample': ['native', 'native', [], true],
  'asof/between-samples': ['native', 'native', [], true],
  'asof/before-the-first': ['native', 'native', [], true],
  'asof/after-the-last': ['native', 'native', [], true],
  'resample/fixed-minute-mean': ['native', 'native', [], true],
  'resample/fixed-minute-count': ['native', 'native', [], true],
  'resample/gapped-omit': ['native', 'native', [], true],
  'resample/gapped-null-buckets': ['set', 'hybrid', ['fill-policy'], true],
  'resample/sparse-fill-null': ['set', 'hybrid', ['fill-policy'], true],
  'resample/sparse-fill-zero': ['set', 'hybrid', ['fill-policy'], true],
  'resample/sparse-fill-locf': ['set', 'hybrid', ['fill-policy'], true],
  'resample/sparse-fill-linear': ['set', 'hybrid', ['fill-policy'], true],
  'resample/gapped-first': ['set', 'hybrid', ['unsupported-aggregate'], true],
  'resample/gapped-last': ['set', 'hybrid', ['unsupported-aggregate'], true],
  'resample/explicit-empty-edges': ['set', 'hybrid', ['fill-policy'], true],
  'resample/calendar-month': ['set', 'hybrid', ['calendar-width'], true],
  'rolling/time-mean-30s': ['set', 'hybrid', ['rolling-refinement'], true],
  'rolling/min-periods-withholds': ['set', 'hybrid', ['rolling-refinement'], true],
  'rolling/gapped-sum': ['set', 'hybrid', ['rolling-refinement'], true],
  'rolling/gapped-count-keeps-the-gaps': ['set', 'hybrid', ['rolling-refinement'], true],
  'rolling/gapped-max': ['set', 'hybrid', ['rolling-refinement'], true],
  'rolling/duplicate-instants-share-an-answer': ['set', 'hybrid', ['rolling-refinement'], true],
  // an as-of join with no key has no prefix to pin, so the one-sided
  // bound is honest and the fetch reads the table: that is the row
  'asof/backward-unkeyed':
    ['set', 'hybrid', ['asof-refinement', 'missing-series-prefix'], false],
  'asof/forward': ['set', 'hybrid', ['asof-refinement', 'missing-series-prefix'], false],
  'asof/nearest-ties-backward':
    ['set', 'engine', ['asof-refinement', 'missing-series-prefix'], false],
  'asof/tolerance-refuses-a-distant-match':
    ['set', 'hybrid', ['asof-refinement', 'missing-series-prefix'], false],
  'asof/keyed': ['set', 'hybrid', ['asof-refinement'], true],
  'asof/keyed-nearest': ['set', 'hybrid', ['asof-refinement'], true],
  'asof/selectors-read-both-spellings': ['set', 'hybrid', ['asof-refinement'], true],
};

/** The engine's own result shape for a sequence of items. */
const sequence = (items) => (items.length === 0 ? undefined
  : items.length === 1 ? items[0] : items);

/** What one projected case expects, in the shape a call answers. */
const wanted = (projected) => (Array.isArray(projected.expected)
  ? sequence(projected.expected) : projected.expected);

/** The two drivers, by name; the wasm one initializes once. */
const DRIVERS = { 'sqlite-node': () => nodeDriver(), 'sqlite-wasm': () => wasmDriverInstance };
/** @type {any} */
let wasmDriverInstance = null;
before(async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  wasmDriverInstance = wasmDriver(sqlite3Handle(sqlite3));
});

/** Open a store over one case's documents. */
async function storeFor(driver, documents, mapping, path = undefined) {
  const store = await openStore(MAPPINGS[mapping],
    path === undefined ? { driver } : { driver, path });
  const collection = store.collection(SERIES_COLLECTION);
  await store.transaction(async () => {
    for (const document of documents) await collection.insert(document);
  });
  return { store, collection };
}

describe('the temporal corpus through SQLite', () => {
  it('projects the cases a collection can carry, and the plan table is complete', () => {
    assert.ok(PROJECTED.length >= 30, `only ${PROJECTED.length} cases projected`);
    assert.deepStrictEqual(PROJECTED.map((row) => row.entry.name).sort(),
      Object.keys(PLANS).sort(),
      'every projected case has a plan row, and every plan row names a projected case');
    // and the shapes the order actually promised are all present
    const shapes = new Set(PROJECTED.map((row) => row.projected.shape));
    assert.deepStrictEqual([...shapes].sort(),
      ['asof', 'asof-join', 'bucket', 'range', 'resample', 'rolling']);
  });

  /** Cases actually executed, per executor and mapping. */
  const ran = {};
  for (const executor of Object.keys(DRIVERS)) {
    for (const mapping of /** @type {const} */ (['indexed', 'unindexed'])) {
      ran[`${executor}/${mapping}`] = 0;
      describe(`${executor}, ${mapping} — every case answers what the references recorded`, () => {
        for (const { entry, projected } of PROJECTED) {
          it(entry.name, async () => {
            const { store, collection } = await storeFor(DRIVERS[executor](), projected.documents, mapping);
            try {
              const where = `${executor} (${mapping}) disagreed on ${entry.name}`;
              const expected = wanted(projected);
              const actual = await collection.execute(projected.query);
              assert.ok(deepEquals(actual, expected),
                `${where}: recorded ${JSON.stringify(expected)}, `
                + `answered ${JSON.stringify(actual)}`);

              // and the ENGINE alone, over the same rows: a pushdown is
              // compared against the answer with no pushdown in it
              const forced = await collection.execute(projected.query, { pushdown: false });
              assert.ok(deepEquals(forced, expected),
                `${where} with pushdown forced off: answered ${JSON.stringify(forced)}`);

              // the plan, not just the answer (a silent residual agrees forever)
              if (mapping === 'indexed') {
                const explained = await collection.explain(projected.query);
                const [mode, seriesMode, reasons, seeks] = PLANS[entry.name];
                assert.strictEqual(explained.mode, mode, `${where}: document mode`);
                assert.strictEqual(explained.series.mode, seriesMode, `${where}: temporal mode`);
                assert.deepStrictEqual(explained.series.reasons.map((r) => r.code), reasons,
                  `${where}: reasons`);
                assert.strictEqual(explained.scanNarrative.includes('USING INDEX'), seeks,
                  `${where}: the database's own plan is ${explained.scanNarrative}`);
                assert.strictEqual(explained.series.index !== null, seeks,
                  `${where}: the reported index must agree with the plan the database took`);
              }
              else {
                const explained = await collection.explain(projected.query);
                if (projected.shape === 'range' || projected.shape === 'asof') {
                  // a plain FLWOR over a collection that declares no
                  // composite index asked an ORDINARY question: nothing
                  // in a column says "instant", and inventing one would
                  // make every `age > 21` a temporal plan
                  assert.strictEqual(explained.series, null, `${where}: no index, no instant`);
                }
                else {
                  // a document that NAMED a §8.16 operator said so
                  // itself, so the record survives and carries the loss
                  assert.strictEqual(explained.series.index, null,
                    `${where}: nothing is declared, so nothing may be claimed`);
                  assert.ok(explained.series.reasons.some((r) => r.code === 'missing-series-prefix'),
                    `${where}: an unindexed mapping names the loss`);
                }
                assert.doesNotMatch(explained.scanNarrative, /USING INDEX/,
                  `${where}: an unindexed mapping cannot seek`);
              }
              ran[`${executor}/${mapping}`] += 1;
            }
            finally {
              await store.close();
            }
          });
        }
      });
    }
  }

  it('ran every projected case under both drivers and both mappings — the count', () => {
    assert.deepStrictEqual(ran,
      Object.fromEntries(Object.keys(ran).map((key) => [key, PROJECTED.length])),
      'an executor ran fewer cases than the corpus carries');
  });
});

describe('the counts explain() reports are the last ACTUAL run, never an estimate', () => {
  it('null before the document has run, and the real numbers after it', async () => {
    const { entry, projected } = PROJECTED.find((row) => row.entry.name === 'resample/gapped-omit');
    const { store, collection } = await storeFor(nodeDriver(), projected.documents, 'indexed');
    try {
      const before = await collection.explain(projected.query);
      assert.strictEqual(before.series.counts, null,
        `${entry.name}: nothing has run, so there is nothing to count`);
      const answer = await collection.execute(projected.query);
      const after = await collection.explain(projected.query);
      assert.strictEqual(after.series.counts.statements, 1);
      assert.strictEqual(after.series.counts.results, answer.length);
      assert.strictEqual(after.series.counts.candidates, answer.length,
        'a native bucket answers the groups it fetched');
      assert.deepStrictEqual(collection.stats().series,
        { queries: 1, statements: 1, candidates: answer.length,
          results: answer.length, diverted: 0 });
    }
    finally {
      await store.close();
    }
  });

  it('a refinement counts the CANDIDATES it fetched and the items it answered', async () => {
    const { projected } = PROJECTED.find((row) => row.entry.name === 'rolling/time-mean-30s');
    const { store, collection } = await storeFor(nodeDriver(), projected.documents, 'indexed');
    try {
      const answer = await collection.execute(projected.query);
      const explained = await collection.explain(projected.query);
      assert.strictEqual(explained.series.counts.candidates, projected.documents.length,
        'a rolling window answers once per input instant, so every row is a candidate');
      assert.strictEqual(explained.series.counts.results, answer.length);
      assert.strictEqual(explained.series.refinement, 'rollingSeries');
    }
    finally {
      await store.close();
    }
  });
});

describe('strict mode refuses a refinement before it runs', () => {
  for (const name of ['resample/sparse-fill-locf', 'resample/calendar-month',
    'rolling/gapped-sum', 'asof/keyed']) {
    it(`${name} is JD0010, and the message names the temporal reason`, async () => {
      const { projected } = PROJECTED.find((row) => row.entry.name === name);
      const { store, collection } = await storeFor(nodeDriver(), projected.documents, 'indexed');
      try {
        await assert.rejects(
          Promise.resolve().then(() => collection.execute(projected.query, { strict: true })),
          (error) => {
            assert.strictEqual(/** @type {any} */ (error).code, 'JD0010');
            const [, , reasons] = PLANS[name];
            assert.match(/** @type {any} */ (error).message, new RegExp(reasons[0]));
            return true;
          });
      }
      finally {
        await store.close();
      }
    });
  }

  for (const name of ['range/interior-minute', 'asof/on-a-sample', 'bucket/fixed-minute',
    'resample/fixed-minute-mean']) {
    it(`${name} is native, so strict mode runs it`, async () => {
      const { projected } = PROJECTED.find((row) => row.entry.name === name);
      const { store, collection } = await storeFor(nodeDriver(), projected.documents, 'indexed');
      try {
        const actual = await collection.execute(projected.query, { strict: true });
        assert.ok(deepEquals(actual, wanted(projected)));
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('a native bucket that meets a row with no instant hands the question back', () => {
  it('the engine refuses it, and the store diverts rather than inventing a group', async () => {
    // the kernel refuses a row whose instant names none (JQ2001); SQL
    // cannot refuse, and would group every such row under one NULL
    // bucket. The store fetches the whole collection and lets the
    // engine answer what it answers everywhere — counted, never quiet
    const { store, collection } = await storeFor(nodeDriver(),
      [{ series: 'sensor-a', at: 1000, value: 1 }, { series: 'sensor-a', value: 2 }], 'indexed');
    try {
      const query = { $resample: [{ $for: { s: '$[*]' }, $return: '$s' }, { every: 1000 }] };
      const explained = await collection.explain(query);
      assert.strictEqual(explained.mode, 'native', 'the plan is a bucket');
      await assert.rejects(
        Promise.resolve().then(() => collection.execute(query)),
        (error) => /** @type {any} */ (error).code === 'JQ2001');
      assert.strictEqual(collection.stats().series.diverted, 1,
        'the diversion is counted; a native bucket that quietly answered would be the defect');
    }
    finally {
      await store.close();
    }
  });
});

describe('the grouping spelling: every order and window the plan pushes', () => {
  const ORIGIN = 1767225600000;
  const rows = [];
  for (let i = 0; i < 300; i++)
    rows.push({ series: 'sensor-a', at: ORIGIN + i * 1000, value: i % 7 });
  const grouped = (extra) => ({
    $for: { r: '$[*]' },
    $where: { $and: [
      { $eq: ['$r.series', 'sensor-a'] },
      { $ge: ['$r.at', ORIGIN] },
      { $lt: ['$r.at', ORIGIN + 300000] },
    ] },
    $groupby: { b: { '$time-bucket': ['$r.at', 60000, ORIGIN] } },
    $return: { at: '$b', v: { $avg: '$r.value' }, n: { $count: '$r' } },
    ...extra,
  });
  const SHAPES = {
    'ascending under a window': [{ $subsequence: [grouped({ $orderby: ['$b'] }), 0, 2] },
      /GROUP BY "at" ORDER BY "at" ASC LIMIT 2$/],
    descending: [grouped({ $orderby: [{ $key: '$b', $dir: 'desc' }] }),
      /GROUP BY "at" ORDER BY "at" DESC$/],
    'first appearance under a window': [{ $subsequence: [grouped({}), 0, 2] },
      /GROUP BY "at" ORDER BY MIN\("rowid"\) LIMIT 2$/],
  };

  for (const [label, [document, sql]] of Object.entries(SHAPES)) {
    it(`${label} is native, and answers what the engine alone answers`, async () => {
      const store = await openStore(MAPPINGS.indexed, { driver: nodeDriver() });
      const collection = store.collection(SERIES_COLLECTION);
      try {
        await store.transaction(async () => {
          for (const row of rows) await collection.insert(row);
        });
        const explained = await collection.explain(document);
        assert.strictEqual(explained.mode, 'native');
        assert.match(explained.sql, sql);
        assert.ok(deepEquals(await collection.execute(document),
          await collection.execute(document, { pushdown: false })),
        `${label}: the pushed answer and the engine's must not disagree`);
      }
      finally {
        await store.close();
      }
    });
  }
});

describe("a profile's row bound counts what the fetch answered, and refuses", () => {
  it('a bucket under maxRows answers; one past it is JD2007, never a truncation', async () => {
    const rows = [];
    for (let i = 0; i < 120; i++)
      rows.push({ series: 'sensor-a', at: i * 1000, value: i % 7 });
    const store = await openStore(MAPPINGS.indexed, { driver: nodeDriver(),
      profile: { collections: [SERIES_COLLECTION], maxRows: 3, refuseFullScan: true } });
    const collection = store.collection(SERIES_COLLECTION);
    try {
      await store.transaction(async () => {
        for (const row of rows) await collection.insert(row);
      });
      const document = (every) => ({ $resample: [
        { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'sensor-a'] }, $return: '$s' },
        { every }] });
      const answered = await collection.execute(document(60000));
      assert.strictEqual(answered.length, 2, 'two minutes of readings, two buckets');
      await assert.rejects(
        Promise.resolve().then(() => collection.execute(document(30000))),
        (error) => /** @type {any} */ (error).code === 'JD2007');
    }
    finally {
      await store.close();
    }
  });
});

describe('the streaming cursor answers what execute answers', () => {
  for (const name of ['resample/fixed-minute-mean', 'rolling/gapped-sum', 'range/interior-minute']) {
    it(name, async () => {
      const { projected } = PROJECTED.find((row) => row.entry.name === name);
      const { store, collection } = await storeFor(nodeDriver(), projected.documents, 'indexed');
      try {
        const items = [];
        for await (const item of collection.query(projected.query)) items.push(item);
        assert.ok(deepEquals(sequence(items), wanted(projected)),
          `${name}: the cursor and the call must not disagree`);
      }
      finally {
        await store.close();
      }
    });
  }
});

describe("the injected clock reaches the residual, and the zone survives it", () => {
  // D7's seam, and the one thing it exists to prevent: a refinement
  // that rebuilt the spec instead of passing it through would answer in
  // UTC and be right for eight months of the year. The provider is a
  // scripted fixed offset, so nothing here depends on the host's tzdb.
  const OFFSET = 120;
  const provider = {
    toParts: (epoch) => {
      const d = new Date(epoch + OFFSET * 60000);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
        milliseconds: d.getUTCMilliseconds(), offset: OFFSET };
    },
    toEpoch: (parts) => Date.UTC(parts.year, parts.month - 1, parts.day,
      parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, parts.milliseconds ?? 0)
      - OFFSET * 60000,
  };
  const rows = [];
  for (let month = 0; month < 6; month++) {
    for (const day of [1, 15])
      rows.push({ series: 'sensor-a', at: Date.UTC(2026, month, day, 12), value: month + day / 100 });
  }
  const document = { $resample: [
    { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'sensor-a'] }, $return: '$s' },
    { every: 'P1M', zone: 'Test/Fixed', aggregate: 'mean' }] };

  it('a named zone with no provider is refused, never answered in UTC', async () => {
    const store = await openStore(MAPPINGS.indexed, { driver: nodeDriver() });
    const collection = store.collection(SERIES_COLLECTION);
    try {
      for (const row of rows) await collection.insert(row);
      const explained = await collection.explain(document);
      assert.strictEqual(explained.series.mode, 'hybrid');
      assert.deepStrictEqual(explained.series.reasons.map((r) => r.code), ['named-zone']);
      await assert.rejects(
        Promise.resolve().then(() => collection.execute(document)),
        (error) => /** @type {any} */ (error).code === 'JQ0003');
    }
    finally {
      await store.close();
    }
  });

  it('with one injected the ladder walks it, and answers what the kernel does', async () => {
    const store = await openStore(MAPPINGS.indexed,
      { driver: nodeDriver(), zoneProvider: provider });
    const collection = store.collection(SERIES_COLLECTION);
    try {
      for (const row of rows) await collection.insert(row);
      const actual = await collection.execute(document);
      assert.ok(deepEquals(actual,
        resampleSeries(rows, { every: 'P1M', zone: 'Test/Fixed', provider, aggregate: 'mean' })),
      'the frozen spec reached the kernel unchanged — zone included');
      // and it is NOT what UTC would have said, or the assertion above
      // would pass for a refinement that dropped the zone
      assert.ok(!deepEquals(actual,
        resampleSeries(rows, { every: 'P1M', aggregate: 'mean' })),
      'a UTC answer here would be the D7 failure this test exists for');
    }
    finally {
      await store.close();
    }
  });
});

describe('reopening a file-backed store does not change an answer', () => {
  it('the same corpus, the same plan and the same rows after a close', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const { projected } = PROJECTED.find((row) => row.entry.name === 'range/interior-minute');
    const bucket = PROJECTED.find((row) => row.entry.name === 'bucket/fixed-minute').projected;
    try {
      const first = await storeFor(nodeDriver(), projected.documents, 'indexed', dbPath);
      const before = await first.collection.execute(projected.query);
      const bucketBefore = await first.collection.execute(bucket.query);
      await first.store.close();

      // the second open VERIFIES the declared shape rather than
      // rebuilding it, so an index that did not survive is JD0002 here
      const store = await openStore(MAPPINGS.indexed, { driver: nodeDriver(), path: dbPath });
      const collection = store.collection(SERIES_COLLECTION);
      try {
        assert.ok(deepEquals(await collection.execute(projected.query), before));
        assert.ok(deepEquals(await collection.execute(bucket.query), bucketBefore));
        const explained = await collection.explain(projected.query);
        assert.strictEqual(explained.series.index, 'sample_by_series_at');
        assert.match(explained.scanNarrative, /USING INDEX sample_by_series_at/);
      }
      finally {
        await store.close();
      }
    }
    finally {
      cleanup();
    }
  });
});
