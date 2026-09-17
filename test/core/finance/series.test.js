//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adx, cci, vwap, obv, volumeRatio, kdj, williamsR, annualizedReturn, sortino, calmar, beta } from '@jarenjs/core/finance';

const golden = JSON.parse(readFileSync(new URL('./fixtures/series-golden.json', import.meta.url), 'utf8'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
it('matches independently generated TA-Lib 0.6.4 directional, CCI, OBV and Williams vectors', () => {
  const { high, low, close, volume, expected } = golden, period = golden.oracle.period;
  const result = { ...adx(high, low, close, period), cci: cci(high, low, close, period), obv: obv(close, volume), williamsR: williamsR(high, low, close, period) };
  for (const [name, values] of Object.entries(expected)) values.forEach((value, i) => value === null
    ? assert.equal(result[name][i], null) : near(result[name][i], value));
  assert.deepEqual(adx(Float64Array.from(high), Float64Array.from(low), Float64Array.from(close), period), adx(high, low, close, period));
});

it('pins volume weighting, reset flags, prior volume windows and the chosen KDJ convention', () => {
  const h = [3, 6, 9, 12], l = [1, 2, 3, 4], c = [2, 4, 6, 8], v = [0, 2, 1, 3];
  assert.deepEqual(vwap(h, l, c, v), [null, 4, 14 / 3, 38 / 6]);
  assert.deepEqual(vwap(h, l, c, v, [false, false, true, false]), [null, 4, 6, 7.5]);
  assert.deepEqual(volumeRatio([2, 4, 9, 6], 2), [null, null, 3, 12 / 13]);
  assert.deepEqual(volumeRatio([0, 0, 2], 2), [null, null, null]);
  assert.deepEqual(obv([2, 3, 3, 1], [10, 20, 30, 40]), [10, 30, 30, -10]);
  const value = kdj(h, l, c, 2, 2);
  assert.equal(value.k[0], null); assert.equal(value.d[1], null); assert.equal(value.j[1], null);
  near(value.k[2], 100 * 4 / 7); near(value.d[2], (60 + 100 * 4 / 7) / 2);
  near(value.j[2], 3 * value.k[2] - 2 * value.d[2]);
});

it('uses explicit periodicity, seeded equity, aligned covariance and downside RMS', () => {
  near(annualizedReturn([0.1, -0.1], 2), -0.01);
  near(sortino([0.1, -0.1, 0.2, -0.2]), 0);
  near(sortino([0.1, -0.1, 0.2], 0, 12), (0.2 / 3) / Math.sqrt(0.01 / 3) * Math.sqrt(12));
  near(calmar([0.1, -0.1], 2), -0.1);
  near(calmar([-0.5], 1), -1);
  near(beta([0.2, 0.4, -0.2], [0.1, 0.2, -0.1]), 2);
  assert.equal(annualizedReturn([-1, 0.5], 12), -1);
  for (const value of [annualizedReturn([], 12), sortino([0.1]), calmar([0.1], 12), beta([0.1], [0.2]), beta([0.1, 0.2], [0.2, 0.2])]) assert.ok(Number.isNaN(value));
});

it('defines flat/short windows and refuses malformed domains without changing inputs', () => {
  const flat = [3, 3, 3, 3, 3], copy = [...flat];
  assert.deepEqual(adx(flat, flat, flat, 2).adx, [null, null, null, 0, 0]);
  assert.deepEqual(cci(flat, flat, flat, 2), [null, 0, 0, 0, 0]);
  assert.deepEqual(williamsR(flat, flat, flat, 2), [null, 0, 0, 0, 0]);
  assert.deepEqual(cci(flat, flat, flat, 10), [null, null, null, null, null]);
  assert.deepEqual(adx([], [], []).adx, []); assert.deepEqual(obv([], []), []);
  assert.throws(() => adx(flat, flat, flat, 1));
  assert.throws(() => cci([1], [], [1])); assert.throws(() => cci([1], [2], [1]));
  assert.throws(() => vwap([1], [1], [1], [-1])); assert.throws(() => vwap([1], [1], [1], [1], [1]));
  assert.throws(() => volumeRatio([NaN], 1)); assert.throws(() => kdj(flat, flat, flat, 2, 0));
  assert.throws(() => annualizedReturn([-2], 12)); assert.throws(() => annualizedReturn([0.1], 0));
  assert.throws(() => sortino([0.1], NaN)); assert.throws(() => beta([0.1], []));
  assert.deepEqual(flat, copy);
});
