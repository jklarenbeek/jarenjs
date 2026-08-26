//@ts-check
/**
 * @file The five time-series operators against the shared corpus
 * (QUERY-FORMAT.md §8.16).
 *
 * `test/json/fixtures/series-corpus.json` carries, for every case, the
 * query document that spells the question and the answer a **plain
 * reference** gives it — a map keyed by bucket, a fresh sum per window,
 * a linear scan per match, written in `scripts/lib/series-corpus.js` and
 * touching no kernel. So this file holds the query engine to a value
 * rather than to a second implementation, and a disagreement names which
 * executor moved rather than starting an argument about which is right.
 *
 * The same file is what `benchmark/series.js` times and what the
 * database suite will execute, which is the whole reason it is one file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileJsonQuery } from '@jarenjs/json/query';
import {
  resampleSeries, rollingSeries, overlapsInterval,
} from '@jarenjs/core/series';
import {
  SERIES_CORPUS_PATH, caseSeries, referenceAnswer,
} from '../../../scripts/lib/series-corpus.js';

const corpus = JSON.parse(
  readFileSync(new URL(`../../../${SERIES_CORPUS_PATH}`, import.meta.url), 'utf8'));

/**
 * Every case of one kind that carries a query DOCUMENT. Version 1's
 * cases share three of these kind names and carry no document — they
 * are the plain-reference answers `benchmark/series.js` is timed
 * against, and the fixture is append-only, so they stay.
 * @param {string} kind
 */
const of = (kind) => corpus.cases.filter((c) => c.kind === kind && c.doc !== undefined);

/** The rows a series case reads. @param {any} testCase @returns {any[]} */
const rowsOf = (testCase) => caseSeries(testCase, corpus.samples);

/** Run a case's document over an input. @param {any} doc @param {any} input */
const run = (doc, input) => compileJsonQuery(doc)(input);

describe('$overlaps answers the corpus', () => {
  for (const testCase of of('overlaps')) {
    it(testCase.name, () => {
      assert.strictEqual(run(testCase.doc, testCase.input), testCase.expected);
      // and the kernel the operator calls says the same thing, so the
      // language cannot drift from the algebra underneath it
      assert.strictEqual(overlapsInterval(testCase.a, testCase.b), testCase.expected);
    });
  }

  it('touching spans do not overlap, which is the half-open rule itself', () => {
    const touching = corpus.cases.find((c) => c.name === 'overlaps/touching');
    assert.strictEqual(touching.expected, false,
      'an interval holds its start and not its end');
  });
});

describe('$time-bucket answers the corpus', () => {
  for (const testCase of of('time-bucket')) {
    it(testCase.name, () => {
      assert.strictEqual(run(testCase.doc, testCase.input), testCase.expected);
    });
  }
});

describe('$resample answers the corpus', () => {
  for (const testCase of of('resample')) {
    it(testCase.name, () => {
      const rows = rowsOf(testCase);
      assert.deepStrictEqual(run(testCase.doc, { rows }), testCase.expected);
    });
  }

  for (const testCase of of('resample')) {
    it(`${testCase.name} — and the kernel agrees`, () => {
      assert.deepStrictEqual(resampleSeries(rowsOf(testCase), testCase.spec),
        testCase.expected);
    });
  }

  it('count is what tells a measured gap apart from an absence', () => {
    // the two shapes fill has to keep apart. A bucket that held rows and
    // no numbers is a MEASUREMENT — everybody reported a gap — and
    // reports null with a real count; a bucket that held nothing at all
    // is an ABSENCE, and is the only kind a fill policy speaks for
    const measured = corpus.cases.find((c) => c.name === 'resample/gapped-null-buckets');
    assert.ok(measured.expected.some((b) => b.count > 0 && b.value === null),
      'a bucket that held only gaps reports null with a real count');
    assert.ok(measured.expected.every((b) => b.count > 0),
      'a gapped series has no EMPTY bucket: the instants are all still there');
    const absent = corpus.cases.find((c) => c.name === 'resample/sparse-fill-null');
    assert.ok(absent.expected.some((b) => b.count === 0 && b.value === null),
      'an empty bucket reports null with a count of zero');
  });

  it('locf and linear never extrapolate past the outermost measured bucket', () => {
    for (const name of ['resample/sparse-fill-locf', 'resample/sparse-fill-linear']) {
      const testCase = corpus.cases.find((c) => c.name === name);
      const first = testCase.expected[0];
      assert.ok(first.count !== 0 || first.value === null,
        `${name}: a leading empty bucket has nothing to carry or interpolate from`);
    }
  });
});

