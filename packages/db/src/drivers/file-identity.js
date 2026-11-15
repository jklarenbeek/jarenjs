//@ts-check
/** Native filesystem identity stays below the Node/Bun entry points. */
import { chain } from '../driver.js';
import { DbCompileError } from '../errors.js';
import { migrationOwnerOf, sqliteDatabasePath } from '../migration-target.js';

/** The device/inode each open connection's file had when it was pinned:
 * at `open()` for a connection a native driver opened, at the first identity
 * call for one it did not. One map for both drivers, so either driver's hook
 * answers the same for one connection. */
const pins = new WeakMap();

/** The device/inode a filename names now, or `null` when it names nothing.
 * The filesystem is imported only when identifying an opened file.
 * @param {string} path @returns {Promise<string | null>} */
const statIdentity = (path) => import('node:fs/promises')
  .then((fs) => fs.stat(path, { bigint: true }))
  .then((stat) => `${stat.dev}:${stat.ino}`, (error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });

/**
 * Pin a freshly opened connection's file identity, read from SQLite's own
 * main filename right after the open. A private in-memory database has no
 * file to pin; a stat that fails leaves the connection unpinned (pinned at
 * its first identity call instead), never fails the open. The connection
 * answers unchanged. Between the native open and this stat the path could
 * still be replaced: that window is the caller's precondition (an unchanged
 * path while the database opens), since `node:sqlite` exposes no descriptor
 * to stat instead.
 * @param {any} connection @returns {any} value-or-promise of the connection
 */
export function pinDatabaseIdentity(connection) {
  return chain(sqliteDatabasePath(connection), async (path) => {
    if (path === null) return connection;
    try {
      const identity = await statIdentity(path);
      if (identity !== null) pins.set(connection, identity);
    }
    catch {
      // unpinned: the first identity call pins it, and reports what it meets
    }
    return connection;
  });
}

/** Device/inode identity also catches hardlinks that SQLite filenames cannot.
 * It is the file the connection opened: each call re-stats the connection's
 * filename and refuses (`JD0021`) when it no longer names the pinned file —
 * replaced or removed after the open — rather than identify the file now at
 * that path, which the connection does not read. Two private in-memory
 * databases remain independent.
 * @param {any} connection @returns {any} value-or-promise of string or null */
export function nativeDatabaseIdentity(connection) {
  return chain(sqliteDatabasePath(connection), (path) => path === null ? null
    : statIdentity(path).then((current) => {
      const owner = pins.has(connection) ? connection : migrationOwnerOf(connection);
      const pinned = pins.get(owner);
      if (pinned === undefined && current !== null) {
        pins.set(connection, current);
        return current;
      }
      if (current === null || current !== pinned) {
        throw new DbCompileError('JD0021', `the database file '${path}' was ${current === null ? 'removed' : 'replaced'} `
          + 'after the connection opened it: the path no longer names the file the connection reads, so its identity is unknown');
      }
      return pinned;
    }));
}
