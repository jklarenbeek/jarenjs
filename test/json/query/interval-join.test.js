import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { queryJson, JsonQueryRuntimeError } from '@jarenjs/json/query';

// A two-binding `$overlaps` phrase is answered through an interval index
// over its inner side. The oracle is the one the hash and spatial join
// suites use: a `$let` makes the planner decline every index rewrite, so
// the same document with one is the nested loop the probe replaces.
const withLet = (doc) => ({ ...doc, $let: { _z: 1 } });

/**
 * What one evaluation answered, or the error it raised, in a form two
 * evaluations can be compared by.
 * @param {any} doc
 * @param {any} data
 */
function outcome(doc, data) {
  try {
    return { value: queryJson(doc, data) };
  }
  catch (e) {
    if (!(e instanceof JsonQueryRuntimeError))
      throw e;
    return { code: e.code, docPath: e.docPath, message: e.message };
  }
}

/**
 * Both evaluations, which must agree: answer for answer, in the same
 * order, or error for error.
 * @param {any} doc
 * @param {any} data
 */
function bothWays(doc, data) {
  const indexed = outcome(doc, data);
  assert.deepStrictEqual(indexed, outcome(withLet(doc), data),
    'the interval probe must answer exactly what the nested loop answers');
  return indexed;
}

const join = {
  $for: { a: '$.outer[*]', b: '$.inner[*]' },
  $where: { $overlaps: ['$a.span', '$b.span'] },
  $return: '$b.id',
};

/**
 * The rows again, each span's `start` an accessor that counts its reads.
 * The engine reads the caller's objects by reference, so the count is
 * the predicate work the phrase did.
 * @param {any[]} rows
 * @param {{ reads: number }} counter
 */
function counting(rows, counter) {
  return rows.map((row) => {
    const { start, end } = row.span;
    const span = { end };
    Object.defineProperty(span, 'start', {
      enumerable: true,
      get() {
        counter.reads++;
        return start;
      },
    });
    return { ...row, span };
  });
}

/**
 * Bookings and probes over one year, thirty minutes to eight hours long,
 * drawn from one linear congruential sequence for 500, 1,000 and 2,000
 * spans a side, in that order.
 */
function residentCorpus() {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const spans = (n, prefix) => Array.from({ length: n }, (_, i) => {
    const start = Math.floor(rnd() * 365 * DAY);
    return { id: `${prefix}${i}`, span: { start, end: start + 1_800_000 + Math.floor(rnd() * 7.5 * HOUR) } };
  });
  const sides = new Map();
  for (const n of [500, 1000, 2000])
    sides.set(n, { bookings: spans(n, 'b'), probes: spans(n, 'p') });
  return sides;
}