describe('$rolling answers the corpus', () => {
  for (const testCase of of('rolling')) {
    it(testCase.name, () => {
      assert.deepStrictEqual(run(testCase.doc, { rows: rowsOf(testCase) }), testCase.expected);
    });
  }

  for (const testCase of of('rolling')) {
    it(`${testCase.name} — and the kernel agrees`, () => {
      assert.deepStrictEqual(rollingSeries(rowsOf(testCase), testCase.spec), testCase.expected);
    });
  }

  it('rows sharing an instant share an answer', () => {
    const testCase = corpus.cases.find(
      (c) => c.name === 'rolling/duplicate-instants-share-an-answer');
    const answer = run(testCase.doc, { rows: testCase.rows });
    const [a, b] = answer.filter((row) => row.at === 10);
    assert.deepStrictEqual(a, b,
      'a window is a function of the instant it ends at, never of arrival order');
    assert.strictEqual(a.count, 3, 'and both readings at that instant are in it');
  });

  it('minPeriods withholds a value without hiding the count', () => {
    const testCase = corpus.cases.find((c) => c.name === 'rolling/min-periods-withholds');
    const withheld = testCase.expected.filter((row) => row.value === null);
    assert.strictEqual(withheld.length, 29, 'the leading partial windows');
    assert.ok(withheld.every((row) => row.count > 0), 'each still reports what it saw');
  });
});

describe('$asof answers the corpus', () => {
  for (const testCase of of('asof-join')) {
    it(testCase.name, () => {
      assert.deepStrictEqual(run(testCase.doc, testCase.input), testCase.expected);
    });
  }

  it('a left row with no match keeps right: null and stays in the answer', () => {
    const testCase = corpus.cases.find((c) => c.name === 'asof/keyed');
    const answer = run(testCase.doc, testCase.input);
    assert.strictEqual(answer.length, testCase.input.left.length,
      'no match is data; a join that dropped the row would answer a different question');
    const orphan = answer.find((match) => match.left.k === 'c');
    assert.deepStrictEqual(orphan.right, null);
    assert.deepStrictEqual(orphan.distance, null);
  });

  it('an equal instant takes the LAST right row', () => {
    const testCase = corpus.cases.find((c) => c.name === 'asof/backward-unkeyed');
    const answer = run(testCase.doc, testCase.input);
    const at25 = answer.find((match) => match.left.at === 25);
    assert.strictEqual(at25.right.value, 21, "'as of' means the later reading");
  });
});

describe('the committed answers are still what the references give', () => {
  // the other half of a differential oracle: the fixture is only an
  // oracle while it agrees with the plain references that wrote it, and
  // a reference that drifted would otherwise take every executor with it
  for (const testCase of corpus.cases) {
    if (testCase.kind === 'invalid')
      continue;
    it(testCase.name, () => {
      assert.deepStrictEqual(referenceAnswer(testCase, corpus.samples), testCase.expected);
    });
  }
});

describe('the corpus refusals are the codes the corpus records', () => {
  for (const testCase of of('invalid')) {
    it(testCase.name, () => {
      assert.throws(() => run(testCase.doc, testCase.input), (error) => {
        assert.strictEqual(error.code, testCase.code,
          `${testCase.name}: ${error.message}`);
        return true;
      });
    });
  }

  it('splits the two families the way §8.16 says it does', () => {
    // what a document AUTHORED is refused when the query compiles; what
    // the DATA decides is refused when it runs. A closed spec is only
    // closed if BOTH halves are gated
    const compileTime = of('invalid').filter((c) => c.code === 'JQ0003');
    const runTime = of('invalid').filter((c) => c.code === 'JQ2001');
    assert.ok(compileTime.length >= 8, 'the authored refusals');
    assert.ok(runTime.length >= 5, 'the data refusals');
    for (const testCase of compileTime) {
      assert.throws(() => compileJsonQuery(testCase.doc),
        (error) => error.code === 'JQ0003',
        `${testCase.name} must be refused before it ever sees a row`);
    }
    for (const testCase of runTime)
      assert.doesNotThrow(() => compileJsonQuery(testCase.doc));
  });
});
