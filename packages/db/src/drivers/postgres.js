//@ts-check
/**
 * @file The PostgreSQL binding: an INJECTED client behind the driver
 * contract, and the PostgreSQL dialect re-exported beside it.
 *
 * This module imports no PostgreSQL package and no runtime builtin.
 * The host supplies a connection source — anything with
 * `connect()` answering `{ query(text, values), release?() }`, which
 * `pg.Pool` is verbatim — and this driver adapts it. The host owns the
 * client implementation; the public binding has no package to import.
 *
 * ONE client is acquired at open and held until `close()`, then
 * released exactly once. That is not a simplification: a connection
 * owns one savepoint stack and one transaction, and a store that took a
 * different pooled client per statement would have `BEGIN` on one and
 * `COMMIT` on another.
 *
 * The three normalizations, all forced by the wire rather than chosen:
 *
 *  - `int8` and `numeric` arrive as STRINGS, because they can exceed
 *    what a double holds. The store's contract is JavaScript numbers —
 *    so they are converted. An `int8` outside the safe integer range
 *    refuses rather than returning a rounded key or count.
 *  - `json`/`jsonb` arrive PARSED, because the client's type parsers
 *    are the host's configuration. Every document read is already
 *    `::text` (the dialect's `jsonText`), but a graph load's built
 *    object is not, and the row decoder reads text. One re-encode, and
 *    the driver is correct whatever the host configured.
 *  - a JavaScript boolean is bound as 1 or 0, because a boolean MEMBER
 *    is 1 or 0 in this mapping (the dialect's `typeFor` says
 *    `smallint`) and `pg` would otherwise send `'true'`.
 */

import { chain, openConnection, baseCapabilities } from '../driver.js';
import { postgresDialect } from '../dialects/postgres.js';
import { DbCompileError, DbRuntimeError, wrapDriverError } from '../errors.js';
import { workerQueue } from './worker-queue.js';
import { rowBytes } from './worker-protocol.js';
import { postgresSettings, postgresChannel, POSTGRES_DEFAULTS } from './postgres-options.js';
import { postgresCursors } from './postgres-cursor.js';
import { createPostgresNotifications } from './postgres-notifications.js';
import { sqlTokens } from '../dialects/check-read.js';
export { POSTGRES_DEFAULTS };

export { postgresDialect, IDENTIFIER_BYTES } from '../dialects/postgres.js';

/** The minimum PostgreSQL this store accepts, as the server's own
 * `server_version_num` spells it: 16.0. */
export const POSTGRES_FLOOR = 160000;

/**
 * Own a dedicated, bounded LISTEN connection. Each null token asks the host
 * to drain durable changes.page from its saved cursor. Tokens coalesce and
 * contain no row, tenant or authorization data.
 * @param {{ connect: Function }} source
 * @param {any} options
 * @returns {any}
 */
export function postgresNotifications(source, options) {
  return createPostgresNotifications(postgresDriver, source, options);
}

/** Types the wire hands back as text because they can exceed a double,
 * and the two it hands back as text for width alone. The store's
 * contract is JavaScript numbers throughout. */
const NUMERIC_OIDS = new Set([21, 23, 26, 700, 701, 1700]);
/** `json` and `jsonb`: parsed by the client unless the host said
 * otherwise, and the row decoder reads text. */
const JSON_OIDS = new Set([114, 3802]);
/** `bool`, which every shared form compares against 1 and 0. */
const BOOL_OID = 16;

/**
 * The next server-side statement name, monotonic across this PROCESS
 * rather than across one adapter.
 *
 * A prepared statement belongs to the SESSION, and a pooled client's
 * session outlives the store that borrowed it: a second store handed
 * the same physical connection would otherwise re-use `jaren_s1` for
 * different SQL, and PostgreSQL refuses that by name. One counter for
 * every adapter in the process makes the collision impossible without
 * the driver having to know which client the pool will hand it.
 */
let statementSequence = 0;
const sessionStatementCounts = new WeakMap();

/**
 * One column's converter, chosen once per result from the type the
 * server declared rather than per value from what it looks like.
 * @param {number} dataTypeID
 * @returns {((value: any) => any) | null} `null` where the wire value
 *   is already what the store reads
 */
