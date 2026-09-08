//@ts-check
/**
 * @file Change capture (D13): committed writes become an observable,
 * ordered stream of RFC 6902 patches — derived from SQLite's own
 * session changesets where the binding has them, from a write-path
 * journal where it does not (`bun:sqlite` has no `createSession`), or
 * off entirely. One diff format then runs end to end: store → patch →
 * live query → patch → O(k) render.
 *
 * The pointer contract (LIVE-FORMAT §2): `/<table>/<key>/<path…>`,
 * every token escaped per RFC 6901. A single key renders as its
 * scalar text (integers in decimal); a composite key renders as the
 * JSON text of its parts array. Join-table rows are tiny documents
 * under the join table's name — membership changes are part of the
 * stream, not a blind spot.
 *
 * Session facts this file is built on (probed, 3.51.2):
 * - a changeset carries ONE NET OP PER ROW (insert+update coalesce;
 *   insert+delete vanish; a no-op update is absent), and within-table
 *   order is NOT statement order — every row op targets a distinct
 *   pointer, so application order across rows cannot matter;
 * - `ROLLBACK TO` a savepoint removes the undone rows from the
 *   session (pinned by test — the classic caveat does NOT hold here);
 * - a rolled-back transaction yields an empty changeset;
 * - virtual generated columns are invisible;
 * - an UPDATE's old record carries the primary key and the CHANGED
 *   columns only — which is exactly enough for property-level ops,
 *   and why the doc column's old/new blobs make a minimal nested
 *   diff possible (`SELECT json(?)` turns JSONB back into text).
 */

import { createJSONPatch } from '@jarenjs/json/patch';
import { encodeJSONPointerSegment, decodeJSONPointerSegment } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, attempt } from './driver.js';
import { createCursor, drainPage, utf8Length, PAGE_LIMIT_DEFAULT } from './cursor.js';

/** The persisted change log (LIVE-FORMAT §5). */
export const CHANGES_TABLE = '_jaren_changes';
/**
 * The log's durable state: one row holding the highest sequence ever
 * allocated for this file, so the high watermark survives a log that
 * retention or maintenance has emptied (LIVE-FORMAT §5).
 */
export const CHANGES_STATE_TABLE = '_jaren_changes_state';
export const DEFAULT_RETENTION = 1000;

/** A driver failure met by the change reader, classified — never raw. */
const captureFailure = (error) => wrapDriverError(error, { docPath: '/capture' });

//#region the binary changeset parser

const OP_INSERT = 18;
const OP_UPDATE = 23;
const OP_DELETE = 9;

/**
 * Parse one SQLite varint (1–9 bytes, big-endian 7-bit groups, the
 * ninth byte carrying 8 bits).
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {{ value: number, next: number }}
 */
function readVarint(bytes, at) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i];
    if ((byte & 0x80) === 0) return { value: value * 128 + byte, next: at + i + 1 };
    value = value * 128 + (byte & 0x7f);
  }
  return { value: value * 256 + bytes[at + 8], next: at + 9 };
}

const utf8 = new TextDecoder();

/**
 * Read one value record. `undefined` means "not present in this
 * record" (an unchanged column); `null` is SQL NULL.
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {{ value: any, next: number }}
 */
function readValue(bytes, at) {
  const type = bytes[at];
  at += 1;
  if (type === 0) return { value: undefined, next: at };
  if (type === 5) return { value: null, next: at };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 1) {
    const big = view.getBigInt64(at);
    // JS documents cannot produce integers beyond 2^53 through this
    // store; a raw-SQL value beyond it converts lossily (documented)
    return { value: Number(big), next: at + 8 };
  }
  if (type === 2) return { value: view.getFloat64(at), next: at + 8 };
  const { value: length, next } = readVarint(bytes, at);
  const slice = bytes.subarray(next, next + length);
  if (type === 3) return { value: utf8.decode(slice), next: next + length };
  if (type === 4) return { value: slice.slice(), next: next + length };
  throw new DbRuntimeError('JD2050',
    `unknown changeset value type ${type} at offset ${at - 1}`);
}

