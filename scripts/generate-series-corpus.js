#!/usr/bin/env node
//@ts-check
/**
 * The temporal-series corpus: one committed list of canonical samples
 * and the answers the plain references give over them, written into
 * `test/json/fixtures/series-corpus.json`.
 *
 * Why generated rather than typed: the fixture's job is to be an ORACLE.
 * A second executor — the same bucketing as a query document, the same
 * range as an indexed database plan, the same rolling window in a
 * browser tab — asserts it returns exactly what this file records, so a
 * divergence names which executor moved. Hand-typing several hundred
 * means would make the file a second implementation to maintain, and the
 * first typo would be indistinguishable from a bug.
 *
 *   node scripts/generate-series-corpus.js           # check, exit 1 on drift
 *   node scripts/generate-series-corpus.js --write   # rewrite the fixture
 *
 * The samples are carried in the file rather than left to be re-derived,
 * because `Math.sin` is implementation-defined in ECMAScript and an
 * executor that recomputed the corpus could disagree with it in the last
 * bit while every runner stayed green. Reading the numbers is the point.
 *
 * `cases` is an append-only list keyed by `name`: a later case is added,
 * never a fork of this generator, so every executor keeps reading one
 * file and `version` says which vocabulary it holds.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERIES_ORIGIN, SERIES_STEP_MS, SERIES_SEED, VALUE_SCALE, VALUE_LAW,
  QUERY_SIZE, GAP_PERIOD, GAP_RUN, CALENDAR_MONTHS,
  generateSeries, referenceAnswer,
} from './lib/series-corpus.js';

const OUT = fileURLToPath(new URL('../test/json/fixtures/series-corpus.json', import.meta.url));

/**
 * The vocabulary of cases this file holds; a later order raises it.
 *
 * 1 — the range, bucket, rolling and as-of answers the plain references
 *     give, for a runner holding a kernel to a value.
 * 2 — the five operators of the validated vocabulary: the query document
 *     that spells each question, and the answer a reference gives it.
 */
export const CORPUS_VERSION = 2;

/** How many canonical samples the fixture carries — five minutes at 1 Hz. */
export const CORPUS_SIZE = 300;

/** The bucket width every bucketing executor is held to. */
export const BUCKET_MS = 60000;

/** The rolling window every windowing executor is held to, in samples. */
export const ROLLING_WIDTH = 60;

const MINUTE = 60000;

/**
 * The half-open windows the range cases cut. Each one pins a different
 * edge: an aligned interior minute, a window whose bounds land exactly
 * on samples, one that starts before the corpus, and one entirely
 * outside it — an empty answer is data, and an executor has to return it
 * rather than fail.
 */
const RANGES = [
  ['range/interior-minute', SERIES_ORIGIN + MINUTE, SERIES_ORIGIN + 2 * MINUTE],
  ['range/half-open-edges', SERIES_ORIGIN + 10 * SERIES_STEP_MS,
    SERIES_ORIGIN + 20 * SERIES_STEP_MS],
  ['range/starts-before-corpus', SERIES_ORIGIN - MINUTE, SERIES_ORIGIN + 3 * SERIES_STEP_MS],
  ['range/entirely-after-corpus', SERIES_ORIGIN + 10 * MINUTE, SERIES_ORIGIN + 11 * MINUTE],
];

/**
 * The instants the as-of cases ask about: exactly on a sample, between
 * two, before the first (no answer at all), and after the last (the
 * last sample, not nothing).
 */
const AS_OF = [
  ['asof/on-a-sample', SERIES_ORIGIN + 42 * SERIES_STEP_MS],
  ['asof/between-samples', SERIES_ORIGIN + 42 * SERIES_STEP_MS + 500],
  ['asof/before-the-first', SERIES_ORIGIN - 1],
  ['asof/after-the-last', SERIES_ORIGIN + 10 * MINUTE],
];


/** The half-open spans the `$overlaps` cases ask about. */
const OVERLAPS = [
  ['overlaps/touching', { start: 0, end: 10 }, { start: 10, end: 20 }],
  ['overlaps/shares-one-instant', { start: 0, end: 11 }, { start: 10, end: 20 }],
  ['overlaps/nested', { start: 0, end: 100 }, { start: 40, end: 50 }],
  ['overlaps/disjoint', { start: 0, end: 10 }, { start: 90, end: 100 }],
  ['overlaps/identical', { start: 5, end: 6 }, { start: 5, end: 6 }],
];

