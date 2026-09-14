/** Public installed composition: authenticated transport around the Store's structural cursor. */
import assert from 'node:assert/strict';
import { sealContinuation, openContinuation } from '@jarenjs/contract/continuation-node';
import { openStore } from '@jarenjs/db';

export async function qualifyContinuation() {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const store = await openStore({ $model: '0.1', entities: { Item: { schema: {
    type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
      age: { type: 'integer', 'x-entity': { index: true } } },
  } } } }, { driver });
  try {
    const items = store.entity('Item');
    for (const row of [{ id: 'a', age: 20 }, { id: 'b', age: 20 }, { id: 'c', age: 30 }]) await items.create(row);
    const spec = { orderBy: '$it.age' };
    const first = await items.page(spec, { limit: 1 });
    const key = new Uint8Array(32).fill(3);
    const common = { scope: { tenant: 'synthetic' }, query: 'items:age:v1', order: first.continuation.order, now: 1000 };
    const token = sealContinuation(first.continuation, { ...common, keyId: 'k1', key, expiresAt: 2000 });
    const after = openContinuation(token, { ...common, getKey: () => key });
    const next = await items.page(spec, { limit: 2, after });
    assert.deepEqual([...first.items, ...next.items].map(row => row.id), ['a', 'b', 'c']);
    assert.equal(next.hasMore, false);
    await assert.rejects(items.page({ orderBy: '$it.id' }, { limit: 1, after }), { code: 'JD0035' });
  } finally { await store.close(); }
}
