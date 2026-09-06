//@ts-check
/**
 * @file The closed set of connection pragmas a store configures, in
 * ONE place: each entry names the `openStore` option, the SQL pragma it
 * spells, the validator its value must pass before anything reaches
 * SQL, and how the engine's read-back answer is compared with the
 * request and reported.
 *
 * Three rules, each the answer to a way a configured store can lie:
 *
 *  - **the set is closed.** An option that names a pragma outside it is
 *    a coded refusal (`JD0006`) naming the option, never a member that
 *    is accepted and quietly not applied — SQLite itself accepts
 *    `PRAGMA synchronous = bogus` without a word and leaves the old
 *    value in place, which is exactly why a value is validated here and
 *    only a member of a closed word set or a checked integer is spelled;
 *  - **a driver applies what it declares.** A binding's capability
 *    table lists the pragmas it can apply; a request the binding does
 *    not declare is refused (`JD0007`), as is a journal-mode write on a
 *    read-only connection, which the engine answers with an I/O error;
 *  - **setting is not applying.** Every pragma is read back after the
 *    open sequence and the read value is what the capability report
 *    carries; a requested value the engine did not take is a refusal
 *    (`JD0008`), because a store that believes a configuration it does
 *    not have is worse than one that failed to open.
 *
 * `foreign_keys` is deliberately NOT here: the model requires it ON and
 * the open path verifies it per connection (`JD0003` when it stays
 * off). It is an invariant, not a preference.
 */

import { DbCompileError } from './errors.js';
import { chain } from './driver.js';

/**
 * A closed word set with the engine's numeric spelling beside each
 * word, for the pragmas whose read-back answer is a number.
 * @param {string[]} words - in the engine's numeric order
 * @returns {{ words: readonly string[],
 *   normalize: (value: any, option: string) => string,
 *   read: (value: any) => string | null }}
 */
function wordSet(words) {
  const frozen = Object.freeze([...words]);
  return {
    words: frozen,
    normalize: (value, option) => {
      const word = typeof value === 'string' ? value.toLowerCase() : null;
      if (word === null || !frozen.includes(word)) {
        throw new TypeError(`openStore: ${option} is one of ${
          frozen.map((w) => `'${w}'`).join(', ')}, got ${JSON.stringify(value)}`);
      }
      return word;
    },
    // the engine answers the word for journal_mode and the number for
    // synchronous/temp_store; both are read back to the word
    read: (value) => {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < frozen.length)
        return frozen[value];
      const word = typeof value === 'string' ? value.toLowerCase() : null;
      return word !== null && frozen.includes(word) ? word : null;
    },
  };
}

/**
 * An integer bound: the request must be a safe integer within it, and
 * the read-back is the engine's number.
 * @param {number} min
 * @param {number} [max]
 * @returns {{ normalize: (value: any, option: string) => number,
 *   read: (value: any) => number | null }}
 */