/** The `$resample` cases: the source rows, the spec, and nothing else. */
const RESAMPLES = [
  ['resample/fixed-minute-mean', 'samples',
    { every: 60000, origin: SERIES_ORIGIN, aggregate: 'mean' }],
  ['resample/fixed-minute-count', 'samples',
    { every: 60000, origin: SERIES_ORIGIN, aggregate: 'count' }],
  ['resample/gapped-omit', 'gapped',
    { every: 10000, origin: SERIES_ORIGIN, aggregate: 'mean' }],
  ['resample/gapped-null-buckets', 'gapped',
    { every: 5000, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'null' }],
  ['resample/sparse-fill-null', 'sparse',
    { every: 2000, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'null' }],
  ['resample/sparse-fill-zero', 'sparse',
    { every: 2000, origin: SERIES_ORIGIN, aggregate: 'sum', fill: 'zero' }],
  ['resample/sparse-fill-locf', 'sparse',
    { every: 2000, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'locf' }],
  ['resample/sparse-fill-linear', 'sparse',
    { every: 2000, origin: SERIES_ORIGIN, aggregate: 'mean', fill: 'linear' }],
  ['resample/gapped-first', 'gapped',
    { every: 20000, origin: SERIES_ORIGIN, aggregate: 'first' }],
  ['resample/gapped-last', 'gapped',
    { every: 20000, origin: SERIES_ORIGIN, aggregate: 'last' }],
  ['resample/explicit-empty-edges', 'samples',
    { every: 30000, origin: SERIES_ORIGIN, aggregate: 'max', fill: 'null',
      start: SERIES_ORIGIN - 60000, end: SERIES_ORIGIN + 150000 }],
];

/** The `$rolling` cases, all measured in time rather than in rows. */
const ROLLINGS = [
  ['rolling/time-mean-30s', 'samples', { width: 30000, aggregate: 'mean' }],
  ['rolling/min-periods-withholds', 'samples',
    { width: 30000, aggregate: 'mean', minPeriods: 30 }],
  ['rolling/gapped-sum', 'gapped', { width: 20000, aggregate: 'sum' }],
  ['rolling/gapped-count-keeps-the-gaps', 'gapped', { width: 20000, aggregate: 'count' }],
  ['rolling/gapped-max', 'gapped', { width: 20000, aggregate: 'max' }],
];

/**
 * The two sides of every `$asof` case. Deliberately small and
 * hand-shaped: a join's answers are decided by boundary instants, not by
 * volume, and every row here exists to pin one — an exact hit, a
 * duplicate instant, a left row before the right side starts, a match
 * just outside a tolerance, and a key that has no partner at all.
 */
const ASOF_LEFT = [
  { at: 0, value: 1, k: 'a' },
  { at: 25, value: 2, k: 'a' },
  { at: 50, value: 3, k: 'b' },
  { at: 50, value: 4, k: 'a' },
  { at: 500, value: 5, k: 'c' },
];

const ASOF_RIGHT = [
  { at: -10, value: 10, k: 'a' },
  { at: 20, value: 20, k: 'a' },
  { at: 20, value: 21, k: 'a' },
  { at: 50, value: 30, k: 'b' },
  { at: 80, value: 40, k: 'a' },
];

/** The `$asof` cases: the spec, and what it asks of those two sides. */
const ASOFS = [
  ['asof/backward-unkeyed', {}],
  ['asof/forward', { direction: 'forward' }],
  ['asof/nearest-ties-backward', { direction: 'nearest' }],
  ['asof/tolerance-refuses-a-distant-match', { direction: 'nearest', tolerance: 10 }],
  ['asof/keyed', { by: '$.k' }],
  ['asof/keyed-nearest', { by: '$.k', direction: 'nearest' }],
];

/** The `$time-bucket` cases: one instant, one ladder. */
const TIME_BUCKETS = [
  ['time-bucket/fixed-minute', SERIES_ORIGIN + 125000, 60000, SERIES_ORIGIN, null],
  ['time-bucket/fixed-hour-default-origin', SERIES_ORIGIN + 5400000, 'PT1H', null, null],
  ['time-bucket/offset-context', SERIES_ORIGIN + 5400000, 'PT1H', null, { offset: 30 }],
  ['time-bucket/negative-epoch', -1, 60000, 0, null],
];

/**
 * The documents that must NOT compile or must not run, and the code
 * each is refused with. A closed spec is only closed if the refusals
 * are gated, and the split is the point: what a document AUTHORED is
 * `JQ0003` when the query compiles, what the DATA decides is `JQ2001`
 * when it runs.
 */
