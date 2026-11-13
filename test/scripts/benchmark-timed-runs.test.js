/**
 * A timed suite is run in several processes and published as one output:
 * every figure the processes differ on is their median, everything else
 * must agree, and the record of how far they agreed travels with it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { joinMeasurements, measurementOf, mergeRuns, parseArgs } from '../../benchmark/website-data.js';

describe('the outputs of a timed suite\'s processes', () => {
  it('publish the median of each figure the processes differ on and keep what they agree on', () => {
    const run = (ns, date) => ({ date, node: 'v24', iterations: 20, tables: [{ title: 't', columns: ['a', 'b'], rows: [{ name: 'r', results: [ns, null] }] }] });
    const merged = mergeRuns([run(30, 'd1'), run(10, 'd2'), run(20, 'd3')]);
    assert.deepStrictEqual(merged, run(20, 'd1'));
  });

  it('matches rows a process sorted by its own timings by label, and sorts the merged rows again', () => {
    const merged = mergeRuns([
      { update: [{ label: 'x', ns: 1 }, { label: 'y', ns: 5 }] },
      { update: [{ label: 'y', ns: 2 }, { label: 'x', ns: 3 }] },
      { update: [{ label: 'x', ns: 4 }, { label: 'y', ns: 6 }] },
    ]);
    assert.deepStrictEqual(merged, { update: [{ label: 'x', ns: 3 }, { label: 'y', ns: 5 }] });
  });

  it('refuses outputs that disagree on anything but a figure or a run\'s own date', () => {
    assert.throws(() => mergeRuns([{ pass: 'a' }, { pass: 'b' }]), /\/pass: the runs disagree/);
    assert.throws(() => mergeRuns([{ a: 1 }, { b: 1 }]), /the runs carry different members/);
    assert.throws(() => mergeRuns([{ ns: 1 }, { ns: null }]), /\/ns: the runs disagree/);
    assert.throws(() => mergeRuns([{ rows: [{ label: 'x' }] }, { rows: [{ label: 'z' }] }]), /\/rows: the runs list different rows/);
  });
});

describe('a timed suite\'s measurement record', () => {
  const settled = (spread) => ({ method: 'settled', spread, settled: spread <= 1.15 });

  it('counts unsettled rows per process and spreads only over figures the processes differ on', () => {
    const outputs = [{ ns: 100, same: 5, iterations: 7 }, { ns: 110, same: 5, iterations: 9 }, { ns: 125, same: 5, iterations: 8 }];
    const logs = [[settled(1.02), settled(1.3)], [settled(1.05), settled(1.1)], [settled(1.01), settled(1.2)]];
    assert.deepStrictEqual(measurementOf(outputs, logs), {
      method: 'settled', processes: 3, rows: 2, unsettledRows: 2 / 3, worstRoundSpread: 1.3,
      figures: 1, processSpread: { median: 1.25, worst: 1.25 }, figuresOverSpread: 1,
    });
  });

  it('has no process spread for one process', () => {
    const row = { seq: 0, rounds: [1, 1.04], spread: 1.04, settled: true };
    assert.deepStrictEqual(measurementOf([{ ns: 1 }], [[row]]), {
      method: 'settled', processes: 1, rows: 1, unsettledRows: 0, worstRoundSpread: 1.04,
      figures: 0, processSpread: null, figuresOverSpread: 0,
    });
  });

  it('joins the records of a suite timed by two tools', () => {
    const a = { method: 'settled', processes: 3, rows: 4, unsettledRows: 1, worstRoundSpread: 1.2, figures: 2, processSpread: { median: 1.1, worst: 1.3 }, figuresOverSpread: 1 };
    const b = { method: 'settled', processes: 3, rows: 2, unsettledRows: 0, worstRoundSpread: 1.05, figures: 2, processSpread: { median: 1.3, worst: 1.4 }, figuresOverSpread: 1 };
    assert.deepStrictEqual(joinMeasurements(undefined, a), a);
    assert.deepStrictEqual(joinMeasurements(a, b), {
      method: 'settled', processes: 3, rows: 6, unsettledRows: 1, worstRoundSpread: 1.2,
      figures: 4, processSpread: { median: 1.2, worst: 1.4 }, figuresOverSpread: 2,
    });
  });
});

describe('the timed-run flags', () => {
  it('name the process count and the output directory', () => {
    const options = parseArgs(['node', 'website-data.js', '--processes', '2', '--out', '/tmp/x']);
    assert.deepStrictEqual([options.processes, options.out], [2, '/tmp/x']);
  });
});
