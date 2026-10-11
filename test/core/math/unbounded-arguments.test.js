//@ts-check
/**
 * @file `Float64.fib` and `Float64.factorial` finish for an unbounded argument.
 * Both looped to `n` with a counter that stops advancing at 2**53 (and an
 * Infinity never arrives), so `factorial(Infinity)` - or `1e300!` typed into the
 * calculator - never returned. They run in a child process with a deadline so a
 * regression fails the test rather than freezing the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { Float64 } from '@jarenjs/core/math';

/** @param {string} expression @returns {string} */
function inChild(expression) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { Float64 } from '@jarenjs/core/math'; console.log(String(${expression}));`],
  { encoding: 'utf8', timeout: 5000, cwd: process.cwd() });
  assert.strictEqual(result.status, 0, `${expression} did not finish: ${result.stderr || result.signal}`);
  return result.stdout.trim();
}

describe('Float64.factorial / Float64.fib — unbounded arguments', () => {
  it('answers Infinity for a factorial past the largest double, however large the argument', () => {
    assert.strictEqual(inChild('Float64.factorial(Infinity)'), 'Infinity');
    assert.strictEqual(inChild('Float64.factorial(1e300)'), 'Infinity');
    assert.strictEqual(inChild('Float64.factorial(2 ** 53 + 2)'), 'Infinity');
  });

  it('answers Infinity for a Fibonacci number past the largest double', () => {
    assert.strictEqual(inChild('Float64.fib(Infinity)'), 'Infinity');
    assert.strictEqual(inChild('Float64.fib(1e300)'), 'Infinity');
  });

  it('keeps the exact boundaries', () => {
    assert.strictEqual(Float64.factorial(170), 7.257415615307994e306);
    assert.strictEqual(Float64.factorial(171), Infinity);
    assert.strictEqual(Float64.factorial(5), 120);
    assert.strictEqual(Float64.factorial(0), 1);
    assert.ok(Number.isNaN(Float64.factorial(-3)));
    assert.strictEqual(Float64.fib(10), 55);
    assert.strictEqual(Float64.fib(1476), 1.3069892237633987e308);
    assert.strictEqual(Float64.fib(1477), Infinity);
    assert.strictEqual(Float64.fib(0), 0);
  });
});
