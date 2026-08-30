import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { createIntervalIndex } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

const iv = (start, end, id) => ({ start, end, id });

/** The oracle: what asking every interval would find. */
function scanAt(items, at) {
  return items.filter((i) => at >= i.start && at < i.end);
}
function scanOverlapping(items, start, end) {
  return items.filter((i) => i.start < end && start < i.end);
}

/** Ascending by start, ties by input position - the index's own order. */
function inIndexOrder(items, subset) {
  const wanted = new Set(subset);
  return items.map((item, at) => ({ item, at }))
    .filter(({ item }) => wanted.has(item))
    .sort((a, b) => a.item.start - b.item.start || a.at - b.at)
    .map(({ item }) => item);
}

describe('the interval index', () => {
  it('should answer with the caller\'s own rows, ascending by start', () => {
    const rows = [iv(30, 40, 'c'), iv(0, 10, 'a'), iv(0, 100, 'b')];
    const index = createIntervalIndex(rows);
    assert.strictEqual(index.size, 3);
    const got = index.overlapping(0, 200);
    assert.deepStrictEqual(got.map((i) => i.id), ['a', 'b', 'c']);
    assert.strictEqual(got[0], rows[1]);
    assert.strictEqual(got[2], rows[0]);
  });

  it('should keep rows sharing a start in the order they arrived', () => {
    const rows = [iv(0, 5, 'first'), iv(0, 9, 'second'), iv(0, 7, 'third')];
    assert.deepStrictEqual(createIntervalIndex(rows).at(0).map((i) => i.id),
      ['first', 'second', 'third']);
  });

  it('should be half-open at a point, both ends', () => {
    const index = createIntervalIndex([iv(0, 10, 'a'), iv(10, 20, 'b')]);
    assert.deepStrictEqual(index.at(9).map((i) => i.id), ['a']);
    assert.deepStrictEqual(index.at(10).map((i) => i.id), ['b']);
    assert.deepStrictEqual(index.at(20).map((i) => i.id), []);
    assert.deepStrictEqual(index.at(-1).map((i) => i.id), []);
  });

  it('should treat a touching range query as no overlap', () => {
    const index = createIntervalIndex([iv(10, 20, 'a')]);
    assert.deepStrictEqual(index.overlapping(0, 10).map((i) => i.id), []);
    assert.deepStrictEqual(index.overlapping(20, 30).map((i) => i.id), []);
    assert.deepStrictEqual(index.overlapping(19, 21).map((i) => i.id), ['a']);
  });

  it('should NOT lose a long interval that began far before the query', () => {
    // the defect the prefix maximum-end exists to prevent: a span that
    // started a year before the query still overlaps it, and a binary
    // search around the query's own neighbourhood never sees it
    const rows = [iv(0, 1_000_000, 'the conference week')];
    for (let i = 1; i <= 2000; i++)
      rows.push(iv(i * 100, i * 100 + 10, `meeting ${i}`));
    const index = createIntervalIndex(rows);
    assert.deepStrictEqual(index.at(150_050).map((i) => i.id), ['the conference week']);
    assert.deepStrictEqual(index.overlapping(150_050, 150_060).map((i) => i.id),
      ['the conference week']);
    const late = index.overlapping(199_990, 200_020).map((i) => i.id);
    assert.deepStrictEqual(late, ['the conference week', 'meeting 2000']);
  });

  it('should still cut, not scan, when a long interval is present', () => {
    // the long span is live everywhere, but the rows before the query
    // are all spent - the prefix maximum is what proves that, and the
    // answer stays exact
    const rows = [iv(0, 5, 'early')];
    for (let i = 0; i < 5000; i++)
      rows.push(iv(i * 10, i * 10 + 5, `short ${i}`));
    rows.push(iv(1, 1_000_000, 'the long one'));
    const index = createIntervalIndex(rows);
    assert.deepStrictEqual(index.at(40_000).map((i) => i.id), ['the long one', 'short 4000']);
  });

  it('should agree with a full scan over a seeded corpus of every shape', () => {
    const random = mulberry32(20260826);
    const rows = [];
    for (let i = 0; i < 4000; i++) {
      const start = Math.floor(random() * 200_000) - 50_000;
      // most spans are short; a few are long enough to span the corpus
      const width = i % 97 === 0
        ? Math.floor(random() * 150_000) + 1
        : Math.floor(random() * 60) + 1;
      rows.push(iv(start, start + width, `row ${i}`));
    }
    // duplicates are real data and must be answered twice
    rows.push(iv(1000, 1010, 'dup a'), iv(1000, 1010, 'dup b'));
    const index = createIntervalIndex(rows);
    assert.strictEqual(index.size, rows.length);

    let points = 0;
    let ranges = 0;
    let hits = 0;
    for (let q = 0; q < 400; q++) {
      const at = Math.floor(random() * 220_000) - 60_000;
      assert.deepStrictEqual(index.at(at), inIndexOrder(rows, scanAt(rows, at)),
        `point query ${q} at ${at}`);
      points++;
      const width = Math.floor(random() * 5000) + 1;
      const got = index.overlapping(at, at + width);
      assert.deepStrictEqual(got, inIndexOrder(rows, scanOverlapping(rows, at, at + width)),
        `range query ${q} at ${at}`);
      hits += got.length;
      ranges++;
    }
    assert.strictEqual(points, 400);
    assert.strictEqual(ranges, 400);
    assert.isTrue(hits > 1000, `the corpus answered ${hits} rows - too few to prove anything`);
  });

  it('should read whichever members hold the bounds, in any spelling', () => {
    const rows = [
      { from: '2026-03-01T09:00:00Z', to: '2026-03-01T10:00:00Z', who: 'ada' },
      { from: '2026-03-01T09:30:00Z', to: '2026-03-01T11:00:00Z', who: 'grace' },
    ];
    const index = createIntervalIndex(rows, { start: 'from', end: 'to' });
    assert.deepStrictEqual(index.at('2026-03-01T09:45:00Z').map((r) => r.who), ['ada', 'grace']);
    assert.deepStrictEqual(index.at('2026-03-01T10:00:00Z').map((r) => r.who), ['grace']);

    const byFunction = createIntervalIndex([{ span: [0, 10] }, { span: [5, 20] }],
      { start: (row) => row.span[0], end: (row, i) => row.span[1] + i });
    assert.strictEqual(byFunction.at(20).length, 1);
    assert.throws(() => createIntervalIndex([], { end: 7 }),
      /'end' selector is a property name or a function/);
  });

  it('should answer an empty index with empty results', () => {
    const index = createIntervalIndex([]);
    assert.strictEqual(index.size, 0);
    assert.deepStrictEqual(index.at(0), []);
    assert.deepStrictEqual(index.overlapping(0, 1), []);
  });

  it('should refuse a row it cannot index rather than skip it', () => {
    assert.throws(() => createIntervalIndex([iv(0, 10), iv(5, 5)]),
      /row 1: an interval ends at 5/);
    assert.throws(() => createIntervalIndex([iv(0, 10), { start: 0 }]), /row 1, end:/);
    assert.throws(() => createIntervalIndex([iv(0, 10), 5]), /row 1 is not an object/);
    assert.throws(() => createIntervalIndex('nope'), /intervals are an array of rows/);
  });

  it('should refuse a range query that holds no instant', () => {
    const index = createIntervalIndex([iv(0, 10)]);
    assert.throws(() => index.overlapping(5, 5), /the query ends at 5/);
    assert.throws(() => index.overlapping(6, 5), /the query ends at 5/);
    assert.throws(() => index.at('noon'), /not an RFC 3339 instant/);
  });

  it('should hand back a fresh array a caller may keep', () => {
    const index = createIntervalIndex([iv(0, 10, 'a'), iv(1, 9, 'b')]);
    const first = index.at(5);
    first.length = 0;
    assert.strictEqual(index.at(5).length, 2);
  });

  it('should answer from its own snapshot, not from the rows', () => {
    // static on purpose: the bounds were copied at build time, so a row
    // mutated afterwards cannot silently change what the index says
    const rows = [iv(0, 10, 'a')];
    const index = createIntervalIndex(rows);
    rows[0].start = 500;
    rows[0].end = 600;
    assert.deepStrictEqual(index.at(5).map((i) => i.id), ['a']);
    assert.deepStrictEqual(index.at(550), []);
  });
});