function integer(min, max = Number.MAX_SAFE_INTEGER) {
  return {
    normalize: (value, option) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new TypeError(`openStore: ${option} is an integer ${
          max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`}, got ${
          JSON.stringify(value)}`);
      }
      return value;
    },
    read: (value) => (typeof value === 'number' && Number.isFinite(value) ? value
      : typeof value === 'bigint' ? Number(value) : null),
  };
}

/**
 * The closed table, in the order the open sequence applies it. The
 * busy timeout goes first because every later statement may wait on
 * it; the journal mode next because it must run outside a transaction.
 *
 * `memoryFixed` marks a pragma a `:memory:` database cannot take — its
 * journal mode is `memory` whatever is asked, and it has no file to
 * map — so the open sequence does not write it there and the report
 * carries what the engine answers instead. `fileWrite` marks a pragma
 * whose write touches the file, refused on a read-only connection.
 */
export const PRAGMAS = Object.freeze({
  busyTimeout: Object.freeze({
    pragma: 'busy_timeout', default: 5000, ...integer(0, 0x7fffffff),
    memoryFixed: false, fileWrite: false,
  }),
  journalMode: Object.freeze({
    pragma: 'journal_mode', default: 'wal',
    ...wordSet(['delete', 'truncate', 'persist', 'memory', 'wal', 'off']),
    memoryFixed: true, fileWrite: true,
  }),
  synchronous: Object.freeze({
    pragma: 'synchronous', default: undefined,
    ...wordSet(['off', 'normal', 'full', 'extra']),
    memoryFixed: false, fileWrite: false,
  }),
  walAutocheckpoint: Object.freeze({
    pragma: 'wal_autocheckpoint', default: undefined, ...integer(0, 0x7fffffff),
    memoryFixed: false, fileWrite: false,
  }),
  journalSizeLimit: Object.freeze({
    pragma: 'journal_size_limit', default: undefined, ...integer(-1),
    memoryFixed: false, fileWrite: false,
  }),
  cacheSize: Object.freeze({
    pragma: 'cache_size', default: undefined, ...integer(-0x7fffffff, 0x7fffffff),
    memoryFixed: false, fileWrite: false,
  }),
  mmapSize: Object.freeze({
    pragma: 'mmap_size', default: undefined, ...integer(0),
    memoryFixed: true, fileWrite: false,
  }),
  tempStore: Object.freeze({
    pragma: 'temp_store', default: undefined,
    ...wordSet(['default', 'file', 'memory']),
    memoryFixed: false, fileWrite: false,
  }),
});

/** The option names of the closed set, in application order. */
export const PRAGMA_NAMES = Object.freeze(Object.keys(PRAGMAS));

/**
 * SQLite pragmas an operator might reasonably name on `openStore` that
 * this store does not configure — each refused by name rather than
 * ignored. Spelled as the engine spells them; the camel-case twin of
 * each is refused too, and so is the snake-case spelling of a member
 * of the closed set.
 */
const NOT_CONFIGURABLE = Object.freeze([
  'foreign_keys', 'locking_mode', 'page_size', 'auto_vacuum', 'secure_delete',
  'automatic_index', 'cell_size_check', 'checkpoint_fullfsync', 'fullfsync',
  'query_only', 'read_uncommitted', 'recursive_triggers', 'reverse_unordered_selects',
  'threads', 'trusted_schema', 'analysis_limit', 'application_id', 'user_version',
  'encoding', 'max_page_count', 'soft_heap_limit', 'hard_heap_limit',
  'defer_foreign_keys', 'ignore_check_constraints', 'legacy_alter_table',
  'writable_schema', 'case_sensitive_like', 'schema_version', 'incremental_vacuum',
]);

/** @param {string} snake */
const camelOf = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Option name → the reason it is refused, for every spelling refused. */
const REFUSED = (() => {
  /** @type {Map<string, string>} */
  const out = new Map();
  const set = PRAGMA_NAMES.map((name) => `'${name}'`).join(', ');
  for (const snake of NOT_CONFIGURABLE) {
    const reason = snake === 'foreign_keys'
      ? "names PRAGMA foreign_keys, which the model requires ON and verifies at open; it is not configurable"
      : `names PRAGMA ${snake}, which this store does not configure; the configurable set is ${set}`;
    out.set(snake, reason);
    out.set(camelOf(snake), reason);
  }
  for (const name of PRAGMA_NAMES) {
    const snake = PRAGMAS[/** @type {keyof typeof PRAGMAS} */ (name)].pragma;
    if (snake !== name) out.set(snake, `is spelled '${name}' on openStore`);
  }
  return out;
})();

/**
 * Refuse an open option that names a pragma outside the closed set
 * (`JD0006`). The option bag's other members are the store's own and
 * are not judged here.
 * @param {Record<string, any>} options
 */
export function refuseUnsupportedPragmaKeys(options) {
  for (const key of Object.keys(options)) {
    const reason = REFUSED.get(key);
    if (reason !== undefined) {
      throw new DbCompileError('JD0006', `openStore option '${key}' ${reason}`);
    }
  }
}

/**
 * The validated requests an open makes: every explicitly given option
 * of the closed set, normalized, plus the two defaults (busy timeout
 * 5000 ms; journal mode `wal` on a writable file). A request the
 * store kind cannot take is settled here: an explicit journal mode on
 * a read-only store is `JD0007` (the engine refuses the write), and a
 * `memoryFixed` pragma on a `:memory:` store is dropped from the
 * requests — the report then carries what the engine answers.
 *
 * A request is EXPLICIT when the operator spelled it and a DEFAULT
 * otherwise, and the read-back treats the two differently: an explicit
 * value the engine did not take refuses the open (`JD0008`), while a
 * default is the store's preference — WAL where the engine can — and a
 * build that cannot take it (the wasm build's file systems have no
 * shared memory for a WAL) opens with the report saying what the
 * connection actually reads. Nothing is ever reported as effective
 * without having been read back; only the refusal is reserved for what
 * was asked for.
 * @param {Record<string, any>} options
 * @param {{ memory: boolean, readOnly: boolean }} kind
 * @returns {Map<string, { value: number | string, explicit: boolean }>}
 *   option name → the normalized value and whether the operator asked
 *   for it, in application order
 */
export function resolvePragmaRequests(options, kind) {
  /** @type {Map<string, { value: number | string, explicit: boolean }>} */
  const requests = new Map();
  for (const name of PRAGMA_NAMES) {
    const entry = PRAGMAS[/** @type {keyof typeof PRAGMAS} */ (name)];
    const given = options[name];
    if (given === undefined) {
      if (entry.default === undefined) continue;
      // the journal-mode default is for a file this connection may
      // write; a read-only store keeps whatever mode the file has
      if (entry.fileWrite && kind.readOnly) continue;
      if (entry.memoryFixed && kind.memory) continue;
      requests.set(name, { value: entry.default, explicit: false });
      continue;
    }
    const value = entry.normalize(given, name);
    if (entry.fileWrite && kind.readOnly) {
      throw new DbCompileError('JD0007',
        `${name} cannot be applied on a read-only store: PRAGMA ${entry.pragma} writes the file`);
    }
    if (entry.memoryFixed && kind.memory) continue;
    requests.set(name, { value, explicit: true });
  }
  return requests;
}

/**
 * The one column a `PRAGMA name` read answers, whatever the engine
 * names it (`busy_timeout` answers a `timeout` column).
 * @param {any} row
 */
const firstValue = (row) => {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const values = Object.values(row);
  return values.length === 0 ? undefined : values[0];
};

/**
 * Apply the requests on an open connection and read every declared
 * pragma back. Refuses `JD0007` for a request the binding does not
 * declare and `JD0008` for an EXPLICIT request the engine did not take;
 * answers the effective record — every option name of the closed set,
 * the read-back value, or `null` where the binding declares the pragma
 * absent or the engine answered nothing.
 * @param {any} connection - the probed connection (`capabilities.configurablePragmas`)
 * @param {Map<string, { value: number | string, explicit: boolean }>} requests
 *   - from {@link resolvePragmaRequests}
 * @returns {any} value-or-promise of the frozen effective record
 */
export function configurePragmas(connection, requests) {
  const declared = new Set(connection.capabilities.configurablePragmas ?? []);
  const dialect = connection.dialect;
  for (const [name, request] of requests) {
    if (declared.has(name)) continue;
    // Only an EXPLICIT request refuses. A default is the store's own
    // preference — a busy timeout, WAL where the engine has one — and a
    // connection whose vocabulary does not include it (another engine
    // entirely, or a build that compiled the pragma out) opens with the
    // effective record saying `null` rather than failing on a value
    // nobody asked for.
    if (!request.explicit) continue;
    throw new DbCompileError('JD0007',
      `the driver cannot apply pragma '${name}': its binding declares ${
        declared.size === 0 ? 'no configurable pragma' : [...declared].map((n) => `'${n}'`).join(', ')}`);
  }
  const names = PRAGMA_NAMES.filter((name) => declared.has(name));
  const apply = (i) => {
    if (i >= names.length) return null;
    const name = names[i];
    const request = requests.get(name);
    if (request === undefined) return apply(i + 1);
    const entry = PRAGMAS[/** @type {keyof typeof PRAGMAS} */ (name)];
    return chain(connection.exec(dialect.pragma.set(entry.pragma, request.value)), () => apply(i + 1));
  };
  /** @type {Record<string, number | string | null>} */
  const effective = {};
  for (const name of PRAGMA_NAMES) effective[name] = null;
  const read = (i) => {
    if (i >= names.length) return null;
    const name = names[i];
    const entry = PRAGMAS[/** @type {keyof typeof PRAGMAS} */ (name)];
    return chain(connection.prepare(dialect.introspect.pragma(entry.pragma)), (statement) =>
      chain(statement.get([]), (row) => {
        const value = entry.read(firstValue(row));
        effective[name] = value;
        const request = requests.get(name);
        if (request !== undefined && request.explicit && value !== request.value) {
          throw new DbCompileError('JD0008',
            `pragma '${name}' did not take: ${JSON.stringify(request.value)} was requested and the `
            + `connection reads back ${JSON.stringify(value)}`);
        }
        return read(i + 1);
      }));
  };
  return chain(apply(0), () => chain(read(0), () => Object.freeze(effective)));
}
