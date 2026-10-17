// Runs under Bun: the foreign-commit corpus through the real bun:sqlite
// driver, over a file a second bun:sqlite connection commits to beside the
// store, in a write-ahead log and in a rollback journal.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

import { FOREIGN_COMMIT_OPTIONS, lockedAfterReads, staleAfterReads } from '../oracle/foreign-commit-reads.js';

const found = {};
const failures = [];
for (const [journal, corpus, journalMode] of [['wal', staleAfterReads, 'wal'], ['delete', lockedAfterReads, 'delete']]) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-foreign-commit-bun-'));
  const path = join(dir, 'store.sqlite');
  try {
    const { Database } = await import('bun:sqlite');
    found[journal] = await corpus((model, options) => openStore(model,
      { driver: bunDriver(), path, journalMode, ...FOREIGN_COMMIT_OPTIONS, ...options }), (sql) => {
      const db = new Database(path);
      try { db.run(sql); }
      finally { db.close(); }
    });
  }
  catch (error) { failures.push(String(error?.stack ?? error)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', found, failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
