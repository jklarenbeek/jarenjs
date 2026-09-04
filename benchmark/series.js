#!/usr/bin/env node
//@ts-check
/**
 * JarenJS Series Benchmark — the ground a temporal kernel has to stand
 * on, measured before one exists.
 *
 * A seeded series of `{ at, value }` samples at one-second spacing is
 * answered the same four questions — a range, fixed buckets, a rolling
 * mean, and the latest value at or before an instant — by every executor
 * the suite already has:
 *
 *   the plain references  a full filter and a sorted binary cut; a
 *                         one-pass bucket loop and a one-pass rolling
 *                         sum, each checked against the obvious
 *                         implementation it replaces
 *   a query document      the same bucketing through `$start-of` and
 *                         `$groupby`, and the same window through the
 *                         count-based `$window` — twice, because the
 *                         window over a bare value array and the window
 *                         labelled at the instant it ends are different
 *                         prices for different answers
 *   stock SQLite          a declared epoch column under a `(series, at)`
 *                         index, against the same range read out of the
 *                         stored JSON document with date functions
 *   the kernel            `@jarenjs/core/series` — the same buckets, the
 *                         same rolling mean, the same as-of read and,
 *                         beyond what the references answer, a fill
 *                         policy over a corpus full of holes, a bucket
 *                         ladder routed through an injected zone
 *                         provider, and a downsampler
 *
 * The kernel rows arrived in the order the campaign built them, against
 * a ground that was published before any of them existed. The one-pass
 * references are the ceiling, not a rival: they answer a fixed question
 * with a loop written for that question, and a kernel that validates a
 * specification, normalizes a series and returns a labelled record is
 * measured honestly against them rather than compared with something
 * easier.
 *
 * Correctness before timing, and refusal on disagreement. Every
 * committed case in `test/json/fixtures/series-corpus.json` is replayed
 * through the references, and then every pair above must answer the
 * identical rows — same instants, same values, same order — before a
 * single number prints. `--verify` stops there.
 *
 * Every row publishes the spread its own rounds disagreed by (p75/p25)
 * beside its median, so two runs are compared against a measured
 * tolerance rather than an invented one, and a ratio drawn from a noisy
 * row is legible as the band it is.
 *
 * Rows that lose stay in. The resident arrays start from decoded numbers
 * in RAM and pay nothing for durability, where SQLite starts from bytes
 * on a page: the database is not faster than an array it has already
 * been read into, and saying so is the point of publishing both. What
 * the database buys is durability, a selective read that never touches
 * the rest of the corpus, and composition with everything else stored
 * beside it.
 *
 * Raw SQL appears here because the question is physical: what a declared
 * epoch column under an index costs against reparsing the document it
 * came from. No planner is involved, and none is claimed.
 *
 * Usage:
 *   node benchmark/series.js                     # the full grid
 *   node benchmark/series.js --quick             # one small leg
 *   node benchmark/series.js --verify            # equivalence only
 *   node benchmark/series.js --sizes 20000,100000
 *   node benchmark/series.js --output json --filepath results.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { queryJson } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import {
  resampleSeries, rollingSeries, asOfJoin, downsampleSeries,
} from '@jarenjs/core/series';

import {
  SERIES_ORIGIN, SERIES_STEP_MS, SERIES_SEED, VALUE_LAW, SERIES_CORPUS_PATH,
  generateSeries, asDocuments,
  filterRange, cutRange, bucketStart, bucketOnePass, bucketNaive,
  rollingMeanOnePass, rollingMeanNaive, asOfBackward, probeInstants, gappedSeries,
  referenceAnswer, seriesMappings, SERIES_COLLECTION,
} from '../scripts/lib/series-corpus.js';

import { formatNs } from './lib/fmt.js';
import { quantile } from '@jarenjs/core/stats';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

//#region flags

const argv = process.argv.slice(2);

/**
 * Every option this suite reads, and whether it takes a value. A run
 * that quietly ignored `--verifyy` would answer the full grid where the
 * operator asked for equivalence alone, and the transcript would look
 * like a benchmark somebody meant to run.
 */
const OPTIONS = Object.freeze({
  '--quick': false, '--verify': false, '--help': false, '-h': false,
  '--sizes': true, '--warmup': true, '--seed': true,
  '--output': true, '--filepath': true,
});
for (let i = 0; i < argv.length; i++) {
  const takesValue = OPTIONS[argv[i]];
  if (takesValue === undefined) {
    console.error(`Unknown option: ${argv[i]}`);
    console.error(`This suite reads ${Object.keys(OPTIONS).join(', ')}.`);
    process.exit(2);
  }
  if (takesValue) {
    if (argv[i + 1] === undefined || OPTIONS[argv[i + 1]] !== undefined) {
      console.error(`${argv[i]} needs a value.`);
      process.exit(2);
    }
    i++;
  }
}

const list = (name, fallback) => (argv.includes(name)
  ? argv[argv.indexOf(name) + 1].split(',').map((s) => parseInt(s.trim(), 10))
  : fallback);
const one = (name, fallback) =>
  (argv.includes(name) ? parseInt(argv[argv.indexOf(name) + 1], 10) : fallback);

const flags = {
  quick: argv.includes('--quick'),
  verify: argv.includes('--verify'),
  sizes: list('--sizes', null),
  warmup: one('--warmup', 3),
  seed: one('--seed', SERIES_SEED),
  output: argv.includes('--output') ? argv[argv.indexOf('--output') + 1] : null,
  filepath: argv.includes('--filepath') ? argv[argv.indexOf('--filepath') + 1] : null,
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node benchmark/series.js [--quick] [--verify] [--sizes a,b] [--warmup N]');
  console.log('  [--seed N] [--output json --filepath PATH]');
  process.exit(0);
}

/** The corpus sizes measured. The query rows are the slow ones, so a
 * quick run keeps only the small leg. */
const SIZES = flags.sizes ?? (flags.quick ? [20_000] : [20_000, 100_000]);

/** Unmeasured passes before each row's samples are kept. */
const WARMUP = flags.quick ? 1 : flags.warmup;

/**
 * Rounds per row. The generic query rows run five because one of them
 * costs tens of milliseconds and nine buys no resolution; the indexed
 * as-of runs fifty-one because a single microsecond read is below the
 * clock's own noise until it is repeated.
 */
const ROUNDS = Object.freeze({ default: 9, query: 5, asof: 51 });

/** Every published order statistic here is a value that was measured. */
const NEAREST = /** @type {const} */ ({ method: 'nearest-rank' });

/** The width of the measured range, and of a bucket. */
const RANGE_MS = 3600_000;
const BUCKET_MS = 60_000;

/** The rolling window, in samples. At one-second spacing it is also
 * sixty seconds wide, which is what makes the count-based `$window` row
 * comparable to it. */
const ROLLING_WIDTH = 60;

/** The one series key every row lives under. */
const SERIES_KEY = 'sensor-a';

/**
 * The gap corpus: every 997 samples, 300 of them are measured gaps. At
 * one-second spacing that is a five-minute outage roughly every quarter
 * of an hour — about 30% of the corpus missing, in runs long enough to
 * empty whole buckets, which is the only shape that exercises a fill
 * policy at all.
 */
const GAP_PERIOD = 997;
const GAP_RUN = 300;

/** What a downsampled line is asked for — D11's default threshold. */
const RENDER_TARGET = 2000;

/**
 * The zone the calendar row runs on: `Etc/UTC` is a NAMED zone, so every
 * boundary goes through the provider, and it is a constant zero offset,
 * so the provider ladder must answer EXACTLY what the integer ladder
 * does and the row's whole content is what routing every boundary
 * through the provider costs. The provider is the shipped one over the
 * host's ICU (`@jarenjs/locales/intl-zones`) — what a consumer actually
 * passes — wrapped only to count the calls. Correctness across a real
 * transition is a test's job (`test/locales/intl-zones.test.js`); a
 * benchmark that changed the answer could not compare the two.
 */
const BENCH_ZONE = 'Etc/UTC';

