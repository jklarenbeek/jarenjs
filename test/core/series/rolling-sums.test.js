//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollingSeries } from '@jarenjs/core/series';
import { mulberry32 } from '@jarenjs/core/random';

const series = (/** @type {[number, number | null][]} */ pairs) => pairs.map(([at, value]) => ({ at, value }));

/** The exactly rounded sum of some doubles (Shewchuk's partials). */
function exactSum(/** @type {number[]} */ values) {
  /** @type {number[]} */
  const partials = [];
  for (let x of values) {
    let kept = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y;
      const low = y - (high - x);
      if (low !== 0) partials[kept++] = low;
      x = high;
    }
    partials.length = kept;
    partials.push(x);
  }
  return partials.reduce((a, b) => a + b, 0);
}

describe('a rolling sum or mean forgets what has left the window', () => {
  it('does not stay infinite after an overflowing reading has left', () => {
    const rows = series([[0, 1e308], [1, 1e308], [2, 1], [3, 2], [4, 3], [5, 4]]);
    assert.deepEqual(rollingSeries(rows, { width: 2, aggregate: 'sum' }).map((r) => r.value),
      [1e308, Infinity, 1e308, 3, 5, 7]);
    assert.deepEqual(rollingSeries(rows, { width: 2, aggregate: 'mean' }).map((r) => r.value),
      [1e308, Infinity, 5e307, 1.5, 2.5, 3.5]);
  });

  it('does not keep the rounding a large reading left behind', () => {
    const rows = series([[0, 1e16], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
    assert.deepEqual(rollingSeries(rows, { width: 2, aggregate: 'sum' }).map((r) => r.value),
      [1e16, 1e16, 2, 2, 2, 2]);
    assert.deepEqual(rollingSeries(rows, { width: 2, aggregate: 'mean' }).map((r) => r.value),
      [1e16, 5e15, 1, 1, 1, 1]);
  });

  it('stays within rounding of the exact window sum when magnitudes differ widely', () => {
    const random = mulberry32(20261012);
    let checked = 0;
    for (let trial = 0; trial < 40; trial++) {
      const rows = [];
      let at = 0;
      for (let i = 0; i < 120; i++) {
        at += 1 + Math.floor(random() * 3);
        const magnitude = 10 ** Math.floor(random() * 24 - 6);
        rows.push({ at, value: random() < 0.1 ? null : (random() - 0.5) * magnitude });
      }
      const width = 1 + Math.floor(random() * 30);
      const out = rollingSeries(rows, { width, aggregate: 'sum' });
      rows.forEach((row, k) => {
        const window = rows.filter((r) => r.at > row.at - width && r.at <= row.at && r.value !== null)
          .map((r) => /** @type {number} */ (r.value));
        if (window.length === 0) return;
        const scale = window.reduce((a, b) => a + Math.abs(b), 0);
        assert.ok(Math.abs(/** @type {number} */ (out[k].value) - exactSum(window)) <= 1e-14 * scale,
          `trial ${trial}, row ${k}`);
        checked++;
      });
    }
    assert.ok(checked > 3000);
  });
});
