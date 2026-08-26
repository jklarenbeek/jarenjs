//@ts-check
/**
 * @file The temporal-series corpus has one source, and generating it
 * twice writes the same bytes.
 *
 * `test/json/fixtures/series-corpus.json` is the oracle later executors
 * are held to: the same bucketing as a query document, the same range as
 * an indexed database plan, the same rolling window somewhere that is
 * not Node. A second copy — a fixture pasted beside a runner, a
 * reference re-implemented in a benchmark — is a corpus that can
 * disagree with itself while every runner stays green, which is the one
 * failure a differential oracle cannot survive.
 *
 * Byte-identical regeneration is the other half. A generator that
 * reached for a clock, a hash seed or an insertion-ordered map would
 * still produce a plausible fixture, and the drift would only surface as
 * an unexplained diff months later.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  SERIES_CORPUS_PATH, SERIES_ORIGIN, SERIES_STEP_MS, VALUE_SCALE,
  generateSeries, bucketOnePass, bucketNaive, rollingMeanOnePass, rollingMeanNaive,
  filterRange, cutRange, asOfBackward,
  resampleNaive, rollingNaive, asOfNaive, overlapsNaive,
} from '../../scripts/lib/series-corpus.js';
import { generateSeriesCorpus, serializeCorpus } from '../../scripts/generate-series-corpus.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every consumer of the corpus, and how each reaches it. */
const READERS = [
  ['scripts/generate-series-corpus.js', /lib\/series-corpus\.js/, 'the fixture writer'],
  ['benchmark/series.js', /scripts\/lib\/series-corpus\.js/, 'the benchmark'],
  ['test/json/query/series-corpus.test.js', /scripts\/lib\/series-corpus\.js/,
    'the validated query vocabulary'],
];

