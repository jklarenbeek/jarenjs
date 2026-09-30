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

describe('compat ranges — honoured beside a numeric version, npm\'s semantics', () => {
  it('a 1.4.0 client and a 1.9.0 server with compat [\'^1\'] negotiate; a 2.0.0 client does not', () => {
    assert.strictEqual(compatReason({ version: '1.4.0' }, { version: '1.9.0', compat: ['^1'] }), 'server-accepts');
    assert.strictEqual(compatReason({ version: '2.0.0' }, { version: '1.9.0', compat: ['^1'] }), null);
    assert.strictEqual(compatReason({ version: '1.9.0', compat: ['~1.4'] }, { version: '1.4.7' }), 'client-accepts');
  });

  it('caret keeps the left-most non-zero part, tilde keeps the minor, >= is a floor; a non-numeric version satisfies none', () => {
    const table = /** @type {[string, string, boolean][]} */ ([
      ['^1', '1.0.0', true], ['^1', '1.99.3', true], ['^1', '2.0.0', false], ['^1.2', '1.1.9', false], ['^1.2', '1.2', true],
      ['^0.3', '0.3.9', true], ['^0.3', '0.4.0', false], ['^0.0.3', '0.0.3', true], ['^0.0.3', '0.0.4', false], ['^0', '0.9.9', true],
      ['~1.4', '1.4.0', true], ['~1.4', '1.4.7', true], ['~1.4', '1.5.0', false], ['~1.4.2', '1.4.1', false],
      ['>=1.2.0', '1.2.0', true], ['>=1.2.0', '9', true], ['>=1.2.0', '1.1.9', false],
      ['^1', 'banana', false], ['^1', '1.0.0-rc.1', false],
    ]);
    for (const [range, version, expected] of table) {
      assert.strictEqual(compatReason({ version }, { version: '99.0.0', compat: [range] }) !== null, expected, `${range} ∋ ${version}`);
    }
  });

  it('a malformed range, or a range beside a version that is not numeric, is JC0015 at compile; exact entries keep working', () => {
    const doc = (/** @type {string | undefined} */ version, /** @type {string[]} */ compat) => ({
      $contract: '0.1', ...(version === undefined ? {} : { version }), compat, operations: { 'a.b': { kind: 'read', output: true } },
    });
    for (const [version, compat, at] of /** @type {[string | undefined, string[], string][]} */ ([
      ['1.9.0', ['^x'], '/compat/0'], ['1.9.0', ['1', '~1'], '/compat/1'], ['banana', ['^1'], '/compat/0'], [undefined, ['>=1'], '/compat/0'],
    ])) {
      assert.throws(() => compileContract(doc(version, compat)), (e) => e.code === 'JC0015' && e.docPath === at, JSON.stringify([version, compat]));
    }
    assert.doesNotThrow(() => compileContract(doc('banana', ['apple', '1.0'])), 'exact strings beside any version');
    assert.doesNotThrow(() => compileContract(doc('1.9.0', ['^1', '1.8.0'])));
  });
});
