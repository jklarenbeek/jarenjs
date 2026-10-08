//@ts-check
/**
 * @file SQLite file copies shared by the Node and Bun bindings: removing a
 * database file with every side file SQLite keeps beside it, publishing a
 * finished copy by rename, the Bun binding's page copy, and disk-backed
 * snapshots onto a new path.
 *
 * The Bun binding copies a database that has a file through SQLite's
 * online backup on a dedicated read-only `node:sqlite` connection — Bun
 * ships it on the same SQLite library as `bun:sqlite` — holding one read
 * transaction for the whole copy, so no write restarts it and the copy is
 * the database as it stood when the copy began. Bun's `backup()` runs
 * every step before it returns: progress arrives synchronously, and
 * nothing else on the thread runs until the copy ends. It copies with one
 * `VACUUM INTO` statement instead — no progress, free pages dropped — for
 * a database without a file (memory, temporary), when `node:sqlite` cannot
 * be loaded, and when the two bindings report different SQLite source
 * ids: two library copies on one file in one process break each other's
 * POSIX locks, so the ids are compared before `node:sqlite` opens the file.
 *
 * Every builtin is imported lazily inside the function that needs it,
 * never at module scope, so the bindings load under any runtime.
 */
import { DbCompileError, DbRuntimeError } from '../errors.js';
import { refuseSpecialSqlitePath } from '../backup.js';

/** The files SQLite keeps beside a database: its rollback journal, its
 * write-ahead log and that log's shared-memory index. */
const SIDE_FILES = Object.freeze(['-journal', '-wal', '-shm']);

const SOURCE_ID = 'SELECT sqlite_source_id() AS id';

/**
 * Remove a SQLite file and every side file SQLite may have left beside
 * it — a copy that failed part-way leaves its `-journal` too. A path that
 * does not exist is not an error.
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function removeSqliteFile(path) {
  const fs = await import('node:fs/promises');
  for (const suffix of ['', ...SIDE_FILES]) await fs.rm(`${path}${suffix}`, { force: true });
}

/** The first bytes of a hot rollback journal: SQLite rolls back a journal
 * that begins with them, and zeroes them once it is done with one. */
