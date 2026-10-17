//@ts-check
/**
 * @file After each of the store's read paths, a row another connection
 * commits is seen by the store's next reads on node:sqlite, in a write-ahead
 * log and in a rollback journal (where a read transaction left open would
 * refuse that commit busy instead). Bun runs the same corpus in
 * foreign-commit-reads-bun.test.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { FOREIGN_COMMIT_OPTIONS, lockedAfterReads, readPaths, staleAfterReads } from './oracle/foreign-commit-reads.js';

/** Run `corpus` over a store file in `journalMode`.
 * @param {typeof staleAfterReads} corpus @param {string} journalMode */
async function overFile(corpus, journalMode) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-foreign-commit-'));
  const path = join(dir, 'store.sqlite');
  try {
    return await corpus((model, options) => openStore(model,
      { driver: nodeDriver(), path, journalMode, ...FOREIGN_COMMIT_OPTIONS, ...options }), (sql) => {
      const db = new DatabaseSync(path);
      try { db.exec(sql); }
      finally { db.close(); }
    });
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('a commit beside the store on node:sqlite', () => {
  it('names every read path the corpus runs', () => {
    assert.equal(Object.keys(readPaths(null)).length, 30);
  });

  it('is seen by the reads after every read path, in a write-ahead log', async () => {
    assert.deepEqual(await overFile(staleAfterReads, 'wal'), []);
  });

  it('is not refused busy after any read path, in a rollback journal', async () => {
    assert.deepEqual(await overFile(lockedAfterReads, 'delete'), []);
  });
});
