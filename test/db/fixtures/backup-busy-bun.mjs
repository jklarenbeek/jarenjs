// Under Bun, a file backup through the Bun driver while another connection
// holds the file's exclusive lock, which a timer on this thread releases:
// the copy waits out the lock without holding this thread, so the timer
// runs and the copy completes. One JSON line the spawning test reads.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'jaren-backup-busy-'));
const report = { runtime: typeof Bun === 'undefined' ? 'node' : 'bun' };
try {
  const path = join(directory, 'source.db');
  const MODEL = { $model: '0.1', collections: { notes: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } } } } };
  const store = await openStore(MODEL, { driver: bunDriver(), path, journalMode: 'delete', busyTimeout: 800 });
  for (let i = 0; i < 200; i++) await store.collection('notes').insert({ id: String(i), body: 'x'.repeat(2000) });
  // a rollback journal: an exclusive transaction keeps every reader out
  const other = new Database(path);
  other.exec('BEGIN EXCLUSIVE');
  other.exec('SELECT count(*) FROM sqlite_schema');
  let released = false;
  let settled = false;
  setTimeout(() => { report.releasedBeforeSettled = !settled; other.exec('COMMIT'); other.close(); released = true; }, 100);
  try {
    const copy = await store.backupTo(join(directory, 'copy.db'), { onProgress: () => {} });
    report.pages = copy.pages;
  }
  catch (error) { report.code = /** @type {any} */ (error).code ?? String(error); }
  settled = true;
  report.released = released;
  const copied = await openStore(MODEL, { driver: bunDriver(), path: join(directory, 'copy.db'), readOnly: true });
  report.rows = (await copied.collection('notes').all()).length;
  await copied.close();
  await store.close();
}
finally {
  rmSync(directory, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