/** How many times the ladder has asked the provider for a boundary. */
const providerCalls = { toParts: 0, toEpoch: 0 };

const intlProvider = createIntlZoneProvider();

const benchProvider = {
  toParts: (epoch, zone) => {
    providerCalls.toParts++;
    return intlProvider.toParts(epoch, zone);
  },
  toEpoch: (parts, zone, disambiguation) => {
    providerCalls.toEpoch++;
    return intlProvider.toEpoch(parts, zone, disambiguation);
  },
};

//#endregion

//#region checks

const checks = [];
let failures = 0;

/**
 * Record an equivalence check; a failure withholds every timing. The
 * detail is what the reader needs to see when it fails — the two counts,
 * or the first instant that disagreed — never just "false".
 * @param {string} name
 * @param {boolean} agrees
 * @param {string} detail
 */
function check(name, agrees, detail) {
  checks.push({ name, agrees, detail });
  if (!agrees) {
    failures++;
    console.error(`EQUIVALENCE FAILURE: ${name} — ${detail}`);
  }
}

/**
 * Where two `{ at, value }` sequences first disagree, or null when they
 * do not. Compared by equality: every value in this corpus is an exact
 * binary fraction and every sum of them is exact, so a tolerance here
 * would only hide a real divergence.
 * @param {{at: number, value: number}[]} a
 * @param {{at: number, value: number}[]} b
 * @returns {string | null}
 */