/**
 * Decode a binary changeset into row operations.
 * @param {Uint8Array} bytes
 * @returns {{ table: string, pk: boolean[], op: 'insert'|'update'|'delete',
 *   indirect: boolean, oldValues: any[] | null, newValues: any[] | null }[]}
 */
export function parseChangeset(bytes) {
  /** @type {any[]} */
  const operations = [];
  let at = 0;
  let table = '';
  let columnCount = 0;
  /** @type {boolean[]} */
  let pk = [];
  const readRecord = () => {
    const values = [];
    for (let i = 0; i < columnCount; i++) {
      const read = readValue(bytes, at);
      values.push(read.value);
      at = read.next;
    }
    return values;
  };
  while (at < bytes.length) {
    const marker = bytes[at];
    if (marker === 0x54 /* 'T' */ || marker === 0x50 /* 'P' */) {
      at += 1;
      const n = readVarint(bytes, at);
      columnCount = n.value;
      at = n.next;
      pk = [];
      for (let i = 0; i < columnCount; i++) pk.push(bytes[at + i] !== 0);
      at += columnCount;
      let end = at;
      while (bytes[end] !== 0) end += 1;
      table = utf8.decode(bytes.subarray(at, end));
      at = end + 1;
      continue;
    }
    const op = bytes[at];
    const indirect = bytes[at + 1] !== 0;
    at += 2;
    if (op === OP_INSERT) {
      operations.push({ table, pk, op: 'insert', indirect,
        oldValues: null, newValues: readRecord() });
    }
    else if (op === OP_DELETE) {
      operations.push({ table, pk, op: 'delete', indirect,
        oldValues: readRecord(), newValues: null });
    }
    else if (op === OP_UPDATE) {
      const oldValues = readRecord();
      operations.push({ table, pk, op: 'update', indirect,
        oldValues, newValues: readRecord() });
    }
    else {
      throw new DbRuntimeError('JD2050',
        `unknown changeset op ${op} at offset ${at - 2}`);
    }
  }
  return operations;
}

//#endregion

//#region the pointer contract

/**
 * The key token (LIVE-FORMAT §2): a single key is its scalar text;
 * a composite key is the JSON text of its parts array.
 * @param {any[]} parts
 * @returns {string}
 */
export function keyToken(parts) {
  return parts.length === 1 ? String(parts[0]) : JSON.stringify(parts);
}

const pointerOf = (table, token, path = '') =>
  `/${encodeJSONPointerSegment(table)}/${encodeJSONPointerSegment(token)}${path}`;

//#endregion

//#region translation

/**
 * @typedef {{ kind: 'collection' | 'entity' | 'join',
 *   columns: { name: string, role: 'key'|'doc'|'scalar'|'fk'|'epoch',
 *     storage?: string }[],
 *   keyIndexes: number[], docIndex: number }} TableShape
 */

/** Decode one stored column value to its DOCUMENT-level value. */
function documentValue(column, value) {
  if (value === null || value === undefined) return value;
  if (column.storage === 'boolean') return value === 1;
  return value;
}

/**
 * Translate parsed row operations into RFC 6902 ops, resolving JSONB
 * blobs through the connection (`SELECT json(?)`).
 * @param {any} connection
 * @param {Map<string, TableShape>} shapes
 * @param {any[]} operations
 * @returns {any} value-or-promise of RFC 6902 ops
 */
