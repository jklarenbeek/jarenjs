//@ts-check
/**
 * @file `resampleSeries` with the `omit` fill emits no empty bucket, so it
 * must not walk one: two rows far apart at a fine width, or a window far
 * wider than the data, cost time in proportion to the rows. Each case runs
 * in a child process under a deadline, because the walk it replaces does
 * not finish.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { resampleSeries } from '@jarenjs/core/series';

/** Run one resample in a fresh process and answer its JSON. @param {string} call */
function inChild(call) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { resampleSeries } from '@jarenjs/core/series'; console.log(JSON.stringify(${call}));`],
  { encoding: 'utf8', timeout: 5000, cwd: process.cwd() });
  assert.strictEqual(result.status, 0, `did not finish: ${result.signal} ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('resampleSeries - omit fill walks the occupied buckets', () => {
  it('jumps two rows a thousand years apart at a one-millisecond width', () => {
    assert.deepStrictEqual(
      inChild('resampleSeries([{ at: 0, value: 1 }, { at: 3.2e13, value: 5 }], { every: 1, aggregate: "sum" })'),
      [{ at: 0, value: 1, count: 1 }, { at: 3.2e13, value: 5, count: 1 }]);
  });

  it('stops at the last occupied bucket of a window that runs on for ever', () => {
    assert.deepStrictEqual(
      inChild('resampleSeries([{ at: 5, value: 2 }], { every: 1, start: 0, end: 1e15 })'),
      [{ at: 5, value: 2, count: 1 }]);
  });

  it('jumps a calendar ladder to the month that holds the next row', () => {
    assert.deepStrictEqual(
      inChild('resampleSeries([{ at: "2020-01-15T00:00:00Z", value: 1 }, { at: "2021-03-02T00:00:00Z", value: 3 }],'
        + ' { every: "P1M", aggregate: "sum" })'),
      [{ at: Date.UTC(2020, 0, 1), value: 1, count: 1 }, { at: Date.UTC(2021, 2, 1), value: 3, count: 1 }]);
  });

  it('keeps the answers of the small cases the walk used to give', () => {
    const rows = [{ at: 0, value: 1 }, { at: 1, value: 3 }, { at: 7, value: 5 }, { at: 8, value: null }];
    assert.deepStrictEqual(resampleSeries(rows, { every: 2, aggregate: 'sum' }), [
      { at: 0, value: 4, count: 2 }, { at: 6, value: 5, count: 1 }, { at: 8, value: null, count: 1 }]);
    assert.deepStrictEqual(resampleSeries(rows, { every: 2, aggregate: 'sum', start: 4, end: 7 }), []);
    assert.deepStrictEqual(resampleSeries(rows, { every: 2, aggregate: 'count', fill: 'omit', start: -4 }), [
      { at: 0, value: 2, count: 2 }, { at: 6, value: 1, count: 1 }, { at: 8, value: 1, count: 1 }]);
  });
});
