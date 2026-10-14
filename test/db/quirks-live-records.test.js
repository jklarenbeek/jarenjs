//@ts-check
/**
 * @file A capture record is shared by every observer and every live
 * registration of the commit that wrote it. A live result is the
 * registration's own value: an observer that rewrites the record it was
 * handed must not rewrite what a registration serves, and two
 * registrations must not serve one object.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    r: {
      schema: { type: 'object', properties: { id: { type: 'string' }, v: { type: 'integer' } } },
      key: '/id',
    },
  },
};
const ROWS = [{ $for: { r: '$[*]' }, $return: '$r' }];
const WINDOW = [{ $subsequence: [{ $for: { r: '$[*]' }, $orderby: [{ $key: '$r.id' }], $return: '$r' }, 0, 5] }];

describe('a live result is not the capture record it was built from', () => {
  it('an observer that rewrites its record leaves every registration and the store as written', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const documents = store.collection('r');
    const rows = await documents.live(ROWS);
    const again = await documents.live(ROWS);
    const window = await documents.live(WINDOW);
    assert.strictEqual(rows.mode.strategy, 'rows');
    assert.strictEqual(window.mode.strategy, 'window');
    store.observe((record) => {
      for (const operation of record.patch) {
        if (operation.value !== null && typeof operation.value === 'object') operation.value.v = 999;
      }
    });
    await documents.insert({ id: 'a', v: 1 });
    assert.deepStrictEqual(rows.result.rows, [{ id: 'a', v: 1 }]);
    assert.deepStrictEqual(again.result.rows, [{ id: 'a', v: 1 }]);
    assert.deepStrictEqual(window.result.rows, [{ id: 'a', v: 1 }]);
    assert.deepStrictEqual(await documents.execute(ROWS), [{ id: 'a', v: 1 }]);
    assert.notStrictEqual(rows.result.rows[0], again.result.rows[0]);
    assert.notStrictEqual(rows.result.rows[0], window.result.rows[0]);
    // a later write to the same row shares no object with the first either
    await documents.put({ id: 'a', v: 2 }, 'a');
    assert.deepStrictEqual(rows.result.rows, [{ id: 'a', v: 2 }]);
    await store.close();
  });

  it('a registration whose filter rejects the row pays no copy of it', async () => {
    // 60 views that reject every insert, and a document whose member is a
    // large array: a copy per view per insert is a visible multiple of the
    // write itself, no copy at all is a small fraction
    const model = { $model: '0.1', collections: { big: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' }, pad: { type: 'array' } } },
      key: '/id' } } };
    const inserts = async (views) => {
      const store = await openStore(model, { driver: nodeDriver(), capture: true });
      const big = store.collection('big');
      for (let i = 0; i < views; i++) {
        await big.live([{ $for: { s: '$[*]' }, $where: { $eq: ['$s.n', -1] }, $return: '$s' }]);
      }
      const pad = Array.from({ length: 300_000 }, (_, i) => i);
      const started = process.hrtime.bigint();
      for (let i = 0; i < 4; i++) await big.insert({ id: `k${i}`, n: i, pad });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      await store.close();
      return elapsed;
    };
    // the two are timed in turn, the fastest of five each, so a load spike
    // that lasts a while slows both and not one
    let alone = Infinity;
    let watched = Infinity;
    for (let round = 0; round < 5; round++) {
      alone = Math.min(alone, await inserts(0));
      watched = Math.min(watched, await inserts(60));
    }
    assert.ok(watched < alone * 3 + 20,
      `60 rejecting views cost ${watched.toFixed(0)} ms beside ${alone.toFixed(0)} ms for the writes alone`);
  });
});
