//@ts-check
/**
 * @file `createMemoryLedger` under the shared ledger contract, plus the
 * proof that the contract is not vacuous: a ledger whose generation
 * fence is removed FAILS the fence case, and a ledger that spells the
 * legacy id fails the id case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { ledgerContract, cases } from './ledger-contract.js';

ledgerContract('createMemoryLedger', (options) => ({ ledger: createMemoryLedger(options), staleCode: 'JC1011' }));

/** The tuple a versioned id names, read back from the id. */
const tupleOf = (/** @type {any} */ ref) => /** @type {[string, string, string]} */ (JSON.parse(String(ref.id).slice(2)));

describe('the harness holds the fence', () => {
  it('a ledger that settles by id alone fails the fence case', async () => {
    /** @type {import('./ledger-contract.js').LedgerFactory} */
    const unfenced = (options) => {
      const inner = createMemoryLedger(options);
      // the fence removed: settle whatever LIVE record the ref's id
      // names, whatever generation the ref carries
      const live = (/** @type {any} */ ref, /** @type {number | undefined} */ now) => {
        const [op, scope, key] = tupleOf(ref);
        const record = /** @type {any} */ (inner.lookup({ op, scope, key, now }));
        if (record === null) throw Object.assign(new Error('no record'), { code: 'JC1011' });
        return { id: record.id, generation: record.generation };
      };
      return {
        staleCode: 'JC1011',
        ledger: {
          claim: (/** @type {any} */ c) => inner.claim(c),
          lookup: (/** @type {any} */ k) => inner.lookup(k),
          sweep: (/** @type {any} */ now) => inner.sweep(now),
          commit: (/** @type {any} */ ref, /** @type {any} */ response, /** @type {any} */ now) => inner.commit(live(ref, now), response, now),
          fail: (/** @type {any} */ ref, /** @type {any} */ retryable, /** @type {any} */ response, /** @type {any} */ now) => inner.fail(live(ref, now), retryable, response, now),
        },
      };
    };
    await assert.rejects(() => cases.fence(unfenced), (/** @type {any} */ err) => err.name === 'AssertionError');
  });

  it('a ledger that spells the legacy id fails the id case', async () => {
    /** @type {import('./ledger-contract.js').LedgerFactory} */
    const legacy = (options) => {
      const inner = createMemoryLedger(options);
      const spell = (/** @type {any} */ c) => ({ op: `${c.op}|${c.scope}|${c.key}`, scope: '', key: '-' });
      return {
        staleCode: 'JC1011',
        ledger: {
          claim: (/** @type {any} */ c) => {
            const out = /** @type {any} */ (inner.claim({ ...spell(c), hash: c.hash, now: c.now }));
            return out.state === 'new' ? { state: 'new', ref: { id: `${c.op}|${c.scope}|${c.key}`, generation: out.ref.generation } } : out;
          },
          lookup: (/** @type {any} */ k) => inner.lookup({ ...spell(k), now: k.now }),
          sweep: (/** @type {any} */ now) => inner.sweep(now),
          commit: () => {},
          fail: () => {},
        },
      };
    };
    await assert.rejects(() => cases.ids(legacy), (/** @type {any} */ err) => err.name === 'AssertionError');
  });
});
