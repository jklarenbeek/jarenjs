//@ts-check
/**
 * @file A native statement hands back what the engine reads. A number past
 * 2^53 is read as the double the engine holds, where a driver's integer
 * read refuses it. Every case runs on SQLite and, when `JAREN_PG_URL` names
 * an endpoint, on PostgreSQL; the Bun run lives in its own file.
 */
import { describe, it } from 'node:test';
import { onBothEngines } from './query-core-engines.js';
import { cases } from './fixtures/exact-reads-cases.mjs';

describe('a native read answers what the engine answers', () => {
  for (const kase of cases) {
    it(kase.name, async () => {
      await onBothEngines(kase.model, async (store, host) => {
        if (kase.hosts !== undefined && !kase.hosts.includes(host)) return;
        const rows = store.collection('rows');
        for (const document of kase.docs) await rows.insert(document);
        await kase.run(rows, kase.docs, host);
      });
    });
  }

});
