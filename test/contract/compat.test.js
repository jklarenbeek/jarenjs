//@ts-check
/**
 * @file `isCompatible`/`compatReason` (CONTRACT-FORMAT.md §13): the one
 * implementation of the negotiation rule, callable on compiled
 * contracts, raw documents and well-known descriptions alike — the same
 * matrix `client.negotiate()` answers over the wire, proven here as the
 * pure function a server can call too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { isCompatible, compatReason } from '@jarenjs/contract/diff';

/** @param {{ id?: string, version?: string, compat?: string[] }} root */
const contractOf = (root) => compileContract({
  $contract: '0.1', ...root,
  operations: { ping: { kind: 'read', output: true, http: { method: 'GET', path: '/ping' } } },
});

describe('isCompatible / compatReason — the negotiation rule as a pure function', () => {
  it('same-version: equal versions, and two unversioned ends', () => {
    assert.strictEqual(compatReason(contractOf({ version: '5' }), contractOf({ version: '5' })), 'same-version');
    assert.strictEqual(compatReason(contractOf({}), contractOf({})), 'same-version');
    assert.strictEqual(isCompatible(contractOf({}), contractOf({})), true);
  });

  it("server-accepts: the server's compat names the client's version (checked before client-accepts)", () => {
    const client = contractOf({ version: '4', compat: ['5'] });
    const server = contractOf({ version: '5', compat: ['4', '3'] });
    assert.strictEqual(compatReason(client, server), 'server-accepts');
    assert.strictEqual(isCompatible(client, server), true);
  });

  it("client-accepts: the client's compat names the server's version", () => {
    assert.strictEqual(compatReason(contractOf({ version: '6', compat: ['5'] }), contractOf({ version: '5' })), 'client-accepts');
  });

  it('null: no rule holds — including an unversioned end against a versioned one', () => {
    assert.strictEqual(compatReason(contractOf({ version: '6', compat: ['4'] }), contractOf({ version: '5', compat: ['3'] })), null);
    assert.strictEqual(compatReason(contractOf({}), contractOf({ version: '5' })), null);
    assert.strictEqual(compatReason(contractOf({ version: '5' }), contractOf({})), null);
    assert.strictEqual(isCompatible(contractOf({ version: '6' }), contractOf({ version: '5' })), false);
  });

  it('reads documents and descriptions, not just compiled contracts, and tolerates junk members', () => {
    assert.strictEqual(isCompatible({ version: '5' }, { version: '5', compat: [] }), true);
    assert.strictEqual(compatReason({ version: '4' }, { version: '5', compat: ['4'] }), 'server-accepts');
    // a hostile description: non-string versions and compat entries are ignored, never compared loosely
    assert.strictEqual(compatReason({ version: /** @type {any} */ (5) }, { version: '5' }), null);
    assert.strictEqual(compatReason({ version: '5' }, { version: '4', compat: /** @type {any} */ ([5, '5']) }), 'server-accepts');
    assert.strictEqual(compatReason({ version: '5' }, { version: '4', compat: /** @type {any} */ ('5') }), null);
  });
});
