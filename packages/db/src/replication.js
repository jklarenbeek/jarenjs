//@ts-check
/** Durable replication state shares the data transaction and capture settlement. */
import { stableStringify, deepFreeze } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { utf8Length, assertItemBytes, createCursor, drainPage } from './cursor.js';
import { chain } from './driver.js';
import { DbRuntimeError } from './errors.js';
import { refuseCancelled } from './cancellation.js';
import { normalizeReplication, normalizeReplicationSnapshot, normalizeFrontier, replicationIdentity, REPLICATION_DEFAULTS } from './replication-format.js';
import { REPLICATION_TABLES } from './replication-tables.js';

const equal = (a, b) => stableStringify(a) === stableStringify(b);
const position = (frontier, id) => Object.hasOwn(frontier, id) ? frontier[id] : 0;
const dominates = (a, b) => Object.entries(b).every(([id, seq]) => position(a, id) >= seq);
const fail = (code, reason) => { throw new DbRuntimeError(code, reason); };
const joinFrontiers = (a, b) => normalizeFrontier(Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
  .map((id) => [id, Math.max(position(a, id), position(b, id))])));
const each = (items, fn) => {
  let i = 0;
  const next = () => {
    while (i < items.length) {
      const value = fn(items[i++]);
      if (value instanceof Promise) return value.then(next);
    }
    return null;
  };
  return next();
};

