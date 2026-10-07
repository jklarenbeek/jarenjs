//@ts-check
/**
 * @file A document that names no entity root is not a live document
 * (LIVE-FORMAT §7): `store.live` refuses it with `JD0033`, the code
 * `store.execute` gives the same document, before any registration. A load
 * specification — `load({ include })`'s argument, which a `@jarenjs/linq`
 * `include()` chain hands over — is one such document; it used to be listed
 * as a re-running graph and was refused by a `TypeError`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';

const key = { 'x-entity': { key: true } };
const MODEL = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key },
    posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
  Post: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key }, score: { type: 'number' } } } },
} };
const NO_ENTITY_ROOT = /JD0033: store\.live takes an entity-root document/;

describe('a document with no entity root is not a live query', () => {
  it('a load specification is refused with JD0033, as store.execute refuses it, and nothing registers', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    try {
      const spec = { include: { posts: { orderBy: '$it.score', take: 2 } } };
      await assert.rejects(Promise.resolve().then(() => store.live(spec)), { code: 'JD0033', message: NO_ENTITY_ROOT });
      await assert.rejects(Promise.resolve().then(() => store.execute(spec)), { code: 'JD0033' });
      await assert.rejects(Promise.resolve().then(() => store.live([{ $for: { u: '$.Nobody[*]' }, $return: '$u' }])), { code: 'JD0033' });
      assert.strictEqual(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });

  it('so is a linq include() chain handed to the client live()', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), capture: true, validator: null });
    try {
      const graph = client.entities.Author.include((/** @type {any} */ a) => a.posts, { orderBy: (/** @type {any} */ p) => p.score, take: 2 });
      await assert.rejects(Promise.resolve().then(() => client.live(graph)), { code: 'JD0033', message: NO_ENTITY_ROOT });
    }
    finally { await client.close(); }
  });
});
