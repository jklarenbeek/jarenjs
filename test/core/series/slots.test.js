import { describe, it } from 'node:test';
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