/** @param {any} options */
export function createReplicationEngine(options) {
  const { connection, rows, capture, model, now, bracket } = options;
  const config = { ...REPLICATION_DEFAULTS, ...options.config };
  replicationIdentity(config.replica, 1);
  for (const member of ['retention', 'maxOperations', 'maxBytes']) {
    if (!Number.isSafeInteger(config[member]) || config[member] < 1)
      throw new TypeError(`replication.${member} must be a positive safe integer`);
  }
  if (config.resolver !== undefined && (typeof config.resolver?.id !== 'string' || !config.resolver.id
    || typeof config.resolver.resolve !== 'function')) throw new TypeError('replication.resolver needs a stable id and pure resolve function');
  const sql = (text, method = 'run', params = []) => chain(connection.prepare(text), (s) => s[method](params));
  const state = () => chain(sql(`SELECT value FROM ${REPLICATION_TABLES.state} WHERE id = 1`, 'get'), (row) => JSON.parse(row.value));
  const saveState = (value) => sql(`UPDATE ${REPLICATION_TABLES.state} SET value = ? WHERE id = 1`, 'run', [stableStringify(value)]);
  const rowState = (table, key) => chain(sql(`SELECT value, frontier FROM ${REPLICATION_TABLES.rows} WHERE name = ? AND key = ?`, 'get', [table, key]),
    (row) => row === undefined ? { value: null, frontier: {} } : { value: JSON.parse(row.value), frontier: JSON.parse(row.frontier) });
  const saveRow = (operation, frontier) => sql(`INSERT INTO ${REPLICATION_TABLES.rows} (name, key, value, frontier) VALUES (?, ?, ?, ?) `
    + 'ON CONFLICT(name, key) DO UPDATE SET value = excluded.value, frontier = excluded.frontier', 'run',
  [operation.table, operation.key, stableStringify(operation.after), stableStringify(frontier)]);
  const cancelled = (request) => refuseCancelled(request, now, {
    abortCode: 'JD2072', aborted: 'the next replication operation', passed: 'the next replication operation', ran: 'the transaction is not acknowledged',
  });
  const bounded = (document) => {
    if (document.operations.length > config.maxOperations) fail('JD2106', 'replication operation bound exceeded');
    assertItemBytes(utf8Length(stableStringify(document)), config.maxBytes);
  };
  const receipt = (envelope) => sql(`INSERT INTO ${REPLICATION_TABLES.receipts} (id, payload) VALUES (?, ?)`, 'run',
    [replicationIdentity(envelope.replica, envelope.seq), stableStringify(envelope)]);
  // Pull one row at a time and refuse before accumulating beyond shared credits.
  const collectBounded = async (query, params, map, request, credits) => {
    const cursor = createCursor({ streaming: 'row', barrier: null, signal: request?.signal, deadline: request?.deadline, now,
      open: () => chain(connection.prepare(query), (statement) => statement.iterate(params)), items: (row) => [map(row)] });
    const result = [];
    for await (const item of cursor) {
      if (++credits.count > config.maxOperations) fail('JD2106', 'replication read exceeds its row capacity');
      credits.bytes += utf8Length(stableStringify(item)) + 1;
      assertItemBytes(credits.bytes, Math.min(request?.maxBytes ?? config.maxBytes, config.maxBytes));
      result.push(item);
    }
    return result;
  };

  const ready = bracket(() => chain(each([
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.state} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.rows} (name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, frontier TEXT NOT NULL, PRIMARY KEY(name, key))`,
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.receipts} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.outbox} (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.conflicts} (id TEXT PRIMARY KEY, evidence TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLES.claims} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  ], (ddl) => connection.exec(ddl)), () => chain(sql(`SELECT value FROM ${REPLICATION_TABLES.state} WHERE id = 1`, 'get'), (existing) => {
    if (existing !== undefined) {
      const saved = JSON.parse(existing.value);
      if (saved.replica !== config.replica || saved.model !== model)
        fail('JD2102', 'the durable replica identity or model revision disagrees with this open');
      return null;
    }
    return chain(rows.empty(), (empty) => {
      if (!empty) fail('JD2105', 'initialize replication on an empty store, then import an explicit snapshot');
      return sql(`INSERT INTO ${REPLICATION_TABLES.state} (id, value) VALUES (1, ?)`, 'run',
        [stableStringify({ replica: config.replica, model, frontier: {} })]);
    });
  })));

  /** Convert net capture patches against durable before-images, inside commit. */
  const commit = (patch, context) => {
    if (patch.length === 0) return null;
    const grouped = new Map();
    for (const operation of patch) {
      const segments = operation.path.split('/').slice(1).map(decodeJSONPointerSegment);
      const identity = JSON.stringify(segments.slice(0, 2));
      if (!grouped.has(identity)) grouped.set(identity, { table: segments[0], key: segments[1], patch: [] });
      const prefix = operation.path.split('/').slice(0, 3).join('/');
      grouped.get(identity).patch.push({ ...operation, path: operation.path.slice(prefix.length),
        ...(operation.from === undefined ? {} : { from: operation.from.slice(prefix.length) }) });
    }
    if (grouped.size > config.maxOperations) fail('JD2106', 'replication operation bound exceeded');
    if (context?.replication === true) {
      // Applying metadata has already installed the intended final images.
      // Any undeclared cascade must roll back with the envelope, never escape
      // its receipt and leave an acknowledged row silently missing.
      return each([...grouped.values()], (entry) => chain(rowState(entry.table, entry.key), (expected) =>
        chain(rows.read(entry.table, entry.key), (actual) => {
          if (!equal(actual ?? null, expected.value)) fail('JD2104', 'replication caused an undeclared row side effect');
        })));
    }
    return chain(state(), (saved) => {
      const operations = [];
      return chain(each([...grouped.values()].sort((a, b) => {
        const x = JSON.stringify([a.table, a.key]); const y = JSON.stringify([b.table, b.key]);
        return x < y ? -1 : x > y ? 1 : 0;
      }), (entry) => chain(rowState(entry.table, entry.key), (old) => {
        const after = entry.patch.length === 1 && entry.patch[0].op === 'remove' && entry.patch[0].path === ''
          ? null : applyJSONPatch(old.value, entry.patch);
        return chain(rows.read(entry.table, entry.key), (actual) => {
          if (!equal(actual ?? null, after)) fail('JD2104', 'capture disagrees with the durable replica before-image');
          operations.push({ table: entry.table, key: entry.key, before: old.value, after });
        });
      })), () => {
        const seq = position(saved.frontier, config.replica) + 1;
        const envelope = normalizeReplication({ $replication: '0.1', replica: config.replica, seq,
          frontier: saved.frontier, model, operations });
        bounded(envelope);
        const frontier = joinFrontiers(saved.frontier, { [config.replica]: seq });
        return chain(each(operations, (operation) => saveRow(operation, frontier)), () => chain(receipt(envelope), () =>
          chain(sql(`INSERT INTO ${REPLICATION_TABLES.outbox} (seq, payload) VALUES (?, ?)`, 'run', [seq, stableStringify(envelope)]), () =>
            chain(sql(`DELETE FROM ${REPLICATION_TABLES.outbox} WHERE seq <= ?`, 'run', [seq - config.retention]), () =>
              saveState({ ...saved, frontier })))));
      });
    });
  };

  /** All checks precede writes; conflict evidence commits without advancing a frontier. */
  const apply = (input, request, transaction) => {
    const envelope = normalizeReplication(input);
    bounded(envelope);
    cancelled(request);
    if (envelope.model !== model) fail('JD2102', 'replication model revision mismatch');
    const identity = replicationIdentity(envelope.replica, envelope.seq);
    return transaction(async () => {
      capture.setContext({ replication: true });
      cancelled(request);
      const saved = await state();
      const previous = await sql(`SELECT payload FROM ${REPLICATION_TABLES.receipts} WHERE id = ?`, 'get', [identity]);
      if (previous !== undefined) {
        if (previous.payload !== stableStringify(envelope)) fail('JD2101', 'the envelope identity already has a different payload');
        return { status: 'duplicate', frontier: saved.frontier, conflicts: [] };
      }
      const claim = await sql(`SELECT payload FROM ${REPLICATION_TABLES.claims} WHERE id = ?`, 'get', [identity]);
      if (claim !== undefined && claim.payload !== stableStringify(envelope))
        fail('JD2101', 'a conflicted envelope identity already has a different payload');
      const seen = position(saved.frontier, envelope.replica);
      if (envelope.seq <= seen) fail('JD2105', 'a snapshot covers this envelope but its receipt is unavailable; reset is required');
      if (envelope.seq !== seen + 1 || !dominates(saved.frontier, envelope.frontier))
        fail('JD2100', 'a sequence or causal gap requires missing history or an explicit reset');
      if (envelope.replica === config.replica) fail('JD2101', 'a replica cannot accept an unknown envelope under its own identity');
      const conflicts = [];
      const chosen = [];
      for (const operation of envelope.operations) {
        cancelled(request);
        const local = await rowState(operation.table, operation.key);
        const actual = await rows.read(operation.table, operation.key) ?? null;
        if (!equal(actual, local.value)) fail('JD2104', 'a row was written outside its replication history');
        let after = operation.after;
        if (!equal(actual, operation.before) && !equal(actual, operation.after)) {
          if (dominates(envelope.frontier, local.frontier)) fail('JD2104', 'the operation before-image disagrees with its causal base');
          const evidence = { envelope: identity, table: operation.table, key: operation.key,
            base: operation.before, local: { value: actual, frontier: local.frontier },
            remote: { value: operation.after, replica: envelope.replica, seq: envelope.seq, frontier: envelope.frontier },
            resolver: config.resolver?.id ?? null, resolution: null };
          if (config.resolver) {
            const input = structuredClone(evidence);
            let decision;
            try { decision = config.resolver.resolve(deepFreeze(input)); }
            catch (cause) { throw new DbRuntimeError('JD2103', 'the conflict resolver failed', { cause }); }
            if (decision && typeof decision.then === 'function') {
              Promise.resolve(decision).catch(() => {});
              fail('JD2103', 'a conflict resolver must be synchronous');
            }
            if (!decision || !['local', 'remote', 'merged'].includes(decision.action))
              fail('JD2103', 'a pure resolver must return local, remote or merged synchronously');
            after = decision.action === 'local' ? actual : decision.action === 'remote' ? operation.after : decision.value;
            // Reuse the document grammar for merged values, including finite JSON.
            if (!equal(after, actual)) normalizeReplication({ ...envelope, operations: [{ ...operation, before: actual, after }] });
            evidence.resolution = { action: decision.action, value: after };
          }
          conflicts.push(evidence);
        }
        chosen.push({ ...operation, before: actual, after });
      }
      bounded({ ...envelope, operations: chosen });
      assertItemBytes(utf8Length(stableStringify(conflicts)), config.maxBytes);
      for (const conflict of conflicts) {
        await sql(`INSERT INTO ${REPLICATION_TABLES.conflicts} (id, evidence) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence`,
          'run', [JSON.stringify([identity, conflict.table, conflict.key]), stableStringify(conflict)]);
      }
      if (conflicts.length > 0 && !config.resolver) {
        if (claim === undefined) await sql(`INSERT INTO ${REPLICATION_TABLES.claims} (id, payload) VALUES (?, ?)`, 'run', [identity, stableStringify(envelope)]);
        return { status: 'conflict', frontier: saved.frontier, conflicts };
      }
      // Canonical capture order is independent of FK topology; defer constraints
      // until all rows of the logical transaction have reached their final state.
      await connection.exec(connection.dialect.tx.deferForeignKeys);
      for (const operation of chosen) {
        cancelled(request);
        if (!equal(operation.before, operation.after)) await rows.write(operation);
      }
      for (const operation of chosen) {
        if (!equal(await rows.read(operation.table, operation.key) ?? null, operation.after))
          fail('JD2104', 'the stored logical row differs from the requested replicated value');
      }
      const frontier = joinFrontiers(saved.frontier, { [envelope.replica]: envelope.seq });
      for (const operation of chosen) await saveRow(operation, frontier);
      await receipt(envelope);
      await saveState({ ...saved, frontier });
      cancelled(request);
      return { status: 'applied', frontier, conflicts };
    }, request);
  };

  const page = async (request = {}) => {
    const { after = 0, limit = 100, maxBytes = config.maxBytes } = request;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('replication.page needs safe after, limit and maxBytes bounds');
    cancelled(request);
    const saved = await state();
    const highWatermark = position(saved.frontier, config.replica);
    const floor = await sql(`SELECT min(seq) AS lo FROM ${REPLICATION_TABLES.outbox}`, 'get');
    const earliestAvailable = floor.lo === null ? null : Number(floor.lo);
    const bounds = { earliestAvailable, highWatermark };
    if (after > highWatermark || after + 1 < (earliestAvailable ?? highWatermark + 1))
      return { items: [], ...bounds, resetRequired: true, hasMore: false };
    const cursor = createCursor({ streaming: 'row', barrier: null, signal: request.signal, deadline: request.deadline, now,
      open: () => chain(connection.prepare(`SELECT payload FROM ${REPLICATION_TABLES.outbox} WHERE seq > ? ORDER BY seq LIMIT ?`),
        (statement) => statement.iterate([after, limit + 1])),
      items: (row) => [{ envelope: JSON.parse(row.payload), bytes: utf8Length(row.payload) }] });
    const page = await drainPage(cursor, { limit, maxBytes: Math.min(maxBytes, config.maxBytes), after,
      sizeOf: (item) => item.bytes, continuationOf: (item) => item.envelope.seq });
    return { items: page.items.map((item) => item.envelope), ...bounds, next: page.continuation ?? after,
      bytes: page.items.reduce((sum, item) => sum + item.bytes, 0), resetRequired: false, hasMore: page.hasMore };
  };
  const snapshot = async (request = {}) => {
    cancelled(request);
    const saved = await state();
    const credits = { count: 0, bytes: 0 };
    const values = await collectBounded(`SELECT name, key, value, frontier FROM ${REPLICATION_TABLES.rows} ORDER BY name, key LIMIT ?`, [config.maxOperations + 1],
      (row) => ({ table: row.name, key: row.key, value: JSON.parse(row.value), frontier: JSON.parse(row.frontier) }), request, credits);
    const receipts = await collectBounded(`SELECT payload FROM ${REPLICATION_TABLES.receipts} ORDER BY id LIMIT ?`, [config.maxOperations + 1],
      (row) => JSON.parse(row.payload), request, credits);
    const document = normalizeReplicationSnapshot({ $replicationSnapshot: '0.1', model, frontier: saved.frontier,
      rows: values, receipts });
    assertItemBytes(utf8Length(stableStringify(document)), config.maxBytes);
    cancelled(request);
    return document;
  };
  const reset = (input, request, transaction) => {
    const document = normalizeReplicationSnapshot(input);
    if (document.model !== model) fail('JD2102', 'snapshot model revision mismatch');
    if (document.rows.length + document.receipts.length > config.maxOperations) fail('JD2106', 'snapshot exceeds the bounded reset capacity');
    assertItemBytes(utf8Length(stableStringify(document)), config.maxBytes);
    for (const row of document.rows) if (!dominates(document.frontier, row.frontier)) fail('JD2104', 'snapshot row is ahead of its frontier');
    const receipts = new Map();
    for (const envelope of document.receipts) {
      if (envelope.model !== model || !dominates(document.frontier, { ...envelope.frontier, [envelope.replica]: envelope.seq }))
        fail('JD2104', 'snapshot receipt is ahead of its frontier or names another model');
      receipts.set(replicationIdentity(envelope.replica, envelope.seq), envelope);
    }
    // A frontier must never hide an unproven receipt gap.
    const counts = new Map();
    for (const envelope of receipts.values()) counts.set(envelope.replica, (counts.get(envelope.replica) ?? 0) + 1);
    for (const [replica, seq] of Object.entries(document.frontier)) if ((counts.get(replica) ?? 0) !== seq)
      fail('JD2104', 'snapshot receipts do not cover the complete frontier');
    return transaction(async () => {
      capture.setContext({ replication: true });
      cancelled(request);
      const saved = await state();
      if (!dominates(document.frontier, saved.frontier)) fail('JD2105', 'reset would discard acknowledged local history');
      const credits = { count: 0, bytes: 0 };
      const localReceipts = await collectBounded(`SELECT id, payload FROM ${REPLICATION_TABLES.receipts} LIMIT ?`, [config.maxOperations + 1],
        (row) => row, request, credits);
      for (const local of localReceipts) if (stableStringify(receipts.get(local.id)) !== local.payload)
        fail('JD2101', 'snapshot rewrites an acknowledged envelope identity');
      const localRows = await collectBounded(`SELECT name, key, value FROM ${REPLICATION_TABLES.rows} LIMIT ?`, [config.maxOperations + 1],
        (row) => row, request, credits);
      const desired = new Map(document.rows.map((row) => [JSON.stringify([row.table, row.key]), row]));
      const operations = new Map(localRows.map((row) => [JSON.stringify([row.name, row.key]),
        { table: row.name, key: row.key, before: JSON.parse(row.value), after: null }]));
      for (const [key, row] of desired) operations.set(key, { table: row.table, key: row.key,
        before: operations.get(key)?.before ?? null, after: row.value });
      await connection.exec(connection.dialect.tx.deferForeignKeys);
      for (const operation of operations.values()) {
        cancelled(request);
        if (!equal(await rows.read(operation.table, operation.key) ?? null, operation.before))
          fail('JD2104', 'reset found a row outside its replication history');
      }
      for (const operation of operations.values()) {
        cancelled(request);
        if (!equal(operation.before, operation.after)) await rows.write(operation);
      }
      for (const operation of operations.values()) if (!equal(await rows.read(operation.table, operation.key) ?? null, operation.after))
        fail('JD2104', 'reset did not store the requested logical state');
      await sql(`DELETE FROM ${REPLICATION_TABLES.rows}`);
      for (const row of document.rows) await saveRow({ ...row, after: row.value }, row.frontier);
      for (const envelope of receipts.values()) if (!localReceipts.some((local) => local.id === replicationIdentity(envelope.replica, envelope.seq))) await receipt(envelope);
      await sql(`DELETE FROM ${REPLICATION_TABLES.outbox}`);
      await saveState({ ...saved, frontier: document.frontier });
      cancelled(request);
      return { status: 'reset', frontier: document.frontier };
    }, request);
  };
  return { ready, commit, apply, page, snapshot, reset,
    frontier: () => chain(state(), (saved) => saved.frontier),
    conflicts: (request = {}) => {
      const limit = request.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('conflicts.limit must be a positive safe integer');
      if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1))
        throw new TypeError('conflicts.maxBytes must be a positive safe integer');
      cancelled(request);
      return collectBounded(`SELECT evidence FROM ${REPLICATION_TABLES.conflicts} ORDER BY id LIMIT ?`, [Math.min(limit, config.maxOperations)],
        (row) => JSON.parse(row.evidence), request, { count: 0, bytes: 1 });
    },
  };
}
