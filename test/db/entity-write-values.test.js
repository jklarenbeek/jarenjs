//@ts-check
/**
 * @file What an entity write takes as its document: `create()`, `add()` and
 * `update()` accept an object and refuse anything else `JD2003`, as `put()`
 * does. A string, an array, a number, `null` or `undefined` is never a
 * document: on an entity whose key the database allocates it used to be
 * spread into one (`create('abc')` stored `{ "0": "a", "1": "b", "2": "c" }`),
 * and `create(undefined)` stored an empty row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = { $model: '0.1', entities: { Log: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, msg: { type: 'string' } } } } } };

/** @param {(store: any) => Promise<void>} body */
async function withStore(body) {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  try { await body(store); }
  finally { await store.close(); }
}

const rows = async (/** @type {any} */ store) => {
  const out = [];
  for (let id = 1; id <= 10; id++) {
    const row = await store.entity('Log').asNoTracking().get(id);
    if (row !== undefined) out.push(row);
  }
  return out;
};

describe('entity writes take a document', () => {
  const notDocuments = [['a string', 'abc'], ['an array', [1, 2]], ['a number', 5], ['a boolean', true], ['null', null], ['undefined', undefined]];

  it('create() and add() refuse what is not an object, and store nothing', async () => {
    await withStore(async (store) => {
      for (const [what, value] of notDocuments) {
        await assert.rejects(async () => store.entity('Log').create(value),
          { code: 'JD2003', message: /^JD2003: create\(\) takes an entity document/ }, `create(${what})`);
        await assert.rejects(async () => store.entity('Log').add(value),
          { code: 'JD2003', message: /^JD2003: add\(\) takes an entity document/ }, `add(${what})`);
      }
      await store.saveChanges();
      assert.deepEqual(await rows(store), []);
      assert.deepEqual(await store.entity('Log').create({ msg: 'ok' }), { id: 1, msg: 'ok' });
    });
  });

  it('update() refuses changes that are not an object, and writes nothing', async () => {
    await withStore(async (store) => {
      await store.entity('Log').create({ msg: 'ok' });
      for (const [what, value] of notDocuments) {
        await assert.rejects(async () => store.entity('Log').update(1, value),
          { code: 'JD2003', message: /^JD2003: update\(\) takes an object of the members to change/ }, `update(${what})`);
      }
      assert.deepEqual(await rows(store), [{ id: 1, msg: 'ok' }]);
      assert.deepEqual(await store.entity('Log').update(1, { msg: 'changed' }), { id: 1, msg: 'changed' });
    });
  });
});
