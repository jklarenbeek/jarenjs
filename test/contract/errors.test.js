//@ts-check
/**
 * @file The error surface: every code in `CONTRACT_CODES` has a one-line
 * meaning, the populated ranges are exactly the compile codes
 * `JC0001–JC0017`, the projection codes `JC0060`–`JC0061`, the host codes
 * `JC1001–JC1008`, the http codes `JC2001–JC2015`, the client codes
 * `JC2050–JC2058` and the port/local codes `JC2070–JC2074`, and every
 * class keeps its contract — the
 * coded-error contract for compile/runtime (composed message, own
 * fields, `hasOwn` cause), a coded `TypeError` for host errors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { CONTRACT_CODES, ContractCompileError, ContractRuntimeError, ContractHostError } from '@jarenjs/contract';

const range = (/** @type {number} */ from, /** @type {number} */ to) => Array.from({ length: to - from + 1 }, (_, i) => `JC${String(from + i).padStart(4, '0')}`);

describe('contract errors — the code table', () => {
  it('lists the compile, projection, host, http, client and port/local codes with one-line meanings, frozen', () => {
    const codes = Object.keys(CONTRACT_CODES);
    assert.deepStrictEqual(codes, [...range(1, 20), ...range(60, 61), ...range(1001, 1010), ...range(2001, 2015), ...range(2050, 2058), ...range(2070, 2074), ...range(2090, 2095)]);
    for (const code of codes) {
      const meaning = CONTRACT_CODES[/** @type {keyof typeof CONTRACT_CODES} */ (code)];
      assert.strictEqual(typeof meaning, 'string', code);
      assert.ok(meaning.length > 0 && !meaning.includes('\n'), code);
    }
    assert.strictEqual(Object.isFrozen(CONTRACT_CODES), true);
  });
});

describe('contract errors — ContractCompileError', () => {
  it('composes the coded message and carries code, reason, docPath', () => {
    const err = new ContractCompileError('JC0008', 'http.path is not a valid template', '/operations/a/http/path');
    assert.strictEqual(err.name, 'ContractCompileError');
    assert.strictEqual(err.code, 'JC0008');
    assert.strictEqual(err.reason, 'http.path is not a valid template');
    assert.strictEqual(err.docPath, '/operations/a/http/path');
    assert.strictEqual(err.message, 'JC0008: http.path is not a valid template at /operations/a/http/path');
    assert.strictEqual(Object.hasOwn(err, 'cause'), false);
    assert.ok(err instanceof Error);
  });

  it('renders the root pointer and keeps a cause only when given', () => {
    const cause = new Error('inner');
    const root = new ContractCompileError('JC0001', 'not an object', '');
    assert.strictEqual(root.message, "JC0001: not an object at ''");
    const withCause = new ContractCompileError('JC0007', 'unresolved', '/x', cause);
    assert.strictEqual(withCause.cause, cause);
    const noLocation = new ContractCompileError('JC0001', 'why');
    assert.strictEqual(noLocation.docPath, undefined);
    assert.strictEqual(noLocation.message, 'JC0001: why');
  });
});

describe('contract errors — ContractRuntimeError', () => {
  it('carries code, msgid, params, status and retryable, and no docPath', () => {
    const err = new ContractRuntimeError('JC2003', 'the request body exceeds the declared limit', {
      msgid: 'contract/body-too-large', params: { limit: 1024 }, status: 413, retryable: false,
    });
    assert.strictEqual(err.name, 'ContractRuntimeError');
    assert.strictEqual(err.code, 'JC2003');
    assert.strictEqual(err.msgid, 'contract/body-too-large');
    assert.deepStrictEqual(err.params, { limit: 1024 });
    assert.strictEqual(err.status, 413);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.docPath, undefined);
    assert.strictEqual(err.message, 'JC2003: the request body exceeds the declared limit');
    assert.strictEqual(Object.hasOwn(err, 'cause'), false);
  });

  it('defaults params to {} and installs an own cause exactly when the key is present', () => {
    const bare = new ContractRuntimeError('JC2001', 'why', { msgid: 'contract/x' });
    assert.deepStrictEqual(bare.params, {});
    assert.strictEqual(bare.status, undefined);
    assert.strictEqual(bare.retryable, undefined);
    const withUndefinedCause = new ContractRuntimeError('JC2001', 'why', { msgid: 'contract/x', cause: undefined });
    assert.strictEqual(Object.hasOwn(withUndefinedCause, 'cause'), true);
    assert.strictEqual(withUndefinedCause.cause, undefined);
    const thrown = new Error('host');
    assert.strictEqual(new ContractRuntimeError('JC2001', 'why', { msgid: 'contract/x', cause: thrown }).cause, thrown);
  });
});

describe('contract errors — ContractHostError', () => {
  it('is a TypeError with a code, a reason and the composed message', () => {
    const err = new ContractHostError('JC1003', 'no ledger');
    assert.ok(err instanceof TypeError);
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'ContractHostError');
    assert.strictEqual(err.code, 'JC1003');
    assert.strictEqual(err.reason, 'no ledger');
    assert.strictEqual(err.message, 'JC1003: no ledger');
    assert.strictEqual(Object.hasOwn(err, 'cause'), false);
    assert.strictEqual(Object.hasOwn(err, 'docPath'), false);
  });
});
