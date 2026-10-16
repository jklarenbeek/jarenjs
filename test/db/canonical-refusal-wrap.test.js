//@ts-check
/**
 * @file A canonicalization refusal carries a `JO` code, yet the store's
 * wrappers keep answering the code they promise for it: a lifecycle that
 * wraps every uncoded failure under its own code (a backup's `JD2078`)
 * wraps this one too, with the refusal, its code and `dataPath` as the
 * `cause`; a wrapper that passes a host's `TypeError` through passes it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, wrapDriverError } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { canonicalizeJson, JsonCanonicalizeError } from '@jarenjs/json/canonical';
import { TransactionFailure, connectionLost } from '../../packages/db/src/errors.js';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: { notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } } } },
};

/** The refusal `canonicalizeJson({ a: NaN })` throws. @returns {any} */
function refusal() {
  try { canonicalizeJson({ a: NaN }); }
  catch (error) { return error; }
  throw new Error('canonicalizeJson accepted NaN');
}

/** The cause is the refusal itself, its code and place intact. @param {any} error */
function causedByRefusal(error) {
  assert.ok(error.cause instanceof JsonCanonicalizeError);
  assert.deepStrictEqual([error.cause.code, error.cause.dataPath], ['JO2003', '/a']);
}

describe('a canonicalization refusal through the store\'s wrappers', () => {
  it('a backup whose onProgress throws one rejects JD2078, the refusal as cause', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: source.dbPath });
      try {
        for (let i = 0; i < 40; i++) await store.collection('notes').insert({ id: `n${i}`, body: 'x'.repeat(400) });
        await assert.rejects(store.backupTo(target.dbPath, { rate: 4, onProgress: () => canonicalizeJson({ a: NaN }) }),
          (/** @type {any} */ error) => {
            assert.deepStrictEqual([error.name, error.code, error.class, error.retryable],
              ['DbRuntimeError', 'JD2078', 'error', false]);
            assert.strictEqual(error.message, 'JD2078: the backup failed: NaN is not a JSON number at /a');
            causedByRefusal(error);
            return true;
          });
      }
      finally { await store.close(); }
    }
    finally { source.cleanup(); target.cleanup(); }
  });

  it('wrapDriverError wraps it under the lifecycle code when it wraps every failure, and passes it otherwise', () => {
    const always = wrapDriverError(refusal(), { code: 'JD2078', reason: 'the backup failed', always: true });
    assert.deepStrictEqual([always.name, always.code], ['DbRuntimeError', 'JD2078']);
    causedByRefusal(always);
    const generic = wrapDriverError(refusal(), { always: true });
    assert.deepStrictEqual([generic.name, generic.code], ['DbRuntimeError', 'JD2005']);
    causedByRefusal(generic);
    const own = refusal();
    assert.strictEqual(wrapDriverError(own), own);
  });

  it('a transaction failure led by one takes no code from it', () => {
    const failure = new TransactionFailure(refusal(), new Error('rollback failed'));
    assert.strictEqual(wrapDriverError(failure, { always: false }), failure);
    assert.strictEqual(Object.hasOwn(failure, 'code'), false);
    const always = new TransactionFailure(refusal(), new Error('rollback failed'));
    wrapDriverError(always, { code: 'JD2078', reason: 'the backup failed', always: true });
    assert.strictEqual(/** @type {any} */ (always).code, 'JD2078');
  });

  it('connectionLost never hands one back as the lost connection', () => {
    const lost = connectionLost(refusal(), { outcomeAtStake: false });
    assert.deepStrictEqual([lost.name, lost.code, lost.class, lost.retryable], ['DbRuntimeError', 'JD2087', 'connection', true]);
    causedByRefusal(lost);
  });
});