const INVALID = [
  ['invalid/unknown-spec-member', 'JQ0003',
    { $rolling: ['$.rows', { width: 60000, minPeriod: 2 }] }, { rows: [] }],
  ['invalid/unknown-aggregate', 'JQ0003',
    { $resample: ['$.rows', { every: 60000, aggregate: 'median' }] }, { rows: [] }],
  ['invalid/missing-every', 'JQ0003',
    { $resample: ['$.rows', { aggregate: 'mean' }] }, { rows: [] }],
  ['invalid/spec-is-not-a-literal-object', 'JQ0003',
    { $rolling: ['$.rows', '$.spec'] }, { rows: [], spec: { width: 60000 } }],
  ['invalid/duration-mixes-two-families', 'JQ0003',
    { $resample: ['$.rows', { every: 'P1MT1H' }] }, { rows: [] }],
  ['invalid/named-zone-without-a-provider', 'JQ0003',
    { $resample: ['$.rows', { every: 'P1M', zone: 'Europe/Amsterdam' }] }, { rows: [] }],
  ['invalid/min-periods-is-not-a-count', 'JQ0003',
    { $rolling: ['$.rows', { width: 60000, minPeriods: 0 }] }, { rows: [] }],
  ['invalid/negative-tolerance', 'JQ0003',
    { $asof: ['$.left', '$.right', { tolerance: -1 }] }, { left: [], right: [] }],
  ['invalid/selector-is-not-singular', 'JQ0003',
    { $rolling: ['$.rows', { width: 60000, at: '$.readings[*].on' }] }, { rows: [] }],
  ['invalid/unknown-direction', 'JQ0003',
    { $asof: ['$.left', '$.right', { direction: 'sideways' }] }, { left: [], right: [] }],
  ['invalid/row-is-not-a-record', 'JQ2001',
    { $rolling: ['$.rows', { width: 60000 }] }, { rows: [7] }],
  ['invalid/instant-names-none', 'JQ2001',
    { $resample: ['$.rows', { every: 60000 }] }, { rows: [{ at: '09:30:00Z', value: 1 }] }],
  ['invalid/value-is-not-a-reading', 'JQ2001',
    { $resample: ['$.rows', { every: 60000 }] }, { rows: [{ at: 0, value: 'warm' }] }],
  ['invalid/interval-is-reversed', 'JQ2001',
    { $overlaps: ['$.a', '$.b'] }, { a: { start: 10, end: 0 }, b: { start: 0, end: 10 } }],
  ['invalid/interval-is-not-a-record', 'JQ2001',
    { $overlaps: ['$.a', '$.b'] }, { a: [0, 10], b: { start: 0, end: 10 } }],
  ['invalid/bucket-width-is-not-a-span', 'JQ2001',
    { '$time-bucket': ['$.at', '$.w'] }, { at: 0, w: true }],
];

/**
 * The cases the five operators of the validated vocabulary are held to:
 * for each, the query document that spells the question and the answer a
 * plain reference gives it. Both halves are recorded, so a runner is
 * held to a VALUE rather than to a second implementation, and a
 * disagreement names which executor moved.
 * @param {import('./lib/series-corpus.js').Sample[]} samples
 * @returns {any[]}
 */