const JOURNAL_MAGIC = Object.freeze([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

/** A write-ahead log's header; any frame follows it. */
const WAL_HEADER_BYTES = 32;

/**
 * The first `length` bytes of a file, `null` when there is no file.
 * @param {any} fs - `node:fs/promises`
 * @param {string} path
 * @param {number} length
 * @returns {Promise<Uint8Array | null>}
 */
async function headOf(fs, path, length) {
  let file;
  try { file = await fs.open(path, 'r'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const head = new Uint8Array(length);
    const { bytesRead } = await file.read(head, 0, length, 0);
    return head.subarray(0, bytesRead);
  }
  finally {
    await file.close();
  }
}

/**
 * Publish a complete SQLite file onto `to` by rename — one step on one
 * file system, so `to` never holds a partial file. Refused with `JD2078`,
 * deleting nothing, while a side file of `to` would be replayed into the
 * published file, which would then open as the database that file belongs
 * to: a write-ahead log that holds frames (anything past its header) or a
 * hot rollback journal (one that begins with the journal magic). Such a
 * file belongs to an open database or to one whose writer did not finish,
 * and is never this function's to delete. An empty or header-only log and
 * a journal whose header a clean commit zeroed (persist mode) are never
 * replayed and do not block publication. A `to` that is a symbolic link is
 * replaced by the file, as any rename does.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function publishSqliteFile(from, to) {
  const fs = await import('node:fs/promises');
  const refused = (side, what) => new DbRuntimeError('JD2078', `the copy was not published: '${side}' ${what} — `
    + 'the target belongs to an open database, or to one whose writer did not finish; the target was not replaced');
  const wal = `${to}-wal`;
  if (((await headOf(fs, wal, WAL_HEADER_BYTES + 1))?.length ?? 0) > WAL_HEADER_BYTES)
    throw refused(wal, 'holds write-ahead log frames SQLite may replay into the published copy');
  const journal = `${to}-journal`;
  const head = await headOf(fs, journal, JOURNAL_MAGIC.length);
  if (head !== null && JOURNAL_MAGIC.every((byte, i) => head[i] === byte))
    throw refused(journal, 'is a hot journal SQLite would roll back into the published copy');
  await fs.rename(from, to);
}

/**
 * Flush a SQLite file SQLite has written and closed to stable storage, and
 * read its page count: its size over the page size its header names.
 * @param {string} path
 * @returns {Promise<number>}
 */
async function flushedPageCount(path) {
  const fs = await import('node:fs/promises');
  // opened for writing: Windows refuses to flush a read-only handle
  const file = await fs.open(path, 'r+');
  try {
    await file.sync();
    const header = new Uint8Array(100);
    await file.read(header, 0, header.length, 0);
    const encoded = (header[16] << 8) | header[17];
    return (await file.stat()).size / (encoded === 1 ? 65536 : encoded);
  }
  finally {
    await file.close();
  }
}

/** One row of a `bun:sqlite`-shaped statement, its statement finalized.
 * @param {any} db @param {string} sql @returns {any} */
const firstRow = (db, sql) => {
  const statement = db.prepare(sql);
  try { return statement.get(); }
  finally { statement.finalize?.(); }
};

/** The source id of the SQLite library under `node:sqlite`, read once per
 * process; `null` when it cannot be read.
 * @type {string | null | undefined} */
let nodeLibrary;

/**
 * The source id of the SQLite library `node:sqlite` runs on, read on a
 * memory database — never on the file a second library in this process
 * must not open — through a function and `exec`, never a prepared
 * statement (see {@link copyBunDatabase}).
 * @param {any} sqlite - the loaded `node:sqlite` module
 * @returns {string | null}
 */
function nodeSqliteLibrary(sqlite) {
  if (nodeLibrary === undefined) {
    nodeLibrary = null;
    try {
      const probe = new sqlite.DatabaseSync(':memory:');
      try {
        probe.function('jaren_source_id', (id) => { nodeLibrary = id; return null; });
        probe.exec('SELECT jaren_source_id(sqlite_source_id())');
      }
      finally {
        probe.close();
      }
    }
    catch { /* unknown: never the Bun handle's id, so the copy falls back */ }
  }
  return nodeLibrary;
}

/**
 * Copy a `bun:sqlite`-shaped database onto `target` with one `VACUUM INTO`
 * statement — no progress, free pages dropped. `target` does not exist yet
 * or is an empty file; SQLite refuses any other.
 * @param {any} db
 * @param {string} target
 */
function vacuumInto(db, target) {
  const statement = db.prepare('VACUUM INTO ?');
  try { statement.run(target); }
  finally { statement.finalize?.(); }
}

/**
 * Copy a `bun:sqlite` database onto `target` page by page, `rate` pages per
 * step, reporting `progress` after every step that leaves pages to copy.
 * The copy runs on a dedicated `node:sqlite` connection opened read-only on
 * the file the database's `main` schema names — never the path it was
 * opened with, whose meaning a relative path ties to the working
 * directory — with the Bun handle's busy timeout, inside one read
 * transaction that is ended, and the connection closed, however the copy
 * ends. The libraries are compared before that file is opened, and the
 * connection prepares no statement: under Bun, `close()` leaves a
 * connection with an unfinalized statement open, holding the file and its
 * log until a collection. The fallbacks are the file comment's. `target`
 * does not exist yet or is an empty file; a failed copy may leave a
 * partial one, which the caller removes with {@link removeSqliteFile}.
 *
 * Either copy holds the thread from its first page to its last. The copy
 * is then flushed and its page count read from its header — real I/O, so
 * the timers and I/O callbacks that came due during the copy run before it
 * settles, and an abort they raise is seen before publication. No timer is
 * involved: a clock that never advances cannot stall it.
 * @param {any} db - a `bun:sqlite`-shaped `Database`
 * @param {string} target
 * @param {{ rate?: number, progress?: (report: { totalPages: number,
 *   remainingPages: number }) => void }} [options]
 * @returns {Promise<number>} the copy's page count
 */
export async function copyBunDatabase(db, target, options) {
  const file = firstRow(db, "SELECT file FROM pragma_database_list WHERE name = 'main'")?.file ?? '';
  const sqlite = file === '' ? null : await import('node:sqlite').catch(() => null);
  if (typeof sqlite?.backup === 'function' && typeof sqlite?.DatabaseSync === 'function'
    && nodeSqliteLibrary(sqlite) === firstRow(db, SOURCE_ID)?.id) {
    const dedicated = new sqlite.DatabaseSync(file, { readOnly: true, timeout: firstRow(db, 'PRAGMA busy_timeout')?.timeout ?? 0 });
    try {
      // the read transaction starts at its first read and holds the
      // snapshot every step copies from
      dedicated.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
      try { await sqlite.backup(dedicated, target, options); }
      finally {
        try { dedicated.exec('COMMIT'); }
        catch { /* a read transaction that cannot end ends with its connection */ }
      }
    }
    finally {
      dedicated.close();
    }
  }
  else vacuumInto(db, target);
  return flushedPageCount(target);
}

/**
 * Make a finished copy of a WAL database a rollback-journal file, through
 * SQLite: a WAL file creates its `-wal` and `-shm` beside it whenever it is
 * opened, read-only included, and cannot be opened where they cannot be
 * created (a read-only directory or medium). Only page 1's header changes:
 * its file format bytes (18-19), change counter and version-valid-for
 * number. A rollback-journal copy (`VACUUM INTO` writes one) is left alone,
 * without loading `node:sqlite`, which a Bun runtime may lack.
 * @param {string} path
 */
async function asRollbackJournal(path) {
  const fs = await import('node:fs/promises');
  const head = await headOf(fs, path, 20);
  if (head === null || (head[18] !== 2 && head[19] !== 2)) return;
  const sqlite = await import('node:sqlite');
  // `exec` only: under Bun, `close()` leaves a connection with an
  // unfinalized statement open (see copyBunDatabase)
  const db = new sqlite.DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode=DELETE'); }
  finally { db.close(); }
}

/** Reserve a new destination and fill it through SQLite, never a JS image;
 * a copy of a WAL database is made a rollback-journal file. A failed fill,
 * or one that left the reservation without a database, removes the
 * destination with every side file it left.
 * @param {string} target - a file path the caller has checked
 * @param {() => any} write @returns {Promise<number>} */
export async function writeSqliteSnapshot(target, write) {
  const fs = await import('node:fs/promises');
  const reservation = await fs.open(target, 'wx');
  try {
    // only reserved: SQLite fills the empty file through its own handle
    await reservation.close();
    await write();
    await asRollbackJournal(target);
    const pages = await flushedPageCount(target);
    if (!Number.isSafeInteger(pages) || pages < 1)
      throw new DbRuntimeError('JD2078', `the snapshot wrote no database to '${target}'`);
    return pages;
  }
  catch (error) {
    await removeSqliteFile(target);
    throw error;
  }
}

/**
 * Run `copy`, an online backup that reads through `connection`, inside one
 * read transaction of that connection: every step then reads one snapshot,
 * so another connection's commit cannot restart the copy and a steadily
 * written source still finishes, and a source another connection has
 * locked fails busy at the first read, as SQLite reports it. The
 * transaction ends however the copy does: committed (it read only), else
 * rolled back, else with its closed connection.
 * @param {any} connection
 * @param {() => any} copy
 */
async function insideOneRead(connection, copy) {
  connection.exec('BEGIN');
  try {
    // the read transaction starts at its first read
    connection.exec('SELECT count(*) FROM sqlite_schema');
    return await copy();
  }
  finally {
    try { connection.exec('COMMIT'); }
    catch {
      try { connection.exec('ROLLBACK'); }
      catch { /* it ended with its connection */ }
    }
  }
}

/**
 * Copy a database onto a new path, committed write-ahead log included,
 * without opening a model store. The target is a new file: an existing
 * one, even empty, is refused (`EEXIST`), and a name SQLite reads as
 * something else (`file:…`, `:memory:`) is a `TypeError` before the call
 * waits for the connection.
 *
 * A connection the Node or Bun driver opened copies through its own online
 * backup inside one read transaction (on Node the connection's own, on Bun
 * the dedicated connection's): the copy is the committed database as it
 * stood when the copy began, another connection's commits cannot restart
 * it, and a source another connection has locked fails busy. Every page is
 * copied, free pages in place — their unused bytes may be the copying
 * connection's image of them — so unaliased rowids keep their values; of
 * page 1's header, the change counter and version-valid-for number may
 * differ, SQLite's backup gives the copy the schema cookie 1, and a copy of
 * a WAL database is made a rollback-journal file. On Bun the copy holds the
 * calling thread until it ends (its fallbacks are the file comment's). A
 * connection without that primitive copies with one `VACUUM INTO`
 * statement, which compacts: free pages dropped, not page for page.
 * SQLite's page caches bound working memory; no JavaScript image of the
 * database is built.
 *
 * Refused with `JD0038` before any file is touched when the connection is
 * not a synchronous SQLite one, and when it is inside an open transaction
 * once this call owns it — called from a transaction callback before its
 * first await, or after a `BEGIN` on the connection: the copy would leave
 * out uncommitted writes. From an awaited part of a transaction callback
 * the call waits for that transaction like any other caller (`JD0012` once
 * the queue timeout passes). A failed copy, or one that left the
 * reservation without a database, removes the target and every side file.
 * @param {any} connection
 * @param {string} target
 * @returns {Promise<{ path: string, pages: number }>} `pages` is the copy's page count
 */
export async function snapshotDatabase(connection, target) {
  if (connection.dialect.name !== 'sqlite' || !connection.synchronous)
    throw new DbCompileError('JD0038', 'snapshotDatabase requires a synchronous SQLite connection');
  if (typeof target !== 'string' || target === '' || target.includes('\0'))
    throw new TypeError('snapshotDatabase: target is a non-empty file path without NUL bytes');
  refuseSpecialSqlitePath(target, 'snapshotDatabase: target');
  const backup = typeof connection.backup?.copy === 'function' ? connection.backup : null;
  // a primitive that copies on a connection of its own holds its own read
  // transaction; one that copies through this connection needs one here
  const write = backup === null ? () => connection.prepare('VACUUM INTO ?').run([target])
    : backup.snapshot === true ? () => backup.copy(target, {})
      : () => insideOneRead(connection, () => backup.copy(target, {}));
  // Acquire ownership before asynchronous filesystem work. Acquiring it
  // afterwards would queue behind an outer transaction awaiting this call.
  const snapshot = () => {
    // checked once the connection is this call's: a transaction it waited
    // for has ended by then, so only one the call runs inside is refused
    if (connection.transactionState?.() === true)
      throw new DbCompileError('JD0038', 'snapshotDatabase cannot run inside an open transaction: '
        + 'the copy would leave out its uncommitted writes; take the snapshot once the transaction has ended');
    return writeSqliteSnapshot(target, write);
  };
  const pages = await (typeof connection.exclusively === 'function'
    ? connection.exclusively(snapshot, 'a database snapshot') : snapshot());
  return { path: target, pages };
}