function converterFor(dataTypeID) {
  if (dataTypeID === 20) {
    return (value) => {
      if (value === null || value === undefined) return value;
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        throw new DbRuntimeError('JD2005',
          `PostgreSQL int8 value '${String(value)}' is outside the safe JavaScript integer range`);
      }
      return number;
    };
  }
  if (NUMERIC_OIDS.has(dataTypeID)) {
    return (value) => (value === null || value === undefined ? value : Number(value));
  }
  if (dataTypeID === BOOL_OID) {
    return (value) => {
      if (value === null || value === undefined) return value;
      if (value === true || value === 1 || value === 't' || value === 'true') return 1;
      if (value === false || value === 0 || value === 'f' || value === 'false') return 0;
      throw new DbRuntimeError('JD2003', 'PostgreSQL boolean parser returned an unsupported representation');
    };
  }
  if (JSON_OIDS.has(dataTypeID)) {
    return (value) => (value === null || value === undefined || typeof value === 'string'
      ? value : JSON.stringify(value));
  }
  return null;
}

/**
 * Normalize a result's rows in place. Nothing is copied where no column
 * needs converting, which is the common case: a document read is
 * already text and a key is already a string.
 * @param {{ rows?: any[], fields?: { name: string, dataTypeID: number }[] }} result
 * @returns {any[]}
 */
function normalizeRows(result) {
  const rows = result.rows ?? [];
  const fields = result.fields ?? [];
  /** @type {{ name: string, convert: (value: any) => any }[]} */
  const converters = [];
  for (const field of fields) {
    const convert = converterFor(field.dataTypeID);
    if (convert !== null) converters.push({ name: field.name, convert });
  }
  if (converters.length === 0) return rows;
  for (const row of rows) {
    for (const { name, convert } of converters) row[name] = convert(row[name]);
  }
  return rows;
}

/**
 * One bound value, in the encoding the wire needs.
 * @param {any} value
 * @returns {any}
 */
function encodeParam(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return String(value);
  // a packed vector is bytes; a client that recognizes only its
  // platform's buffer type would otherwise stringify the view
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const Buf = /** @type {any} */ (globalThis).Buffer;
    if (Buf !== undefined && !Buf.isBuffer(value)) {
      const view = /** @type {any} */ (value);
      return Buf.from(view.buffer, view.byteOffset, view.byteLength);
    }
  }
  return value;
}

/**
 * The PostgreSQL probe. It replaces the SQLite one wholesale — there is
 * no `sqlite_version()` and no compile-options table here — and every
 * capability it does not name reads `false` from
 * {@link baseCapabilities}, which is what makes the store's refusals
 * fire by name rather than at the first statement.
 * @param {any} raw
 * @returns {any} value-or-promise of the frozen capability table
 */
export function postgresProbe(raw) {
  return chain(raw.prepare("SELECT current_setting('server_version_num') AS num, "
    + "current_setting('server_version') AS version", { buffered: true }), (statement) =>
    chain(statement.get([]), (row) => {
      const num = Number(row?.num);
      const version = String(row?.version ?? '');
      if (!Number.isFinite(num) || num < POSTGRES_FLOOR) {
        throw new DbCompileError('JD0001',
          `the PostgreSQL server is ${version || num}, below the supported floor 16.0`);
      }
      return Object.freeze({
        ...baseCapabilities(),
        version,
        jsonb: true,
        generatedColumns: true,
        returning: true,
        upsert: true,
        savepoints: true,
        // a real ALTER, which is the one structural thing this engine
        // has and SQLite does not
        alterTableFull: true,
        // SQL cursors fetch bounded frames on the same owned session.
        lazyIteration: raw.nativeCursor === true,
        cursorTransaction: raw.nativeCursor === true,
        cursorLifetimeMs: raw.limits?.cursorLifetimeMs,
        maxCursors: raw.limits?.maxCursors,
        statementTimeout: raw.serverTimeouts === true,
        postgres: Object.freeze({ ...raw.limits,
          statementTimeoutMs: raw.serverTimeouts === true ? raw.limits.statementTimeoutMs : null,
          lockTimeoutMs: raw.serverTimeouts === true ? raw.limits.lockTimeoutMs : null,
          cursorMode: raw.nativeCursor === true ? 'native' : 'buffered', poolMode: 'session',
          prepared: raw.preparedMode, cursorCancel: raw.cursorCancel === true }),
        // the closed configuration vocabulary is SQLite's; a PostgreSQL
        // server is configured by its operator
        configurablePragmas: Object.freeze([]),
        // every maintenance operation IS a SQLite pragma
        maintenance: Object.freeze({
          checkpoint: false, integrityCheck: false, foreignKeyCheck: false, optimize: false,
        }),
        // Replication snapshots require the bounded native cursor path.
        jobs: true,
        changeCapture: true,
        replication: raw.nativeCursor === true,
      });
    }));
}