export function buildOperatorCases(samples) {
  const cases = [];
  for (const [name, a, b] of OVERLAPS) {
    cases.push(answered({ name, kind: 'overlaps', a, b,
      doc: { $overlaps: ['$.a', '$.b'] },
      input: { a, b } }, samples));
  }
  for (const [name, at, every, origin, context] of TIME_BUCKETS) {
    const args = ['$.at', every];
    if (origin !== null || context !== null) args.push(origin);
    if (context !== null) args.push(context);
    cases.push(answered({ name, kind: 'time-bucket', at, every, origin, context,
      doc: { '$time-bucket': args },
      input: { at } }, samples));
  }
  for (const [name, source, spec] of RESAMPLES) {
    cases.push(answered({ name, kind: 'resample', source, size: QUERY_SIZE, spec,
      doc: { $resample: ['$.rows[*]', spec] } }, samples));
  }
  // a monthly ladder over a series that spans real calendar months: a
  // month is not a fixed width, so this is the one bucket case an
  // integer multiplier cannot answer
  cases.push(answered({
    name: 'resample/calendar-month',
    kind: 'resample',
    source: 'calendar',
    size: CALENDAR_MONTHS * 3,
    spec: { every: 'P1M', aggregate: 'mean' },
    doc: { $resample: ['$.rows[*]', { every: 'P1M', aggregate: 'mean' }] },
  }, samples));
  for (const [name, source, spec] of ROLLINGS) {
    cases.push(answered({ name, kind: 'rolling', source, size: QUERY_SIZE, spec,
      doc: { $rolling: ['$.rows[*]', spec] } }, samples));
  }
  // two readings in the same millisecond share a window and share an
  // answer - the window is a function of the instant it ends at, never
  // of arrival order - and both of them count
  cases.push(answered({
    name: 'rolling/duplicate-instants-share-an-answer',
    kind: 'rolling',
    source: 'inline',
    rows: [{ at: 0, value: 1 }, { at: 10, value: 2 }, { at: 10, value: 4 }, { at: 30, value: 8 }],
    spec: { width: 25, aggregate: 'mean' },
    doc: { $rolling: ['$.rows[*]', { width: 25, aggregate: 'mean' }] },
  }, samples));
  for (const [name, spec] of ASOFS) {
    cases.push(answered({ name, kind: 'asof-join', spec,
      doc: { $asof: ['$.left[*]', '$.right[*]', spec] },
      input: { left: ASOF_LEFT, right: ASOF_RIGHT } }, samples));
  }
  // the two sides spelling their instant differently, read through the
  // row selectors rather than rewritten first
  cases.push(answered({
    name: 'asof/selectors-read-both-spellings',
    kind: 'asof-join',
    spec: { leftAt: '$.on', rightAt: "$['recorded at']", by: '$.k' },
    doc: { $asof: ['$.left[*]', '$.right[*]',
      { leftAt: '$.on', rightAt: "$['recorded at']", by: '$.k' }] },
    input: {
      left: ASOF_LEFT.map((row) => ({ on: row.at, value: row.value, k: row.k })),
      right: ASOF_RIGHT.map((row) => ({ 'recorded at': row.at, value: row.value, k: row.k })),
    },
  }, samples));
  for (const [name, code, doc, input] of INVALID)
    cases.push({ name, kind: 'invalid', code, doc, input });
  return cases;
}





/**
 * Every case, with the answer the references give.
 * @param {import('./lib/series-corpus.js').Sample[]} samples
 * @returns {any[]}
 */
export function buildCases(samples) {
  const cases = [];
  for (const [name, start, end] of RANGES)
    cases.push(answered({ name, kind: 'range', start, end }, samples));
  cases.push(answered({
    name: 'bucket/fixed-minute',
    kind: 'bucket',
    every: BUCKET_MS,
    origin: SERIES_ORIGIN,
    aggregate: 'mean',
  }, samples));
  cases.push(answered({
    name: 'rolling/mean-full-windows',
    kind: 'rolling',
    width: ROLLING_WIDTH,
    aggregate: 'mean',
  }, samples));
  for (const [name, at] of AS_OF)
    cases.push(answered({ name, kind: 'asof', direction: 'backward', at }, samples));
  cases.push(...buildOperatorCases(samples));
  return cases;
}

/**
 * One case, with the answer the plain references give it.
 *
 * The generator never computes an answer of its own: it describes a
 * question and asks {@link referenceAnswer}, which is the one dispatcher
 * the benchmark and the query suite also read. A writer that computed
 * its own would be a second implementation, and the fixture's whole job
 * is that there is not one.
 *
 * @param {any} entry
 * @param {import('./lib/series-corpus.js').Sample[]} samples
 * @returns {any}
 */
function answered(entry, samples) {
  return { ...entry, expected: referenceAnswer(entry, samples) };
}

/** The whole fixture, as it is written. */
export function generateSeriesCorpus() {
  const samples = generateSeries(CORPUS_SIZE);
  return {
    version: CORPUS_VERSION,
    seed: SERIES_SEED,
    origin: SERIES_ORIGIN,
    stepMs: SERIES_STEP_MS,
    valueScale: VALUE_SCALE,
    law: VALUE_LAW,
    gapPeriod: GAP_PERIOD,
    gapRun: GAP_RUN,
    querySize: QUERY_SIZE,
    samples,
    cases: buildCases(samples),
  };
}

/** @param {any} corpus */
export function serializeCorpus(corpus) {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : OUT;
  const corpus = generateSeriesCorpus();
  const text = serializeCorpus(corpus);
  if (argv.includes('--write')) {
    writeFileSync(out, text);
    console.log(`series corpus: ${corpus.samples.length} samples, `
      + `${corpus.cases.length} cases written to ${out}`);
  }
  else {
    let current = null;
    try {
      current = readFileSync(out, 'utf8');
    }
    catch {
      current = null;
    }
    if (current === text) {
      console.log(`series corpus: ${corpus.cases.length} cases, the committed fixture agrees.`);
    }
    else {
      console.error('series corpus: the committed fixture does not match what the references answer now.');
      console.error('Run `node scripts/generate-series-corpus.js --write` and read the diff before keeping it.');
      process.exitCode = 1;
    }
  }
}