function firstDisagreement(a, b) {
  if (a.length !== b.length)
    return `${a.length} rows against ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].at !== b[i].at || a[i].value !== b[i].value) {
      return `row ${i}: {at ${a[i].at}, value ${a[i].value}}`
        + ` against {at ${b[i].at}, value ${b[i].value}}`;
    }
  }
  return null;
}

/**
 * The same comparison, with the bucket `count` a bucketing executor also
 * has to reproduce.
 * @param {{at: number, value: number, count: number}[]} a
 * @param {{at: number, value: number, count: number}[]} b
 * @returns {string | null}
 */
function firstBucketDisagreement(a, b) {
  const rows = firstDisagreement(a, b);
  if (rows !== null)
    return rows;
  for (let i = 0; i < a.length; i++) {
    if (a[i].count !== b[i].count)
      return `row ${i}: count ${a[i].count} against ${b[i].count}`;
  }
  return null;
}

/**
 * The obvious resample-and-fill: key every sample into a map, walk the
 * whole range, then interpolate across each run of empty buckets. It
 * allocates a map, it makes three passes, and it is exactly the loop a
 * consumer writes today — which is what makes it the reference the
 * kernel's single pass has to agree with before it is timed.
 * @param {{at: number, value: number | null}[]} samples - ascending
 * @param {number} every
 * @param {number} origin
 * @returns {{ at: number, value: number | null, count: number }[]}
 */
function resampleFillNaive(samples, every, origin) {
  if (samples.length === 0)
    return [];
  /** @type {Map<number, {sum: number, n: number, count: number}>} */
  const groups = new Map();
  for (const sample of samples) {
    const key = bucketStart(sample.at, every, origin);
    let group = groups.get(key);
    if (group === undefined) {
      group = { sum: 0, n: 0, count: 0 };
      groups.set(key, group);
    }
    group.count++;
    if (sample.value !== null) {
      group.sum += sample.value;
      group.n++;
    }
  }
  const first = bucketStart(samples[0].at, every, origin);
  const last = bucketStart(samples[samples.length - 1].at, every, origin);
  const out = [];
  for (let at = first; at <= last; at += every) {
    const group = groups.get(at);
    out.push(group === undefined
      ? { at, value: /** @type {number | null} */ (null), count: 0 }
      : { at, value: group.n === 0 ? null : group.sum / group.n, count: group.count });
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].count !== 0)
      continue;
    let end = i;
    while (end < out.length && out[end].count === 0) end++;
    let before = i - 1;
    while (before >= 0 && (out[before].count === 0 || out[before].value === null)) before--;
    let after = end;
    while (after < out.length && (out[after].count === 0 || out[after].value === null)) after++;
    if (before >= 0 && after < out.length) {
      const a = out[before];
      const b = out[after];
      const slope = (/** @type {number} */(b.value) - /** @type {number} */(a.value)) / (b.at - a.at);
      for (let k = i; k < end; k++)
        out[k].value = /** @type {number} */(a.value) + slope * (out[k].at - a.at);
    }
    i = end - 1;
  }
  return out;
}

/**
 * What a downsampled line has to be true of, since there is no second
 * implementation to compare it with: nothing invented, nothing
 * reordered, the ends where the data's ends are, one marker per run of
 * gaps, and no more points than were asked for.
 * @param {any} result
 * @param {{at: number, value: number | null}[]} source
 * @param {number} target
 * @returns {string | null} the first violation, or null
 */
function downsampleViolation(result, source, target) {
  const { points } = result;
  if (points.length > target)
    return `${points.length} points against a target of ${target}`;
  if (result.renderedCount !== points.length || result.sourceCount !== source.length)
    return `counts ${result.renderedCount}/${result.sourceCount} against ${points.length}/${source.length}`;
  if (points[0].at !== source[0].at || points[points.length - 1].at !== source[source.length - 1].at)
    return 'an end moved';
  const known = new Set(source.map((s) => `${s.at}|${s.value}`));
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].at < points[i - 1].at)
      return `out of order at ${i}`;
    if (!known.has(`${points[i].at}|${points[i].value}`))
      return `invented a point at ${points[i].at}`;
  }
  let runs = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i].value === null && (i === 0 || source[i - 1].value !== null))
      runs++;
  }
  const markers = points.filter((p) => p.value === null).length;
  if (markers !== runs)
    return `${markers} gap markers against ${runs} runs of gaps`;
  return null;
}

//#endregion

//#region the committed oracle

/**
 * Replay every case in the committed fixture through the references.
 * The fixture is what a second executor — a query, a database plan, a
 * browser tab — will be held to in a later order, so a run that measured
 * references which had drifted away from it would be measuring the wrong
 * thing entirely.
 * @returns {{ version: number, cases: number, samples: number }}
 */
function verifyCommittedCorpus() {
  const corpus = JSON.parse(readFileSync(new URL(`../${SERIES_CORPUS_PATH}`, import.meta.url), 'utf8'));
  const samples = generateSeries(corpus.samples.length, corpus.origin, corpus.stepMs);
  check('the fixture\'s samples are the ones the generator makes',
    JSON.stringify(samples) === JSON.stringify(corpus.samples),
    `${corpus.samples.length} samples under ${corpus.law}`);
  let refused = 0;
  for (const entry of corpus.cases) {
    // a refusal is a compiler's answer, not a reference's: those cases
    // carry an error CODE rather than a value, and the query suite is
    // where they are executed. Counting them here says so out loud
    // rather than silently walking past a third of the file.
    if (entry.kind === 'invalid') {
      refused++;
      continue;
    }
    const actual = referenceAnswer(entry, samples);
    const agrees = JSON.stringify(actual) === JSON.stringify(entry.expected);
    check(`fixture case '${entry.name}'`, agrees,
      agrees ? `${entry.kind}, as committed` : `${entry.kind}: ${JSON.stringify(actual).slice(0, 160)}`);
  }
  check('the fixture\'s refusals are the query compiler\'s to answer, not a reference\'s',
    refused > 0, `${refused} cases carry a refusal code`);
  return { version: corpus.version, cases: corpus.cases.length, samples: corpus.samples.length };
}

//#endregion

//#region measurement

/**
 * One row's cost: `rounds` runs after `WARMUP` unmeasured passes,
 * reported as the median with the spread it was drawn from. A mean over
 * a handful of runs hides which one was slow; the median is what the
 * ground this suite reproduces published.
 *
 * The spread is `p75 / p25` — the row's own tolerance, measured rather
 * than declared. A row whose rounds disagree with each other is the row
 * whose median will disagree with itself between runs, and a reader
 * comparing two runs needs to know which rows those are before reading a
 * ratio as a point rather than a band.
 *
 * @param {() => any} run
 * @param {number} rounds
 * @returns {{ ns: number, spread: number }} median nanoseconds, and p75/p25
 */
function medianNs(run, rounds) {
  for (let w = 0; w < WARMUP; w++) run();
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - start));
  }
  // nearest rank: with nine rounds, interpolating between two samples
  // invents a number nobody measured; `samples` is never empty (rounds ≥ 1)
  const lo = /** @type {number} */ (quantile(samples, 0.25, NEAREST));
  return {
    ns: /** @type {number} */ (quantile(samples, 0.5, NEAREST)),
    spread: lo === 0 ? 1 : Math.round((/** @type {number} */ (quantile(samples, 0.75, NEAREST)) / lo) * 100) / 100,
  };
}

//#endregion

//#region the statements
// Read out loud rather than assembled, because the physical question is
// exactly what they say: the first two answer the same range from a
// declared integer column and from the document it was derived from.

const SQL = Object.freeze({
  range: 'SELECT at, value FROM sample WHERE series = ? AND at >= ? AND at < ? ORDER BY at',
  jsonRange: 'SELECT json_extract(doc, \'$.on\') AS at, json_extract(doc, \'$.value\') AS value'
    + ' FROM sample WHERE json_extract(doc, \'$.series\') = ?'
    + ' AND CAST(strftime(\'%s\', json_extract(doc, \'$.on\')) AS INTEGER) * 1000 >= ?'
    + ' AND CAST(strftime(\'%s\', json_extract(doc, \'$.on\')) AS INTEGER) * 1000 < ?'
    + ' ORDER BY json_extract(doc, \'$.on\')',
  asOf: 'SELECT at, value FROM sample WHERE series = ? AND at <= ? ORDER BY at DESC LIMIT 1',
  bucket: 'SELECT (at - CAST(? AS INTEGER)) / CAST(? AS INTEGER) AS b,'
    + ' avg(value) AS value, count(*) AS n'
    + ' FROM sample WHERE series = ? GROUP BY b ORDER BY b',
});

// The same four questions, asked of the STORE rather than of raw SQL.
// These go through the planner: a document, a plan, a dialect and the
// same `(series, at)` index the raw statements above read by hand — so
// the pair of rows prices what recognizing a shape costs against
// writing the statement yourself, and the store rows against the
// resident ones price durability.

const STORE_SERIES = { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', SERIES_KEY] },
  $return: '$s' };

/** The query documents, compiled once by the engine's own literal cache. */
const CALENDAR_BUCKET_QUERY = {
  $for: { s: '$[*]' },
  $groupby: { b: { '$start-of': ['$s.on', 'minute'] } },
  $orderby: ['$b'],
  $return: { at: '$b', value: { $avg: '$s.value' }, count: { $count: '$s.value' } },
};

// The count window twice, because the two answer different questions.
// The first is what the language actually offers over a bare value
// array: a sequence of means with no instants on them, which is the row
// the ground published. The second is the same window over the stored
// documents, labelled at its last instant so it IS the series a rolling
// kernel returns — and it costs what carrying the label costs, because
// the vocabulary has no "last item of this window" and `$max` over sixty
// RFC 3339 strings is the way to say it.
const COUNT_WINDOW_QUERY = {
  $for: { w: { $in: '$[*]', $window: 'sliding', $size: ROLLING_WIDTH } },
  $return: { $avg: '$w' },
};

const LABELLED_WINDOW_QUERY = {
  $for: { w: { $in: '$[*]', $window: 'sliding', $size: ROLLING_WIDTH } },
  $return: { at: { $max: '$w.on' }, value: { $avg: '$w.value' } },
};

//#endregion

//#region one leg

/**
 * Everything measured at one corpus size: the corpus, the store loaded
 * from it, every equivalence check between the executors, and — unless
 * the run stops at `--verify` — every timing.
 * @param {number} n
 */
async function runLeg(n) {
  const label = `${n.toLocaleString('en-US')} samples`;
  const series = generateSeries(n);
  const gapped = gappedSeries(series, GAP_PERIOD, GAP_RUN);
  // the same outages with the rows removed rather than emptied: a fill
  // policy answers a bucket that has no rows at all, and a `null` at an
  // instant that exists is a measurement, not a missing bucket
  const sparse = gapped.filter((sample) => sample.value !== null);
  const documents = asDocuments(series, SERIES_KEY);
  const values = series.map((sample) => sample.value);
  const last = series[n - 1].at;

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sample (series TEXT NOT NULL, at INTEGER NOT NULL,'
    + ' value REAL NOT NULL, doc TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO sample (series, at, value, doc) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < n; i++)
    insert.run(SERIES_KEY, series[i].at, series[i].value, JSON.stringify(documents[i]));
  db.exec('COMMIT');
  db.exec('CREATE INDEX sample_series_at ON sample (series, at)');

  // the same rows again, through the store: one collection, the same
  // composite index, and every question asked as a DOCUMENT
  const store = await openStore(seriesMappings().indexed, { driver: nodeDriver() });
  const samples = store.collection(SERIES_COLLECTION);
  // the load writes through the transaction's OWN handle: a transaction
  // owns its connection, and the outer handle would wait for it
  await store.transaction(async (tx) => {
    const loading = tx.collection(SERIES_COLLECTION);
    for (let i = 0; i < n; i++)
      await loading.insert({ series: SERIES_KEY, at: series[i].at, value: series[i].value });
  });

  const rangeStmt = db.prepare(SQL.range);
  const jsonRangeStmt = db.prepare(SQL.jsonRange);
  const asOfStmt = db.prepare(SQL.asOf);
  const bucketStmt = db.prepare(SQL.bucket);

  // the range every range row answers, and the instants the as-of rows
  // probe: one window in the middle of the corpus, and fifty-one
  // instants drawn from it, so no row measures one lucky page
  const rangeStart = SERIES_ORIGIN + Math.floor(n / 3) * SERIES_STEP_MS;
  const rangeEnd = rangeStart + RANGE_MS;
  const probes = probeInstants(ROUNDS.asof, SERIES_ORIGIN, last, flags.seed);

  //#region equivalence

  const filtered = filterRange(series, rangeStart, rangeEnd);
  const cut = cutRange(series, rangeStart, rangeEnd);
  const cutRows = series.slice(cut.lo, cut.hi);
  check(`${label}: the sorted cut reads the rows the full filter finds`,
    firstDisagreement(filtered, cutRows) === null,
    firstDisagreement(filtered, cutRows) ?? `${filtered.length} rows`);

  const buckets = bucketOnePass(series, BUCKET_MS, SERIES_ORIGIN);
  const bucketsNaive = bucketNaive(series, BUCKET_MS, SERIES_ORIGIN);
  check(`${label}: the one-pass bucket loop answers what the obvious grouping does`,
    firstBucketDisagreement(buckets, bucketsNaive) === null,
    firstBucketDisagreement(buckets, bucketsNaive) ?? `${buckets.length} buckets`);

  const rolling = rollingMeanOnePass(series, ROLLING_WIDTH);
  const rollingNaive = rollingMeanNaive(series, ROLLING_WIDTH);
  check(`${label}: the one-pass rolling sum answers what a fresh sum per window does`,
    firstDisagreement(rolling, rollingNaive) === null,
    firstDisagreement(rolling, rollingNaive) ?? `${rolling.length} windows`);

  const queryBuckets = queryJson(CALENDAR_BUCKET_QUERY, documents)
    .map((/** @type {any} */ row) => ({ at: Date.parse(row.at), value: row.value, count: row.count }));
  check(`${label}: calendar-minute buckets from a query document match the fixed-width loop`,
    firstBucketDisagreement(queryBuckets, buckets) === null,
    firstBucketDisagreement(queryBuckets, buckets) ?? `${queryBuckets.length} buckets`);

  const queryWindows = /** @type {any[]} */ (queryJson(COUNT_WINDOW_QUERY, values));
  const windowMismatch = queryWindows.length !== rolling.length
    ? `${queryWindows.length} means against ${rolling.length}`
    : queryWindows.findIndex((v, i) => v !== rolling[i].value);
  check(`${label}: a count window of ${ROLLING_WIDTH} over the values matches the rolling sum`,
    windowMismatch === -1, windowMismatch === -1 ? `${queryWindows.length} means`
      : `${windowMismatch}`);

  const labelledWindows = /** @type {any[]} */ (queryJson(LABELLED_WINDOW_QUERY, documents))
    .map((row) => ({ at: Date.parse(row.at), value: row.value }));
  check(`${label}: the same window labelled from the documents matches it instant for instant`,
    firstDisagreement(labelledWindows, rolling) === null,
    firstDisagreement(labelledWindows, rolling) ?? `${labelledWindows.length} windows`);

  const sqlRange = /** @type {any[]} */ (rangeStmt.all(SERIES_KEY, rangeStart, rangeEnd));
  check(`${label}: the indexed range reads the rows the sorted cut does`,
    firstDisagreement(sqlRange, cutRows) === null,
    firstDisagreement(sqlRange, cutRows) ?? `${sqlRange.length} rows`);

  const sqlJsonRange = /** @type {any[]} */ (jsonRangeStmt.all(SERIES_KEY, rangeStart, rangeEnd))
    .map((row) => ({ at: Date.parse(row.at), value: row.value }));
  check(`${label}: the same range read out of the stored document agrees with the column`,
    firstDisagreement(sqlJsonRange, cutRows) === null,
    firstDisagreement(sqlJsonRange, cutRows) ?? `${sqlJsonRange.length} rows`);

  let asOfMismatch = null;
  for (const at of probes) {
    const expected = asOfBackward(series, at);
    const rows = /** @type {any[]} */ (asOfStmt.all(SERIES_KEY, at));
    const actual = rows.length === 0 ? null : { at: rows[0].at, value: rows[0].value };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      asOfMismatch = `at ${at}: ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`;
      break;
    }
  }
  check(`${label}: the indexed as-of answers the reference on all ${probes.length} probes`,
    asOfMismatch === null, asOfMismatch ?? `${probes.length} probes`);

  const sqlBuckets = /** @type {any[]} */ (bucketStmt.all(SERIES_ORIGIN, BUCKET_MS, SERIES_KEY))
    .map((row) => ({ at: SERIES_ORIGIN + row.b * BUCKET_MS, value: row.value, count: row.n }));
  check(`${label}: the grouped integer bucket aggregate matches the one-pass loop`,
    firstBucketDisagreement(sqlBuckets, buckets) === null,
    firstBucketDisagreement(sqlBuckets, buckets) ?? `${sqlBuckets.length} buckets`);

  // the kernel answers the references' own questions before it is timed
  // against them, and its two new ones against the obvious loop

  const kernelBuckets = resampleSeries(series,
    { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean' });
  check(`${label}: the kernel's fixed buckets match the one-pass loop`,
    firstBucketDisagreement(kernelBuckets, buckets) === null,
    firstBucketDisagreement(kernelBuckets, buckets) ?? `${kernelBuckets.length} buckets`);

  const kernelDays = resampleSeries(series, { every: 'P1D', aggregate: 'mean' });
  providerCalls.toParts = 0;
  providerCalls.toEpoch = 0;
  const kernelDaysZoned = resampleSeries(series,
    { every: 'P1D', aggregate: 'mean', zone: BENCH_ZONE, provider: benchProvider });
  const boundaryCalls = providerCalls.toParts + providerCalls.toEpoch;
  check(`${label}: a daily ladder walked through the injected provider answers the integer one`,
    firstBucketDisagreement(kernelDaysZoned, kernelDays) === null,
    firstBucketDisagreement(kernelDaysZoned, kernelDays)
      ?? `${kernelDays.length} days, ${boundaryCalls} provider calls for ${n} samples`);
  // the ladder is O(buckets), not O(rows): a provider consulted per
  // sample would be the defect no timing on this corpus could show,
  // because a 28-hour corpus only has two daily boundaries in it
  check(`${label}: and asks the provider per boundary rather than per sample`,
    boundaryCalls < 4 * (kernelDays.length + 2),
    `${boundaryCalls} calls for ${kernelDays.length} buckets over ${n} samples`);

  const kernelSparse = resampleSeries(sparse,
    { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean' });
  const kernelFilled = resampleSeries(sparse,
    { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'linear' });
  const filledNaive = resampleFillNaive(sparse, BUCKET_MS, SERIES_ORIGIN);
  check(`${label}: filling the empty buckets keeps every bucket the omitting run reported`,
    kernelSparse.every((row, i) => firstBucketDisagreement(
      [row], [kernelFilled.filter((b) => b.count !== 0)[i]]) === null),
    `${kernelSparse.length} measured of ${kernelFilled.length} emitted`);
  check(`${label}: linear fill over the gap corpus matches the obvious map-and-walk`,
    firstBucketDisagreement(kernelFilled, filledNaive) === null,
    firstBucketDisagreement(kernelFilled, filledNaive)
      ?? `${kernelFilled.length} buckets, ${kernelFilled.filter((b) => b.count === 0).length} filled`);

  const kernelRolling = rollingSeries(series,
    { width: ROLLING_WIDTH * SERIES_STEP_MS, aggregate: 'mean', minPeriods: ROLLING_WIDTH });
  const rollingTail = kernelRolling.slice(ROLLING_WIDTH - 1);
  const rollingHead = kernelRolling.slice(0, ROLLING_WIDTH - 1);
  check(`${label}: the kernel's time window of ${ROLLING_WIDTH} s matches the one-pass ring sum`,
    firstDisagreement(/** @type {any[]} */ (rollingTail), rolling) === null,
    firstDisagreement(/** @type {any[]} */ (rollingTail), rolling) ?? `${rollingTail.length} windows`);
  check(`${label}: and withholds a value for every window short of ${ROLLING_WIDTH} rows`,
    rollingHead.every((row) => row.value === null),
    `${rollingHead.length} withheld, ${kernelRolling.length} rows in all`);

  const probeRows = probes.map((at) => ({ at, value: null }));
  const kernelAsOf = asOfJoin(probeRows, series);
  const asOfExpected = probes.map((at) => asOfBackward(series, at));
  let joinMismatch = null;
  for (let i = 0; i < kernelAsOf.length; i++) {
    // the join returns the LEFT side in its own sorted order, and the
    // probes were drawn unsorted on purpose, so the comparison is by
    // instant rather than by position
    const actual = kernelAsOf[i].right;
    const expected = asOfBackward(series, kernelAsOf[i].left.at);
    if ((actual === null) !== (expected === null)
      || (actual !== null && (actual.at !== expected.at || actual.value !== expected.value))) {
      joinMismatch = `probe at ${kernelAsOf[i].left.at}`;
      break;
    }
  }
  check(`${label}: the kernel's as-of join answers the reference on all ${probes.length} probes`,
    joinMismatch === null, joinMismatch ?? `${kernelAsOf.length} matches`);

  // the same join at the other shape: one left row for every hundred
  // right rows, which is where a walk stops paying for the right side
  // it already had to read and an index starts paying per probe
  const denseLeft = series.filter((_, i) => i % 100 === 0).map((row) => ({ at: row.at, value: null }));
  const kernelAsOfDense = asOfJoin(denseLeft, series);
  let denseMismatch = null;
  for (let i = 0; i < kernelAsOfDense.length; i++) {
    const expected = asOfBackward(series, kernelAsOfDense[i].left.at);
    const actual = kernelAsOfDense[i].right;
    if (actual === null || expected === null || actual.at !== expected.at) {
      denseMismatch = `left row ${i}`;
      break;
    }
  }
  check(`${label}: the same join over ${denseLeft.length} left rows answers the reference too`,
    denseMismatch === null, denseMismatch ?? `${kernelAsOfDense.length} matches`);

  const sqlAsOfJoin = probes.map((at) => {
    const rows = /** @type {any[]} */ (asOfStmt.all(SERIES_KEY, at));
    return rows.length === 0 ? null : { at: rows[0].at, value: rows[0].value };
  });
  let storedJoinMismatch = null;
  for (let i = 0; i < probes.length; i++) {
    if (JSON.stringify(sqlAsOfJoin[i]) !== JSON.stringify(asOfExpected[i] === null ? null
      : { at: asOfExpected[i].at, value: asOfExpected[i].value })) {
      storedJoinMismatch = `probe ${i} at ${probes[i]}`;
      break;
    }
  }
  check(`${label}: the same join through ${probes.length} index reads answers the same rows`,
    storedJoinMismatch === null, storedJoinMismatch ?? `${sqlAsOfJoin.length} matches`);

  const rendered = downsampleSeries(series, { target: RENDER_TARGET });
  const renderedGaps = downsampleSeries(gapped, { target: RENDER_TARGET });
  check(`${label}: the downsampled line invents nothing and moves no end`,
    downsampleViolation(rendered, series, RENDER_TARGET) === null,
    downsampleViolation(rendered, series, RENDER_TARGET)
      ?? `${rendered.renderedCount} of ${rendered.sourceCount} points`);
  check(`${label}: the same over the gap corpus keeps every run of gaps a gap`,
    downsampleViolation(renderedGaps, gapped, RENDER_TARGET) === null,
    downsampleViolation(renderedGaps, gapped, RENDER_TARGET)
      ?? `${renderedGaps.renderedCount} points, `
        + `${renderedGaps.points.filter((p) => p.value === null).length} markers`);
  check(`${label}: and draws the same line twice from the same series`,
    JSON.stringify(downsampleSeries(gapped, { target: RENDER_TARGET }).points)
      === JSON.stringify(renderedGaps.points),
    'two runs, one answer');

  //#region the store, over the same rows

  // Four documents, four plans. The first three are what the planner
  // recognizes — an indexed range, a fixed bucket ladder and an as-of
  // join bounded by the probes it was given — and the fourth is what it
  // deliberately does NOT: a window measured in time is a refinement,
  // so the index bounds the fetch and the kernel decides. Each one is
  // checked against the answer its resident twin gives before it is
  // timed, and the plan the database took is read from the store's own
  // `explain()` rather than asserted.

  const STORE_RANGE = {
    $for: { s: '$[*]' },
    $where: { $and: [
      { $eq: ['$s.series', SERIES_KEY] },
      { $ge: ['$s.at', rangeStart] },
      { $lt: ['$s.at', rangeEnd] },
    ] },
    $orderby: [{ $key: '$s.at' }],
    $return: '$s',
  };
  const STORE_BUCKET = { $resample: [STORE_SERIES,
    { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean' }] };
  const STORE_ROLLING = { $rolling: [STORE_SERIES,
    { width: ROLLING_WIDTH * SERIES_STEP_MS, aggregate: 'mean', minPeriods: ROLLING_WIDTH }] };
  const storeProbes = probes.map((at) => ({ series: SERIES_KEY, at, value: null }));
  const STORE_ASOF = { $asof: [{ $const: storeProbes }, '$[*]', { by: '$.series' }] };

  const stored = (document) => {
    const answer = samples.execute(document);
    if (typeof answer?.then === 'function')
      throw new Error('the node driver answered a promise; a benchmark cannot time one');
    return answer === undefined ? [] : (Array.isArray(answer) ? answer : [answer]);
  };

  const storeRange = stored(STORE_RANGE);
  check(`${label}: the store's indexed range answers the rows the sorted cut finds`,
    firstDisagreement(storeRange.map((row) => ({ at: row.at, value: row.value })), cutRows) === null,
    firstDisagreement(storeRange.map((row) => ({ at: row.at, value: row.value })), cutRows)
      ?? `${storeRange.length} rows`);

  const storeBucket = stored(STORE_BUCKET);
  check(`${label}: the store's native bucket answers the one-pass loop, value for value`,
    firstBucketDisagreement(storeBucket, buckets) === null,
    firstBucketDisagreement(storeBucket, buckets) ?? `${storeBucket.length} buckets`);

  const storeRolling = stored(STORE_ROLLING);
  check(`${label}: the store's rolling refinement answers the kernel it hands the rows to`,
    firstDisagreement(storeRolling, /** @type {any[]} */ (kernelRolling)) === null,
    firstDisagreement(storeRolling, /** @type {any[]} */ (kernelRolling))
      ?? `${storeRolling.length} windows`);

  const storeAsOf = stored(STORE_ASOF);
  let storeJoinMismatch = null;
  for (let i = 0; i < storeAsOf.length; i++) {
    const expected = asOfBackward(series, storeAsOf[i].left.at);
    const actual = storeAsOf[i].right;
    if ((actual === null) !== (expected === null)
      || (actual !== null && (actual.at !== expected.at || actual.value !== expected.value))) {
      storeJoinMismatch = `probe at ${storeAsOf[i].left.at}`;
      break;
    }
  }
  check(`${label}: the store's batched as-of join answers the reference on all ${probes.length} probes`,
    storeJoinMismatch === null, storeJoinMismatch ?? `${storeAsOf.length} matches`);

  /** What the store said it would do, and what it actually read. */
  const storePlans = {};
  const storeCounts = {};
  for (const [key, document] of Object.entries({
    storeRange: STORE_RANGE, storeBucket: STORE_BUCKET,
    storeRolling: STORE_ROLLING, storeAsOfJoin: STORE_ASOF,
  })) {
    const explained = await samples.explain(document);
    storePlans[key] = `${explained.series.mode}: ${explained.scanNarrative}`;
    storeCounts[key] = explained.series.counts;
  }
  // the whole point of the batched join, as a number: a FIXED cost,
  // whatever the probes number, and a fetch the index bounded. Two
  // statements now — the anchor seek that closes the open side, then
  // the join's own fetch — and two is as flat in the probes as one was
  check(`${label}: the batched join costs a FIXED two statements for ${probes.length} probes`,
    storeCounts.storeAsOfJoin.statements === 2,
    `${storeCounts.storeAsOfJoin.statements} statement(s), `
      + `${storeCounts.storeAsOfJoin.candidates} candidates of ${n} rows`);

  //#endregion

  //#endregion

  const plans = Object.fromEntries(Object.entries({
    range: [SQL.range, [SERIES_KEY, rangeStart, rangeEnd]],
    jsonRange: [SQL.jsonRange, [SERIES_KEY, rangeStart, rangeEnd]],
    asOf: [SQL.asOf, [SERIES_KEY, rangeStart]],
    bucket: [SQL.bucket, [SERIES_ORIGIN, BUCKET_MS, SERIES_KEY]],
  }).map(([key, [sql, args]]) => [key,
    /** @type {any[]} */ (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(.../** @type {any[]} */ (args)))
      .map((row) => row.detail).join(' | ')]));
  Object.assign(plans, storePlans);

  const results = {
    filter: filtered.length,
    cut: cut.hi - cut.lo,
    bucket: buckets.length,
    rolling: rolling.length,
    kernelBucket: kernelBuckets.length,
    kernelDay: kernelDays.length,
    kernelDayZoned: kernelDaysZoned.length,
    kernelSparse: kernelSparse.filter((row) => row.count !== 0).length,
    kernelFill: kernelFilled.length,
    kernelRolling: kernelRolling.length,
    kernelAsOf: kernelAsOf.length,
    kernelAsOfDense: kernelAsOfDense.length,
    kernelRender: rendered.renderedCount,
    kernelRenderGaps: renderedGaps.renderedCount,
    sqlAsOfJoin: sqlAsOfJoin.length,
    sqlAsOfDense: denseLeft.length,
    queryBucket: queryBuckets.length,
    queryWindow: queryWindows.length,
    labelledWindow: labelledWindows.length,
    sqlRange: sqlRange.length,
    sqlJsonRange: sqlJsonRange.length,
    sqlAsOf: 1,
    sqlBucket: sqlBuckets.length,
    storeRange: storeRange.length,
    storeBucket: storeBucket.length,
    storeRolling: storeRolling.length,
    storeAsOfJoin: storeAsOf.length,
  };

  if (flags.verify || failures !== 0) {
    db.close();
    await store.close();
    return { n, label, rows: {}, results, plans, counts: storeCounts };
  }

  let probe = 0;
  const rows = {
    filter: medianNs(() => filterRange(series, rangeStart, rangeEnd), ROUNDS.default),
    cut: medianNs(() => {
      // the same 3,600 rows the filter returns, so the two rows are the
      // same answer reached two ways rather than a bound against a list
      const bounds = cutRange(series, rangeStart, rangeEnd);
      return series.slice(bounds.lo, bounds.hi);
    }, ROUNDS.default),
    bucket: medianNs(() => bucketOnePass(series, BUCKET_MS, SERIES_ORIGIN), ROUNDS.default),
    rolling: medianNs(() => rollingMeanOnePass(series, ROLLING_WIDTH), ROUNDS.default),
    kernelBucket: medianNs(() => resampleSeries(series,
      { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean' }), ROUNDS.default),
    kernelDay: medianNs(() => resampleSeries(series,
      { every: 'P1D', aggregate: 'mean' }), ROUNDS.default),
    kernelDayZoned: medianNs(() => resampleSeries(series,
      { every: 'P1D', aggregate: 'mean', zone: BENCH_ZONE, provider: benchProvider }),
    ROUNDS.default),
    kernelSparse: medianNs(() => resampleSeries(sparse,
      { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean' }), ROUNDS.default),
    kernelFill: medianNs(() => resampleSeries(sparse,
      { every: BUCKET_MS, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'linear' }),
    ROUNDS.default),
    kernelRolling: medianNs(() => rollingSeries(series,
      { width: ROLLING_WIDTH * SERIES_STEP_MS, aggregate: 'mean', minPeriods: ROLLING_WIDTH }),
    ROUNDS.default),
    kernelAsOf: medianNs(() => asOfJoin(probeRows, series), ROUNDS.default),
    kernelAsOfDense: medianNs(() => asOfJoin(denseLeft, series), ROUNDS.default),
    kernelRender: medianNs(() => downsampleSeries(series, { target: RENDER_TARGET }),
      ROUNDS.default),
    kernelRenderGaps: medianNs(() => downsampleSeries(gapped, { target: RENDER_TARGET }),
      ROUNDS.default),
    queryBucket: medianNs(() => queryJson(CALENDAR_BUCKET_QUERY, documents), ROUNDS.query),
    queryWindow: medianNs(() => queryJson(COUNT_WINDOW_QUERY, values), ROUNDS.query),
    labelledWindow: medianNs(() => queryJson(LABELLED_WINDOW_QUERY, documents), ROUNDS.query),
    sqlRange: medianNs(() => rangeStmt.all(SERIES_KEY, rangeStart, rangeEnd), ROUNDS.default),
    sqlJsonRange: medianNs(() => jsonRangeStmt.all(SERIES_KEY, rangeStart, rangeEnd), ROUNDS.default),
    sqlAsOf: medianNs(() => asOfStmt.all(SERIES_KEY, probes[probe++ % probes.length]), ROUNDS.asof),
    sqlAsOfJoin: medianNs(() => probes.map((at) => asOfStmt.all(SERIES_KEY, at)), ROUNDS.default),
    sqlAsOfDense: medianNs(() => denseLeft.map((row) => asOfStmt.all(SERIES_KEY, row.at)),
      ROUNDS.default),
    sqlBucket: medianNs(() => bucketStmt.all(SERIES_ORIGIN, BUCKET_MS, SERIES_KEY), ROUNDS.default),
    storeRange: medianNs(() => samples.execute(STORE_RANGE), ROUNDS.default),
    storeBucket: medianNs(() => samples.execute(STORE_BUCKET), ROUNDS.default),
    storeRolling: medianNs(() => samples.execute(STORE_ROLLING), ROUNDS.default),
    storeAsOfJoin: medianNs(() => samples.execute(STORE_ASOF), ROUNDS.default),
  };
  db.close();
  await store.close();
  return { n, label, rows, results, plans, counts: storeCounts };
}

//#endregion

//#region run

const corpusMeta = verifyCommittedCorpus();

const legs = [];
for (const n of SIZES)
  legs.push(await runLeg(n));

const width = Math.max(...checks.map((c) => c.name.length)) + 2;
console.log(`\nEquivalence — ${checks.length} checks, every one before a timing`);
for (const c of checks)
  console.log(`  ${c.agrees ? 'ok  ' : 'FAIL'} ${c.name.padEnd(width)} ${c.detail}`);

if (failures !== 0) {
  console.error(`\n${failures} equivalence check(s) failed; no timing is reported.`);
  process.exit(1);
}

if (flags.verify) {
  console.log(`\nverified: ${checks.length} checks over corpus version ${corpusMeta.version}`
    + ` (${corpusMeta.cases} committed cases). No timing was taken.`);
  process.exit(0);
}

//#endregion

//#region the tables

const ns = (v) => (v === undefined ? '—' : formatNs(v.ns));
const count = (v) => (v === undefined ? '—' : v.toLocaleString('en-US'));
const ratio = (a, b) => (a === undefined || b === undefined ? null
  : Math.round((a.ns / b.ns) * 100) / 100);
const times = (r) => (r === null ? '—' : `${r.toFixed(2)}×`);

const ORDER = [
  ['filter', `${RANGE_MS / 3600_000} h range — full in-memory filter`],
  ['cut', `${RANGE_MS / 3600_000} h range — sorted binary cut`],
  ['bucket', `fixed ${BUCKET_MS / 1000} s buckets — one-pass loop`],
  ['rolling', `rolling mean, width ${ROLLING_WIDTH} — one-pass ring sum`],
  ['kernelBucket', `fixed ${BUCKET_MS / 1000} s buckets — core resampleSeries`],
  ['kernelDay', 'daily buckets — core resampleSeries, integer ladder'],
  ['kernelDayZoned', 'daily buckets — core resampleSeries, the Intl zone provider'],
  ['kernelSparse', `fixed ${BUCKET_MS / 1000} s buckets, gap corpus — core resampleSeries (fill omit)`],
  ['kernelFill', `the same buckets + linear fill — core resampleSeries (fill linear)`],
  ['kernelRolling', `rolling mean, ${ROLLING_WIDTH} s window — core rollingSeries`],
  ['kernelAsOf', 'as-of join, 51 left rows — core asOfJoin'],
  ['kernelAsOfDense', 'as-of join, one left row per 100 — core asOfJoin'],
  ['kernelRender', `${RENDER_TARGET} points from the line — core downsampleSeries (lttb)`],
  ['kernelRenderGaps', `${RENDER_TARGET} points, gap corpus — core downsampleSeries (lttb)`],
  ['queryBucket', 'calendar-minute buckets — query document ($start-of + $groupby)'],
  ['queryWindow', `count window ${ROLLING_WIDTH} over the values — query document ($window)`],
  ['labelledWindow', `the same window, labelled — query document ($window + $max)`],
  ['sqlRange', `${RANGE_MS / 3600_000} h range — SQLite, declared epoch column`],
  ['sqlJsonRange', `${RANGE_MS / 3600_000} h range — SQLite, date functions over the document`],
  ['sqlAsOf', 'as-of one instant — SQLite, index read backwards'],
  ['sqlAsOfJoin', 'the same 51-row join — SQLite, one index read per left row'],
  ['sqlAsOfDense', 'the same dense join — SQLite, one index read per left row'],
  ['sqlBucket', `fixed ${BUCKET_MS / 1000} s aggregate — SQLite, integer bucket + GROUP BY`],
  ['storeRange', `${RANGE_MS / 3600_000} h range — the store, a document over the (series, at) index`],
  ['storeBucket', `fixed ${BUCKET_MS / 1000} s buckets — the store, $resample pushed to GROUP BY`],
  ['storeRolling', `rolling mean, ${ROLLING_WIDTH} s window — the store, index-bounded + core kernel`],
  ['storeAsOfJoin', `as-of join, ${ROUNDS.asof} left rows — the store, one batched fetch + core kernel`],
];

const largest = legs[legs.length - 1];

/** The widest within-run spread at the largest leg — the row a reader
 * has to treat as a band rather than a point. */
const noisiest = ORDER
  .filter(([key]) => largest.rows[key] !== undefined)
  .reduce((worst, [key, name]) =>
    (worst === null || largest.rows[key].spread > worst.spread
      ? { route: key, label: name, spread: largest.rows[key].spread }
      : worst), null);

const timingTable = {
  title: `One temporal question, every route a consumer has today — median of ${ROUNDS.default}`
    + ` rounds (${ROUNDS.query} for the query rows, ${ROUNDS.asof} for the as-of)`,
  head: ['route', ...legs.map((leg) => leg.label), 'rows'],
  rows: ORDER.map(([key, name]) => ({
    cells: [name, ...legs.map((leg) => ns(leg.rows[key])), count(largest.results[key])],
    strong: key === 'cut' || key === 'sqlRange' || key.startsWith('kernel'),
  })),
  note: 'Lower is better. Every route answered the identical rows — same instants, same values,'
    + ' same order — before it was timed. The resident rows start from decoded numbers already in'
    + ' RAM and pay nothing for durability, where every SQLite row starts from bytes on a page:'
    + ' they are the ceiling a stored answer is measured against, not a row a database can win.'
    + ' The "rows" column is the answer size at the largest leg. Each row also carries the'
    + ' spread its own rounds disagreed by (p75/p25), published beside its median: the widest'
    + ` here is ${noisiest.label} at ${noisiest.spread.toFixed(2)}×, and a row that disagrees`
    + ' with itself within a run is the row whose ratio has to be read as a band between runs.',
};

const planTable = {
  title: 'What SQLite actually did',
  head: ['statement', 'plan'],
  rows: [
    ['range', 'declared epoch column, (series, at) index'],
    ['jsonRange', 'the same range through json_extract + strftime'],
    ['asOf', 'the index read backwards, one row'],
    ['bucket', 'integer bucket key, GROUP BY'],
    ['storeRange', 'the store\'s range document, planned'],
    ['storeBucket', 'the store\'s $resample, planned'],
    ['storeRolling', 'the store\'s $rolling — a named refinement'],
    ['storeAsOfJoin', 'the store\'s $asof — one batched fetch'],
  ].map(([key, name]) => ({ cells: [name, largest.plans[key]], strong: false })),
  note: 'Read from EXPLAIN QUERY PLAN on the measuring host rather than asserted. The declared'
    + ' column is the difference between a search and a scan, and the scan is what a consumer'
    + ' storing instants only inside the document is paying for every range read. The four store'
    + ' rows carry the plan MODE the planner chose in front of the plan the database took, so a'
    + ' refinement that quietly stopped being one would show here: `native` means the statement'
    + ' alone answered, and `hybrid` means the index bounded the fetch and the temporal kernel'
    + ' decided over what came back.',
};

const tables = [timingTable, planTable];
for (const table of tables) {
  console.log(`\n${table.title}`);
  const w = Math.max(...table.rows.map((r) => String(r.cells[0]).length),
    String(table.head[0]).length) + 2;
  console.log(`  ${String(table.head[0]).padEnd(w)}`
    + `${table.head.slice(1).map((h) => String(h).padStart(22)).join('')}`);
  for (const row of table.rows) {
    console.log(`  ${String(row.cells[0]).padEnd(w)}`
      + `${row.cells.slice(1).map((c) => String(c).padStart(22)).join('')}`);
  }
  console.log(`  ${table.note}`);
}

//#endregion

//#region the derived figures

/**
 * The ratios the notes and any published prose are drawn from, so a
 * verdict can never outlive the number behind it. Every one is taken at
 * the largest leg, which `largest` names.
 */
const figures = {
  largest: largest.label,
  cutVsFilter: ratio(largest.rows.filter, largest.rows.cut),
  columnVsDocument: ratio(largest.rows.sqlJsonRange, largest.rows.sqlRange),
  storedRangeVsResident: ratio(largest.rows.sqlRange, largest.rows.cut),
  storedBucketVsResident: ratio(largest.rows.sqlBucket, largest.rows.bucket),
  queryBucketVsResident: ratio(largest.rows.queryBucket, largest.rows.bucket),
  queryWindowVsResident: ratio(largest.rows.queryWindow, largest.rows.rolling),
  labelCost: ratio(largest.rows.labelledWindow, largest.rows.queryWindow),
  asOfVsRange: ratio(largest.rows.sqlRange, largest.rows.sqlAsOf),
  kernelBucketVsOnePass: ratio(largest.rows.kernelBucket, largest.rows.bucket),
  kernelRollingVsOnePass: ratio(largest.rows.kernelRolling, largest.rows.rolling),
  kernelBucketVsQuery: ratio(largest.rows.queryBucket, largest.rows.kernelBucket),
  kernelRollingVsQuery: ratio(largest.rows.labelledWindow, largest.rows.kernelRolling),
  providerCost: ratio(largest.rows.kernelDayZoned, largest.rows.kernelDay),
  fillCost: ratio(largest.rows.kernelFill, largest.rows.kernelSparse),
  kernelAsOfVsStored: ratio(largest.rows.kernelAsOf, largest.rows.sqlAsOfJoin),
  kernelAsOfDenseVsStored: ratio(largest.rows.kernelAsOfDense, largest.rows.sqlAsOfDense),
  gapRenderCost: ratio(largest.rows.kernelRenderGaps, largest.rows.kernelRender),
  storeRangeVsSql: ratio(largest.rows.storeRange, largest.rows.sqlRange),
  storeRangeVsResident: ratio(largest.rows.storeRange, largest.rows.cut),
  storeBucketVsSql: ratio(largest.rows.storeBucket, largest.rows.sqlBucket),
  storeBucketVsQuery: ratio(largest.rows.queryBucket, largest.rows.storeBucket),
  storeBucketVsResident: ratio(largest.rows.storeBucket, largest.rows.bucket),
  storeRollingVsResident: ratio(largest.rows.storeRolling, largest.rows.kernelRolling),
  storeAsOfVsIndexReads: ratio(largest.rows.storeAsOfJoin, largest.rows.sqlAsOfJoin),
  storeAsOfCandidates: largest.counts?.storeAsOfJoin?.candidates ?? null,
  storeAsOfStatements: largest.counts?.storeAsOfJoin?.statements ?? null,
  storeRollingCandidates: largest.counts?.storeRolling?.candidates ?? null,
  renderReduction: largest.results.kernelRender === undefined ? null
    : Math.round((largest.n / largest.results.kernelRender) * 100) / 100,
  noisiestRoute: noisiest.route,
  noisiestSpread: noisiest.spread,
};

const notes = [
  `A sorted cut answers the ${RANGE_MS / 3600_000}-hour range ${times(figures.cutVsFilter)} faster`
    + ` than filtering all ${largest.label} — bounds, not predicates, are what a range read is.`,
  `A declared epoch column under a (series, at) index answers that range`
    + ` ${times(figures.columnVsDocument)} faster than date functions over the stored document,`
    + ' which is a search against a scan and shows in the plan.',
  `The same range costs ${times(figures.storedRangeVsResident)} the resident cut, and the grouped`
    + ` aggregate ${times(figures.storedBucketVsResident)} the one-pass loop. Durable execution is`
    + ' not faster than an array already decoded in memory, and this suite does not claim it is:'
    + ' what the database buys is that it never had to read the rest of the corpus.',
  `The generic route a consumer has today costs ${times(figures.queryBucketVsResident)} the`
    + ` one-pass bucket loop and ${times(figures.queryWindowVsResident)} the one-pass rolling sum.`
    + ' Those two ratios are the size of the gap a temporal kernel exists to close.',
  `Labelling that window with the instant it ends at costs a further ${times(figures.labelCost)},`
    + ' because the vocabulary has no "last item of this window": saying it takes `$max` over sixty'
    + ' RFC 3339 strings per window. The unlabelled row is the one the ground published; the'
    + ' labelled one is the answer a rolling kernel actually returns.',
  `Every row carries the spread its own rounds disagreed by; the widest at ${figures.largest} is`
    + ` ${noisiest.label} at ${noisiest.spread.toFixed(2)}×. That is the tolerance to read the`
    + ' ratios above with — a row that disagrees with itself inside one run will disagree with'
    + ' itself between two.',
  `The kernel costs ${times(figures.kernelBucketVsOnePass)} the one-pass bucket loop and`
    + ` ${times(figures.kernelRollingVsOnePass)} the one-pass ring sum, and answers`
    + ` ${times(figures.kernelBucketVsQuery)} faster than the generic bucket route and`
    + ` ${times(figures.kernelRollingVsQuery)} faster than the labelled window. That is the trade`
    + ' this campaign is making, stated as two numbers rather than one: a loop written for one'
    + ' question stays the ceiling, and the gap the vocabulary was paying is closed.',
  `Routing every bucket boundary through the shipped Intl zone provider costs`
    + ` ${times(figures.providerCost)} the integer ladder over the identical answer. A 28-hour corpus`
    + ' has two daily boundaries in it, so the row prices a handful of ICU reads against the whole'
    + ' ladder, proves the two ladders agree, and proves the provider is consulted per BOUNDARY'
    + ' rather than per sample — which the equivalence checks count outright; it does not price a'
    + ' provider over a corpus long enough to need one.',
  `Filling the empty buckets of a corpus ${Math.round((GAP_RUN / GAP_PERIOD) * 100)}% missing costs`
    + ` ${times(figures.fillCost)} emitting only the buckets that had rows. That is the fill pass`
    + ' alone: the same corpus, the same ladder, one policy apart.',
  `The as-of join LOSES to the index at ${ROUNDS.asof} left rows —`
    + ` ${times(figures.kernelAsOfVsStored)} the cost of ${ROUNDS.asof} index reads — and wins at`
    + ` ${times(1 / (figures.kernelAsOfDenseVsStored ?? 1))} once there is one left row per hundred`
    + ' right ones. The reason is the shape rather than the engine: a b-tree pays O(log n) per'
    + ' probe, and a sorted walk pays for the whole right side whether it was asked one question or'
    + ' a thousand. Few questions of a large series belong to the index; a join of two series'
    + ' belongs to the walk. Both rows stay in.',
  `The store answers the same range at ${times(figures.storeRangeVsSql)} the hand-written`
    + ' statement — which selects two COLUMNS where the store renders and parses a whole JSON'
    + ' document per row. That is the price of storing documents rather than columns, and it is'
    + ` not the planner's: the same ladder as a GROUP BY costs ${times(figures.storeBucketVsSql)}`
    + ' the hand-written one, where the extra is a guarded predicate and one member read out of'
    + ` the document. Against the generic query route the vocabulary had before, the pushed bucket`
    + ` is ${times(figures.storeBucketVsQuery)} FASTER. Against a decoded array in memory the`
    + ` range is ${times(figures.storeRangeVsResident)} and the bucket`
    + ` ${times(figures.storeBucketVsResident)}: durability and a selective read are what that`
    + ' buys, and both numbers are published rather than netted out.',
  `A window measured in time is NOT pushed — it is a named refinement — and the store answers it`
    + ` at ${times(figures.storeRollingVsResident)} the resident kernel over`
    + ` ${figures.storeRollingCandidates?.toLocaleString('en-US')} candidates the index bounded.`
    + ' The database contributes the fetch; `rollingSeries` contributes the answer, and'
    + " `explain()` says so rather than calling the result native.",
  `The batched as-of join costs ${times(figures.storeAsOfVsIndexReads)} ${ROUNDS.asof} separate`
    + ` index reads, in ${figures.storeAsOfStatements} statements rather than ${ROUNDS.asof} — and`
    + ` it read ${figures.storeAsOfCandidates?.toLocaleString('en-US')} of ${largest.label}. That`
    + ' is the trade stated plainly. With no tolerance the open side has no bound the probes'
    + ' imply — the row answering the earliest probe may lie arbitrarily far before it — so the'
    + " plan asks the database for the data's own: per series, the last instant at or before that"
    + ' probe, folded to the least of them. It is one aggregate through the same index, and it is'
    + ' the second statement. What it saves depends on where the probes sit, and these fifty-one'
    + ' are spread evenly across the whole span: the earliest sits near the beginning, so there is'
    + ' little below it to skip, and this is the anchor at its WORST. What the batch buys is the'
    + ' bound — a fixed two statements whatever the probes number — and a tolerance, or a key with'
    + ' few rows behind it, is what makes the candidate set small.',
  `Downsampling ${largest.label} to ${RENDER_TARGET} points is a ${figures.renderReduction}x`
    + ` reduction, and doing it over the gap corpus costs ${times(figures.gapRenderCost)} the dense`
    + ' one: the holes are segment boundaries, and each segment is sampled on its own budget so'
    + ' that no line is ever drawn across one.',
];

console.log('\nDerived figures');
for (const note of notes)
  console.log(`  · ${note}`);

const headline = {
  title: `Bounds beat predicates by ${times(figures.cutVsFilter)}, and a declared column beats the`
    + ` document it came from by ${times(figures.columnVsDocument)}`,
  text: `Over ${largest.label} at ${SERIES_STEP_MS / 1000}-second spacing, every route answers the`
    + ' identical rows before it is timed. The two measurements that matter are physical, not'
    + ` clever: a sorted cut is ${times(figures.cutVsFilter)} a full filter, and an indexed epoch`
    + ` column is ${times(figures.columnVsDocument)} the same range read back out of the JSON`
    + ' document with date functions. Against them, the generic query route costs'
    + ` ${times(figures.queryBucketVsResident)} the one-pass bucket loop — the gap the temporal`
    + ` kernel closes, at ${times(figures.kernelBucketVsOnePass)} that loop for a call that`
    + ' validates a specification, normalizes a series and returns a labelled record.',
};

//#endregion

//#region output

if (flags.output === 'json') {
  const payload = {
    meta: {
      suite: 'series',
      title: 'Series — one temporal question, every route a consumer has today',
      description: 'A range, fixed buckets, a rolling mean and an as-of read, answered over one'
        + ' seeded series by plain references, by the core series kernel, by a generic query'
        + ' document and by stock SQLite under a declared epoch column — equivalence-gated on a'
        + ' committed corpus, with the resident ceiling and the durable loss both published.',
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      seed: flags.seed,
      origin: SERIES_ORIGIN,
      stepMs: SERIES_STEP_MS,
      law: VALUE_LAW,
      corpus: SERIES_CORPUS_PATH,
      corpusVersion: corpusMeta.version,
      corpusCases: corpusMeta.cases,
      warmup: WARMUP,
      rounds: ROUNDS,
      quick: flags.quick,
      engine: 'node:sqlite :memory:, sample(series, at, value, doc) under a (series, at) index',
      legs: legs.map((leg) => ({ n: leg.n, label: leg.label })),
      plans: Object.entries(largest.plans).map(([key, plan]) => ({ key, plan })),
      figures,
      notes,
      equivalenceFailures: failures,
    },
    headline,
    checks,
    tables,
    rows: legs.flatMap((leg) => ORDER
      .filter(([key]) => leg.rows[key] !== undefined)
      .map(([key, name]) => ({
        n: leg.n, route: key, label: name, ns: leg.rows[key].ns,
        spread: leg.rows[key].spread, results: leg.results[key],
      }))),
  };
  const json = JSON.stringify(payload, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`\nwrote ${flags.filepath}`);
  }
  else console.log(json);
}

//#endregion