export function translateOperations(connection, shapes, operations) {
  const jsonOf = (blob) => (blob === undefined || blob === null
    ? blob
    : chain(connection.prepare('SELECT json(?) AS t'), (statement) =>
      chain(statement.get([blob]), (row) => JSON.parse(row.t))));

  /** @type {any[]} */
  const ops = [];
  /** Translate ONE operation, mutating `ops`; value-or-promise. The
   * caller drives ITERATIVELY — a self-recursive walk overflowed the
   * stack on a 10k-row transaction (found by the live-query
   * measurement, fixed here). */
  const translateOne = (operation) => {
    const shape = shapes.get(operation.table);
    if (shape === undefined) return null; // an internal table
    const record = operation.newValues ?? operation.oldValues ?? [];
    const token = keyToken(shape.keyIndexes.map((index) =>
      (operation.op === 'update'
        ? operation.oldValues?.[index]
        : record[index])));

    if (shape.kind === 'join') {
      // membership rows are tiny documents under the join table's name
      if (operation.op === 'insert') {
        const value = {};
        for (let c = 0; c < shape.columns.length; c++)
          value[shape.columns[c].name] = record[c];
        ops.push({ op: 'add', path: pointerOf(operation.table, token), value });
      }
      else if (operation.op === 'delete') {
        ops.push({ op: 'remove', path: pointerOf(operation.table, token) });
      }
      return null;
    }

    const buildDocument = (values) => chain(
      jsonOf(values[shape.docIndex]), (doc) => {
        const out = doc ?? {};
        for (let c = 0; c < shape.columns.length; c++) {
          const column = shape.columns[c];
          if (column.role === 'doc' || column.role === 'epoch') continue;
          // a collection's key column is physical bookkeeping — the
          // document carries its own key member per the model
          if (shape.kind === 'collection' && column.role === 'key') continue;
          const value = values[c];
          if (value === null || value === undefined) continue;
          out[column.name] = documentValue(column, value);
        }
        return out;
      });

    if (operation.op === 'insert') {
      return chain(buildDocument(record), (doc) => {
        ops.push({ op: 'add', path: pointerOf(operation.table, token), value: doc });
        return null;
      });
    }
    if (operation.op === 'delete') {
      ops.push({ op: 'remove', path: pointerOf(operation.table, token) });
      return null;
    }
    // update: property-level ops from the CHANGED columns; the doc
    // column diffs old against new for a minimal nested patch
    const columnOps = () => {
      for (let c = 0; c < shape.columns.length; c++) {
        const column = shape.columns[c];
        const newValue = operation.newValues[c];
        if (newValue === undefined || column.role === 'doc') continue;
        if (column.role === 'epoch') continue; // derived; the doc string decides
        if (shape.kind === 'collection' && column.role === 'key') continue;
        const oldValue = operation.oldValues[c];
        const path = pointerOf(operation.table, token, `/${encodeJSONPointerSegment(column.name)}`);
        if (newValue === null) {
          if (oldValue !== null) ops.push({ op: 'remove', path });
        }
        else if (oldValue === null) {
          ops.push({ op: 'add', path, value: documentValue(column, newValue) });
        }
        else {
          ops.push({ op: 'replace', path, value: documentValue(column, newValue) });
        }
      }
    };
    const newDocBlob = operation.newValues[shape.docIndex];
    if (newDocBlob === undefined) {
      columnOps();
      return null;
    }
    return chain(jsonOf(operation.oldValues[shape.docIndex]), (oldDoc) =>
      chain(jsonOf(newDocBlob), (newDoc) => {
        columnOps();
        const prefix = pointerOf(operation.table, token);
        for (const op of createJSONPatch(oldDoc ?? {}, newDoc ?? {})) {
          ops.push({ ...op, path: `${prefix}${op.path}`,
            ...(op.from !== undefined ? { from: `${prefix}${op.from}` } : {}) });
        }
        return null;
      }));
  };
  let index = 0;
  const drive = () => {
    while (index < operations.length) {
      const outcome = translateOne(operations[index]);
      index += 1;
      if (outcome instanceof Promise) return outcome.then(drive);
    }
    return ops;
  };
  return drive();
}

//#endregion

//#region the capture engine

