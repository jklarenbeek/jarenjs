import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { createIntervalIndex } from '@jarenjs/core/series';
import { mulberry32 } from '../../../scripts/lib/series-corpus.js';

// What "O(log n + k)" has to mean if it is a claim rather than a hope:
// a query must not read the rows, and answering a fixed question over a
// corpus 64 times larger must not cost 64 times more. Both are checked
// here against the SAME corpus shape at two sizes, so the assertions
// calibrate themselves and no absolute millisecond figure is pinned to
// whatever host happens to run them.

const SPACING = 1000;
const QUERY_WIDTH = 5 * SPACING;

/**
 * `n` intervals at a fixed density, so a query of a fixed width returns
 * the same number of rows however large the corpus is. One in every
 * 500 spans a thousand slots, which is the shape that makes a naive
 * sorted-start index wrong.
 * @param {number} n
 * @returns {{ start: number, end: number }[]}
 */
function corpus(n) {
  const random = mulberry32(20260828);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * SPACING + Math.floor(random() * SPACING);
    const width = i % 500 === 0 ? 1000 * SPACING : 1 + Math.floor(random() * (2 * SPACING));
    out[i] = { start, end: start + width };
  }
  return out;
}

/** The instants a run of queries asks about, spread across the corpus. */
function probes(n, count) {
  const random = mulberry32(4242);
  const out = new Array(count);
  for (let i = 0; i < count; i++)
    out[i] = Math.floor(random() * n * SPACING);
  return out;
}

/** The best of `rounds` passes, in milliseconds - the least-disturbed one. */
function best(rounds, run) {
  let fastest = Infinity;
  for (let r = 0; r < rounds; r++) {
    const from = performance.now();
    run();
    const took = performance.now() - from;
    if (took < fastest) fastest = took;
  }
  return fastest;
}

describe('the interval index answers without reading the corpus', () => {
  it('should read every row exactly once, at build time, and never again', () => {
    // a counting selector is the only witness that cannot be argued
    // with: if a query re-read a bound, this number would move
    let reads = 0;
    const rows = corpus(2000);
    const index = createIntervalIndex(rows, {
      start: (row) => { reads++; return row.start; },
      end: (row) => { reads++; return row.end; },
    });
    assert.strictEqual(reads, 2 * rows.length, 'two bounds per row, once each');

    const atBuild = reads;
    for (const at of probes(2000, 500)) {
      index.at(at);
      index.overlapping(at, at + QUERY_WIDTH);
    }
    assert.strictEqual(reads, atBuild, 'a query read a bound out of a row');
  });

  it('should cost the same on a corpus 64 times larger', () => {
    // linear work would be ~64x; two binary cuts and a walk over the
    // hits is ~1x, and the margin between those is what is asserted
    const small = 2048;
    const large = small * 64;
    const smallIndex = createIntervalIndex(corpus(small));
    const largeIndex = createIntervalIndex(corpus(large));
    assert.strictEqual(largeIndex.size, large);

    const smallProbes = probes(small, 2000);
    const largeProbes = probes(large, 2000);
    let smallRows = 0;
    let largeRows = 0;
    const smallMs = best(5, () => {
      smallRows = 0;
      for (const at of smallProbes)
        smallRows += smallIndex.overlapping(at, at + QUERY_WIDTH).length;
    });
    const largeMs = best(5, () => {
      largeRows = 0;
      for (const at of largeProbes)
        largeRows += largeIndex.overlapping(at, at + QUERY_WIDTH).length;
    });

    // same density, so the answers are the same size - the comparison
    // is of the search, not of the result
    assert.isTrue(Math.abs(largeRows - smallRows) < smallRows / 2,
      `result counts diverged: ${smallRows} vs ${largeRows} rows over 2000 queries`);
    assert.isTrue(largeMs < smallMs * 8,
      `2000 queries: ${smallMs.toFixed(3)} ms over ${small} intervals, `
      + `${largeMs.toFixed(3)} ms over ${large} - a full scan would be ~64x`);
  });

  it('should beat asking every interval, on the same corpus and the same answer', () => {
    const rows = corpus(131072);
    const index = createIntervalIndex(rows);
    const queries = probes(131072, 200);

    let indexed = null;
    const indexMs = best(5, () => {
      indexed = 0;
      for (const at of queries)
        indexed += index.overlapping(at, at + QUERY_WIDTH).length;
    });
    let scanned = null;
    const scanMs = best(3, () => {
      scanned = 0;
      for (const at of queries) {
        const end = at + QUERY_WIDTH;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].start < end && at < rows[i].end) scanned++;
        }
      }
    });

    assert.strictEqual(indexed, scanned, 'the index and the scan must answer the same rows');
    assert.isTrue(indexMs < scanMs,
      `200 queries over 131,072 intervals returning ${indexed} rows: `
      + `index ${indexMs.toFixed(3)} ms, full scan ${scanMs.toFixed(3)} ms`);
  });
});
