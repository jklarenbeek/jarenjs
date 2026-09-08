//@ts-check
/** Portable logical transactions. Canonical payloads are also collision-free receipts. */
import { stableStringify } from '@jarenjs/core/object';
import { DbCompileError } from './errors.js';

export const REPLICATION_VERSION = '0.1';
export const REPLICATION_DEFAULTS = Object.freeze({ retention: 1000, maxOperations: 10000, maxBytes: 4194304 });

const invalid = (reason) => { throw new DbCompileError('JD0060', reason); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const sequence = (value) => Number.isSafeInteger(value) && value >= 0;
const members = (value, names) => record(value) && Object.keys(value).length === names.length
  && names.every((name) => Object.hasOwn(value, name));

/** Normalize a causal frontier without interpreting host-issued replica names. @param {any} value */
export function normalizeFrontier(value) {
  jsonValue(value);
  if (!record(value) || Object.entries(value).some(([key, seq]) => !id(key) || !sequence(seq)))
    invalid('a frontier maps non-empty replica ids to non-negative safe sequences');
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** JSON identity is unambiguous even when replica ids contain separators. @param {string} replica @param {number} seq */
export function replicationIdentity(replica, seq) {
  if (!id(replica) || !sequence(seq) || seq === 0) invalid('an envelope identity needs a replica and positive safe sequence');
  return JSON.stringify([replica, seq]);
}

/** Reject values whose JSON encoding would silently discard or alter information. */
function jsonValue(value, seen = new Set()) {
  if (seen.size > 128) invalid('replication JSON exceeds the maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) invalid('replication values must be finite, acyclic JSON');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    invalid('replication values must be plain JSON objects');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) invalid('replication arrays contain only dense indexed values');
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('replication arrays contain only data values');
      jsonValue(descriptor.value, seen);
    }
  }
  else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        invalid('replication objects must have enumerable data members');
      jsonValue(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

/** Validate and detach a versioned envelope; array order is part of its identity. @param {any} document */
export function normalizeReplication(document) {
  jsonValue(document);
  if (!members(document, ['$replication', 'replica', 'seq', 'frontier', 'model', 'operations']))
    invalid('a replication envelope has exactly $replication, replica, seq, frontier, model and operations');
  if (document.$replication !== REPLICATION_VERSION) invalid('unsupported replication version');
  replicationIdentity(document.replica, document.seq);
  const frontier = normalizeFrontier(document.frontier);
  if ((Object.hasOwn(frontier, document.replica) ? frontier[document.replica] : 0) !== document.seq - 1)
    invalid('the sender frontier must immediately precede the envelope sequence');
  if (typeof document.model !== 'string' || document.model.length === 0) invalid('model revision must be non-empty');
  if (!Array.isArray(document.operations) || document.operations.length === 0) invalid('an envelope contains at least one operation');
  const rows = new Set();
  for (const operation of document.operations) {
    if (!members(operation, ['table', 'key', 'before', 'after'])
      || typeof operation.table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(operation.table)
      || typeof operation.key !== 'string'
      || !(operation.before === null || record(operation.before))
      || !(operation.after === null || record(operation.after))) invalid('invalid logical row operation');
    const key = JSON.stringify([operation.table, operation.key]);
    if (rows.has(key)) invalid('a transaction contains at most one net operation per row');
    rows.add(key);
    if (stableStringify(operation.before) === stableStringify(operation.after)) invalid('a logical operation must change its row');
  }
  return JSON.parse(stableStringify({ ...document, frontier }));
}

/** Deterministic JSON authoring shared by the DB pen and receipt comparison. @param {any} document @returns {string} */
export function encodeReplication(document) {
  return stableStringify(normalizeReplication(document));
}

/** A reset carries state, causality and collision receipts as one bounded document. @param {any} document */
export function normalizeReplicationSnapshot(document) {
  jsonValue(document);
  if (!members(document, ['$replicationSnapshot', 'model', 'frontier', 'rows', 'receipts'])
    || document.$replicationSnapshot !== REPLICATION_VERSION || typeof document.model !== 'string' || !document.model
    || !Array.isArray(document.rows) || !Array.isArray(document.receipts)) invalid('invalid replication snapshot');
  normalizeFrontier(document.frontier);
  const seen = new Set();
  for (const row of document.rows) {
    if (!members(row, ['table', 'key', 'value', 'frontier']) || typeof row.table !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.table) || typeof row.key !== 'string'
      || !(row.value === null || record(row.value))) invalid('invalid snapshot row');
    normalizeFrontier(row.frontier);
    const key = JSON.stringify([row.table, row.key]);
    if (seen.has(key)) invalid('duplicate snapshot row');
    seen.add(key);
  }
  seen.clear();
  for (const receipt of document.receipts) {
    normalizeReplication(receipt);
    const key = replicationIdentity(receipt.replica, receipt.seq);
    if (seen.has(key)) invalid('duplicate snapshot receipt');
    seen.add(key);
  }
  return JSON.parse(stableStringify(document));
}