/**
 * @param {{ connection: any, shapes: Map<string, TableShape>,
 *   mode: 'session' | 'journal',
 *   log: boolean, retention: number,
 *   now?: () => number,
 *   bracket?: (fn: () => any) => any,
 *   beforeCommit?: (patch: any[], context: any) => any }} options - `now` is the clock a
 *   delivery is stamped with (the store's runtime record); the platform's
 *   when absent. `bracket` runs the first-open DDL (the store's immediate
 *   transaction on a writable store); bare when absent
 * @returns {any}
 */
export function createCaptureEngine(options) {
  const { connection, shapes, mode } = options;
  const clock = options.now ?? Date.now;
  const bracket = options.bracket ?? ((/** @type {() => any} */ fn) => fn());
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  if (options.log && !(Number.isInteger(options.retention) && options.retention >= 1)) {
    // a retention of 0 pruned every record the moment it was written,
    // with the log reported as enabled
    throw new TypeError('capture.log.retention must be a positive integer (records kept)');
  }

  /** @type {Set<Function>} */
  const observers = new Set();
  // the last sequence THIS process delivered: the per-process sequence
  // when no log is kept, and otherwise the file's allocation read back
  // from the durable row — never an answer to a watermark question
  let seq = 0;
  let depth = 0;
  let context = null;
  /** @type {any} */
  let session = null;
  /** @type {any[]} */
  let journal = [];
  /** @type {any[]} */
  const pendingDeliveries = [];

  const logStatements = options.log ? {
    create: dialect.ddl.createPlainTable({
      table: CHANGES_TABLE,
      columns: [
        { name: 'seq', type: dialect.typeFor('integer', 'key'), primaryKey: true },
        { name: 'at', type: dialect.typeFor('integer', 'key') },
        { name: 'source', type: dialect.typeFor('string', 'key') },
        { name: 'patch', type: dialect.typeFor('string', 'key') },
      ],
    }),
    // the durable high watermark: a singleton row the file keeps, so an
    // emptied log still knows the highest sequence it ever allocated
    createState: dialect.ddl.createPlainTable({
      table: CHANGES_STATE_TABLE,
      columns: [
        { name: 'id', type: dialect.typeFor('integer', 'key'), primaryKey: true },
        { name: 'high', type: dialect.typeFor('integer', 'key') },
      ],
    }),
    // idempotent: an existing file is upgraded ONCE from its surviving
    // maximum (a file that never held a row seeds 0); a second open, or
    // a second store on the same file, changes nothing
    hasState: `SELECT 1 AS ${q('present')} FROM ${q(CHANGES_STATE_TABLE)} WHERE ${q('id')} = 1`,
    seedState: `INSERT INTO ${q(CHANGES_STATE_TABLE)} (${q('id')}, ${q('high')}) `
      + `SELECT 1, (SELECT COALESCE(MAX(${q('seq')}), 0) FROM ${q(CHANGES_TABLE)}) `
      + `WHERE NOT EXISTS (SELECT 1 FROM ${q(CHANGES_STATE_TABLE)} WHERE ${q('id')} = 1)`,
    // the sequence is allocated by ONE statement against the durable
    // row, inside the write's own transaction: the next value is one
    // past the higher of the durable watermark and whatever survives in
    // the log (so a state row that went missing can never lower it), and
    // a rolled-back write takes its allocation back with the row. A
    // process counter seeded once at open collided with another store's
    // writes to the same file; the durable row is the file's fact, so two
    // stores allocate distinct, increasing sequences.
    allocate: `INSERT INTO ${q(CHANGES_STATE_TABLE)} (${q('id')}, ${q('high')}) `
      + `VALUES (1, (SELECT COALESCE(MAX(${q('seq')}), 0) + 1 FROM ${q(CHANGES_TABLE)})) `
      + `ON CONFLICT (${q('id')}) DO UPDATE SET ${q('high')} = CASE `
      + `WHEN ${q(CHANGES_STATE_TABLE)}.${q('high')} + 1 > ${dialect.excludedRef(q('high'))} `
      + `THEN ${q(CHANGES_STATE_TABLE)}.${q('high')} + 1 ELSE ${dialect.excludedRef(q('high'))} END `
      + `RETURNING ${q('high')} AS ${q('seq')}`,
    insert: `INSERT INTO ${q(CHANGES_TABLE)} `
      + `(${['seq', 'at', 'source', 'patch'].map(q).join(', ')}) `
      + `VALUES (${[1, 2, 3, 4].map((i) => dialect.parameterRef(i, 'v')).join(', ')})`,
    prune: `DELETE FROM ${q(CHANGES_TABLE)} WHERE ${q('seq')} <= ${dialect.parameterRef(1, 'v')}`,
    read: `SELECT ${['seq', 'at', 'source', 'patch'].map(q).join(', ')} `
      + `FROM ${q(CHANGES_TABLE)} WHERE ${q('seq')} > ${dialect.parameterRef(1, 'v')} `
      + `ORDER BY ${q('seq')}`,
    // the bounded read: a page of records after a cursor, one more than
    // the page so `hasMore` is a fact and not a guess
    readPage: `SELECT ${['seq', 'at', 'source', 'patch'].map(q).join(', ')} `
      + `FROM ${q(CHANGES_TABLE)} WHERE ${q('seq')} > ${dialect.parameterRef(1, 'v')} `
      + `ORDER BY ${q('seq')} LIMIT ${dialect.parameterRef(2, 'v')}`,
    // the two watermarks are the FILE's facts: the earliest surviving
    // row, and the durable high (falling back to the surviving maximum
    // only for a file whose state row is absent — never to this process)
    bounds: `SELECT (SELECT MIN(${q('seq')}) FROM ${q(CHANGES_TABLE)}) AS ${q('lo')}, `
      + `COALESCE((SELECT ${q('high')} FROM ${q(CHANGES_STATE_TABLE)} WHERE ${q('id')} = 1), `
      + `(SELECT MAX(${q('seq')}) FROM ${q(CHANGES_TABLE)}), 0) AS ${q('hi')}`,
  } : null;

  const ready = logStatements === null
    ? null
    // the seed is written only when the row is absent: a read-only open
    // of an already-upgraded file reads the row and writes nothing
    : chain(attempt(() => bracket(() => chain(connection.exec(logStatements.create), () =>
      chain(connection.exec(logStatements.createState), () =>
        chain(connection.prepare(logStatements.hasState), (probe) => chain(probe.get([]), (row) =>
          (row === undefined || row === null
            ? chain(connection.prepare(logStatements.seedState), (statement) => statement.run([]))
            : null)))))),
    (error) => new DbCompileError('JD0002',
      `the change log table could not be created (${error?.message ?? String(error)}) — `
      + 'a read-only store creates nothing; open it read-write once, or without capture.log',
      '/capture', error)), () => null);

  /** A patch value must be JSON: a `{ ...doc, m: undefined }` write
   * stores the member ABSENT, and the journal must record the JSON
   * reality, not the JavaScript artifact. `undefined`/`null` sentinels
   * pass through untouched. */
  const jsonReality = (doc) => (doc === undefined || doc === null
    ? doc
    : JSON.parse(JSON.stringify(doc)));

  /** Journal-mode emission from the write paths. */
  const record = (table, keyParts, before, after) => {
    if (mode !== 'journal' || depth === 0) return;
    journal.push({ table, keyParts,
      before: jsonReality(before), after: jsonReality(after) });
  };

  const journalOps = () => {
    // ONE NET OP PER ROW (§2), the same discipline sessions get for
    // free: fold every entry for one (table, key) into first-before /
    // last-after, so insert+update coalesces, insert+delete vanishes,
    // and an update back to the original emits nothing. Found by the
    // wasm parity suite — the original differential script never wrote
    // the same row twice in one transaction.
    /** @type {Map<string, any>} */
    const netted = new Map();
    /** @type {string[]} */
    const order = [];
    for (const entry of journal) {
      const token = keyToken(entry.keyParts);
      const key = `${entry.table}\u0000${token}`;
      const existing = netted.get(key);
      if (existing === undefined) {
        netted.set(key, {
          table: entry.table, token,
          before: entry.before, after: entry.after,
        });
        order.push(key);
      }
      else {
        existing.after = entry.after;
      }
    }
    /** @type {any[]} */
    const ops = [];
    for (const key of order) {
      const entry = netted.get(key);
      const prefix = pointerOf(entry.table, entry.token);
      if (entry.before === null && entry.after === null) continue;
      if (entry.before === null) {
        ops.push({ op: 'add', path: prefix, value: entry.after });
      }
      else if (entry.after === null) {
        ops.push({ op: 'remove', path: prefix });
      }
      else {
        for (const op of createJSONPatch(entry.before, entry.after)) {
          ops.push({ ...op, path: `${prefix}${op.path}`,
            ...(op.from !== undefined ? { from: `${prefix}${op.from}` } : {}) });
        }
      }
    }
    return ops;
  };

  /** Collect this commit's patch (inside the transaction). */
  const collect = () => {
    if (mode === 'session') {
      const changeset = session.changeset();
      session.close();
      session = null;
      if (changeset.length === 0) return [];
      return translateOperations(connection, shapes, parseChangeset(changeset));
    }
    const ops = journalOps();
    journal = [];
    return ops;
  };

  const persist = (patch, at) => {
    if (logStatements === null || patch.length === 0) return null;
    return chain(connection.prepare(logStatements.allocate), (allocate) =>
      chain(allocate.get([]), (row) => {
        seq = Number(row.seq);
        return chain(connection.prepare(logStatements.insert), (insert) =>
          chain(insert.run([seq, at, mode, JSON.stringify(patch)]), () =>
            chain(connection.prepare(logStatements.prune), (prune) =>
              chain(prune.run([seq - options.retention]), () => null))));
      }));
  };

  /** The collections a patch touches, in first-seen order. */
  const collectionsOf = (patch) => [...new Set(patch.map(
    (op) => decodeJSONPointerSegment(op.path.split('/')[1])))];

  let delivering = false;
  const deliver = () => {
    // never re-entered: an observer that WRITES commits a further record
    // from inside this loop, and delivering that record here handed it to
    // every sibling before the older one — commit order inverted for
    // them, and a maintained view kept a stale row for good. The nested
    // call queues its record; this loop drains it after the current one.
    if (delivering) return;
    delivering = true;
    try {
      while (pendingDeliveries.length > 0) {
        const delivery = pendingDeliveries.shift();
        for (const observer of [...observers]) {
          // error isolation: a throwing observer must never affect the
          // write (the app.observe discipline)
          try {
            observer(delivery);
          }
          catch {
            // deliberately swallowed; the write already committed
          }
        }
      }
    }
    finally {
      delivering = false;
    }
  };

  /**
   * Run `fn` inside the capture scope: the OUTERMOST scope opens a
   * session (or journal buffer) plus a transaction, translates and
   * persists inside it, and delivers to observers after commit.
   *
   * The transaction's scope arguments are FORWARDED to `fn`: the store
   * pins a transaction view to the exact scope its callback runs in,
   * and with capture that is the scope this wrap opens, not the one
   * around it. Callers that need no scope simply ignore the arguments.
   */
  const wrap = (fn) => {
    if (depth > 0) return fn();
    depth = 1;
    const cleanupFailure = () => {
      depth = 0;
      context = null;
      if (session !== null) {
        session.close();
        session = null;
      }
      journal = [];
    };
    let outcome;
    try {
      if (mode === 'session') session = connection.session();
      else journal = [];
      outcome = connection.transaction((...scopeArgs) =>
        chain(fn(...scopeArgs), (result) =>
          chain(collect(), (patch) => chain(options.beforeCommit?.(patch, context), () => {
            if (patch.length === 0) return { result, delivery: null };
            const at = clock();
            return chain(persist(patch, at), () => ({
              result,
              delivery: {
                seq: logStatements === null ? (seq += 1) : seq,
                at,
                source: mode,
                collections: collectionsOf(patch),
                patch,
              },
            }));
          }))));
    }
    catch (error) {
      cleanupFailure();
      throw error;
    }
    const finish = (bundle) => {
      depth = 0;
      context = null;
      if (bundle.delivery !== null) pendingDeliveries.push(bundle.delivery);
      deliver();
      return bundle.result;
    };
    if (outcome instanceof Promise) {
      return outcome.then(finish, (error) => {
        cleanupFailure();
        throw error;
      });
    }
    return finish(outcome);
  };

  /**
   * A NESTED transaction scope: in journal mode, records buffered by
   * an inner transaction that rolls back (and whose failure the
   * caller CATCHES) must vanish exactly as a session drops rows
   * undone by ROLLBACK TO — checkpoint the buffer and truncate on
   * failure.
   */
  const nest = (fn) => {
    if (depth === 0) return wrap(fn);
    if (mode !== 'journal') return fn();
    const mark = journal.length;
    let outcome;
    try {
      outcome = fn();
    }
    catch (error) {
      journal.length = mark;
      throw error;
    }
    if (outcome instanceof Promise) {
      return outcome.then((value) => value, (error) => {
        journal.length = mark;
        throw error;
      });
    }
    return outcome;
  };

  /**
   * The journal's checkpoint pair for NAMED partial rollback
   * (MODEL-FORMAT §5.2). A named `SAVEPOINT` takes a mark; a
   * `ROLLBACK TO` truncates the buffer to it, so records the engine
   * undid vanish from the commit's patch exactly as a session drops
   * rows undone by `ROLLBACK TO`. Session mode needs neither half —
   * SQLite's own changeset already excludes the undone rows — and
   * answers `null` so the caller stores nothing.
   */
  const mark = () => (mode === 'journal' ? journal.length : null);
  /** @param {number | null} at - a value {@link mark} answered */
  const truncate = (at) => {
    if (mode === 'journal' && at !== null && journal.length > at) journal.length = at;
  };

  return {
    mode,
    ready,
    wrap,
    nest,
    mark,
    truncate,
    record,
    // Metadata belongs to this capture transaction and is cleared on every
    // settlement, including a failure while collecting or persisting changes.
    setContext(value) {
      if (depth === 0) throw new TypeError('capture context needs an active transaction');
      context = value;
    },
    observe(fn) {
      if (typeof fn !== 'function')
        throw new TypeError('observe needs a function');
      observers.add(fn);
      return () => observers.delete(fn);
    },
    /**
     * Read the persisted log forward from `after` — EVERY surviving
     * record, in one array, with no bound and no watermark: a
     * reconnecting consumer whose cursor fell below the retention floor
     * receives the surviving suffix and cannot tell it from the whole.
     * Kept for its callers; `changes.page()` is the bounded reader that
     * reports the gap instead (LIVE-FORMAT §5).
     * @param {number} after - the last seq seen
     */
    changesSince(after) {
      requireLog('changesSince');
      requireCursor(after, 'changesSince');
      return chain(connection.prepare(logStatements.read), (statement) =>
        chain(attempt(() => statement.all([after]), captureFailure), (rows) => rows.map(recordOf)));
    },
    /** Whether the persisted log exists — what decides whether the
     * bounded reader is offered at all. */
    logged: logStatements !== null,
    bounds: () => readBounds(),
    page: (options) => readPage(options),
  };

  /** @param {string} member */
  function requireLog(member) {
    if (logStatements !== null) return;
    throw new DbRuntimeError('JD2051',
      `${member}: the change log is not enabled — open the store with capture.log`);
  }
  /** @param {any} after @param {string} member */
  function requireCursor(after, member) {
    if (typeof after === 'number' && Number.isFinite(after)) return;
    throw new TypeError(`${member} takes the last seq seen as a number (after), got ${
      after === undefined ? 'undefined' : JSON.stringify(after)}`);
  }
  /** The record shape observers receive, `collections` included. */
  function recordOf(row) {
    const patch = JSON.parse(row.patch);
    return {
      seq: Number(row.seq),
      at: Number(row.at),
      source: String(row.source),
      collections: collectionsOf(patch),
      patch,
    };
  }
  /**
   * The log's two watermarks: the earliest surviving sequence (`null`
   * when nothing survives) and the highest ever allocated, read from the
   * durable state row. Both are the FILE's facts, never this process's:
   * an emptied log, a reopened file and a second store over the same
   * file all answer the same high watermark, so a stale consumer meets a
   * reset rather than a plausible empty history.
   */
  function readBounds() {
    requireLog('changes.bounds');
    return chain(connection.prepare(logStatements.bounds), (statement) =>
      chain(attempt(() => statement.get([]), captureFailure), (row) => ({
        earliestAvailable: row?.lo === null || row?.lo === undefined ? null : Number(row.lo),
        highWatermark: Number(row?.hi ?? 0),
      })));
  }
  /**
   * One bounded page of the log after `after`: never more than `limit`
   * records or `maxBytes` serialised patch bytes (the one page drain,
   * cursor.js — a record larger than `maxBytes` is its `JD2074`, the
   * cursor not advanced), `hasMore` by one peek, `signal` honoured at a
   * record boundary. The watermarks are read AFTER the rows: a floor
   * that rose during the read can only make the reset verdict stricter,
   * never let a pruned gap pass as a continuation. A cursor below the
   * floor — the record after `after` no longer survives — is a TOTAL
   * refusal: `resetRequired: true`, no items, no `next`, because a
   * partial suffix beside a reset flag invites a consumer to use both.
   * @param {{ after: number, limit?: number, maxBytes?: number | null,
   *   signal?: AbortSignal }} options
   */
  function readPage(options) {
    requireLog('changes.page');
    const after = options?.after;
    requireCursor(after, 'changes.page');
    const limit = options?.limit ?? PAGE_LIMIT_DEFAULT;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError('changes.page: limit must be a positive integer');
    const declaredBytes = options?.maxBytes;
    const maxBytes = declaredBytes === undefined || declaredBytes === null || declaredBytes === Infinity
      ? null : declaredBytes;
    if (maxBytes !== null && !(Number.isSafeInteger(maxBytes) && maxBytes >= 1))
      throw new TypeError('changes.page: maxBytes must be a positive integer, or Infinity for no byte bound');
    const deadline = options?.deadline;
    if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline)))
      throw new TypeError('changes.page: deadline is an epoch-millisecond number');
    // the deadline is read against the store's clock at every record
    // boundary, as on every other page (JD2075)
    const cursor = createCursor({ streaming: 'row', barrier: null, signal: options?.signal, deadline, now: clock,
      open: () => chain(connection.prepare(logStatements.readPage),
        (statement) => statement.iterate([after, limit + 1])),
      wrap: captureFailure,
      items: (row) => [{ record: recordOf(row), bytes: utf8Length(String(row.patch)) }] });
    return drainPage(cursor, {
      limit, maxBytes, after,
      sizeOf: (item) => item.bytes,
      continuationOf: (item) => item.record.seq,
    }).then((page) => chain(readBounds(), (bounds) => {
      const first = bounds.earliestAvailable ?? bounds.highWatermark + 1;
      if (after + 1 < first) {
        return { items: [], ...bounds, hasMore: false, resetRequired: true };
      }
      return {
        items: page.items.map((item) => item.record),
        next: page.continuation ?? after,
        ...bounds,
        hasMore: page.hasMore,
        resetRequired: false,
      };
    }));
  }
}

//#endregion
