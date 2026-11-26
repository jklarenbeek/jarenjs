//@ts-check
/**
 * @file A persisted lexical source names its content revision as the
 * source name and the lowercase hex SHA-256 of the canonical JSON of its
 * rows' UTF-8 bytes, non-ASCII text included; the expected digest here is
 * computed by `node:crypto`, independently of the source under test.
 */

import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createDbSearch } from '@jarenjs/db/search';
import { canonicalizeJson } from '@jarenjs/json/canonical';

const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, title: { type: 'string' },
} } } } };
const documents = [{ id: 'a', title: 'thé à la menthe' }, { id: 'b', title: 'grüner Tee 緑茶 🍵' }];

describe('persisted lexical content revision', () => {
  it('is the source name and the SHA-256 of the canonical rows', async () => {
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    let source;
    try {
      for (const row of documents) await store.entity('Item').create(row);
      source = await createDbSearch(store, 'Item', { version: 1, fields: ['title'] }, { source: 'catalog' });
      assert.equal((await source.search('tee')).hits.length, 1);
      const rows = (await store.entity('Item').page({ orderBy: '$it.id' }, { limit: 10 })).items;
      const digest = createHash('sha256').update(Buffer.from(canonicalizeJson(rows), 'utf8')).digest('hex');
      assert.equal(source.sourceRevision, `catalog:${digest}`);
    }
    finally {
      await source?.dispose();
      await store.close();
    }
  });
});