describe('the series corpus has one source', () => {
  it('exists exactly once, at the path the shared reader names', () => {
    // committed and not-yet-committed both count, and an ignored file
    // does not: the fixture is reviewable work in the tree before it is
    // a commit, and it must be the only one either way
    const found = execFileSync('git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*series-corpus.json'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((line) => line !== '');
    assert.deepStrictEqual(found, [SERIES_CORPUS_PATH],
      'a second copy is a corpus that can disagree with itself');
  });

  it('every consumer reaches the generator, and no other corpus file', () => {
    for (const [file, pattern, role] of READERS) {
      assert.match(read(file), pattern, `${role} (${file}) no longer reaches the one generator`);
      const named = read(file).match(/[\w./-]*series-corpus[\w.-]*\.json/g) ?? [];
      for (const hit of named) {
        assert.ok(hit.endsWith('fixtures/series-corpus.json'),
          `${file} names an unexpected corpus file: ${hit}`);
      }
    }
  });

  it('the benchmark times the shared references rather than its own copies', () => {
    // a benchmark that re-declared `bucketOnePass` would measure
    // something the fixture never recorded an answer for
    const source = read('benchmark/series.js');
    for (const name of ['filterRange', 'cutRange', 'bucketOnePass', 'rollingMeanOnePass',
      'asOfBackward', 'generateSeries']) {
      assert.ok(!new RegExp(`function\\s+${name}\\b`).test(source),
        `benchmark/series.js declares its own ${name}`);
      assert.match(source, new RegExp(`\\b${name}\\b`), `benchmark/series.js does not use ${name}`);
    }
  });
});

describe('the series corpus regenerates byte for byte', () => {
  it('writes the same bytes twice, and those are the committed ones', () => {
    const first = serializeCorpus(generateSeriesCorpus());
    const second = serializeCorpus(generateSeriesCorpus());
    assert.strictEqual(first, second, 'two generations disagree — something read a clock');
    assert.strictEqual(read(SERIES_CORPUS_PATH), first,
      'the committed fixture is not what the generator writes; '
      + 'run `node scripts/generate-series-corpus.js --write` and read the diff');
  });

  it('carries the samples rather than leaving them to be recomputed', () => {
    // Math.sin is implementation-defined, so an executor that rederived
    // the corpus could disagree with it in the last bit
    const corpus = JSON.parse(read(SERIES_CORPUS_PATH));
    assert.strictEqual(corpus.origin, SERIES_ORIGIN);
    assert.strictEqual(corpus.stepMs, SERIES_STEP_MS);
    assert.strictEqual(corpus.valueScale, VALUE_SCALE);
    assert.ok(corpus.samples.length > 0, 'the fixture carries no samples');
    for (const sample of corpus.samples) {
      assert.ok(Number.isInteger(sample.at), `${sample.at} is not an epoch millisecond`);
      assert.ok(Number.isInteger(sample.value * VALUE_SCALE),
        `${sample.value} is not an exact multiple of 1/${VALUE_SCALE}`);
    }
  });
});

describe('the corpus carries the vocabulary every executor is held to', () => {
  const corpus = JSON.parse(read(SERIES_CORPUS_PATH));

  it('holds a query document and an expected answer for every operator', () => {
    // the corpus is what makes "the same operation in JSON, in an
    // indexed database and in a browser" checkable rather than claimed:
    // each case carries the DOCUMENT that spells the question, so a
    // later executor runs the same one rather than writing its own
    const documented = new Set();
    for (const testCase of corpus.cases) {
      if (testCase.doc === undefined)
        continue;
      for (const key of Object.keys(testCase.doc)) documented.add(key);
      assert.ok(testCase.name.length > 0, 'every case is named');
      assert.ok(testCase.kind === 'invalid'
        ? typeof testCase.code === 'string'
        : Object.hasOwn(testCase, 'expected'),
      `${testCase.name} carries neither an expected answer nor a refusal code`);
    }
    assert.deepStrictEqual([...documented].sort(),
      ['$asof', '$overlaps', '$resample', '$rolling', '$time-bucket']);
  });

  it('names every case exactly once, so a later order appends rather than forks', () => {
    const names = corpus.cases.map((c) => c.name);
    assert.deepStrictEqual(names.length, new Set(names).size,
      'two cases share a name; `cases` is keyed by name and append-only');
  });

  it('refuses as often as it answers — both halves of a closed spec', () => {
    const invalid = corpus.cases.filter((c) => c.kind === 'invalid');
    assert.ok(invalid.some((c) => c.code === 'JQ0003'), 'the authored refusals');
    assert.ok(invalid.some((c) => c.code === 'JQ2001'), 'the data refusals');
  });
});

describe('the references agree with the plain implementations they replace', () => {
  const samples = generateSeries(500);

  it('the one-pass bucket loop equals the obvious grouping, value for value', () => {
    assert.deepStrictEqual(bucketOnePass(samples, 60000, SERIES_ORIGIN),
      bucketNaive(samples, 60000, SERIES_ORIGIN));
  });

  it('the carried rolling sum equals a fresh sum per window, value for value', () => {
    // exact because every value is a multiple of 1/VALUE_SCALE: this is
    // an equality, not a tolerance, and it is why the corpus rounds
    assert.deepStrictEqual(rollingMeanOnePass(samples, 60), rollingMeanNaive(samples, 60));
  });

  it('the sorted cut reads the rows the full filter finds', () => {
    const start = SERIES_ORIGIN + 60000;
    const end = start + 120000;
    const bounds = cutRange(samples, start, end);
    assert.deepStrictEqual(samples.slice(bounds.lo, bounds.hi), filterRange(samples, start, end));
  });

  it('the naive resample agrees with a hand-computed bucket', () => {
    // the oracle's own oracle: three rows, two buckets, one of them
    // holding a measured gap, written out rather than derived
    assert.deepStrictEqual(
      resampleNaive([{ at: 0, value: 2 }, { at: 500, value: 4 }, { at: 1500, value: null }],
        { every: 1000, aggregate: 'mean' }),
      [{ at: 0, value: 3, count: 2 }, { at: 1000, value: null, count: 1 }]);
  });

  it('the naive rolling window is measured in time, not in rows', () => {
    assert.deepStrictEqual(
      rollingNaive([{ at: 0, value: 1 }, { at: 10, value: 3 }, { at: 30, value: 5 }],
        { width: 25, aggregate: 'sum' }),
      [{ at: 0, value: 1, count: 1 },
        { at: 10, value: 4, count: 2 },
        { at: 30, value: 8, count: 2 }]);
  });

  it('the naive as-of takes the later row at an equal instant, and backward on a tie', () => {
    const right = [{ at: 0, value: 1 }, { at: 0, value: 2 }, { at: 20, value: 3 }];
    assert.strictEqual(asOfNaive([{ at: 0, value: 0 }], right)[0].right.value, 2,
      "'as of' means the later reading");
    assert.strictEqual(
      asOfNaive([{ at: 10, value: 0 }], right, { direction: 'nearest' })[0].right.value, 2,
      'a nearest tie chooses backward — and still the later of the two there');
  });

  it('the naive overlap is half-open at both ends', () => {
    assert.strictEqual(overlapsNaive({ start: 0, end: 10 }, { start: 10, end: 20 }), false);
    assert.strictEqual(overlapsNaive({ start: 0, end: 11 }, { start: 10, end: 20 }), true);
  });

  it('as-of is backward-looking and half-open at neither end', () => {
    const exact = samples[7].at;
    assert.deepStrictEqual(asOfBackward(samples, exact), samples[7], 'an exact hit is itself');
    assert.deepStrictEqual(asOfBackward(samples, exact + 1), samples[7], 'and holds until the next');
    assert.deepStrictEqual(asOfBackward(samples, exact - 1), samples[6]);
    assert.strictEqual(asOfBackward(samples, SERIES_ORIGIN - 1), null, 'before the first is nothing');
  });
});
