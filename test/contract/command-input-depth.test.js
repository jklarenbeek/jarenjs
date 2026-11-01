//@ts-check
/**
 * @file A command and a run page copy their input through the canonical
 * JSON copy (`cloneJson` of `@jarenjs/json/canonical`) before anything
 * reads it, so an input nested past that copy's bound, or holding a cycle,
 * is refused with its code before the authorization check runs: an input
 * nested 100,000 levels is `JsonCanonicalizeError` `JO2001`, a cyclic one
 * `JO2002` at the member closing the cycle. An input within the bound is
 * read as a frozen copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileContract } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { createRunPageHandler } from '@jarenjs/contract/app';

const contract = compileContract({ $contract: '0.1', operations: { 'item.put': {
  kind: 'command', input: { type: 'object' }, output: { type: 'object' }, http: { method: 'POST', path: '/put' },
} } });
/** `n` objects nested around `{}` under `a`. @param {number} n @returns {any} */
const nested = (n) => { let v = /** @type {any} */ ({}); for (let i = 0; i < n; i++) v = { a: v }; return v; };
const cyclic = () => { const value = /** @type {any} */ ({ a: 1 }); value.self = value; return value; };

/** A command and a run page whose authorization records what it read and refuses. */
const carriers = () => {
  /** @type {any[]} */
  const read = [];
  const authorize = (/** @type {any} */ value) => { read.push(value); return false; };
  const command = createCommand(contract.operations['item.put'], {
    repository: { execute: async (/** @type {any} */ _identity, /** @type {Function} */ run) => run({}) },
    identity: () => ({ op: 'item.put' }), authorize, handler: (/** @type {any} */ value) => value,
  });
  const pages = createRunPageHandler({ page: () => [], authorize });
  return { read, run: [(/** @type {any} */ value) => command.execute(value), (/** @type {any} */ value) => pages(value, {})] };
};

describe('a command and a run page refuse an input their copy cannot hold, before authorizing it', () => {
  it('refuses an input nested 100000 levels with JO2001', async () => {
    const { read, run } = carriers();
    for (const carrier of run) {
      await assert.rejects(() => carrier(nested(100000)), {
        name: 'JsonCanonicalizeError', code: 'JO2001', message: /^a value nested deeper than 1000 levels cannot be canonicalized at \/a\/a/,
      });
    }
    assert.equal(read.length, 0);
  });

  it('refuses a cyclic input with JO2002 at the member closing the cycle', async () => {
    const { read, run } = carriers();
    for (const carrier of run)
      await assert.rejects(() => carrier(cyclic()), { name: 'JsonCanonicalizeError', code: 'JO2002', message: 'a circular reference cannot be canonicalized at /self' });
    assert.equal(read.length, 0);
  });

  it('reads an input 1000 levels deep as a frozen copy', async () => {
    const { read, run } = carriers();
    const input = nested(999);
    assert.deepEqual(await run[0](input), { state: 'refused', reason: 'unauthorized', historic: false });
    await assert.rejects(() => run[1](input), { code: 'JC1008' });
    assert.equal(read.length, 2);
    for (const copy of read) {
      assert.notEqual(copy, input);
      assert.deepEqual(copy, input);
      let level = copy;
      for (let i = 0; i < 999; i++) level = level.a;
      assert.ok(Object.isFrozen(level));
    }
  });
});
