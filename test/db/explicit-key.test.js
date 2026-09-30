//@ts-check
/**
 * @file On a caller-keyed collection the document's key is THE key
 * (MODEL-FORMAT §6). `put(doc, key)` whose explicit key names another
 * key than the document carries is `JD2002`: it used to answer the
 * document's key and write under it (the explicit one found nothing),
 * while journal capture read its before-image under the explicit key —
 * so the two capture modes described one write two ways. An explicit
 * key that agrees (in any spelling that names the same key) still
 * writes; an allocated collection's `put(doc, key)` is unchanged.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const KEYED = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: {}, v: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

describe('an explicit key on a caller-keyed collection', () => {
  it('that disagrees with the document is JD2002, writes nothing, and no capture mode records it', async () => {
    for (const mode of ['session', 'journal']) {
      const store = await openStore(KEYED, { driver: nodeDriver(), capture: { mode } });
      /** @type {any[]} */
      const records = [];
      store.observe((record) => records.push(record));
      const docs = store.collection('docs');
      await assert.rejects(docs.put({ id: 'a', v: 1 }, 'b'),
        (/** @type {any} */ error) => error.code === 'JD2002'
          && /the key "b" disagrees with the document's key "a" at '\/id'/.test(error.message));
      assert.strictEqual(await docs.get('a'), undefined);
      assert.strictEqual(await docs.get('b'), undefined);
      assert.deepStrictEqual(records, [], `${mode}: nothing was recorded`);
      await store.close();
    }
  });

  it('that agrees still writes — and both capture modes describe it alike', async () => {
    /** @type {Record<string, string[][]>} */
    const seen = {};
    for (const mode of ['session', 'journal']) {
      const store = await openStore(KEYED, { driver: nodeDriver(), capture: { mode } });
      /** @type {any[]} */
      const records = [];
      store.observe((record) => records.push(record));
      const docs = store.collection('docs');
      assert.strictEqual(await docs.put({ id: 'a', v: 1 }, 'a'), 'a');
      assert.strictEqual(await docs.put({ id: 'a', v: 2 }, 'a'), 'a');
      // a number and its canonical text name the same key on a TEXT column
      assert.strictEqual(await docs.put({ id: 7, v: 1 }, '7'), 7);
      assert.strictEqual(await docs.put({ id: 7, v: 2 }, 7), 7);
      seen[mode] = records.map((record) => record.patch.map((/** @type {any} */ op) => `${op.op} ${op.path}`));
      await store.close();
    }
    assert.deepStrictEqual(seen.journal, seen.session);
  });

  it("an allocated collection's put(doc, key) still writes under the key it is given", async () => {
    const store = await openStore({
      $model: '0.1',
      collections: { notes: { schema: { type: 'object', properties: { text: { type: 'string' } } }, key: null, identity: 'uuid', indexes: [] } },
    }, { driver: nodeDriver() });
    const notes = store.collection('notes');
    const key = await notes.insert({ text: 'first' });
    assert.strictEqual(await notes.put({ text: 'second' }, key), key);
    assert.deepStrictEqual(await notes.get(key), { text: 'second' });
    await store.close();
  });
});
