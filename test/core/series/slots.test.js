import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as assert from '../../assert.node.js';

import { findSlots } from '@jarenjs/core/series';

const iv = (start, end) => ({ start, end });
const pairs = (list) => list.map((i) => [i.start, i.end]);

const MINUTE = 60000;
const HOUR = 3600000;

describe('findSlots', () => {
  it('should fill a window back to back when no step is given', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(0, 180)], { duration: 60 })),
      [[0, 60], [60, 120], [120, 180]]);
  });

  it('should yield exactly one slot in a window one duration wide', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(0, 60)], { duration: 60 })), [[0, 60]]);
  });

  it('should yield nothing in a window one millisecond short', () => {
    assert.deepStrictEqual(findSlots([iv(0, 59)], { duration: 60 }), []);
  });

  it('should overlap slots when the step is shorter than the duration', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(0, 90)], { duration: 60, step: 30 })),
      [[0, 60], [30, 90]]);
  });

  it('should leave the tail of a window unused when the step overshoots', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(0, 100)], { duration: 30, step: 40 })),
      [[0, 30], [40, 70]]);
  });

  it('should walk every availability window from its own start', () => {
    assert.deepStrictEqual(
      pairs(findSlots([iv(100, 220), iv(0, 60)], { duration: 60 })),
      [[0, 60], [100, 160], [160, 220]]);
  });

  it('should let a slot straddle the seam between touching windows', () => {
    // 09:00-13:00 plus 13:00-17:00 is continuous cover, so a meeting may
    // start at 12:30 - which is exactly why merge joins touching spans
    assert.deepStrictEqual(
      pairs(findSlots([iv(0, 2 * HOUR), iv(2 * HOUR, 4 * HOUR)],
        { duration: HOUR, step: 90 * MINUTE })),
      [[0, HOUR], [90 * MINUTE, 150 * MINUTE], [180 * MINUTE, 240 * MINUTE]]);
  });

  it('should take a fixed ISO 8601 duration wherever it takes milliseconds', () => {
    assert.deepStrictEqual(
      pairs(findSlots([iv(0, 3 * HOUR)], { duration: 'PT1H', step: 'PT30M' })),
      [[0, 60 * MINUTE], [30 * MINUTE, 90 * MINUTE], [60 * MINUTE, 120 * MINUTE],
        [90 * MINUTE, 150 * MINUTE], [120 * MINUTE, 180 * MINUTE]]);
  });

  it('should refuse a calendar duration rather than approximating one', () => {
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: 'P1M' }),
      /calendar duration and has no fixed width/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: HOUR, step: 'P1Y' }),
      /calendar duration and has no fixed width/);
  });

  it('should refuse a duration or step that is not a positive width', () => {
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: 0 }), /positive number of milliseconds/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: -60 }), /positive number of milliseconds/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: Infinity }), /positive number of milliseconds/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: HOUR, step: 0 }), /step is a positive/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: 'PT0S' }), /positive number of milliseconds/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: 'an hour' }), /not an ISO 8601 duration/);
    assert.throws(() => findSlots([iv(0, HOUR)], { duration: null }), /positive number of milliseconds/);
    assert.throws(() => findSlots([iv(0, HOUR)], null), /a slot spec is an object with a duration/);
  });

  it('should have nowhere to put a slot with no availability', () => {
    assert.deepStrictEqual(findSlots([], { duration: 60 }), []);
  });

  it('should place slots over negative epochs the same way', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(-120, 0)], { duration: 60 })),
      [[-120, -60], [-60, 0]]);
  });

  it('should preserve fractional widths and negative fractional epochs', () => {
    assert.deepStrictEqual(pairs(findSlots([iv(0.1, 0.6)], { duration: 0.2, step: 0.25 })),
      [[0.1, 0.30000000000000004], [0.35, 0.55]]);
    assert.deepStrictEqual(pairs(findSlots([iv(-0.75, 0.25)], { duration: 0.25, step: 0.5 })),
      [[-0.75, -0.5], [-0.25, 0]]);
  });

  it('should refuse a duration that rounds to an empty slot', () => {
    assert.throws(() => findSlots([iv(1e16, 1e16 + 4)], { duration: 1, step: 2 }),
      /duration must advance the slot start/);
    assert.throws(() => findSlots([iv(-1e16, -1e16 + 4)], { duration: 1, step: 2 }),
      /duration must advance the slot start/);
  });

  it('should keep the actual end inside availability when subtraction rounds', () => {
    assert.deepStrictEqual(findSlots([iv(1e16, 1e16 + 2)], { duration: 3, step: 4 }), []);
  });

  it('should refuse a step that cannot advance at the window precision', () => {
    // A bounded child makes a non-advancing loop fail without hanging the suite.
    const source = `
      import assert from 'node:assert/strict';
      import { findSlots } from ${JSON.stringify(import.meta.resolve('@jarenjs/core/series'))};
      for (const start of [1e16, -1e16])
        assert.throws(() => findSlots([{ start, end: start + 4 }], { duration: 2, step: 1 }),
          /step must advance the slot start/);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 2000 });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('should put every slot inside availability, at the promised spacing', () => {
    // an independent count: a window of length L fits floor((L - d)/step) + 1
    const windows = [iv(0, 1000), iv(2000, 2300), iv(2300, 2400)];
    const duration = 120;
    const step = 70;
    const slots = findSlots(windows, { duration, step });
    const merged = [iv(0, 1000), iv(2000, 2400)];
    let expected = 0;
    for (const w of merged)
      expected += Math.floor((w.end - w.start - duration) / step) + 1;
    assert.strictEqual(slots.length, expected);
    for (const slot of slots) {
      assert.strictEqual(slot.end - slot.start, duration);
      assert.isTrue(merged.some((w) => slot.start >= w.start && slot.end <= w.end),
        `slot ${slot.start} escaped availability`);
    }
    for (let i = 1; i < slots.length; i++)
      assert.isTrue(slots[i].start > slots[i - 1].start, 'slots ascend');
  });
});
