//@ts-check
/** Native transaction and notification strategy for the shared journal owner. */
import { DbCompileError } from '../errors.js';

/** @param {string | undefined} notifySql @returns {any} */
export function postgresCapture(notifySql) {
  return Object.freeze({
    check: (options) => {
      if (!options.log && notifySql !== undefined)
        throw new DbCompileError('JD0051', 'change notifications require capture.log for durable resume');
    },
    // Before-images include absent rows an ordinary row lock cannot protect.
    // The durable high-water allocation remains inside the same transaction.
    beforeWrite: (connection) => connection.exec(
      'SELECT pg_catalog.pg_advisory_xact_lock(1246907983, pg_catalog.hashtext(current_schema()))'),
    afterLog: notifySql === undefined ? undefined : (connection) => connection.exec(notifySql),
  });
}
