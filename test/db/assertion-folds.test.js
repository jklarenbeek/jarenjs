//@ts-check
/**
 * @file The fold and the engine answer the same question.
 *
 * A cross-document assertion that is one associative aggregate over the
 * root may be computed one batch at a time. That is only sound if the
 * folded answer equals the answer the engine gives over the whole
 * collection — for EVERY input, including the ones that make aggregates
 * interesting: nulls, missing members, an empty collection, a batch that
 * contributes nothing, and a partition that does not divide evenly.
 *
 * This suite is the proof. It runs each classified shape both ways over
 * the same documents, at several batch sizes, and requires the two to be
 * indistinguishable — the value AND the verdict. A shape that cannot
 * pass this does not belong in the closed set.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { classifyAssertion, compileDocumentStep } from '@jarenjs/db';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

/** Compile one assertion step the way a host does. */
const operationFor = (query, expect) => compileDocumentStep(
  { kind: 'query', collection: 'users', assert: query, ...(expect ? { expect } : {}) },
  0,
  { migrationId: 'm', compileJslt: compileJsltStylesheet, compileQuery: compileJsonQuery },
);

/** The verdict the whole-collection path reaches: null, or the refusal. */
function wholeVerdict(operation, documents) {
  try {
    operation.assert(documents);
    return { ok: true, message: null };
  }
  catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message };
  }
}

/** The verdict the fold reaches over the same documents, in batches. */
function foldVerdict(operation, documents, batchSize) {
  // the whole-collection path lets an engine runtime error propagate out
  // of `assert`, so the fold is compared with the same bracket around
  // it — combining AND finishing — or the two would be measured
  // differently rather than found to differ
  let accumulated = operation.fold.start();
  try {
    for (let at = 0; at < documents.length; at += batchSize) {
      accumulated = operation.fold.combine(accumulated, documents.slice(at, at + batchSize));
    }
    operation.fold.finish(accumulated);
    return { ok: true, message: null, value: operation.fold.value(accumulated) };
  }
  catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message, value: operation.fold.value(accumulated) };
  }
}

/** The document sets an aggregate has to survive. */
const CORPORA = {
  'an empty collection': [],
  'one document': [{ id: 'u0', n: 5 }],
  'a plain range': Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, n: i })),
  'negative and zero': [{ id: 'a', n: -3 }, { id: 'b', n: 0 }, { id: 'c', n: 7 }],
  'a null member': [{ id: 'a', n: 1 }, { id: 'b', n: null }, { id: 'c', n: 3 }],
  'a MISSING member': [{ id: 'a', n: 1 }, { id: 'b' }, { id: 'c', n: 3 }],
  'every member missing': [{ id: 'a' }, { id: 'b' }],
  'all equal': [{ id: 'a', n: 2 }, { id: 'b', n: 2 }, { id: 'c', n: 2 }],
  'fractional': [{ id: 'a', n: 0.1 }, { id: 'b', n: 0.2 }],
  'a larger range': Array.from({ length: 250 }, (_, i) => ({ id: `u${i}`, n: i % 17 })),
};

/** The assertion shapes that classify as a fold. */
const SHAPES = [
  { name: '$count over the root', query: { $count: '$[*]' }, expect: 'ebv' },
  { name: '$count, expecting an empty sequence', query: { $count: '$[*]' }, expect: undefined },
  { name: '$sum over a member', query: { $sum: { $for: { it: '$[*]' }, $return: '$it.n' } }, expect: 'ebv' },
  { name: '$max over a member', query: { $max: { $for: { it: '$[*]' }, $return: '$it.n' } }, expect: 'ebv' },
  { name: '$min over a member', query: { $min: { $for: { it: '$[*]' }, $return: '$it.n' } }, expect: 'ebv' },
  { name: '$avg over a path', query: { $avg: '$[*].n' }, expect: 'ebv' },
  { name: '$sum over a path', query: { $sum: '$[*].n' }, expect: 'ebv' },
  { name: '$max over a path', query: { $max: '$[*].n' }, expect: 'ebv' },
  { name: '$min over a path', query: { $min: '$[*].n' }, expect: 'ebv' },
  { name: '$count over a path', query: { $count: '$[*].n' }, expect: 'ebv' },
];

