//@ts-check
/** Native filesystem identity stays below the Node/Bun entry points. */
import { chain } from '../driver.js';
import { sqliteDatabasePath } from '../migration-target.js';

/** Device/inode identity also catches hardlinks that SQLite filenames cannot.
 * The filesystem is imported only when identifying an opened file; two private
 * in-memory databases remain independent.
 * @param {any} connection @returns {any} value-or-promise of string or null */
export function nativeDatabaseIdentity(connection) {
  return chain(sqliteDatabasePath(connection), (path) => path === null ? null
    : import('node:fs/promises').then((fs) => fs.stat(path, { bigint: true }))
      .then((stat) => `${stat.dev}:${stat.ino}`));
}
