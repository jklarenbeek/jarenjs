//@ts-check
/** Native transaction and notification strategy for the shared journal owner. */
import { DbCompileError } from '../errors.js';
import { POSTGRES_LOCK_CLASSES, transactionLock } from './postgres-locks.js';

/** @param {string | undefined} notifySql @returns {any} */
export function postgresCapture(notifySql) {
  return Object.freeze({
    check: (options) => {
      if (!options.log && notifySql !== undefined)
        throw new DbCompileError('JD0051', 'change notifications require capture.log for durable resume');
    },
    // Before-images include absent rows an ordinary row lock cannot protect.
    // The durable high-water allocation remains inside the same transaction.
    beforeWrite: (connection) => connection.exec(transactionLock(POSTGRES_LOCK_CLASSES.capture)),
    afterLog: notifySql === undefined ? undefined : (connection) => connection.exec(notifySql),
  });
}
