//@ts-check
/**
 * @file `isStackExhausted` (`@jarenjs/core/object`) tells this host's own
 * refusal of a call its stack cannot hold from every other thrown value, so
 * a recursion can raise a coded refusal in its place. The refusal is read
 * from the host: its class and its text are no part of these tests, which
 * provoke it and never spell it, and no test depends on how deep the
 * host's stack is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isPastLongestString, isStackExhausted } from '@jarenjs/core/object';
import { CodedError } from '@jarenjs/core/errors';
import { childReport } from '../lib/child-report.js';

/** What the host throws for a recursion without end. @param {() => number} recurse @returns {any} */
const refusalOf = (recurse) => { try { recurse(); } catch (error) { return error; } return undefined; };
/** @returns {number} */
const descend = () => 1 + descend();

describe('isStackExhausted', () => {
  it('takes the host\'s refusal of a full call stack, whichever recursion raised it', () => {
    const host = refusalOf(descend);
    assert.ok(host instanceof Error);
    assert.equal(isStackExhausted(host), true);
    /** @type {(n: number) => number} */
    const even = (n) => 1 + odd(n + 1);
    /** @type {(n: number) => number} */
    const odd = (n) => 1 + even(n + 1);
    assert.equal(isStackExhausted(refusalOf(() => even(0))), true);
    // the reading is kept: a second question provokes nothing and answers alike
    assert.equal(isStackExhausted(host), true);
  });

  it('takes no other error, though it be of the same class or carry the same text', () => {
    const host = refusalOf(descend);
    const sameClass = refusalOf(() => new Array(-1).length);
    assert.equal(sameClass.constructor, RangeError);
    assert.equal(isStackExhausted(sameClass), false);
    assert.equal(isStackExhausted(new TypeError(host.message)), false);
    assert.equal(isStackExhausted(new Error(host.message)), false);
    // a coded error is never the host's own refusal
    assert.equal(isStackExhausted(new CodedError('SchemaRuntimeError', 'JK2001', host.message)), false);
    for (const value of [host.message, { message: host.message }, null, undefined, 0])
      assert.equal(isStackExhausted(value), false);
  });

  it('is told from the refusal of a string past the host\'s longest, both ways', () => {
    const tooLong = refusalOf(() => { let text = 'x'; for (let i = 0; i < 40; i++) text += text; return text.length; });
    assert.equal(isPastLongestString(tooLong), true);
    assert.equal(isStackExhausted(tooLong), false);
    assert.equal(isPastLongestString(refusalOf(descend)), false);
  });

  it('reads the refusal of the host it runs on: a stack of another size', () => {
    const fixture = fileURLToPath(new URL('./fixtures/stack-exhausted.mjs', import.meta.url));
    for (const stack of [500, 2000]) {
      const run = spawnSync(process.execPath, [`--stack-size=${stack}`, fixture],
        { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, FORCE_COLOR: '0' } });
      const report = childReport(run);
      assert.deepEqual(report.failures, [], `--stack-size=${stack}`);
      assert.equal(run.status, 0);
    }
  });
});
