//@ts-check
/**
 * @file A bounded transaction log over `app.observe` (APP-FORMAT §8.3).
 *
 * The log lives OUTSIDE application state by design: diagnostics are
 * host memory, never data. Records are the observer's bounded JSON
 * metadata; payload capture stays whatever the app was created with
 * (`capturePayloads`), so the log adds no leak surface of its own. A
 * redaction hook lets a host scrub or drop records before they are
 * retained at all.
 */

/**
 * @typedef {Object} TransactionLogOptions
 * @property {number} [limit] - Maximum retained records (default 200);
 *   older records fall off the front.
 * @property {(record: any) => any} [redact] - Applied to every record
 *   before retention; return the (possibly rewritten) record, or
 *   `null`/`undefined` to drop it entirely. Secrets and personal data
 *   are the host's responsibility — this is the hook to enforce it.
 */

/**
 * Create a bounded transaction log. Wire it up with
 * `app.observe(log.observer)`; read it back with `log.entries()`;
 * export it as versioned JSON with `log.export()`.
 *
 * @example
 * const log = createTransactionLog({ limit: 100 });
 * const stop = app.observe(log.observer);
 * // ... later, in a support bundle:
 * const dump = log.export(); // { version: 1, entries: [...] }
 *
 * @param {TransactionLogOptions} [options]
 */
export function createTransactionLog(options = {}) {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('createTransactionLog: "limit" must be a positive integer');
  }
  const redact = options.redact ?? null;
  /** @type {any[]} */
  let entries = [];

  return {
    /**
     * The observer to register with `app.observe`.
     * @param {any} record
     */
    observer(record) {
      let entry = record;
      if (redact !== null) {
        entry = redact(record);
        if (entry === null || entry === undefined) return;
      }
      entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    /** The retained records, oldest first (a fresh array each call). */
    entries() {
      return entries.slice();
    },
    /** Drop every retained record. */
    clear() {
      entries = [];
    },
    /**
     * A versioned export envelope for support bundles. The version
     * covers the envelope shape; record fields follow the observer
     * contract of the app that produced them.
     * @returns {{ version: 1, entries: any[] }}
     */
    export() {
      return { version: 1, entries: entries.slice() };
    },
  };
}
