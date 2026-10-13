// Runs under Bun: the null-reading pair of one binding through the real bun:sqlite driver.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

import { DDL, modelFor, checkNullPair } from '../oracle/null-pair.js';

const failures = [];
for (const type of ['string', ['string', 'null']]) {
  const driver = bunDriver();
  const db = await driver.open(':memory:');
  db.exec(DDL(''));
  const store = await openStore(modelFor(type)(null), { driver: { ...driver, open: async () => db }, adopt: true });
  try { await checkNullPair(store, 'bun'); }
  catch (error) { failures.push(String(error?.message ?? error)); }
  finally { await store.close(); }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
