// Runs under Bun: the exact-read cases through the real bun:sqlite driver.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { problems } from './exact-reads-cases.mjs';

const failures = await problems(async (model, fn) => {
  const store = await openStore(model, { driver: bunDriver() });
  try {
    await fn(store, 'sqlite');
  }
  finally {
    await store.close();
  }
});
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
