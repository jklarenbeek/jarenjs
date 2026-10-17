// Runs under Bun: the integer-read corpus through the real bun:sqlite driver,
// over a file a second bun:sqlite connection writes beside the store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

import { checkIntegerReads } from '../oracle/integer-reads.js';

const failures = [];
const dir = mkdtempSync(join(tmpdir(), 'jaren-integer-bun-'));
const path = join(dir, 'store.sqlite');
try {
  const { Database } = await import('bun:sqlite');
  await checkIntegerReads((model) => openStore(model, { driver: bunDriver(), path }), (sql) => {
    const db = new Database(path);
    try { db.run(sql); }
    finally { db.close(); }
  });
}
catch (error) { failures.push(String(error?.stack ?? error)); }
finally { rmSync(dir, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
