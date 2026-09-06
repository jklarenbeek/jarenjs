//@ts-check
/**
 * @file The PostgreSQL binding: an INJECTED client behind the driver
 * contract, and the PostgreSQL dialect re-exported beside it.
 *
 * This module imports no PostgreSQL package and no runtime builtin.
 * The host supplies a connection source — anything with
 * `connect()` answering `{ query(text, values), release?() }`, which
 * `pg.Pool` is verbatim — and this driver adapts it. That is the whole
 * of D1's "never call a specific npm client outside the adapter seam":
 * there is no seam to leak through, because there is no import.
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
 *    the same ceiling SQLite's INTEGER has — so they are converted, and
 *    a value past 2^53 loses precision here exactly as it would there.
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
import { DbCompileError } from '../errors.js';

export { postgresDialect, IDENTIFIER_BYTES } from '../dialects/postgres.js';

/** The minimum PostgreSQL this store accepts, as the server's own
 * `server_version_num` spells it: 16.0. */
export const POSTGRES_FLOOR = 160000;

/** Types the wire hands back as text because they can exceed a double,
 * and the two it hands back as text for width alone. The store's
 * contract is JavaScript numbers throughout. */
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
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

/**
 * One column's converter, chosen once per result from the type the
 * server declared rather than per value from what it looks like.
 * @param {number} dataTypeID
 * @returns {((value: any) => any) | null} `null` where the wire value
 *   is already what the store reads
 */
function converterFor(dataTypeID) {
  if (NUMERIC_OIDS.has(dataTypeID)) {
    return (value) => (value === null || value === undefined ? value : Number(value));
  }
  if (dataTypeID === BOOL_OID) {
    return (value) => (value === null || value === undefined ? value : (value ? 1 : 0));
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
    + "current_setting('server_version') AS version"), (statement) =>
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
        // no cursor without a second package; the store's cursor says it
        // buffers rather than pretending it streams
        lazyIteration: false,
        // the closed configuration vocabulary is SQLite's; a PostgreSQL
        // server is configured by its operator
        configurablePragmas: Object.freeze([]),
        // every maintenance operation IS a SQLite pragma
        maintenance: Object.freeze({
          checkpoint: false, integrityCheck: false, foreignKeyCheck: false, optimize: false,
        }),
        // the job queue and the change ledger write their own SQLite
        // statements; both refuse by name at open here
        jobs: false,
        changeCapture: false,
      });
    }));
}

/**
 * Adapt one acquired client into the raw binding contract.
 *
 * Statements are PREPARED by name, so the server plans each one once
 * and the store's statement caches are worth having. The one hazard is
 * a cached plan whose result type changed under it — a migration that
 * added a column to a table a live statement selects `*` from — which
 * PostgreSQL reports as `0A000`; the name is dropped and the statement
 * re-runs unnamed, so the caller sees a slower call rather than an
 * error it could do nothing about.
 * @param {{ query: Function, release?: Function }} client
 * @param {{ onClose?: () => any }} [options]
 * @returns {any} the raw binding for {@link openConnection}
 */
export function adaptPostgresClient(client, options = undefined) {
  /** @type {Map<string, string>} sql -> the server-side statement name */
  const names = new Map();
  /** The names the server actually holds — a name is only prepared by
   * its first execution, and deallocating one it never saw is an error
   * of its own. */
  const prepared = new Set();
  /** Released exactly once: on success, on failure, and on a second
   * `close()`, which the connection contract makes a no-op anyway. */
  let released = false;

  const run = (sql, params) => {
    const values = params.map(encodeParam);
    const name = names.get(sql);
    const attempt = name === undefined
      ? client.query(sql, values)
      : client.query({ name, text: sql, values });
    return Promise.resolve(attempt).then((result) => {
      if (name !== undefined) prepared.add(name);
      return result;
    }, (error) => {
      // the cached plan's result type changed under it
      if (error?.code !== '0A000' || name === undefined) throw error;
      names.delete(sql);
      prepared.delete(name);
      return client.query(sql, values);
    });
  };

  return {
    /** @param {string} sql */
    exec: (sql) => Promise.resolve(client.query(sql)).then(() => undefined),
    /** @param {string} sql */
    prepare: (sql) => {
      if (!names.has(sql)) {
        statementSequence += 1;
        names.set(sql, `jaren_s${statementSequence}`);
      }
      return {
        run: (params = []) => run(sql, params)
          .then((result) => ({ changes: result.rowCount ?? 0 })),
        get: (params = []) => run(sql, params).then((result) => normalizeRows(result)[0]),
        all: (params = []) => run(sql, params).then((result) => normalizeRows(result)),
      };
    },
    close: () => {
      if (released) return Promise.resolve(undefined);
      released = true;
      // the session goes back to the pool without this store's
      // statements on it. A failure here is not the caller's to handle:
      // the client is being released either way, and a leaked plan is
      // memory rather than a wrong answer
      const deallocate = [...prepared].reduce(
        (chained, name) => chained.then(
          () => client.query(`DEALLOCATE "${name}"`), () => undefined).then(
          () => undefined, () => undefined),
        Promise.resolve(undefined));
      return deallocate
        .then(() => options?.onClose?.())
        .then(() => client.release?.(), () => client.release?.())
        .then(() => undefined);
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
 * @param {{ schema?: string, queueTimeout?: number }} [options]
 * @returns {any}
 */
export function postgresDriver(source, options = undefined) {
  if (source === null || typeof source !== 'object' || typeof source.connect !== 'function') {
    throw new DbCompileError('JD0003',
      'postgresDriver needs an injected connection source exposing connect() — a pg.Pool is '
      + 'one as it stands, and a single client becomes one with { connect: () => client }');
  }
  const schema = options?.schema;
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new DbCompileError('JD0003',
      `postgresDriver: '${schema}' is not a schema name this driver will set — the name is `
      + 'written into a SET, so it is a plain identifier or nothing');
  }
  const dialect = postgresDialect(schema === undefined ? undefined : { searchPath: schema });

  return Object.freeze({
    name: 'postgres',
    dialect,
    /**
     * @param {string} [path] - a PostgreSQL store lives in a SCHEMA on a
     *   server, not at a path; anything but the conventional `':memory:'`
     *   is refused by name rather than quietly ignored
     * @param {{ queueTimeout?: number }} [openOptions]
     * @returns {Promise<any>}
     */
    open: (path, openOptions) => {
      if (path !== undefined && path !== '' && path !== ':memory:' && path !== schema) {
        return Promise.reject(new DbCompileError('JD0003',
          `this driver was opened with path '${path}', and a PostgreSQL store lives in a `
          + 'schema on a server rather than at a path — name it with '
          + 'postgresDriver(source, { schema })'));
      }
      return Promise.resolve(source.connect()).then((client) => {
        const raw = adaptPostgresClient(client);
        const prepared = schema === undefined
          ? Promise.resolve(undefined)
          // the schema is created by the operator or by the caller; the
          // driver only points the connection at it, and a name that is
          // not there fails as `3F000` — classified `cantopen`
          : raw.exec(`SET search_path TO ${dialect.quoteIdentifier(schema)}`);
        return Promise.resolve(prepared)
          .then(() => openConnection(raw, {
            dialect,
            synchronous: false,
            probe: postgresProbe,
            queueTimeout: openOptions?.queueTimeout ?? options?.queueTimeout,
          }))
          .catch((error) => Promise.resolve(raw.close()).then(() => {
            throw error;
          }, () => {
            throw error;
          }));
      });
    },
  });
}