describe('interval joins are answered through an index, invisibly', () => {
  const outer = [{ id: 'o', span: { start: 0, end: 10 } }];
  const bad = { id: 'x', n: 0, span: { start: 5, end: 5 } };
  const good = { id: 'g', n: 0, span: { start: 1, end: 2 } };

  it('should read a span by reference, once per $overlaps evaluation', () => {
    // the seam the work counts below stand on: a count that stayed at
    // zero would make every bound on them vacuous
    const counter = { reads: 0 };
    const [row] = counting([{ span: { start: 0, end: 10 } }], counter);
    assert.strictEqual(queryJson({ $overlaps: ['$.a', '$.b'] }, { a: row.span, b: { start: 5, end: 20 } }), true);
    assert.strictEqual(counter.reads, 1);
  });

  it('should answer the nested loop\'s pairs in its order for a fraction of the work', () => {
    const doc = {
      $for: { a: '$.bookings[*]', b: '$.probes[*]' },
      $where: { $overlaps: ['$a.span', '$b.span'] },
      $return: { a: '$a.id', b: '$b.id' },
    };
    const pairs = new Map([[500, 239], [1000, 975], [2000, 3907]]);
    for (const [n, side] of residentCorpus()) {
      const counter = { reads: 0 };
      const data = { bookings: side.bookings, probes: counting(side.probes, counter) };
      const indexed = queryJson(doc, data);
      const probed = counter.reads;
      counter.reads = 0;
      const scanned = queryJson(withLet(doc), data);
      assert.strictEqual(indexed.length, pairs.get(n), `${n} x ${n}: pairs`);
      assert.deepStrictEqual(indexed, scanned, `${n} x ${n}: the same pairs in the same order`);
      // the nested loop asks every pair; the probe reads each inner span
      // a fixed number of times to index it, then once per candidate
      assert.strictEqual(counter.reads, n * n, `${n} x ${n}: the nested loop reads every pair`);
      assert.ok(probed * 100 <= counter.reads, `${n} x ${n}: ${probed} reads against ${counter.reads}`);
    }
  });

  it('should raise on the malformed span the nested loop reaches first', () => {
    // the hit comes after it: emitting the index's hits before the spans
    // it could not hold would raise in $return instead
    const doc = { ...join, $return: { $idiv: [1, 0] } };
    assert.deepStrictEqual(bothWays(doc, { outer, inner: [bad, good] }), {
      code: 'JQ2001',
      docPath: '/$where/$overlaps/0',
      message: 'JQ2001: the right interval ends at 5, at or before its start 5 at /$where/$overlaps/0',
    });
  });

  it('should raise in $return when a hit comes before the malformed span', () => {
    const doc = { ...join, $return: { $idiv: [1, 0] } };
    assert.deepStrictEqual(bothWays(doc, { outer, inner: [good, bad] }), {
      code: 'JQ2002',
      docPath: '/$return/$idiv',
      message: "JQ2002: '$idiv' by zero at /$return/$idiv",
    });
  });

  it('should scan every inner span for an outer span it cannot screen', () => {
    // the scan raises at the first inner span that is not empty
    const unscreened = [{ id: 'o', span: { start: 5, end: 5 } }];
    assert.deepStrictEqual(bothWays(join, { outer: unscreened, inner: [{ id: 'none' }, good] }), {
      code: 'JQ2001',
      docPath: '/$where/$overlaps/0',
      message: 'JQ2001: the left interval ends at 5, at or before its start 5 at /$where/$overlaps/0',
    });
    // and over nothing but empty inner spans there is nothing to raise
    assert.deepStrictEqual(bothWays(join, { outer: unscreened, inner: [{ id: 'none' }] }), { value: undefined });
  });

  it('should not pair touching spans, and should pair one shared instant', () => {
    const data = {
      outer: [{ id: 'o', span: { start: 10, end: 20 } }],
      inner: [
        { id: 'before', span: { start: 0, end: 10 } },
        { id: 'first', span: { start: 0, end: 11 } },
        { id: 'after', span: { start: 20, end: 30 } },
        { id: 'last', span: { start: 19, end: 30 } },
      ],
    };
    assert.deepStrictEqual(bothWays(join, data), { value: ['first', 'last'] });
  });

  it('should never pair an empty inner span', () => {
    const data = {
      outer,
      inner: [{ id: 'none' }, { id: 'hit', span: { start: 1, end: 2 } }, { id: 'also none' }],
    };
    assert.deepStrictEqual(bothWays(join, data), { value: 'hit' });
  });

  it('should never run the predicate on an empty inner span', () => {
    // each outer span is read once to probe with and once per candidate;
    // the nested loop reads it once per inner item
    const counter = { reads: 0 };
    const outers = [0, 1, 2].map((k) => {
      const row = { id: `o${k}` };
      const span = { start: k, end: k + 10 };
      Object.defineProperty(row, 'span', {
        enumerable: true,
        get() {
          counter.reads++;
          return span;
        },
      });
      return row;
    });
    const data = {
      outer: outers,
      inner: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }, { id: 'hit', span: { start: 5, end: 6 } }],
    };
    assert.deepStrictEqual(queryJson(join, data), ['hit', 'hit', 'hit']);
    assert.strictEqual(counter.reads, 6);
    counter.reads = 0;
    assert.deepStrictEqual(queryJson(withLet(join), data), ['hit', 'hit', 'hit']);
    assert.strictEqual(counter.reads, 15);
  });

  it('should unpack an array item exactly as $for does', () => {
    const data = {
      outer,
      inner: [
        [{ id: 'p', span: { start: 5, end: 6 } }, { id: 'q', span: { start: 50, end: 60 } }],
        { id: 'r', span: { start: 1, end: 3 } },
      ],
    };
    assert.deepStrictEqual(bothWays(join, data), { value: ['p', 'r'] });
  });

  it('should probe through variables, with the inner span on the left', () => {
    // RFC 3339 and epoch bounds side by side; the index orders the first
    // window's hits by start, the answer keeps the spans' own order
    const doc = {
      $for: { w: '$.windows[*]', s: '$.spans[*]' },
      $where: { $overlaps: ['$s', '$w'] },
      $return: { w: '$w.start', s: '$s.start' },
    };
    const data = {
      windows: [
        { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
        { start: 1767229200000, end: 1767232800000 },
      ],
      spans: [
        { start: '2026-01-01T00:30:00Z', end: '2026-01-01T01:30:00Z' },
        { start: 1767232800000, end: 1767234600000 },
        { start: '2026-01-01T00:00:00.000+00:00', end: '2026-01-01T00:00:00.001Z' },
      ],
    };
    assert.deepStrictEqual(bothWays(doc, data), {
      value: [
        { w: '2026-01-01T00:00:00Z', s: '2026-01-01T00:30:00Z' },
        { w: '2026-01-01T00:00:00Z', s: '2026-01-01T00:00:00.000+00:00' },
        { w: 1767229200000, s: '2026-01-01T00:30:00Z' },
      ],
    });
  });

  it('should probe the innermost binding beneath two outer ones', () => {
    const doc = {
      $for: { a: '$.outer[*]', t: '$.tags[*]', b: '$.inner[*]' },
      $where: { $overlaps: ['$b.span', '$a.span'] },
      $return: { t: '$t', b: '$b.id' },
    };
    const data = {
      outer: [{ span: { start: 0, end: 10 } }, { span: { start: 20, end: 30 } }],
      tags: ['x', 'y'],
      inner: [{ id: 'late', span: { start: 25, end: 26 } }, { id: 'early', span: { start: 5, end: 6 } }],
    };
    assert.deepStrictEqual(bothWays(doc, data), {
      value: [
        { t: 'x', b: 'early' }, { t: 'y', b: 'early' },
        { t: 'x', b: 'late' }, { t: 'y', b: 'late' },
      ],
    });
  });

  it('should leave a phrase it cannot screen to the nested loop', () => {
    // an $and could raise in a conjunct the index would skip, and a
    // correlated inner side would need an index per outer tuple; the
    // nested loop reads every pair exactly once
    const counter = { reads: 0 };
    const inner = counting([{ id: 'p', span: { start: 0, end: 5 } }, { id: 'q', span: { start: 50, end: 60 } }], counter);
    const outers = [
      { id: 'o', span: { start: 0, end: 10 } },
      { id: 'v', span: { start: 40, end: 45 } },
      { id: 'w', span: { start: 55, end: 56 } },
    ];
    const conjunct = { ...join, $where: { $and: [{ $overlaps: ['$a.span', '$b.span'] }] } };
    assert.deepStrictEqual(queryJson(conjunct, { outer: outers, inner }), ['p', 'q']);
    assert.strictEqual(counter.reads, 6);

    counter.reads = 0;
    const correlated = {
      $for: { a: '$.outer[*]', b: '$a.inner[*]' },
      $where: { $overlaps: ['$a.span', '$b.span'] },
      $return: '$b.id',
    };
    const nested = outers.map((row) => ({ ...row, inner }));
    assert.deepStrictEqual(queryJson(correlated, { outer: nested }), ['p', 'q']);
    assert.strictEqual(counter.reads, 6);
  });

  it('should rebuild its index per phrase evaluation when nested', () => {
    const doc = {
      $for: { g: '$.groups[*]' },
      $return: {
        $for: { a: '$g.outer[*]', b: '$g.inner[*]' },
        $where: { $overlaps: ['$a.span', '$b.span'] },
        $return: '$b.id',
      },
    };
    assert.deepStrictEqual(queryJson(doc, {
      groups: [
        { outer: [{ span: { start: 0, end: 10 } }], inner: [{ id: 'one', span: { start: 1, end: 2 } }] },
        { outer: [{ span: { start: 100, end: 110 } }], inner: [{ id: 'two', span: { start: 101, end: 102 } }] },
      ],
    }), ['one', 'two'], 'a stale index would answer the second group wrong');
  });
});

