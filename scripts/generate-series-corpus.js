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
  generateSeries, filterRange, cutRange, bucketOnePass, rollingMeanOnePass, asOfBackward,
} from './lib/series-corpus.js';

const OUT = fileURLToPath(new URL('../test/json/fixtures/series-corpus.json', import.meta.url));

/** The vocabulary of cases this file holds; a later order raises it. */
export const CORPUS_VERSION = 1;

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

/**
 * Every case, with the answer the references give.
 * @param {import('./lib/series-corpus.js').Sample[]} samples
 * @returns {any[]}
 */
export function buildCases(samples) {
  const cases = [];
  for (const [name, start, end] of RANGES) {
    const rows = filterRange(samples, /** @type {number} */ (start), /** @type {number} */ (end));
    const cut = cutRange(samples, /** @type {number} */ (start), /** @type {number} */ (end));
    cases.push({
      name,
      kind: 'range',
      start,
      end,
      expected: {
        lo: cut.lo,
        hi: cut.hi,
        count: rows.length,
        firstAt: rows.length === 0 ? null : rows[0].at,
        lastAt: rows.length === 0 ? null : rows[rows.length - 1].at,
      },
    });
  }
  cases.push({
    name: 'bucket/fixed-minute',
    kind: 'bucket',
    every: BUCKET_MS,
    origin: SERIES_ORIGIN,
    aggregate: 'mean',
    expected: bucketOnePass(samples, BUCKET_MS, SERIES_ORIGIN),
  });
  cases.push({
    name: 'rolling/mean-full-windows',
    kind: 'rolling',
    width: ROLLING_WIDTH,
    aggregate: 'mean',
    expected: rollingMeanOnePass(samples, ROLLING_WIDTH),
  });
  for (const [name, at] of AS_OF) {
    cases.push({
      name,
      kind: 'asof',
      direction: 'backward',
      at,
      expected: asOfBackward(samples, /** @type {number} */ (at)),
    });
  }
  return cases;
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
