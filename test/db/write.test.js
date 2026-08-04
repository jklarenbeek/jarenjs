//@ts-check
/**
 * @file Validated writes (D10): the injected `compileSchema` hook in
 * both its result shapes (`{ valid, errors }` and bare boolean),
 * `JD2003` before any SQL reaches the database, the declared
 * `capabilities.validated` flag, and the runtime error taxonomy —
 * duplicate key (`JD2001`) versus every other database rejection
 * (`JD2005`, wrapped with the original as `cause`), and `JD2006` for
 * patching the absent.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string', minLength: 3 },
          age: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      key: '/id',
      indexes: [{ name: 'by_email', path: '$.email', unique: true }],
    },
    loose: { schema: { type: 'object' }, key: null, identity: 'uuid' },
  },
};

/**
 * The rich hook shape: with `collectErrors`, a compiled Jaren validator
 * already returns `{ valid, errors }` — the hook IS `compile`.
 */
function richCompileSchema() {
  const validator = new JarenValidator({ collectErrors: true, skipErrors: false });
  return (schema) => validator.compile(schema);
}

describe('the injected validation hook (D10)', () => {
  it('rejects an invalid insert with JD2003 carrying the findings, before any SQL', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), compileSchema: richCompileSchema() });
    assert.strictEqual(store.capabilities.validated, true);
    const users = store.collection('users');
    await assert.rejects(
      () => users.insert({ id: 'u1', email: 'x', age: -1 }),
      (error) => {
        assert.strictEqual(error.code, 'JD2003');
        assert.strictEqual(error.collection, 'users');
        assert.ok(Array.isArray(error.errors) && error.errors.length > 0,
          'the hook findings ride on the error');
        return true;
      });
    assert.strictEqual(await users.get('u1'), undefined, 'nothing reached the database');
    await store.close();
  });

  it('put and patch validate the RESULT; a rejected patch leaves the stored document alone', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), compileSchema: richCompileSchema() });
    const users = store.collection('users');
    await users.insert({ id: 'u1', email: 'a@b.c', age: 30 });
    await assert.rejects(() => users.put({ id: 'u1', email: 'x' }),
      (e) => e.code === 'JD2003');
    await assert.rejects(
      () => users.patch('u1', [{ op: 'replace', path: '/age', value: -5 }]),
      (e) => e.code === 'JD2003');
    assert.deepStrictEqual(await users.get('u1'),
      { id: 'u1', email: 'a@b.c', age: 30 }, 'the stored document is untouched');
    await store.close();
  });

  it('a bare-boolean hook works; absence means validated: false', async () => {
    const booleanHook = (schema) => {
      const mustHaveText = schema === MODEL.collections.loose.schema;
      return (doc) => (mustHaveText ? typeof doc.text === 'string' : true);
    };
    const store = await openStore(MODEL,
      { driver: nodeDriver(), compileSchema: booleanHook });
    const loose = store.collection('loose');
    await assert.rejects(() => loose.insert({ nope: 1 }), (error) => {
      assert.strictEqual(error.code, 'JD2003');
      assert.strictEqual(error.errors, undefined, 'a bare false carries no findings');
      return true;
    });
    assert.strictEqual(typeof await loose.insert({ text: 'ok' }), 'string');
    await store.close();

    const unvalidated = await openStore(MODEL, { driver: nodeDriver() });
    assert.strictEqual(unvalidated.capabilities.validated, false);
    await unvalidated.collection('users').insert({ id: 'zz', email: 'x', age: -9 });
    assert.strictEqual((await unvalidated.collection('users').get('zz')).age, -9,
      'without a hook, writes are declaredly unvalidated');
    await unvalidated.close();
  });
});

describe('the runtime error taxonomy', () => {
  it('JD2001 is the key conflict; a unique-INDEX conflict is JD2005 with the cause', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.collection('users');
    await users.insert({ id: 'u1', email: 'a@b.c' });

    await assert.rejects(() => users.insert({ id: 'u1', email: 'z@b.c' }), (error) => {
      assert.strictEqual(error.code, 'JD2001');
      assert.strictEqual(error.key, 'u1');
      assert.strictEqual(error.collection, 'users');
      assert.ok(error.cause instanceof Error);
      return true;
    });

    await assert.rejects(() => users.insert({ id: 'u2', email: 'a@b.c' }), (error) => {
      assert.strictEqual(error.code, 'JD2005');
      assert.match(error.message, /UNIQUE constraint failed/);
      assert.ok(error.cause instanceof Error, 'the original database error is the cause');
      return true;
    });
    await store.close();
  });

  it('JD2006: patch on an absent key', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await assert.rejects(
      () => store.collection('users').patch('ghost', [{ op: 'add', path: '/age', value: 1 }]),
      (error) => {
        assert.strictEqual(error.code, 'JD2006');
        assert.strictEqual(error.key, 'ghost');
        return true;
      });
    await store.close();
  });

  it('a malformed patch document raises the json family error unchanged', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.collection('users');
    await users.insert({ id: 'u1', email: 'a@b.c' });
    await assert.rejects(
      () => users.patch('u1', [{ op: 'teleport', path: '/age' }]),
      (error) => {
        assert.match(String(error.code), /^JP/);
        return true;
      });
    await store.close();
  });
});
