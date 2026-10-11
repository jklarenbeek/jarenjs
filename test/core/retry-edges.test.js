//@ts-check
/**
 * @file The retry primitives at their numeric edges: a wait longer than one
 * timer holds is slept in turns instead of firing at once (a long
 * `Retry-After` was cut to a millisecond), a negative or unbounded
 * `Retry-After` is no hint, and a zero base delay stays zero at any attempt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDelay, parseRetryAfter, sleep } from '@jarenjs/core/retry';

describe('sleep — past the longest single timer', () => {
  it('does not settle early when the delay exceeds 2^31 - 1 ms, and aborts cleanly', async () => {
    const controller = new AbortController();
    let settled = false;
    const waiting = sleep(2 ** 31 + 5, controller.signal).then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(settled, false);
    controller.abort();
    await waiting;
    assert.strictEqual(settled, true);
  });

  it('settles a short wait as before', async () => {
    const started = Date.now();
    await sleep(15);
    assert.ok(Date.now() - started >= 10);
  });
});

describe('parseRetryAfter — values that are no hint', () => {
  it('refuses a negative number of seconds instead of reading it as a date', () => {
    assert.strictEqual(parseRetryAfter('-5', { now: 0 }), undefined);
    assert.strictEqual(parseRetryAfter('-5', { dialect: 'milliseconds' }), undefined);
  });

  it('refuses a number too large to be a finite wait', () => {
    assert.strictEqual(parseRetryAfter('1e306'), undefined);
    assert.strictEqual(parseRetryAfter('1e306', { dialect: 'milliseconds' }), 1e306);
  });

  it('keeps seconds, milliseconds and dates', () => {
    assert.strictEqual(parseRetryAfter('120'), 120000);
    assert.strictEqual(parseRetryAfter('0'), 0);
    assert.strictEqual(parseRetryAfter('250', { dialect: 'milliseconds' }), 250);
    assert.strictEqual(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', { now: 4000 }), 6000);
  });
});

describe('backoffDelay — zero base', () => {
  it('stays zero at any attempt instead of 0 × Infinity', () => {
    assert.strictEqual(backoffDelay({ baseMs: 0, random: () => 0.5 }, 2000), 0);
    assert.strictEqual(backoffDelay({ baseMs: 0, policy: 'equal', random: () => 0.5 }, 5000), 0);
    assert.strictEqual(backoffDelay({ baseMs: 0, policy: 'contract-compat', random: () => 0 }, 3000), 0);
  });

  it('keeps the doubling and the cap', () => {
    assert.strictEqual(backoffDelay({ baseMs: 100, maxMs: 1000, random: () => 1 }, 3), 400);
    assert.strictEqual(backoffDelay({ baseMs: 100, maxMs: 1000, random: () => 1 }, 4000), 1000);
  });
});
