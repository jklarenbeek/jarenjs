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
 *
 * There is deliberately no `@jarenjs/core/series` row. The kernel does
 * not exist yet, and a row that measured nothing would be a placeholder
 * pretending to be a measurement. What this suite publishes is what a
 * consumer can run TODAY, so a later fast path arrives with a number to
 * beat rather than a claim.
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

import {
  SERIES_ORIGIN, SERIES_STEP_MS, SERIES_SEED, VALUE_LAW, SERIES_CORPUS_PATH,
  generateSeries, asDocuments,
  filterRange, cutRange, bucketOnePass, bucketNaive,
  rollingMeanOnePass, rollingMeanNaive, asOfBackward, probeInstants,
} from '../scripts/lib/series-corpus.js';

import { formatNs } from './lib/fmt.js';
import { quantile } from './lib/horizon.js';

//#region flags

const argv = process.argv.slice(2);
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

/** The width of the measured range, and of a bucket. */
const RANGE_MS = 3600_000;
const BUCKET_MS = 60_000;

/** The rolling window, in samples. At one-second spacing it is also
 * sixty seconds wide, which is what makes the count-based `$window` row
 * comparable to it. */
const ROLLING_WIDTH = 60;

/** The one series key every row lives under. */
const SERIES_KEY = 'sensor-a';

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
  for (const entry of corpus.cases) {
    let actual;
    if (entry.kind === 'range') {
      const rows = filterRange(samples, entry.start, entry.end);
      const cut = cutRange(samples, entry.start, entry.end);
      actual = {
        lo: cut.lo,
        hi: cut.hi,
        count: rows.length,
        firstAt: rows.length === 0 ? null : rows[0].at,
        lastAt: rows.length === 0 ? null : rows[rows.length - 1].at,
      };
    }
    else if (entry.kind === 'bucket')
      actual = bucketOnePass(samples, entry.every, entry.origin);
    else if (entry.kind === 'rolling')
      actual = rollingMeanOnePass(samples, entry.width);
    else if (entry.kind === 'asof')
      actual = asOfBackward(samples, entry.at);
    else {
      check(`fixture case '${entry.name}'`, false, `unknown kind '${entry.kind}'`);
      continue;
    }
    const agrees = JSON.stringify(actual) === JSON.stringify(entry.expected);
    check(`fixture case '${entry.name}'`, agrees,
      agrees ? `${entry.kind}, as committed` : `${entry.kind}: ${JSON.stringify(actual).slice(0, 160)}`);
  }
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
  const lo = quantile(samples, 0.25);
  return {
    ns: quantile(samples, 0.5),
    spread: lo === 0 ? 1 : Math.round((quantile(samples, 0.75) / lo) * 100) / 100,
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
function runLeg(n) {
  const label = `${n.toLocaleString('en-US')} samples`;
  const series = generateSeries(n);
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

  //#endregion

  const plans = Object.fromEntries(Object.entries({
    range: [SQL.range, [SERIES_KEY, rangeStart, rangeEnd]],
    jsonRange: [SQL.jsonRange, [SERIES_KEY, rangeStart, rangeEnd]],
    asOf: [SQL.asOf, [SERIES_KEY, rangeStart]],
    bucket: [SQL.bucket, [SERIES_ORIGIN, BUCKET_MS, SERIES_KEY]],
  }).map(([key, [sql, args]]) => [key,
    /** @type {any[]} */ (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(.../** @type {any[]} */ (args)))
      .map((row) => row.detail).join(' | ')]));

  const results = {
    filter: filtered.length,
    cut: cut.hi - cut.lo,
    bucket: buckets.length,
    rolling: rolling.length,
    queryBucket: queryBuckets.length,
    queryWindow: queryWindows.length,
    labelledWindow: labelledWindows.length,
    sqlRange: sqlRange.length,
    sqlJsonRange: sqlJsonRange.length,
    sqlAsOf: 1,
    sqlBucket: sqlBuckets.length,
  };

  if (flags.verify || failures !== 0) {
    db.close();
    return { n, label, rows: {}, results, plans };
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
    queryBucket: medianNs(() => queryJson(CALENDAR_BUCKET_QUERY, documents), ROUNDS.query),
    queryWindow: medianNs(() => queryJson(COUNT_WINDOW_QUERY, values), ROUNDS.query),
    labelledWindow: medianNs(() => queryJson(LABELLED_WINDOW_QUERY, documents), ROUNDS.query),
    sqlRange: medianNs(() => rangeStmt.all(SERIES_KEY, rangeStart, rangeEnd), ROUNDS.default),
    sqlJsonRange: medianNs(() => jsonRangeStmt.all(SERIES_KEY, rangeStart, rangeEnd), ROUNDS.default),
    sqlAsOf: medianNs(() => asOfStmt.all(SERIES_KEY, probes[probe++ % probes.length]), ROUNDS.asof),
    sqlBucket: medianNs(() => bucketStmt.all(SERIES_ORIGIN, BUCKET_MS, SERIES_KEY), ROUNDS.default),
  };
  db.close();
  return { n, label, rows, results, plans };
}

//#endregion

//#region run

const corpusMeta = verifyCommittedCorpus();

const legs = [];
for (const n of SIZES)
  legs.push(runLeg(n));

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
  ['queryBucket', 'calendar-minute buckets — query document ($start-of + $groupby)'],
  ['queryWindow', `count window ${ROLLING_WIDTH} over the values — query document ($window)`],
  ['labelledWindow', `the same window, labelled — query document ($window + $max)`],
  ['sqlRange', `${RANGE_MS / 3600_000} h range — SQLite, declared epoch column`],
  ['sqlJsonRange', `${RANGE_MS / 3600_000} h range — SQLite, date functions over the document`],
  ['sqlAsOf', 'as-of one instant — SQLite, index read backwards'],
  ['sqlBucket', `fixed ${BUCKET_MS / 1000} s aggregate — SQLite, integer bucket + GROUP BY`],
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
    strong: key === 'cut' || key === 'sqlRange',
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
  ].map(([key, name]) => ({ cells: [name, largest.plans[key]], strong: false })),
  note: 'Read from EXPLAIN QUERY PLAN on the measuring host rather than asserted. The declared'
    + ' column is the difference between a search and a scan, and the scan is what a consumer'
    + ' storing instants only inside the document is paying for every range read.',
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
  'There is no kernel row here. It does not exist yet, and a placeholder measuring nothing would'
    + ' be worse than an empty column.',
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
    + ` ${times(figures.queryBucketVsResident)} the one-pass bucket loop — the gap a temporal`
    + ' kernel has to close, published before one exists so it cannot be claimed away.',
};

//#endregion

//#region output

if (flags.output === 'json') {
  const payload = {
    meta: {
      suite: 'series',
      title: 'Series — one temporal question, every route a consumer has today',
      description: 'A range, fixed buckets, a rolling mean and an as-of read, answered over one'
        + ' seeded series by plain references, by a generic query document and by stock SQLite'
        + ' under a declared epoch column — equivalence-gated on a committed corpus, with the'
        + ' resident ceiling and the durable loss both published.',
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
