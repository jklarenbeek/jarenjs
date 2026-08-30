import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { asOfJoin } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

// The reference is the O(n·m) join: for every left row, look at every
// right row and keep the best one under the stated rule. It cannot be
// wrong about which row is nearest, because it looked at all of them —
// which is exactly what makes it worth comparing a two-pointer walk to.

const DIRECTIONS = ['backward', 'forward', 'nearest'];

/**
 * The obvious join, written to the same tie rules: the LAST right row at
 * an equal instant, and backward on a `nearest` tie.
 */
function referenceJoin(left, right, direction, tolerance, keyOf) {
  return left.map((l) => {
    let best = null;
    let bestDistance = null;
    right.forEach((r, index) => {
      if (keyOf !== null && keyOf(r) !== keyOf(l))
        return;
      const delta = l.at - r.at;
      if (direction === 'backward' && delta < 0) return;
      if (direction === 'forward' && delta > 0) return;
      const distance = Math.abs(delta);
      if (distance > tolerance) return;
      const better = bestDistance === null
        || distance < bestDistance
        // an equal distance: the later right row wins at an equal
        // instant, and a backward tie beats a forward one for `nearest`
        || (distance === bestDistance && (r.at === best.at
          ? index > best.index
          : (direction === 'nearest' && r.at < l.at)));
      if (better) {
        best = { at: r.at, index, row: r };
        bestDistance = distance;
      }
    });
    return best === null
      ? { left: l, right: null, distance: null }
      : { left: l, right: best.row, distance: bestDistance };
  });
}

/** A seeded series with duplicates, gaps and instants on both sides of the epoch. */
function corpus(seed, n, keys) {
  const random = mulberry32(seed);
  const out = [];
  let at = -20_000;
  for (let i = 0; i < n; i++) {
    if (i === 0 || random() >= 0.2)
      at += Math.floor(random() * 900);
    out.push({
      at,
      value: random() < 0.1 ? null : Math.round(random() * 1000) / 8,
      key: keys === 0 ? undefined : `k${Math.floor(random() * keys)}`,
    });
  }
  return out;
}

const series = (pairs) => pairs.map(([at, value]) => ({ at, value }));

describe('asOfJoin — direction', () => {
  const left = series([[100, 'l1'], [200, 'l2'], [300, 'l3']].map(([at]) => [at, at]));
  const right = series([[150, 15], [250, 25]]);

  it('should take the last right row at or before, by default', () => {
    const out = asOfJoin(left, right);
    assert.deepStrictEqual(out.map((m) => [m.left.at, m.right?.at ?? null, m.distance]), [
      [100, null, null],
      [200, 150, 50],
      [300, 250, 50],
    ]);
  });

  it('should take the first right row at or after, looking forward', () => {
    const out = asOfJoin(left, right, { direction: 'forward' });
    assert.deepStrictEqual(out.map((m) => [m.left.at, m.right?.at ?? null, m.distance]), [
      [100, 150, 50],
      [200, 250, 50],
      [300, null, null],
    ]);
  });

  it('should take whichever is closer, looking nearest', () => {
    const out = asOfJoin(series([[100, 1], [160, 2], [240, 3], [400, 4]]),
      right, { direction: 'nearest' });
    assert.deepStrictEqual(out.map((m) => [m.left.at, m.right.at, m.distance]), [
      [100, 150, 50],
      [160, 150, 10],
      [240, 250, 10],
      [400, 250, 150],
    ]);
  });

  it('should choose backward on a nearest tie', () => {
    // a value already observed is evidence; the next one is a forecast
    const out = asOfJoin(series([[200, 1]]), series([[100, 'a'], [300, 'b']]
      .map(([at, v]) => [at, v === 'a' ? 1 : 2])), { direction: 'nearest' });
    assert.strictEqual(out[0].right.at, 100);
    assert.strictEqual(out[0].distance, 100);
  });

  it('should report a distance that is never negative', () => {
    for (const direction of DIRECTIONS) {
      for (const match of asOfJoin(left, right, { direction }))
        assert.ok(match.distance === null || match.distance >= 0, direction);
    }
  });

  it('should refuse a direction it does not have', () => {
    assert.throws(() => asOfJoin(left, right, { direction: 'either' }), /direction is/);
  });
});

describe('asOfJoin — the exact instant and its duplicates', () => {
  it('should match an exact instant at distance zero in every direction', () => {
    const left = series([[100, 1]]);
    const right = series([[50, 5], [100, 10], [150, 15]]);
    for (const direction of DIRECTIONS) {
      const [match] = asOfJoin(left, right, { direction });
      assert.strictEqual(match.right.at, 100, direction);
      assert.strictEqual(match.distance, 0, direction);
    }
  });

  it('should take the LAST right row at an equal instant, in every direction', () => {
    // two readings in the same millisecond: "as of" means the later one
    const left = series([[100, 1]]);
    const right = [{ at: 100, value: 1, tag: 'first' }, { at: 100, value: 2, tag: 'second' }];
    for (const direction of DIRECTIONS)
      assert.strictEqual(asOfJoin(left, right, { direction })[0].right.tag, 'second', direction);
  });

  it('should take the last row of the first later instant, looking forward', () => {
    const right = [{ at: 200, value: 1, tag: 'a' }, { at: 200, value: 2, tag: 'b' },
      { at: 300, value: 3, tag: 'c' }];
    const [match] = asOfJoin(series([[100, 1]]), right, { direction: 'forward' });
    assert.strictEqual(match.right.tag, 'b');
    assert.strictEqual(match.distance, 100);
  });

  it('should give every left row at one instant the same answer', () => {
    const left = [{ at: 100, value: 1, tag: 'x' }, { at: 100, value: 2, tag: 'y' }];
    const out = asOfJoin(left, series([[50, 5]]));
    assert.deepStrictEqual(out.map((m) => [m.left.tag, m.right.at]), [['x', 50], ['y', 50]]);
  });
});

