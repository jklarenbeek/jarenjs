//@ts-check
/**
 * @file The suite's one backoff (`@jarenjs/core/retry`): the `equal`
 * policy is equal jitter — `cap × (½ + ½·random)`, never under half the
 * capped delay — and it is exactly the durable job queue's retry delay,
 * which used to keep its own copy of the formula. The same seeded draw
 * gives the same delays through either spelling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '@jarenjs/core/retry';
import { mulberry32 } from '@jarenjs/core/random';

describe("backoffDelay's equal-jitter policy", () => {
  it('is cap × (½ + ½·random), capped at maxMs, and full jitter stays the default', () => {
    for (const random of [0, 0.25, 0.5, 0.999]) {
      for (const attempt of [1, 2, 3, 8, 20]) {
        const cap = Math.min(4000, 1000 * 2 ** (attempt - 1));
        assert.equal(backoffDelay({ policy: 'equal', baseMs: 1000, maxMs: 4000, random: () => random }, attempt),
          cap * (0.5 + 0.5 * random));
        assert.equal(backoffDelay({ baseMs: 1000, maxMs: 4000, random: () => random }, attempt), cap * random,
          'strict (full jitter) is unchanged');
      }
    }
  });

  it("yields the job queue's former delay sequence exactly, for a seeded draw", () => {
    // the formula jobs.js carried before it called backoffDelay
    const former = (/** @type {number} */ attempts, /** @type {() => number} */ random, base = 1000, cap = 3_600_000) =>
      Math.round(Math.min(cap, base * 2 ** (attempts - 1)) * (0.5 + random() / 2));
    const a = mulberry32(0x5eed);
    const b = mulberry32(0x5eed);
    for (let attempts = 1; attempts <= 40; attempts++) {
      assert.equal(Math.round(backoffDelay({ policy: 'equal', baseMs: 1000, maxMs: 3_600_000, random: b }, attempts)),
        former(attempts, a), `attempt ${attempts}`);
    }
  });
});
