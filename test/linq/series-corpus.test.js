//@ts-check
/**
 * @file The temporal corpus, executed a sixth time — through the fluent
 * surface.
 *
 * `test/json/fixtures/series-corpus.json` records, for every case, the
 * answer a PLAIN reference gives it. The kernel answers it, the query
 * engine answers it, and `test/db/series-oracle.test.js` makes stock
 * SQLite answer it four ways. This file makes `@jarenjs/linq` the last
 * executor, so the campaign's claim — one fixture, every executor —
 * is a run rather than a sentence.
 *
 * The document is the case's OWN document, not a chain rebuilt by hand:
 * `test/linq/series.test.js` already proved every chain equals the
 * document it lowers to, and re-deriving that here would be a second
 * implementation of one claim. What this file proves instead is that
 * `fromDocument` — the entry point a stored or hand-written document
 * arrives through — answers what the references recorded, and refuses
 * what the language refuses.
 *
 * A sequence has one root, so `seriesSequenceCase` in the one shared
 * reader moves the corpus root into the single item the sequence holds.
 * That projection reads the case's `kind` exactly once, beside the
 * store's, which is the rule `test/scripts/series-corpus-source.test.js`
 * enforces.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { fromDocument } from '@jarenjs/linq';

import {
  readSeriesCorpus, seriesSequenceCase,
} from '../../scripts/lib/series-corpus.js';

const CORPUS = readSeriesCorpus();

/** Every case the fluent surface can be handed, already projected. */
const PROJECTED = CORPUS.cases
  .map((entry) => ({ entry, projected: seriesSequenceCase(entry, CORPUS.samples) }))
  .filter((row) => row.projected !== null);

const VALID = PROJECTED.filter((row) => row.projected.refuses === null);
const INVALID = PROJECTED.filter((row) => row.projected.refuses !== null);

/**
 * `toArray()` always hands back an array; a document whose answer is
 * one item is that item (§2.1's singleton rule). Applying the rule is
 * honest, papering over it with a two-row fixture is not.
 * @param {any} expected
 * @returns {any[]}
 */
const asSequence = (expected) =>
  (Array.isArray(expected) ? expected : expected === undefined ? [] : [expected]);

describe('the temporal corpus through @jarenjs/linq', () => {
  it('projects every case that carries a document, and nothing else', () => {
    assert.strictEqual(PROJECTED.length,
      CORPUS.cases.filter((entry) => entry.doc !== undefined).length);
    assert.ok(VALID.length >= 30, `only ${VALID.length} answerable cases projected`);
    assert.ok(INVALID.length >= 10, `only ${INVALID.length} refusals projected`);
    // every shape the language spells, so a kind cannot quietly drop out
    assert.deepStrictEqual([...new Set(VALID.map((row) => row.projected.shape))].sort(),
      ['asof-join', 'overlaps', 'resample', 'rolling', 'time-bucket']);
  });

  describe('every case answers what the references recorded', () => {
    for (const { entry, projected } of VALID) {
      it(entry.name, () => {
        const answer = fromDocument(projected.source, projected.document).toArray();
        assert.deepStrictEqual(answer, asSequence(projected.expected),
          `@jarenjs/linq disagreed on ${entry.name}`);
      });
    }
  });

  describe('every malformed document is refused at the layer that owns it', () => {
    for (const { entry, projected } of INVALID) {
      it(`${entry.name} is ${projected.refuses}`, () => {
        assert.throws(
          () => fromDocument(projected.source, projected.document).toArray(),
          (error) => {
            assert.strictEqual(/** @type {any} */ (error).code, projected.refuses,
              `${entry.name}: ${/** @type {Error} */ (error).message}`);
            return true;
          });
      });
    }
  });

  it('the projection moves operands and never reaches into a spec', () => {
    // `$` inside a spec selector reads as the ROW, so a rebasing that
    // descended into one would turn `{ at: '$.on' }` into a root path
    // and answer a different question with no error to show for it
    const selectors = PROJECTED.find((row) => row.entry.name.includes('selectors'));
    assert.ok(selectors !== undefined, 'the corpus lost its selector case');
    const spec = selectors.projected.document.$asof[2];
    for (const value of Object.values(spec)) {
      if (typeof value === 'string' && value.startsWith('$'))
        assert.ok(!value.startsWith('$[0]'), `a row selector was rebased: ${value}`);
    }
    assert.match(selectors.projected.document.$asof[0], /^\$\[0\]\./);
  });
});