/**
 * Adapt one acquired session. Only an autocommit read whose cached plan
 * was rejected before execution may retry unnamed. Transactions propagate
 * that original failure so their owner can roll back before further work.
 * @param {{ query: Function, release?: Function, getTransactionStatus?: Function }} client
 * @param {any} [options]
 * @returns {any} the raw binding for {@link openConnection}
 */
export function adaptPostgresClient(client, options = undefined) {
  /** @type {Map<string, string>} */
  const names = new Map();
  const prepared = new Set();
  let released = false;
  let inTransaction = false;
  let closing;
  let poisoned = null;
  let activeQuery = null;
  let cancelling = null;
  let fate = 'none';
  let retire = false;
  const limits = postgresSettings(options);
  const requests = workerQueue([{ active: false, healthy: true, readOnly: false }], limits.maxPending, () => performance.now());
  const status = () => client.getTransactionStatus?.() ?? (inTransaction ? 'T' : 'I');
  const cancel = (owner) => {
    if (activeQuery === null || activeQuery.owner !== owner || options?.cancel === undefined) return Promise.resolve();
    if (cancelling !== null) return cancelling;
    const target = activeQuery;
    cancelling = Promise.resolve().then(() => options.cancel(client, target.id))
      .catch((error) => { poisoned = error; throw error; })
      .finally(() => { cancelling = null; });
    return cancelling;
  };

  // Command tags come from the server, including for statements prepared
  // through the public raw adapter. ROLLBACK TO keeps the transaction open.
  const observe = (result, sql) => {
    for (const item of Array.isArray(result) ? result : [result]) {
      if (item?.command === 'BEGIN' || /^\s*(BEGIN|START TRANSACTION)\b/i.test(sql)) {
        inTransaction = true; fate = 'active';
      }
      if (item?.command === 'COMMIT' || /^\s*(COMMIT|END)\b/i.test(sql)) {
        inTransaction = /\bAND CHAIN\s*;?\s*$/i.test(sql); fate = inTransaction ? 'active' : 'committed';
      }
      if ((item?.command === 'ROLLBACK' || /^\s*ROLLBACK\b/i.test(sql)) && !/\bTO\b/i.test(sql)) {
        inTransaction = /\bAND CHAIN\s*;?\s*$/i.test(sql); fate = inTransaction ? 'active' : 'rolled-back';
      }
    }
    return result;
  };
  let querySequence = 0;
  const query = async (sql, values, name, owner) => {
    if (released || poisoned) throw poisoned ?? new DbRuntimeError('JD2063', 'the PostgreSQL session is closed');
    const lease = await requests.acquire(false, { timeoutMs: limits.statementTimeoutMs });
    const operation = { id: ++querySequence, owner };
    activeQuery = operation;
    try {
      if (released || poisoned) throw poisoned ?? new DbRuntimeError('JD2063', 'the PostgreSQL session is closed');
      if (name !== undefined) {
        prepared.add(name);
        const count = (sessionStatementCounts.get(options?.cacheIdentity ?? client) ?? 0) + 1;
        // Count issued names only once, independent of how often they run.
        if (!operationNames.has(name)) { operationNames.add(name); sessionStatementCounts.set(options?.cacheIdentity ?? client, count); }
        if ((sessionStatementCounts.get(options?.cacheIdentity ?? client) ?? 0) >= limits.maxStatements) retire = true;
      }
      const result = await (name !== undefined ? client.query({ name, text: sql, values })
        : values !== undefined ? client.query({ text: sql, values, queryMode: 'extended' }) : client.query(sql));
      return observe(result, sql);
    }
    catch (error) {
      if (/^\s*COMMIT\b/i.test(sql) && !/^(23|40)/.test(error?.code ?? '')) fate = 'unknown';
      if (/^08|^57P0|^ECONN|^EPIPE/.test(error?.code ?? '')) {
        poisoned = error;
        if (inTransaction || /^\s*COMMIT\b/i.test(sql)) fate = 'unknown';
      }
      throw error;
    }
    finally {
      try { if (cancelling !== null) await cancelling; }
      finally { if (activeQuery === operation) activeQuery = null; lease.release(); }
    }
  };
  const operationNames = new Set();
  const cursors = postgresCursors({ query: (sql, params, owner) => query(sql, params, undefined, owner), status, normalize: normalizeRows, cancel,
    unhealthy: (error) => { poisoned = error; } }, limits);
  const boundedRows = (result) => {
    const rows = normalizeRows(result);
    if (rows.length > limits.allMaxRows || rows.reduce((n, row) => n + rowBytes(row), 0) > limits.allMaxBytes)
      throw new DbRuntimeError('JD2092', 'the buffered PostgreSQL result exceeds its row or byte bound');
    return rows;
  };
  const run = (sql, params, read) => {
    if (closing !== undefined) return Promise.reject(new DbRuntimeError('JD2063', 'the PostgreSQL session is closing'));
    const values = params.map(encodeParam);
    const name = names.get(sql);
    return query(sql, values, name).catch((error) => {
      // The routine identifies a planner refusal, not a feature error raised
      // by a function after effects. Never replay a write or an aborted block.
      if (status() !== 'I' || !read || name === undefined || error?.code !== '0A000'
        || error?.routine !== 'RevalidateCachedQuery'
        || error?.message !== 'cached plan must not change result type'
        || !/^\s*SELECT\b/i.test(sql)) throw error;
      names.delete(sql);
      return query(sql, values);
    });
  };
  // DECLARE accepts SELECT/VALUES and read CTEs, but cannot execute a data
  // mutation CTE. Preserve the direct prepared result path for those writes.
  const cursorSql = (sql) => /^\s*(SELECT|VALUES)\b/i.test(sql) || /^\s*WITH\b/i.test(sql)
    && !sqlTokens(sql).some((token) => token.kind === 'word'
      && ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE'].includes(token.value.toUpperCase()));

  return {
    closeDrainsIterators: true,
    nativeCursor: options?.nativeCursor === true,
    serverTimeouts: options?.serverTimeouts === true,
    preparedMode: options?.prepared ?? 'named',
    cursorCancel: typeof options?.cancel === 'function',
    limits, queueCapacity: limits.maxPending,
    metrics: () => Object.freeze({ ...requests.metrics(), ...cursors.metrics(), statements: names.size, transaction: fate }),
    transactionState: () => fate,
    settleCancellation: () => cancelling,
    // Initialization uses the same request owner as normal SQL and cleanup.
    query,
    /** @param {string} sql */
    exec: (sql) => closing !== undefined ? Promise.reject(new DbRuntimeError('JD2063', 'the PostgreSQL session is closing'))
      : query(sql, undefined).then(() => undefined),
    /** @param {string} sql */
    prepare: (sql, metadata = {}) => {
      if (closing !== undefined) throw new DbRuntimeError('JD2063', 'the PostgreSQL session is closing');
      if (!names.has(sql) && options?.prepared !== 'unnamed' && !metadata.ephemeral
        && names.size < limits.maxStatements && (sessionStatementCounts.get(options?.cacheIdentity ?? client) ?? 0) < limits.maxStatements) {
        statementSequence += 1;
        names.set(sql, `jaren_s${statementSequence}`);
      }
      return {
        run: (params = []) => run(sql, params, false)
          .then((result) => ({ changes: result.rowCount ?? 0 })),
        get: async (params = []) => {
          if (closing !== undefined) throw new DbRuntimeError('JD2063', 'the PostgreSQL session is closing');
          if (metadata.buffered || options?.nativeCursor !== true || !cursorSql(sql))
            return boundedRows(await run(sql, params, true))[0];
          const iterator = await cursors.open(sql, params.map(encodeParam), 1);
          try { return (await iterator.next()).value; }
          finally { await iterator.return(); }
        },
        all: async (params = []) => {
          if (closing !== undefined) throw new DbRuntimeError('JD2063', 'the PostgreSQL session is closing');
          if (options?.nativeCursor !== true || !cursorSql(sql))
            return boundedRows(await run(sql, params, true));
          const iterator = await cursors.open(sql, params.map(encodeParam));
          const rows = [];
          let bytes = 0;
          try {
            for await (const row of iterator) {
              bytes += rowBytes(row);
              if (rows.length >= limits.allMaxRows || bytes > limits.allMaxBytes)
                throw new DbRuntimeError('JD2092', 'the buffered PostgreSQL result exceeds its row or byte bound');
              rows.push(row);
            }
            return rows;
          }
          finally { await iterator.return(); }
        },
        ...(options?.nativeCursor !== true ? {} : { iterate: (params = []) => cursors.open(sql, params.map(encodeParam)) }),
      };
    },
    close: () => {
      if (closing !== undefined) return closing;
      const clean = async () => {
        let cursorFailure;
        try { await cursors.close(); }
        catch (error) { cursorFailure = error; poisoned ??= error; }
        await requests.drain();
        if (releasedClient) return;
        released = true;
        requests.stop();
        if (poisoned !== null) {
          await releaseClient(poisoned);
          if (cursorFailure !== undefined) throw cursorFailure;
          return;
        }
        const failures = [];
        if (status() !== 'I') {
          try { await client.query('ROLLBACK'); inTransaction = false; if (fate !== 'unknown') fate = 'rolled-back'; }
          catch (error) { failures.push(error); }
        }
        if (status() === 'I') for (const name of prepared) {
          try { await client.query(`DEALLOCATE "${name}"`); }
          catch (error) { if (error?.code !== '26000') failures.push(error); }
        }
        try { await options?.onClose?.(); }
        catch (error) { failures.push(error); }
        const failure = failures.length === 1 ? failures[0]
          : failures.length > 1 ? new AggregateError(failures, 'PostgreSQL session cleanup failed') : null;
        await releaseClient(failure ?? (retire ? new Error('prepared session cache lifetime exhausted') : undefined));
        if (failure !== null) throw failure;
      };
      let releasedClient = false;
      const releaseClient = async (error) => {
        if (releasedClient) return;
        releasedClient = true;
        names.clear(); prepared.clear(); operationNames.clear();
        if (error && options?.destroy !== undefined) await options.destroy(client, error);
        else await client.release?.(error);
      };
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new DbRuntimeError('JD2090', 'PostgreSQL cleanup deadline expired; the session was discarded');
          released = true; poisoned = error; requests.stop(error);
          if (inTransaction) fate = 'unknown';
          // A broken host's disposal must not postpone the caller's deadline.
          // Its source credit stays quarantined until disposal acknowledges.
          Promise.resolve(releaseClient(error)).catch(() => {});
          reject(error);
        }, limits.closeTimeoutMs);
      });
      closing = Promise.race([clean(), timeout]).finally(() => clearTimeout(timer));
      return closing;
    },
  };
}