describe('asOfJoin — tolerance', () => {
  const left = series([[1000, 1]]);
  const right = series([[400, 4], [1600, 16]]);

  it('should keep a match exactly at the tolerance and drop the one past it', () => {
    assert.strictEqual(asOfJoin(left, right, { tolerance: 600 })[0].right.at, 400);
    assert.deepStrictEqual(asOfJoin(left, right, { tolerance: 599 })[0],
      { left: left[0], right: null, distance: null });
  });

  it('should take a fixed ISO 8601 duration wherever it takes milliseconds', () => {
    assert.strictEqual(asOfJoin(left, right, { tolerance: 'PT0.6S' })[0].right.at, 400);
  });

  it('should not fall back to the other direction when the near one is out of tolerance', () => {
    // 600 back, 600 forward, and a tolerance of 500: there is no match,
    // not a distant one dressed up as the best available
    const out = asOfJoin(left, right, { direction: 'nearest', tolerance: 500 });
    assert.strictEqual(out[0].right, null);
  });

  it('should refuse a tolerance that is not a non-negative fixed width', () => {
    assert.throws(() => asOfJoin(left, right, { tolerance: -1 }), /non-negative/);
    assert.throws(() => asOfJoin(left, right, { tolerance: 'P1M' }), /calendar duration/);
    assert.throws(() => asOfJoin(left, right, { tolerance: 'soon' }), /non-negative ISO 8601/);
  });
});

describe('asOfJoin — shape', () => {
  it('should return one record per left row, in the left order, unmatched included', () => {
    const out = asOfJoin(series([[300, 3], [100, 1], [200, 2]]), []);
    assert.deepStrictEqual(out.map((m) => m.left.at), [100, 200, 300]);
    for (const match of out)
      assert.deepStrictEqual([match.right, match.distance], [null, null]);
  });

  it('should hand back canonical samples carrying every source member', () => {
    const left = [{ on: '2026-01-01T00:00:10Z', reading: 1, site: 'north' }];
    const right = [{ ts: '2026-01-01T00:00:05Z', v: 9, sensor: 'a' }];
    const [match] = asOfJoin(left, right, {
      left: { at: 'on', value: 'reading' },
      right: { at: 'ts', value: 'v' },
    });
    assert.strictEqual(match.left.site, 'north');
    assert.strictEqual(match.left.at, Date.UTC(2026, 0, 1, 0, 0, 10));
    assert.strictEqual(match.right.sensor, 'a');
    assert.strictEqual(match.right.at, Date.UTC(2026, 0, 1, 0, 0, 5));
    assert.strictEqual(match.distance, 5000);
  });

  it('should join nothing to an empty right side, and answer nothing for an empty left', () => {
    assert.strictEqual(asOfJoin([], series([[0, 1]])).length, 0);
    assert.deepStrictEqual(asOfJoin(series([[0, 1]]), [])[0].right, null);
  });
});

describe('asOfJoin — keys', () => {
  const left = [
    { at: 100, value: 1, sensor: 'a' },
    { at: 110, value: 2, sensor: 'b' },
    { at: 200, value: 3, sensor: 'a' },
    { at: 300, value: 4, sensor: 'c' },
  ];
  const right = [
    { at: 50, value: 'a1', sensor: 'a' },
    { at: 90, value: 'b1', sensor: 'b' },
    { at: 150, value: 'a2', sensor: 'a' },
  ].map((row) => ({ ...row, value: null, tag: row.value }));

  it('should join within a group and never across one', () => {
    const out = asOfJoin(left, right, { key: 'sensor' });
    assert.deepStrictEqual(out.map((m) => [m.left.sensor, m.right?.tag ?? null]), [
      ['a', 'a1'],
      ['b', 'b1'],
      ['a', 'a2'],
      ['c', null],
    ]);
  });

  it('should read a key the two sides spell differently', () => {
    const out = asOfJoin(left, right.map((r) => ({ ...r, probe: r.sensor })),
      { left: { key: 'sensor' }, right: { key: 'probe' } });
    assert.deepStrictEqual(out.map((m) => m.right?.tag ?? null), ['a1', 'b1', 'a2', null]);
  });

  it('should take a function as well as a member name', () => {
    const out = asOfJoin(left, right, { key: (row) => row.sensor.toUpperCase() });
    assert.deepStrictEqual(out.map((m) => m.right?.tag ?? null), ['a1', 'b1', 'a2', null]);
  });
});

describe('asOfJoin — against the O(n·m) reference', () => {
  for (const direction of DIRECTIONS) {
    it(`should answer what looking at every right row answers, '${direction}'`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const left = corpus(seed * 104_729, 120, 0);
        const right = corpus(seed * 15_485_863, 90, 0);
        for (const tolerance of [Infinity, 400, 0]) {
          const spec = tolerance === Infinity ? { direction } : { direction, tolerance };
          assert.deepStrictEqual(
            asOfJoin(left, right, spec),
            referenceJoin(left, right, direction, tolerance, null),
            `seed ${seed}, tolerance ${tolerance}`);
        }
      }
    });

    it(`should answer the same within every key, '${direction}'`, () => {
      for (let seed = 1; seed <= 4; seed++) {
        const left = corpus(seed * 7919, 100, 4);
        const right = corpus(seed * 65_537, 80, 5);
        assert.deepStrictEqual(
          asOfJoin(left, right, { direction, key: 'key' }),
          referenceJoin(left, right, direction, Infinity, (row) => row.key),
          `seed ${seed}`);
      }
    });
  }
});
