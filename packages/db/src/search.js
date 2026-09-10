//@ts-check
/** Optional lexical persistence and bounded execution over authoritative entity snapshots. */
import { compileLexical } from '@jarenjs/core/search';
import { createLexicalProvider } from '@jarenjs/json/query';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { utf8ByteLength } from '@jarenjs/core/string';
import { isCursorBudgetError } from './cursor.js';

/** Atomic snapshot storage over a host-declared collection of {id, payload} documents.
 * Snapshot rows are derived caches and never answer catalog queries.
 * @param {any} store @param {string} collection @param {{maxBytes?:number}} [options] */
export function createDbSearchStorage(store, collection, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (typeof collection !== 'string' || !collection || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid lexical snapshot storage');
  return {
    async load(id) { const row = await store.collection(collection).get(id);
      if (!row) return null;
      if (typeof row.payload !== 'string' || row.payload.length > maxBytes || utf8ByteLength(row.payload) > maxBytes)
        throw new RangeError('Snapshot storage byte credits');
      return row.payload;
    },
    async save(id, payload) {
      if (typeof id !== 'string' || !id || typeof payload !== 'string' || payload.length > maxBytes || utf8ByteLength(payload) > maxBytes)
        throw new RangeError('Snapshot storage byte credits');
      return store.transaction(async (tx) => {
        const target = tx.collection(collection), old = await target.get(id);
        if (old?.payload === payload) return { changes: 0 };
        await target.put({ id, payload }); return { changes: 1 };
      });
    },
  };
}

/**
 * Read a bounded, complete entity snapshot inside the store transaction; captured
 * commits invalidate it. External SQL invalidates through dataVersion on request.
 * A SHA-256 source-content revision also detects uncaptured edits across reopen.
 * Native FTS is deliberately refused: this adapter executes the shared ranker.
 * @param {any} store @param {string} entity
 * @param {import('@jarenjs/core/search').LexicalDefinition} definition
 * @param {{source:string, maxRows?:number, maxBytes?:number, storage?:{load:(key:string)=>Promise<string|null>,save:(key:string,payload:string)=>Promise<any>}, snapshotKey?:string}} options
 * @returns {Promise<any>}
 */
export async function createDbSearch(store, entity, definition, options) {
  const maxRows = options?.maxRows ?? 10000, maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
  if (typeof options?.source !== 'string' || !options.source || !Number.isSafeInteger(maxRows) || maxRows < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new TypeError('Invalid lexical source credits');
  if (!store.capabilities?.capture || store.capabilities.capture === 'none') throw new TypeError('Lexical freshness requires committed capture');
  const compiled = compileLexical(definition), index = compiled.create(), storage = options.storage;
  const snapshotKey = options.snapshotKey ?? `${options.source}:${entity}`;
  let rows = new Map(), sourceRevision = '', dataVersion, dirty = true, disposed = false, epoch = 0, busy = null;
  let reads = 0, writes = 0, restores = 0, rebuilds = 0, sourceBytes = 0, recovery = null, pendingSnapshot = null;
  const observers = new Set(), controller = new AbortController();
  const invalidate = (reason) => {
    dirty = true; epoch++;
    for (const observer of observers) { try { observer({ type: 'reset', reason, revision: epoch, sourceRevision }); }
      catch { /* An observer cannot suppress a sibling's invalidation. */ } }
  };
  const unsubscribe = store.observe((record) => { if (record.collections.includes(entity)) invalidate('source-changed'); });
  const refusal = (state, reason) => ({ state, reason, hits: [], total: null, sourceRevision });
  const refresh = async () => {
    if (disposed) return refusal('error', 'disposed');
    if (busy) return busy;
    const run = async () => {
      try {
        const loaded = await store.transaction(async (tx) => {
          const current = await tx.dataVersion();
          if (dataVersion !== undefined && current !== dataVersion) invalidate('external-source-changed');
          dataVersion = current;
          if (!dirty) return null;
          const page = await tx.entity(entity).page({ orderBy: '$it.id' },
            { limit: maxRows + 1, maxBytes, lookahead: false, signal: controller.signal });
          reads++;
          if (page.hasMore !== false || page.items.length > maxRows) throw new RangeError('Lexical source exceeds row credits');
          const source = canonicalizeJson(page.items);
          if (utf8ByteLength(source) > maxBytes) throw new RangeError('Lexical source exceeds byte credits');
          const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
          const revision = `${options.source}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
          return { items: page.items, revision, bytes: utf8ByteLength(source), epoch };
        }, { signal: controller.signal });
        if (disposed) return refusal('error', 'disposed');
        if (!loaded) return { state: 'complete', changes: 0, sourceRevision };
        if (loaded.epoch !== epoch) return refusal('invalidated', 'source-changed');
        if (loaded.revision === sourceRevision) {
          if (pendingSnapshot !== null) { writes += (await storage.save(snapshotKey, pendingSnapshot)).changes; pendingSnapshot = null; }
          if (disposed || loaded.epoch !== epoch) return refusal(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'source-changed');
          dirty = false; return { state: 'complete', changes: 0, sourceRevision };
        }
        const nextRows = new Map(loaded.items.map((row) => [row.id, Object.freeze(row)]));
        if (nextRows.size !== loaded.items.length) throw new TypeError('Duplicate lexical source IDs');
        let result;
        if (!sourceRevision && storage) {
          const saved = await storage.load(snapshotKey);
          if (saved !== null) {
            result = index.restore(saved, { sourceRevision: loaded.revision });
            if (result.state === 'complete') restores++; else recovery = result.reason;
          }
        }
        if (disposed || loaded.epoch !== epoch) return refusal(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'source-changed');
        if (result?.state !== 'complete') {
          result = index.rebuild(loaded.items, { sourceRevision: loaded.revision }); rebuilds++;
        }
        if (result.state !== 'complete') return { ...result, hits: [], total: null };
        rows = nextRows; sourceRevision = loaded.revision; sourceBytes = loaded.bytes; dirty = false;
        if (storage) { pendingSnapshot = index.snapshot(); writes += (await storage.save(snapshotKey, pendingSnapshot)).changes; pendingSnapshot = null; }
        if (disposed || loaded.epoch !== epoch) return refusal(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'source-changed');
        return { state: 'complete', changes: result.changes, sourceRevision };
      }
      catch (error) { dirty = true; return refusal(error instanceof RangeError || isCursorBudgetError(error)
        ? 'budget-exhausted' : 'error', disposed ? 'disposed' : error?.message ?? String(error)); }
    };
    busy = run().finally(() => { busy = null; }); return busy;
  };
  const service = {
    refresh,
    get sourceRevision() { return sourceRevision; },
    async search(text, spec = {}) {
      const ready = await refresh(); if (ready.state !== 'complete') return ready;
      return createLexicalProvider(index, { row: (id) => rows.get(id) }).compile(spec)(text);
    },
    /** Access a row only under its published search revision. */
    row(id, revision) {
      if (disposed || dirty || revision !== sourceRevision) throw new Error('Lexical source snapshot changed');
      return structuredClone(rows.get(id));
    },
    subscribe(fn) {
      if (disposed || typeof fn !== 'function') throw new TypeError('Invalid lexical observer');
      if (observers.size >= 8) throw new RangeError('Lexical subscription credits');
      observers.add(fn); return () => observers.delete(fn);
    },
    explain() { return { mode: 'resident', nativeFTS: false, reason: 'native-token-rank-parity-unqualified',
      maxRows, maxBytes, capture: store.capabilities.capture, externalChanges: 'dataVersion plus authoritative SHA-256 on refresh' }; },
    stats() { return { ...index.stats(), sourceRows: rows.size, sourceBytes, reads, writes, restores, rebuilds,
      recovery, dirty, pending: busy ? 1 : 0, subscriptions: observers.size }; },
    async dispose() {
      disposed = true; controller.abort(); unsubscribe(); observers.clear();
      await busy; index.dispose(); rows.clear(); sourceBytes = 0; pendingSnapshot = null;
    },
  };
  const ready = await refresh();
  if (ready.state !== 'complete') { await service.dispose(); throw new Error(`Lexical source: ${ready.reason}`); }
  return service;
}