/**
 * The PostgreSQL driver over an injected connection source.
 *
 * The source is anything with `connect()` answering a client — a
 * `pg.Pool` is one without adaptation, and a single client becomes one
 * with `{ connect: () => client }`. The store holds the client it
 * acquires for its whole life and releases it once at `close()`.
 *
 * `schema` is where the store lives. It is set on the acquired
 * connection AND given to the dialect, so the catalog statements the
 * shape check and the introspector run look in the same place the DDL
 * created in — one value, two consumers, which is the failure this
 * option exists to prevent.
 * @param {{ connect: Function }} source
 * @param {any} [options]
 * @returns {any}
 */
export function postgresDriver(source, options = undefined) {
  if (source === null || typeof source !== 'object' || typeof source.connect !== 'function') {
    throw new DbCompileError('JD0003',
      'postgresDriver needs an injected connection source exposing connect() — a pg.Pool is '
      + 'one as it stands, and a single client becomes one with { connect: () => client }');
  }
  const limits = postgresSettings(options);
  const admissions = workerQueue(Array.from({ length: limits.maxConnections }, () =>
    ({ active: false, healthy: true, readOnly: false })), limits.queueCapacity, () => performance.now());
  const schema = options?.schema;
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new DbCompileError('JD0003',
      `postgresDriver: '${schema}' is not a schema name this driver will set — the name is `
      + 'written into a SET, so it is a plain identifier or nothing');
  }
  const notifyChannel = options?.notifyChannel === undefined ? undefined : postgresChannel(options.notifyChannel);
  const dialect = postgresDialect({ searchPath: schema, notifyChannel });

  return Object.freeze({
    name: 'postgres',
    dialect,
    metrics: () => admissions.metrics(),
    /**
     * @param {string} [path] - a PostgreSQL store lives in a SCHEMA on a
     *   server, not at a path; anything but the conventional `':memory:'`
     *   is refused by name rather than quietly ignored
     * @param {{ queueTimeout?: number, signal?: AbortSignal }} [openOptions]
     * @returns {Promise<any>}
     */
    open: (path, openOptions) => {
      if (path !== undefined && path !== '' && path !== ':memory:' && path !== schema) {
        return Promise.reject(new DbCompileError('JD0003',
          `this driver was opened with path '${path}', and a PostgreSQL store lives in a `
          + 'schema on a server rather than at a path — name it with '
          + 'postgresDriver(source, { schema })'));
      }
      const deadline = performance.now() + limits.acquisitionTimeoutMs;
      const remaining = () => Math.max(1, deadline - performance.now());
      return admissions.acquire(false, { timeoutMs: remaining(), signal: openOptions?.signal }).then(async (lease) => {
        let timer, abandon, abandoned = false;
        const acquire = Promise.resolve().then(() => source.connect());
        const timeout = new Promise((_, reject) => {
          abandon = () => { abandoned = true; reject(new DbRuntimeError('JD2064',
            'the PostgreSQL source acquisition was aborted', { cause: openOptions?.signal?.reason })); };
          if (openOptions?.signal?.aborted) abandon();
          else openOptions?.signal?.addEventListener('abort', abandon, { once: true });
          timer = setTimeout(() => { abandoned = true; reject(new DbRuntimeError('JD2091',
            'the PostgreSQL source exceeded its acquisition deadline')); }, remaining());
        });
        let client;
        try { client = await Promise.race([acquire, timeout]); }
        catch (error) {
          if (abandoned) acquire.then(async (late) => {
            await late.release?.();
            lease.release();
          }, () => lease.release()).catch(() => {});
          else lease.release();
          throw error;
        }
        finally { clearTimeout(timer); openOptions?.signal?.removeEventListener('abort', abandon); }
        let released = false;
        const release = async (error) => {
          if (released) return;
          released = true;
          if (error && options?.destroy) await options.destroy(client, error);
          else await client.release?.(error);
          // Destruction may finish before an already-sent cancellation does.
          // Retain the admission credit until that delivery settles as well.
          await raw.settleCancellation();
          lease.release();
        };
        let originalPath;
        const savedSettings = new Map();
        const adapted = { query: (...args) => client.query(...args), release,
          ...(typeof client.getTransactionStatus !== 'function' ? {} : { getTransactionStatus: () => client.getTransactionStatus() }) };
        const raw = adaptPostgresClient(adapted, {
          ...options, ...limits, nativeCursor: options?.cursorMode !== 'buffered', serverTimeouts: false,
          // The pool's physical client identity owns the bounded named cache.
          cacheIdentity: client,
          destroy: (_client, error) => release(error),
          cancel: options?.cancel === undefined ? undefined : (_client, id) => options.cancel(client, id),
          onClose: async () => {
            for (const [name, value] of savedSettings)
              await client.query('SELECT pg_catalog.set_config($1, $2, false)', [name, value]);
            if (originalPath !== undefined)
              await client.query("SELECT pg_catalog.set_config('search_path', $1, false)", [originalPath]);
          },
        });
        let setupFailure;
        const initialQuery = (sql, params = undefined) => {
          if (setupFailure) throw setupFailure;
          return raw.query(sql, params);
        };
        const initialize = async () => {
          for (const [name, value] of [['statement_timeout', limits.statementTimeoutMs], ['lock_timeout', limits.lockTimeoutMs]]) {
            const valueBefore = (await initialQuery(`SHOW ${name}`)).rows[0]?.[name];
            if (typeof valueBefore !== 'string') throw new DbRuntimeError('JD2005', `the source did not return ${name}`);
            savedSettings.set(name, valueBefore);
            await initialQuery('SELECT pg_catalog.set_config($1, $2, false)', [name, String(value)]);
          }
          const effective = (await initialQuery("SELECT name, setting::text AS value, unit FROM pg_catalog.pg_settings "
            + "WHERE name IN ('statement_timeout', 'lock_timeout')")).rows;
          for (const [name, value] of [['statement_timeout', limits.statementTimeoutMs], ['lock_timeout', limits.lockTimeoutMs]]) {
            const setting = effective.find((row) => row.name === name);
            if (setting?.unit !== 'ms' || Number(setting?.value) !== value)
              throw new DbRuntimeError('JD2005', `the PostgreSQL source did not apply ${name}`);
          }
          raw.serverTimeouts = true;
          if (schema !== undefined) {
            originalPath = (await initialQuery('SHOW search_path')).rows[0]?.search_path;
            if (typeof originalPath !== 'string')
              throw new DbRuntimeError('JD2005', 'the PostgreSQL source did not return its search_path');
            const row = (await initialQuery(
              "SELECT n.oid::text AS oid, pg_catalog.has_schema_privilege(n.oid, 'USAGE')::text AS usage "
              + 'FROM pg_catalog.pg_namespace n WHERE n.nspname = $1', [schema])).rows[0];
            if (row === undefined) throw Object.assign(new Error(`schema "${schema}" does not exist`), { code: '3F000' });
            if (row.usage !== 'true') throw Object.assign(new Error(`schema "${schema}" requires USAGE`), { code: '42501' });
            // Naming pg_temp explicitly puts it after the owned schema;
            // otherwise PostgreSQL implicitly searches it first.
            await initialQuery("SELECT pg_catalog.set_config('search_path', $1, false)", [`${dialect.quoteIdentifier(schema)}, pg_temp`]);
          }
          return Promise.resolve(openConnection(raw, {
            dialect,
            synchronous: false,
            probe: postgresProbe,
            queueTimeout: openOptions?.queueTimeout ?? options?.queueTimeout,
          })).then((connection) => Object.freeze({ ...connection,
            get mustQueue() { return connection.mustQueue; }, metrics: () => raw.metrics(),
          }), (error) => { throw wrapDriverError(error); });
        };
        const setupDeadline = new Promise((_, reject) => {
          abandon = () => {
            setupFailure = new DbRuntimeError('JD2064', 'PostgreSQL session initialization was aborted', { cause: openOptions?.signal?.reason });
            reject(setupFailure);
          };
          if (openOptions?.signal?.aborted) abandon();
          else openOptions?.signal?.addEventListener('abort', abandon, { once: true });
          timer = setTimeout(() => {
            setupFailure = new DbRuntimeError('JD2091', 'PostgreSQL session initialization exceeded its acquisition deadline');
            reject(setupFailure);
          }, remaining());
        });
        try {
          return await Promise.race([initialize(), setupDeadline]);
        }
        catch (error) {
          const failure = wrapDriverError(error);
          try { await raw.close(); }
          catch (cleanup) {
            if (cleanup !== error) throw new AggregateError([failure, cleanup],
              'the PostgreSQL connection failed to open and cleanup failed');
          }
          throw failure;
        }
        finally { clearTimeout(timer); openOptions?.signal?.removeEventListener('abort', abandon); }
      });
    },
  });
}