describe('the interval probe against the nested loop, over a seeded corpus', () => {
  // the same corpus every run
  const random = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const BASE = Date.UTC(2026, 0, 1);
  const iso = (ms) => new Date(BASE + ms).toISOString();

  // Spans the kernel accepts, as epoch numbers, RFC 3339 strings or one
  // of each; on a grid this small the edges - touching, one shared
  // instant, contained, equal - all occur. A tenth have no span at all.
  const wellFormed = (rnd) => {
    const start = Math.floor(rnd() * 40);
    const end = start + 1 + Math.floor(rnd() * 12);
    const kind = rnd();
    if (kind < 0.1)
      return undefined;
    if (kind < 0.3)
      return { start: iso(start), end: iso(end) };
    if (kind < 0.4)
      return { start: BASE + start, end: iso(end) };
    return { start: BASE + start, end: BASE + end };
  };

  // spans the kernel refuses, each one reached by `$overlaps` as JQ2001
  const MALFORMED = [
    () => ({ start: BASE + 5, end: BASE + 5 }),
    () => ({ start: BASE + 9, end: BASE + 3 }),
    () => null,
    () => 7,
    () => [BASE, BASE + 1],
    () => 'noon',
    () => ({ start: BASE + 5 }),
    () => ({ start: 'yesterday', end: BASE + 3 }),
    () => ({ start: true, end: BASE + 3 }),
    () => ({ start: BASE + 1, end: Infinity }),
    () => ({ start: '2026-06-30T23:59:60Z', end: BASE + 3 }),
  ];

  const side = (rnd, n, prefix, malformed) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const span = wellFormed(rnd);
      rows.push(span === undefined ? { id: `${prefix}${i}` } : { id: `${prefix}${i}`, span });
    }
    for (let k = 0; k < malformed && n > 0; k++) {
      const at = Math.floor(rnd() * n);
      rows[at] = { id: `${prefix}${at}!`, span: MALFORMED[Math.floor(rnd() * MALFORMED.length)]() };
    }
    return rows;
  };

  // the inner span on either side of the operator
  const docs = [['$a.span', '$b.span'], ['$b.span', '$a.span']].map((operands) => ({
    $for: { a: '$.outer[*]', b: '$.inner[*]' },
    $where: { $overlaps: operands },
    $return: { a: '$a.id', b: '$b.id' },
  }));

  const size = (value) => (Array.isArray(value) ? value.length : value === undefined ? 0 : 1);

  it('should answer element for element over spans the kernel accepts', () => {
    let pairs = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const rnd = random(seed);
      for (const [n, m] of [[0, 4], [4, 0], [1, 1], [3, 7], [12, 9], [30, 40], [80, 80]]) {
        const data = { outer: side(rnd, n, 'a', 0), inner: side(rnd, m, 'b', 0) };
        for (const doc of docs)
          pairs += size(bothWays(doc, data).value);
      }
    }
    // the corpus pairs spans at all, so agreeing proved something
    assert.strictEqual(pairs, 21278);
  });

  it('should raise the nested loop\'s first error over spans the kernel refuses', () => {
    const seen = {};
    for (let seed = 1; seed <= 8; seed++) {
      const rnd = random(100 + seed);
      for (const [n, m, badOuter, badInner] of [[1, 6, 0, 1], [4, 9, 0, 2], [9, 4, 1, 0], [20, 30, 1, 1], [40, 40, 0, 3]]) {
        const data = { outer: side(rnd, n, 'a', badOuter), inner: side(rnd, m, 'b', badInner) };
        for (const doc of docs) {
          const { code, docPath } = bothWays(doc, data);
          const key = `${code} ${docPath}`;
          seen[key] = (seen[key] ?? 0) + 1;
        }
      }
    }
    // a refusal at either operand, and every run reaches one
    assert.deepStrictEqual(seen, {
      'JQ2001 /$where/$overlaps/0': 65,
      'JQ2001 /$where/$overlaps/1': 15,
    });
  });
});
