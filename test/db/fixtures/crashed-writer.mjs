// A writer killed mid-flight: it opens argv[2], commits a table `other`
// with one row, and dies without a close — in `wal` mode (the default)
// with automatic checkpoints off, leaving the database beside a `-wal`
// that holds the commit; in `journal` mode inside a second, unfinished
// transaction large enough to spill pages into the database file, which
// first syncs the journal's header: a hot `-journal` SQLite rolls back.
import { DatabaseSync } from 'node:sqlite';
import { crashAt } from './abrupt-exit.js';

const [path, mode = 'wal'] = process.argv.slice(2);
const db = new DatabaseSync(path);
if (mode === 'journal') {
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=2; CREATE TABLE other(x); INSERT INTO other VALUES (1); BEGIN; '
    + 'WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < 64) INSERT INTO other SELECT randomblob(4000) FROM g');
}
else db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE other(x); INSERT INTO other VALUES (1)');
crashAt(`crashed-${mode}`);