describe('what classifies as what', () => {
  it('a per-document predicate is per-document', () => {
    const classified = classifyAssertion(
      { $for: { it: '$[*]' }, $where: { $lt: ['$it.n', 0] }, $return: '$it.id' });
    assert.strictEqual(classified.strategy, 'perDocument');
    assert.ok(classified.reason.length > 0);
  });

  it('one associative aggregate over the root is a fold, and names its shape', () => {
    for (const shape of SHAPES) {
      const classified = classifyAssertion(shape.query);
      assert.strictEqual(classified.strategy, 'fold', shape.name);
      assert.ok(['$count', '$sum', '$avg', '$max', '$min'].includes(/** @type {string} */ (classified.shape)),
        `${shape.name}: ${classified.shape}`);
    }
  });

  it('everything else materializes, and says why', () => {
    const others = [
      { $let: { total: { $count: '$[*]' } }, $return: { $gt: ['$total', 0] } },
      { $distinct: '$[*].n' },
      { $for: { a: '$[*]', b: '$[*]' }, $where: { $eq: ['$a.n', '$b.n'] }, $return: '$a.id' },
      // two aggregates are not ONE aggregate
      { $count: '$[*]', $sum: '$[*].n' },
    ];
    for (const query of others) {
      const classified = classifyAssertion(query);
      assert.strictEqual(classified.strategy, 'materialize', JSON.stringify(query));
      assert.match(classified.reason, /every document/);
    }
  });

  it('a non-object, an array and null are not folds', () => {
    for (const query of [null, 42, 'text', ['$count'], []]) {
      assert.strictEqual(classifyAssertion(query).strategy, 'materialize', JSON.stringify(query));
    }
  });
});

describe('the fold equals the engine, on every corpus and every partition', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}`, () => {
      const operation = operationFor(shape.query, shape.expect);
      assert.ok(operation.fold !== null, 'this shape must fold');
      for (const [label, documents] of Object.entries(CORPORA)) {
        const whole = wholeVerdict(operation, documents);
        for (const batchSize of [1, 2, 3, 7, 100, 10000]) {
          const folded = foldVerdict(operation, documents, batchSize);
          assert.strictEqual(folded.ok, whole.ok,
            `${shape.name} / ${label} / batch ${batchSize}: verdicts differ `
            + `(whole ${whole.ok ? 'passed' : whole.message}, `
            + `fold ${folded.ok ? 'passed' : folded.message}, value ${JSON.stringify(folded.value)})`);
          assert.strictEqual(folded.message, whole.message,
            `${shape.name} / ${label} / batch ${batchSize}: messages differ`);
        }
      }
    });
  }

  it('the folded VALUE equals the engine\'s value, not merely the verdict', () => {
    for (const shape of SHAPES) {
      const operation = operationFor(shape.query, shape.expect);
      const compiled = compileJsonQuery(shape.query);
      for (const [label, documents] of Object.entries(CORPORA)) {
        let expected;
        try {
          expected = compiled(documents);
        }
        catch {
          continue; // the engine refuses this corpus outright; the verdict suite covers it
        }
        // the VALUE is compared whatever the verdict: an assertion that
        // legitimately refuses (`$count` of an empty collection is 0,
        // whose effective boolean value is false) still has to have
        // computed the same 0 the engine computes
        for (const batchSize of [1, 3, 100]) {
          const folded = foldVerdict(operation, documents, batchSize);
          assert.deepStrictEqual(folded.value, expected,
            `${shape.name} / ${label} / batch ${batchSize}`);
        }
      }
    }
  });
});
